/**
 * 拼盘拆条（roundup splitting）
 *
 * 背景（2026-08-15 事故）：极客公园"极客早知道"12条拼盘因头条事件（GLM-5.3）
 * 昨日已精选，整篇被旧闻判定/去重连坐误杀——藏在其中的两条80+分大新闻
 * （苹果为中国训练专属模型 84分、SpaceX收购Cursor 89分）完全漏报。
 * 根因：评分与去重的最小单位是"一篇文章"，而拼盘一篇文章=多个独立事件。
 *
 * 方案：在AI筛选之前，把多事件拼盘拆成独立子事件，各自走评分/去重/配额：
 *   - 识别：标题含多事件分隔符（；|等）或已知合集栏目名（早知道/早报/速览…）
 *   - 拆分：qwen-plus 从内容片段中逐字摘录各事件正文（禁止脑补材料外信息）
 *   - 子事件URL = 父URL + #ev-N（避开source_url唯一约束；前轮已拆过的子事件
 *     经URL去重自然跳过；与其他报道的内容级重复由既有四层去重兜底）
 *   - 失败降级：拆不出（<2个有效事件）或调用失败 → 保留原拼盘，行为与之前一致
 *
 * 成本护栏：每轮最多拆 MAX_ROUNDUPS 篇（合集占比小），单次 max_tokens 1500。
 */
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const ROUNDUP_MODEL = process.env.ROUNDUP_MODEL || 'qwen-plus';

// 拼盘正文通常远长于RSS片段截断(2000字)，排在后半段的事件会拿不到材料而漏拆
// （实测：极客早知道12条，2000字只覆盖前5条，600亿美金的SpaceX-Cursor在第6条）。
// 拆条前对父页做一次轻量取全文；失败则退回片段（行为与之前一致）。
import { extractText } from './fetch-content.mjs';

async function fetchParentText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AINewsBot/1.0)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return '';
    const html = await res.text();
    return (extractText(html) || '').trim();
  } catch {
    return '';
  }
}
// 每轮最多拆几篇拼盘（成本护栏；合集类文章本身占比很小）
const MAX_ROUNDUPS = Number(process.env.ROUNDUP_SPLIT_MAX) || 5;
// 单篇最多拆出几个子事件（合集后半段也可能有大新闻：SpaceX-Cursor就是极客早知道第4条；
// 4条上限实测会让模型在"大额并购vs常规量产"间选错，放宽到6由下游评分把关）
const MAX_SUBEVENTS = 6;
// 内容片段不足此长度不拆（没有材料硬拆等于让模型编）
const MIN_SNIPPET_LEN = 200;

// 合集栏目关键词（中英文常见"早报/晚报/速览"类栏目名）
const ROUNDUP_COLUMN_RE = /(早知道|早报|晚报|午报|日报|周报|月报|速览|一览|盘点|要闻|合集|合辑|晨讯|roundup|digest|briefing|bulletin)/i;

/**
 * 判断一篇文章是否为"多事件拼盘"候选（纯函数，供测试）
 * 条件：媒体源 + 标题含合集信号 + 有足够内容片段可拆
 */
export function isRoundupCandidate(article) {
  if (!article || !article.title) return false;
  if (article.source_type === 'official' || article.official === true) return false; // 官方源不存在拼盘栏目
  const title = article.title;
  const snippet = (article.content_snippet || article.content || '').trim();
  if (snippet.length < MIN_SNIPPET_LEN) return false;

  const seps = (title.match(/[；;｜|]/g) || []).length;
  // 标题里明确并列了多件事（分号/竖线），且标题足够长（短标题的竖线多是栏目后缀）
  if (seps >= 1 && title.length >= 20) return true;
  // 已知合集栏目名（哪怕标题里只有一件事，正文也可能是合集）
  if (ROUNDUP_COLUMN_RE.test(title) && title.length >= 12) return true;
  return false;
}

/**
 * 把LLM返回的事件列表构造成子事件文章对象（纯函数，供测试）
 * @param {Object} parent - 原拼盘文章
 * @param {Array} events - [{title, segment}]
 * @returns {Array} 子事件文章（0~MAX_SUBEVENTS条）；无有效事件返回[]
 */
export function buildSubEvents(parent, events, max = MAX_SUBEVENTS) {
  if (!Array.isArray(events)) return [];
  const subs = [];
  for (const ev of events) {
    if (subs.length >= max) break;
    const title = String(ev?.title || '').trim();
    const segment = String(ev?.segment || '').trim();
    // 标题太短/太长、正文太薄的子事件不要（防模型硬凑数）
    if (title.length < 8 || title.length > 60) continue;
    if (segment.length < 40) continue;
    subs.push({
      ...parent,
      id: undefined, // 不继承任何库内id
      title,
      original_title: parent.original_title || parent.title, // 留出处拼盘名供溯源
      content_snippet: segment.slice(0, 2000),
      content: '', // 不预置全文：全文是整篇拼盘，会污染摘要（见collect对from_roundup跳过全文抓取）
      content_html: '',
      source_url: `${parent.source_url}#ev-${subs.length + 1}`,
      from_roundup: true,
    });
  }
  return subs;
}

/**
 * 容错解析LLM拆分响应（纯函数，供测试）
 * @returns {Array|null} 事件数组；解析失败返回null
 */
export function parseSplitResponse(text) {
  if (!text) return null;
  let s = String(text).trim();
  // 剥markdown代码围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // 截取第一个{到最后一个}（容忍前后废话）
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i === -1 || j <= i) return null;
  try {
    const obj = JSON.parse(s.slice(i, j + 1));
    if (!obj || !Array.isArray(obj.events)) return null;
    return obj.events;
  } catch {
    return null;
  }
}

function buildPrompt(article) {
  const snippet = (article.content_snippet || article.content || '').slice(0, 6000);
  return `你是AI资讯编辑。下面是一篇"早报/合集"类文章的标题和内容片段，一篇里打包了多条相互独立的新闻事件。

标题：${article.title}

内容片段：
${snippet}

请把其中与AI/大模型/机器人/AI芯片/科技巨头动态相关的独立事件拆出来（至多${MAX_SUBEVENTS}条）。
要求：
- 每条给出：title = 该事件的独立标题（15-30字，含主体+动作，不要带"早知道/早报"等栏目名）；segment = 从内容片段中【逐字摘录】的该事件正文（可摘录多个相邻段落，不要改写、不要总结、不要补充片段里没有的信息）
- 只拆内容片段中确有对应正文的事件；片段里没有正文的不要拆（宁可少拆，严禁编造）
- 若事件超过${MAX_SUBEVENTS}条，按此优先级取舍：大额融资并购（亿美元级）≈ 巨头战略/组织重大变动 > 重大模型或产品发布 > 重要政策 > 其他AI动态
- 非AI主题的事件（如社交产品功能、汽车、消费电子杂闻）不要拆
- 若片段实际只有一条独立事件，或正文不足以支撑拆分，返回空数组

严格按JSON返回，不要输出其他内容：
{"events": [{"title": "...", "segment": "..."}]}`;
}

async function callQwen(messages) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify({
      model: ROUNDUP_MODEL,
      messages,
      temperature: 0.1, // 逐字摘录任务，低温求稳
      max_tokens: 2500,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`DashScope API错误 ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * 对候选池做拼盘拆条：拼盘替换为独立子事件，其余文章原样保留
 * @param {Array} articles - 已完成URL去重的候选文章
 * @returns {Promise<{list: Array, stats: {roundups: number, split: number, failed: number}}>}
 */
export async function splitRoundups(articles) {
  const stats = { roundups: 0, split: 0, failed: 0 };
  if (!DASHSCOPE_API_KEY || !articles.length) return { list: articles, stats };

  const candidates = articles.filter(isRoundupCandidate).slice(0, MAX_ROUNDUPS);
  if (!candidates.length) return { list: articles, stats };
  stats.roundups = candidates.length;

  // 逐篇拆（量少，无需并发）；拆成功的父篇替换为子事件
  const replaced = new Map(); // parent.source_url -> subEvents[]
  for (const parent of candidates) {
    try {
      // 片段可能被2000字截断：先尝试取父页全文补料（失败退回片段）
      const snippetLen = (parent.content_snippet || '').length;
      const fullText = await fetchParentText(parent.source_url);
      const material = fullText.length > snippetLen ? fullText : (parent.content_snippet || '');
      const enriched = { ...parent, content_snippet: material.slice(0, 6000) };
      console.log(`  [拼盘拆条] ${parent.source_name} 材料 ${material.length} 字（片段 ${snippetLen} 字${fullText.length > snippetLen ? '，已取父页全文' : ''}）`);
      const text = await callQwen([
        { role: 'system', content: '你是AI资讯编辑，擅长把合集文章拆解为独立新闻。只输出JSON。' },
        { role: 'user', content: buildPrompt(enriched) },
      ]);
      const events = parseSplitResponse(text);
      const subs = buildSubEvents(parent, events || []);
      if (subs.length >= 2) {
        replaced.set(parent.source_url, subs);
        stats.split += subs.length;
        console.log(`  [拼盘拆条] ${parent.source_name}《${parent.title.slice(0, 30)}…》-> ${subs.length} 个子事件: ${subs.map(s => s.title.slice(0, 18)).join(' / ')}`);
      } else {
        console.log(`  [拼盘拆条] ${parent.source_name}《${parent.title.slice(0, 30)}…》拆出不足2条，保留原篇`);
      }
    } catch (e) {
      stats.failed++;
      console.warn(`  [拼盘拆条] ${parent.source_name} 拆分失败(保留原篇): ${e.message}`);
    }
  }

  if (!replaced.size) return { list: articles, stats };
  const list = [];
  for (const a of articles) {
    const subs = replaced.get(a.source_url);
    if (subs) list.push(...subs);
    else list.push(a);
  }
  return { list, stats };
}
