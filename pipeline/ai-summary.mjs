/**
 * AI总结生成 - 调用通义千问为每篇文章生成500-800字中文精华总结
 * 同时按内容判定一级分类（制度性保障：分类只看内容，不再继承信源配置）
 */
import { CATEGORY_RULES, VALID_CATEGORIES, applyTagInvariants } from './classify-rules.mjs';
import { canonicalizeName } from './tag-canonical.mjs';
import { pickMaterial, groundedAssertions, markQuarantine, QUARANTINE_REASONS, MIN_MATERIAL_CHARS } from './material.mjs';

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
// 默认生产端点；DASHSCOPE_API_URL 仅供回归测试用本地桩服务替身（零成本验证闸门全链路），
// 线上不设该变量，行为与改动前完全一致
const API_URL = process.env.DASHSCOPE_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
// 摘要/翻译/分类环节使用旗舰模型 qwen-max（每天仅处理20篇，量小但最考验理解与防幻觉）；
// 可用环境变量 SUMMARY_MODEL 覆盖
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'qwen-max';

if (!DASHSCOPE_API_KEY) {
  console.warn('警告: DASHSCOPE_API_KEY 未设置，AI总结将使用原文截取');
}

/**
 * 调用通义千问API
 */
async function callQwen(messages, temperature = 0.5) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      messages,
      temperature,
      max_tokens: 2000, // 结构化输出字段较多（要点+分段摘要+金句+标签），留足余量防JSON被截断
    }),
    signal: AbortSignal.timeout(60000), // 60秒超时：qwen-max生成较慢，30秒偶发超时
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DashScope API错误 ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

/**
 * 规范化AI返回的tags对象为 {companies:[], people:[], keywords:[], regions:[]}，每类最多3个
 */
export function normalizeTags(raw) {
  // 制度性保障：清洗后立即做实体别名归一（中文优先），再去重、每类最多3个
  // people 为白名单制：未命中大咖库的人物归一为空串，此处剔除
  const clean = (arr, kind) => Array.isArray(arr)
    ? [...new Set(
        arr.filter(t => typeof t === 'string' && t.trim())
           .map(t => {
             const name = t.trim();
             const hit = canonicalizeName(kind, name);
             // 被白名单剔掉的人名要留痕：LLM标了但名单没收录的，多半是该补名单而非该剔
             // （陶哲轩、Clément Delangue 都这样漏过）。打进采集日志，每周扫一眼补名单。
             if (!hit && kind === 'person') console.log(`  [人名未入库] ${name}`);
             return hit;
           })
           .filter(Boolean)
      )].slice(0, 3)
    : [];
  return {
    companies: clean(raw?.companies, 'company'),
    people: clean(raw?.people, 'person'),
    keywords: clean(raw?.keywords, 'keyword'),
    regions: clean(raw?.regions, 'region'),
  };
}

/**
 * 金句程序化校验：引用必须逐字出现在原文素材中（忽略空白差异、剥离首尾引号），
 * 比对不上直接丢弃——引用环节零幻觉成本，宁缺毋滥
 */
export function verifyQuote(quote, content) {
  if (typeof quote !== 'string' || typeof content !== 'string' || !content) return '';
  const q = quote.trim().replace(/^[“”"'‘’]+|[“”"'‘’]+$/g, '').trim();
  if (q.length < 8 || q.length > 120) return '';
  const squash = s => s.replace(/\s+/g, '');
  return squash(content).includes(squash(q)) ? q : '';
}

/**
 * 规范化核心要点数组：仅收非空字符串，每条截断80字，最多4条
 */
export function normalizeKeyPoints(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(p => typeof p === 'string' && p.trim())
    .map(p => p.trim().slice(0, 80))
    .slice(0, 4);
}

const TAGS_SPEC = `"tags": {"companies": ["公司名"], "people": ["人物名"], "keywords": ["关键词"], "regions": ["区域"]}（companies/people只填该新闻的当事方/主角——发布方、交易/合作双方、被报道的主体，排除仅作为对比、竞品、基准测试、行业背景被顺带提及的公司或人物（如"微软发布X，基准测试超过谷歌和Anthropic"，companies只填微软；即使新闻标题本身就是"A宣称超越B"式的对比宣称，被超越/被对比的B也不是当事方——B没有动作，只填发起宣称的A，如"OpenAI声称新模型超越Anthropic的Opus 5"，companies只填OpenAI、严禁填Anthropic，哪怕正文反复提及B及其模型的分数），也排除仅作为被接入/被兼容/被支持对象被列举的第三方厂商——当事方判断优先于集团归并，非当事方即使能归并到某大厂也不填（如"某平台宣布接入通义千问、智谱GLM等第三方模型"，companies只填该平台方，严禁因通义千问隶属阿里巴巴而填 阿里巴巴；但双方联合官宣的合作，两边都是当事方）；companies一律按内容理解归并到集团/母公司规范名，最终只写母公司名、不写子品牌名（即使全文通篇用的是子品牌名，只要能判断隶属关系就写母公司，如文中说"阿里巴巴旗下淘天集团"则写 阿里巴巴）——子品牌、产品线、事业部、研究院、云部门、全资子公司的动作都记到母公司名下（如 阿里云/通义/夸克/达摩院/平头哥/淘天→阿里巴巴，Azure/GitHub→微软，DeepMind→谷歌，抖音/火山引擎/豆包→字节跳动，微信/腾讯云→腾讯，昇腾/鸿蒙→华为），仅投资/参股关系的独立公司不归并（如 蚂蚁集团不归阿里巴巴，月之暗面不归其投资方）；companies必须是真实存在的公司/机构名，严禁把产品名或模型名（如Claude、Opus、GPT、Gemini）当作公司名；公司名为缩写时不得臆造全称，不确定就直接用缩写（如SSI）；公司用通用英文名如OpenAI、阿里巴巴；people同样只填观点持有者/动作主角本人——观点类文章只填发言人自己，正文中以"某某也表达过类似观点/类似说法"形式顺带提及的人物不是当事方，严禁填写（真实案例："Palantir CEO Karp批评AI行业"一文只填Alex Karp，文中顺带提到"纳德拉也表达过类似观点"的纳德拉绝不填）；人物用业界惯用名，惯用中文用中文如黄仁勋，惯用英文用英文如Sam Altman；regions仅当category为policy时填写（非政策文章一律空数组），且只填政策/监管动作的主体方——谁立法、谁监管、谁发布政策就填谁，被制裁/被针对/被影响的国家不填（如"美国对中国AI模型实施禁令"只填 美国；"欧盟AI法案生效"只填 欧盟），仅多国联合发布/签署时才填多个；regions只填国家/地区级名称（如 中国、美国、欧盟、英国、日本），严禁填城市名——事件发生在某城市时写所属国（如"在伦敦启动测试"填 英国不填伦敦），无则空数组；每类最多3个，没有则空数组）`;

/**
 * 为单篇文章生成中文精华总结（同时提取tags子标签）
 * @param {Object} article - 文章对象
 * @returns {Object} - 带中文标题、总结和tags(JSON字符串)的文章
 */
export async function generateSummary(article) {
  // 素材闸门（2026-10-08 假新闻事故 id 2228 后重写）：
  // 旧写法 `content = hasFullText ? content : (content_snippet || title)` 把标题当正文喂给模型，
  // 于是"特朗普签行政令：美国政府全面封杀AI"这条 112 字壳页稿，模型只看得到"封杀AI"四个字，
  // 凭它编出一条不存在的禁令并拿到 92 分进精选。标题是被加工的对象，不是加工的原料。
  // 现在：全文 → 真实摘要片段 → 没有就隔离（不调模型、不写 articles），宁可不显示也不编一条。
  const mat = pickMaterial(article);
  if (!mat) {
    console.warn(`  [QUARANTINE] 无可用素材（正文缺失或为壳页），隔离不入库: ${String(article.title || '').slice(0, 45)}`);
    return markQuarantine(
      { ...article, summary: '', takeaway: '', key_points: '[]', quote: '', tags: article.tags || '[]' },
      QUARANTINE_REASONS.MISSING_BODY,
      `content=${(article.content || '').length}字, content_snippet=${(article.content_snippet || '').length}字（低于${MIN_MATERIAL_CHARS}字下限、或与标题等同、或为壳页）`,
    );
  }
  const content = mat.material;
  const hasFullText = mat.hasFullText;
  const contentLimit = hasFullText ? 6000 : 2000;
  const isEnglish = article.language === 'en';

  // 无API Key = 加工未真正发生，同样标记失败并隔离（不产出半成品混入主列表）
  if (!DASHSCOPE_API_KEY) {
    return {
      ...article,
      summary: '',
      tags: '[]',
      takeaway: '',
      key_points: '[]',
      quote: '',
      _proc_failed: true,
      _proc_reason: 'DASHSCOPE_API_KEY 未设置',
    };
  }

  // 同一来源同期围绕同一事件连发的多篇稿件（事件去重时带素材合并过来）：
  // 它们不是重复垃圾，而是同一条新闻的不同侧面（主公告/技术细节/基准成绩），
  // 必须汇成一条并点明连发篇数——否则要么各占一条精选（2026-07-30 OpenAI三稿事故），要么信息被丢掉
  const mergedSnippets = article.related_snippets || [];
  const mergedTotal = (article.merged_same_source || 0) + 1; // 含保留篇自身
  const mergedBlock = mergedSnippets.length
    ? `\n【必须整合】${article.source_name} 同期围绕此事共发布了 ${mergedTotal} 篇文章，已合并为这一条新闻。以下是另外 ${mergedSnippets.length} 篇的标题与摘要，其硬事实要一并写进 key_points 与 summary；且 summary 中必须点出"${article.source_name}同期连发${mergedTotal}篇文章谈此事"（以及它们分别讲了什么）：\n${mergedSnippets.map(s => `- ${s.title}：${s.snippet}`).join('\n')}\n`
    : '';

  // 同事件其他媒体报道标题（事件去重时保留）：作为多源事实校对上下文，
  // 单源标题缺失的关键事实（如公司归属）可从其他报道互证，防止幻觉
  // （已被上面"必须整合"列出的同来源稿件排除，避免一份标题既要整合又要"不要总结"的矛盾指令）
  const mergedTitles = new Set(mergedSnippets.map(s => s.title));
  const otherTitles = (article.related_titles || []).filter(t => t && !mergedTitles.has(t));
  const relatedBlock = otherTitles.length
    ? `\n同一事件的其他媒体报道标题（仅用于校对公司归属等关键事实，不要总结它们的内容）：\n${otherTitles.map(t => `- ${t}`).join('\n')}\n`
    : '';

  // 回指校验的比对范围 = 提示词里向模型声明为"有效证据"的全部内容，一处口径。
  // 只拿本篇正文比对会误杀：mergedBlock 明确要求把同来源连发稿的硬事实写进 key_points，
  // 那些事实天然不在本篇正文里。证据集合与提示词承诺的集合必须严格相同，否则
  // "整合要求"和"回指闸门"就是两道互相矛盾的制度（二审 prompt 已有同样的合并素材块）。
  const groundingCorpus = [
    content,
    ...mergedSnippets.map(s => `${s.title || ''} ${s.snippet || ''}`),
    ...otherTitles,
  ].join('\n');

  const prompt = `请为以下AI资讯生成结构化中文精华总结、判定分类并提取标签。

要求：
1. takeaway：一句话要点，25字以内，说清"谁做了什么/结果如何"，硬信息优先，不加修饰
2. key_points：2-4条核心事实要点，每条不超过40字；关键数字（金额/百分比/排名/性能指标/规模）必须放进要点，一条要点一个事实
3. summary：300-600字叙述总结，分2-3个自然段（段落之间用\\n\\n分隔）：先讲发生了什么（核心事件与经过），再讲为什么重要（行业影响、与已有格局的关系）；叙述要连贯有判断，不要把key_points的数字清单原样复述一遍
4. quote：${hasFullText ? '从原文中摘一句最有信息量的原话（20-80字），必须逐字复制原文、一字不改（会与原文程序比对，改写即被丢弃）；没有合适的就给空字符串' : '给空字符串（无全文素材，禁止引用）'}
5. 语言精炼专业，避免废话
6. ${isEnglish ? '将英文标题翻译为简洁有力的中文标题' : '保持原标题或适当优化'}
7. 提取标签：文章涉及的主要公司、人物、关键词
8. 按下面的分类制度判定category（只看文章内容本身，不要参考来源媒体的风格）

事实准确性硬规则（违反即为严重错误）：
- 严格区分模型名与公司名：模型/产品的开发商必须写对，严禁把模型名臆造成公司名（如不存在"Opus公司"，Opus是Anthropic的Claude系列模型）
- 缩写不得擅自展开：原文只写缩写（如SSI、DPO）时，除非你百分之百确定全称，否则直接使用缩写，严禁臆造全称（如Ilya创办的SSI全称是Safe Superintelligence Inc.，不是其他任何展开）
- 原文未明确提及开发商且你无法从"同事件其他报道标题"中确认时，宁可不写公司名，绝不臆断或编造
- 不得编造原文没有的数据、人名、机构名
- 数字与单位严禁换算改写（2026-08-28事故：320 billion被写成"320亿"，差10倍）：英文数字单位（billion/trillion/xxB/万/亿）照抄原文写法（如"320B"或"320 billion"），或精确换算成中文（320 billion=3200亿）；中文摘要中"亿"与"B/billion"严禁混用，换算没把握时一律照抄原文单位
${mergedBlock}${relatedBlock}
${CATEGORY_RULES}

来源：${article.source_name}
原标题：${article.title}
${hasFullText ? '原文全文' : '内容片段（非全文，事实不足时宁缺毋滥）'}：${content.slice(0, contentLimit)}

请严格按以下JSON格式返回：
{"title": "中文标题", "takeaway": "一句话要点", "key_points": ["要点1", "要点2"], "summary": "分段叙述总结", "quote": "原文金句或空字符串", "category": "${VALID_CATEGORIES.join('|')}", ${TAGS_SPEC}}`;

  const messages = [
    { role: 'system', content: '你是AI行业资深编辑，擅长将技术资讯提炼为简洁有力的中文总结。只输出JSON格式。' },
    { role: 'user', content: prompt },
  ];

  // JSON解析失败/调用失败重试1次，再降级
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await callQwen(messages);

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`AI返回中未找到JSON: ${response.slice(0, 100)}`);
      }

      const result = JSON.parse(jsonMatch[0]);
      const tags = normalizeTags(result.tags);
      // 内容分类：合法则覆盖信源继承分类；非法/缺失则保留原分类并告警
      let category = article.category;
      if (VALID_CATEGORIES.includes(result.category)) {
        category = result.category;
      } else {
        console.warn(`  分类判定异常(${result.category})，保留信源默认分类: ${article.title.slice(0, 40)}`);
      }

      // 事实断言回指校验（verifyQuote 的推广，见 material.mjs）：
      // key_points / takeaway 里的硬事实（数字、英文专有名词、引号内实体）必须能在素材正文里
      // 逐字找到，找不到的整条丢弃；全丢说明模型写的内容和正文根本对不上 → 隔离。
      // 关键：这一步与 hasFullText 无关。旧代码只在 hasFullText=true 时校验 quote，
      // 摘要正文里的编造内容一个字都没查过——2228 编的恰恰全在这些字段里。
      const normalizedPoints = normalizeKeyPoints(result.key_points);
      const normalizedTakeaway = typeof result.takeaway === 'string' ? result.takeaway.trim().slice(0, 60) : '';
      const grounding = groundedAssertions({
        keyPoints: normalizedPoints,
        takeaway: normalizedTakeaway,
        body: groundingCorpus,
      });
      if (!grounding.ok) {
        console.warn(`  [QUARANTINE] 摘要硬事实无一处可回指正文，隔离不入库: ${String(article.title || '').slice(0, 45)}`);
        for (const d of grounding.dropped.slice(0, 4)) {
          console.warn(`      · [${d.field}] ${d.value} ← 正文查无 ${d.missing.join(' / ')}`);
        }
        return markQuarantine(
          {
            ...article,
            summary: result.summary || '',
            takeaway: normalizedTakeaway,
            key_points: JSON.stringify(normalizedPoints),
            quote: '',
            category,
            tags: JSON.stringify(applyTagInvariants(category, tags)),
          },
          QUARANTINE_REASONS.UNGROUNDED_SUMMARY,
          grounding.dropped.slice(0, 8).map(d => `[${d.field}] ${d.value} ← 正文查无 ${d.missing.join(' / ')}`).join(' ; '),
        );
      }
      if (grounding.dropped.length) {
        console.warn(`  [GROUND] 丢弃回指不上正文的断言 ${grounding.dropped.length} 条: ${String(article.title || '').slice(0, 40)}`);
        for (const d of grounding.dropped) {
          console.warn(`      · [${d.field}] ${d.value} ← 正文查无 ${d.missing.join(' / ')}`);
        }
      }

      return {
        ...article,
        original_title: isEnglish ? article.title : null,
        title: result.title || article.title,
        summary: result.summary || content.slice(0, 500),
        category,
        tags: JSON.stringify(applyTagInvariants(category, tags)),
        // 结构化字段：一句话要点/核心要点（均已通过与正文的硬事实回指校验）/原文金句（逐字比对）
        takeaway: grounding.takeaway,
        key_points: JSON.stringify(grounding.key_points),
        quote: verifyQuote(result.quote || '', hasFullText ? article.content : ''),
      };

    } catch (err) {
      lastErr = err;
      const reason = err.name === 'TimeoutError' ? '超时（60秒）' : err.message;
      if (attempt < 2) {
        console.error(`总结生成第${attempt}次失败，重试: ${article.title} (${reason})`);
      }
    }
  }

  // 降级：**不伪造半成品**。加工失败的条目打 _proc_failed 标记，交由 collect.mjs 隔离，
  // 绝不以"原文标题直出 + 空 takeaway + 原文截断摘要"的形式混进主列表。
  const reason = lastErr.name === 'TimeoutError' ? '超时（60秒）' : lastErr.message;
  console.error(`总结生成失败(重试后仍失败): ${article.title}`, reason);
  return {
    ...article,
    // 保留原标题与原素材，字段留空——隔离表按原始素材留存，重跑时再生成
    takeaway: '',
    key_points: '[]',
    tags: '[]',
    quote: '',
    summary: '',
    _proc_failed: true,
    _proc_reason: reason,
  };
}

/**
 * 仅从已有标题+内容提取tags（用于历史数据回填，不改动summary）
 * @param {Object} params - {title, content, source_name}
 * @returns {Object|null} - {companies:[], people:[], keywords:[]} 或 null（失败）
 */
export async function extractTags({ title, content, source_name = '' }) {
  if (!DASHSCOPE_API_KEY) {
    console.error('extractTags: DASHSCOPE_API_KEY 未设置');
    return null;
  }

  const prompt = `请从以下AI资讯中提取标签。

来源：${source_name}
标题：${title}
内容：${(content || '').slice(0, 2000)}

请严格按以下JSON格式返回（不要输出其他内容）：
{${TAGS_SPEC}}`;

  const messages = [
    { role: 'system', content: '你是AI行业资讯标签提取器，只输出JSON格式。' },
    { role: 'user', content: prompt },
  ];

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await callQwen(messages, 0.3);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`AI返回中未找到JSON: ${response.slice(0, 100)}`);
      }
      const result = JSON.parse(jsonMatch[0]);
      return normalizeTags(result.tags !== undefined ? result.tags : result);
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        const reason = err.name === 'TimeoutError' ? '超时（30秒）' : err.message;
        console.error(`  标签提取第${attempt}次失败，重试 (${reason})`);
      }
    }
  }
  console.error(`  标签提取失败: ${title.slice(0, 40)}`, lastErr.message);
  return null;
}

/**
 * 批量生成总结（带并发控制）
 * @param {Array} articles - 筛选后的文章列表
 * @param {number} concurrency - 并发数（默认3，避免API限流）
 */
export async function generateSummaries(articles, concurrency = 3) {
  const results = [];
  
  for (let i = 0; i < articles.length; i += concurrency) {
    const batch = articles.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(article => generateSummary(article))
    );
    results.push(...batchResults);
    
    // 批次间等待1秒，避免限流
    if (i + concurrency < articles.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log(`总结进度: ${Math.min(i + concurrency, articles.length)}/${articles.length}`);
  }

  return results;
}
