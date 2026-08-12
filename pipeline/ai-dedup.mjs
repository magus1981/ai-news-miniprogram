/**
 * AI跨期事件去重（内容级比对）
 *
 * 背景：批内事件聚类只处理同一轮采集的文章；跨天/跨批次的同一事件二次报道
 * （不同来源、不同标题表述）会漏网——2026-08-11 实测案例：
 * 8/11 量子位「黄仁勋宣布与华尔街合作，计划撬动5000亿美元」（id 739）
 * 8/12 NVIDIA官网「英伟达与多家金融机构合作，推动AI基础设施建设」（id 749）
 * 是同一事件，因来源/标题/事件名完全不同，四层旧去重全漏，两天各占一条头条。
 *
 * 方案：候选文章写库前，与近10天已入库文章做 AI 内容级比对（比"标题相似度"
 * 和"公司指纹规则"都可靠——同主体不同事件不会被误并）：
 *   - same_event：同一事件且无实质性新信息（纯换来源复述）→ 剔除不入库
 *   - followup：同一事件但有实质性新信息（官方确认/新增机构/新数字/新进展）→
 *     保留但降级：is_followup=1、强制不精选、分数压到原文章之下、记 related_to
 *   - new：与近期文章均非同事件 → 正常入库
 *
 * 判定完全交给AI语义判断（用户明确否决规则兜底：会错杀"同公司不同事件"）。
 * 失败降级：AI调用失败/返回异常时全部放行（安全网不是闸门，不阻塞管线）。
 */
import { pathToFileURL } from 'url';

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
// 去重判定与评分同级的强事实性任务，默认旗舰模型；可用 DEDUP_MODEL 覆盖
const DEDUP_MODEL = process.env.DEDUP_MODEL || 'qwen-max';

const BATCH_SIZE = 15; // 每批候选数（控制上下文长度）
const RECENT_LIMIT = 100; // 近期对照最多取100条（10天窗口内最近、分最高的）

async function callQwen(messages) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEDUP_MODEL,
      messages,
      temperature: 0.2, // 判定要保守稳定，低温度
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`DashScope API错误 ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

function buildPrompt(candidates, recentEvents) {
  const recentLines = recentEvents.map(r => {
    const ev = (r.event_norm || '').trim();
    const head = (r.summary || '').replace(/\s+/g, ' ').slice(0, 80);
    return `[${r.id}] ${(r.date_key || '').slice(5)} | 事件:${ev || '（无）'} | 标题:${r.title} | ${head}`;
  }).join('\n');

  const candLines = candidates.map((c, i) => {
    const ev = (c.event_norm || '').trim();
    const head = (c.summary || c.takeaway || '').replace(/\s+/g, ' ').slice(0, 120);
    return `[${i + 1}] 事件:${ev || '（无）'} | 标题:${c.title} | ${head}`;
  }).join('\n');

  return `你是AI资讯编辑。请逐篇判断【候选文章】是否与【近期已发布文章】构成同一事件。

【近期已发布文章】（近10天已入库，格式 [id] 日期 | 事件名 | 标题 | 摘要开头）：
${recentLines}

【候选文章】（待判定）：
${candLines}

判定标准：
- same_event：与某篇近期文章是"同一主体的同一件事"，即使来源不同、标题/表述完全不同、详略有别，且候选文章没有带来实质性新信息（只是换来源复述、换角度重讲同一件事）→ same_event
- followup：与某篇近期文章是同一事件，但候选文章带来实质性新信息（官方正式确认、新增机构/人名/数字/细节、事件有新进展）→ followup
- new：与近期所有文章都不是同一事件 → new

关键约束：
- 同一主体的不同事件必须判new，严禁因主体/公司相同就判同事件（如"英伟达发布新GPU"与"英伟达投资电厂"是两件事；"公司发布A模型"与"公司发布B模型"是两件事）
- 官方一手稿vs媒体转载：即使内容高度重合，官方博客/官方公告作为一手来源若补充了媒体稿没有的细节（机构名单、金额口径、时间表），属于followup而非same_event
- 拿不准时倾向new（宁可放过，不可误杀——误杀会漏掉真实新进展，误放只是多一条，还有配额外的展示控制）
- same_event/followup 必须给出 related_id（近期文章的id）；new 的 related_id 填 null

请严格按以下JSON格式返回，不要输出其他内容：
{"verdicts": [{"index": 1, "verdict": "new|same_event|followup", "related_id": 12 或 null, "reason": "一句话判断依据"}]}

请为每一篇候选文章都返回判定（不要省略任何index）。`;
}

/**
 * 对候选文章做跨期事件去重
 * @param {Array} candidates - 已通过筛选/摘要/二审的文章数组（将被原地部分修改）
 * @param {Array} recentEvents - getRecentEvents 返回的近10天已入库文章
 * @returns {{kept: Array, dropped: Array}} kept为保留文章（followup已降级），dropped为剔除的同事件复述
 */
export async function dedupAgainstRecent(candidates, recentEvents) {
  if (!DASHSCOPE_API_KEY || !candidates.length) return { kept: candidates, dropped: [] };
  const recent = (recentEvents || []).slice(0, RECENT_LIMIT);
  if (!recent.length) return { kept: candidates, dropped: [] };

  const refById = new Map(recent.map(r => [r.id, r]));
  const kept = [];
  const dropped = [];

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const prompt = buildPrompt(batch, recent);
    let verdicts = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await callQwen([
          { role: 'system', content: '你是严谨的AI资讯编辑，只输出JSON。铁律：宁可放过，不可误杀——同主体不同事件必须判new。' },
          { role: 'user', content: prompt },
        ]);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error(`返回格式异常: ${response.slice(0, 100)}`);
        const parsed = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(parsed.verdicts)) throw new Error('verdicts字段缺失');
        verdicts = parsed.verdicts;
        break;
      } catch (err) {
        const reason = err.name === 'TimeoutError' ? '超时（60秒）' : err.message;
        if (attempt < 2) {
          console.warn(`  跨期去重第${attempt}次失败，重试: ${reason}`);
        } else {
          console.error(`  跨期去重失败，本批${batch.length}条全部放行: ${reason}`);
          batch.forEach(c => kept.push(c));
        }
      }
    }
    if (!verdicts) continue; // 已在上方放行

    const byIndex = new Map(verdicts.map(v => [v.index, v]));
    batch.forEach((c, idx) => {
      const v = byIndex.get(idx + 1);
      // 未返回判定/格式异常：按 new 放行（fail-open）
      if (!v || v.verdict === 'new') { kept.push(c); return; }

      if (v.verdict === 'same_event') {
        dropped.push({ ...c, __related_id: v.related_id, __reason: v.reason || '' });
        return;
      }

      // followup：降级保留
      const ref = refById.get(v.related_id);
      if (ref && typeof ref.ai_score === 'number' && typeof c.ai_score === 'number') {
        // 压到原文章之下至少15分：绝不可能反过来压过原稿进精选
        c.ai_score = Math.min(c.ai_score, ref.ai_score - 15);
      }
      c.is_followup = 1;
      c.is_featured = 0; // 跟进稿强制不精选
      c.related_to = ref
        ? JSON.stringify({ id: ref.id, title: ref.title, date_key: ref.date_key })
        : '';
      c.__related_id = v.related_id;
      c.__reason = v.reason || '';
      kept.push(c);
    });
  }

  return { kept, dropped };
}

// 独立运行调试：node ai-dedup.mjs <候选JSON文件> <近期JSON文件>
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [candFile, recentFile] = process.argv.slice(2);
  if (!candFile || !recentFile) {
    console.log('用法: node ai-dedup.mjs <候选JSON> <近期JSON>');
    process.exit(1);
  }
  const { readFileSync } = await import('fs');
  const candidates = JSON.parse(readFileSync(candFile, 'utf8'));
  const recentEvents = JSON.parse(readFileSync(recentFile, 'utf8'));
  const { kept, dropped } = await dedupAgainstRecent(candidates, recentEvents);
  console.log(`\n结果: 保留 ${kept.length} 条, 剔除 ${dropped.length} 条`);
  for (const d of dropped) console.log(`  [DROP] ${d.title}（关联 #${d.__related_id}）: ${d.__reason}`);
  for (const k of kept) {
    if (k.is_followup) console.log(`  [FOLLOWUP] ${k.title} | 新分 ${k.ai_score} | related_to ${k.related_to} | ${k.__reason}`);
  }
}
