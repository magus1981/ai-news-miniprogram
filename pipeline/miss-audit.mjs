/**
 * 漏报对账（miss audit）
 *
 * 背景（2026-08-15 事故）：苹果为中国训练专属模型、SpaceX收购Cursor两条80+分
 * 大新闻被管线杀掉，一整天无人知晓——系统只有"入选了什么"的记录，没有
 * "杀掉了什么"的对账。质量目标是"全面+高质量+时效"，漏报无法被看见就永远无法被改进。
 *
 * 方案：每轮入库完成后，拿"本轮采到但未入选的新鲜候选"与"当日已入选清单"
 * 让 qwen-plus 做一次主编级对账，把疑似重大漏报打印进运行日志
 * （GitHub Actions日志保留90天，供人工复查；只标记不自动入库，避免AI自说自话）。
 *
 * 护栏：
 *   - 只看近36小时发布的候选（旧候选是历史遗留，不属于"今天的漏报"）
 *   - 候选标题最多取40条（token护栏）
 *   - 任何失败静默降级（对账是锦上添花，绝不阻塞管线）
 */
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const AUDIT_MODEL = process.env.AUDIT_MODEL || 'qwen-plus';

const FRESH_MS = 36 * 3600 * 1000; // 近36小时
const MAX_POOL_TITLES = 40;

/**
 * 从候选池中挑出"未入选的新鲜候选"（纯函数，供测试）
 * @param {Array} pool - 本轮采到的全部候选（拼盘已拆条）
 * @param {Array} admitted - 本轮最终入库的文章
 * @param {number} now - 可注入时钟
 */
export function pickMissedCandidates(pool, admitted, now = Date.now()) {
  const admittedUrls = new Set((admitted || []).map(a => a.source_url));
  return (pool || [])
    .filter(a => a && a.source_url && !admittedUrls.has(a.source_url))
    .filter(a => {
      const ts = new Date(a.published_at || 0).getTime();
      return Number.isFinite(ts) && now - ts <= FRESH_MS;
    })
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    .slice(0, MAX_POOL_TITLES);
}

/**
 * 容错解析对账响应（纯函数，供测试）
 * @returns {Array|null} [{index, reason}]
 */
export function parseAuditResponse(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i === -1 || j <= i) return null;
  try {
    const obj = JSON.parse(s.slice(i, j + 1));
    if (!obj || !Array.isArray(obj.misses)) return null;
    return obj.misses;
  } catch {
    return null;
  }
}

/**
 * 漏报对账主流程：打印疑似漏报到日志
 * @param {Object} args - {pool, admitted, dayArticles}
 *   pool: 本轮采到的全部候选；admitted: 本轮入库的；dayArticles: 当日已入库全部（含历史轮）
 * @returns {Promise<number>} 疑似漏报条数
 */
export async function auditMisses({ pool, admitted, dayArticles }) {
  if (!DASHSCOPE_API_KEY) return 0;
  const missed = pickMissedCandidates(pool, admitted);
  if (!missed.length) {
    console.log('漏报对账: 无未入选新鲜候选，跳过');
    return 0;
  }

  const admittedLines = (dayArticles || []).slice(0, 25)
    .map(a => `- ${a.title}`).join('\n') || '（今日暂无入选）';
  const poolLines = missed
    .map((a, i) => `[${i + 1}] [${a.source_name}] ${a.title}`).join('\n');

  const prompt = `你是AI资讯日报的主编。下面是【今日已入选】清单和【采到但未入选】的候选标题。
请检查是否有"疑似重大漏报"——仅限：重大新模型/新产品发布、大额融资或并购、重要政策法规、科技巨头重大战略动作、重量级人物变动。
要求：
- 只看标题能明确判断为重大的才列出；拿不准的一律不列（宁缺毋滥）
- 与已入选清单属于同一事件的不要列（那是正常去重）
- 没有疑似漏报就返回空数组，这是大多数情况

【今日已入选】
${admittedLines}

【采到但未入选】
${poolLines}

严格按JSON返回：
{"misses": [{"index": 候选序号, "reason": "一句话理由"}]}`;

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
      },
      body: JSON.stringify({
        model: AUDIT_MODEL,
        messages: [
          { role: 'system', content: '你是严谨的AI资讯主编，只输出JSON。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const misses = parseAuditResponse(data.choices?.[0]?.message?.content);
    if (!misses || !misses.length) {
      console.log(`漏报对账: 检查 ${missed.length} 条未入选候选，未发现疑似重大漏报`);
      return 0;
    }
    console.log(`!!! 漏报对账: 疑似 ${misses.length} 条重大漏报（请人工复查）!!!`);
    let n = 0;
    for (const m of misses) {
      const c = missed[(m.index || 0) - 1];
      if (!c) continue;
      n++;
      console.log(`  [MISS?] [${c.source_name}] ${c.title} | ${c.source_url} | 理由: ${m.reason || '?'}`);
    }
    return n;
  } catch (e) {
    console.warn(`漏报对账失败(不阻塞): ${e.message}`);
    return 0;
  }
}
