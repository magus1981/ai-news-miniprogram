/**
 * AI时效校验（旧闻拦截）——摘要生成后的最后一道时效防线
 *
 * 背景（2026-08-12 事故）：评分筛选阶段只能看到"标题+片段"（爬虫源片段就是标题），
 * 时间线索（"从8月2日起""近日发布了"）在全文里，而全文要等入选后才抓取——
 * 新智元把7/31发布的Seedance 2.5和8/2启动的Anthropic水印当新稿收进当日版。
 *
 * 本模块在摘要生成后运行（此时全文已在手、摘要也带时间信息），
 * 用AI提取每篇的"核心新闻事件"（新闻由头）发生日期：
 *   - 由头明确早于今天3天以上 → 旧闻，剔除不入库（不占用当日10-20条配额）
 *   - 由头在3天内或无法确定 → 放行（拿不准不误杀）
 *
 * 区分"新闻由头"与"背景引用"：文中更早的日期若是背景/历史/旧数据引用，
 * 而非本次报道的核心事件，不算由头（如"欧盟2024年通过AI法案"是背景）。
 * 失败降级：AI调用失败/返回异常时全部放行（安全网不是闸门，不阻塞管线）。
 */
import { pathToFileURL } from 'url';

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
// 时效校验为强事实性任务，默认旗舰模型；可用 FRESHNESS_MODEL 覆盖
const FRESHNESS_MODEL = process.env.FRESHNESS_MODEL || 'qwen-max';

const BATCH_SIZE = 15;
// 由头早于今天多少天算旧闻（与媒体源72h采集窗口对齐：3天）
const OLD_DAYS = 3;

async function callQwen(messages) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify({
      model: FRESHNESS_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`DashScope API错误 ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

function buildPrompt(articles, recentTitles) {
  const list = articles.map((a, i) => {
    const contentHead = (a.content || a.content_snippet || '').replace(/\s+/g, ' ').slice(0, 400);
    return `[${i + 1}] 标题:${a.title}\n摘要:${(a.summary || '').slice(0, 200)}\n内容开头:${contentHead}`;
  }).join('\n\n');

  const recentBlock = (recentTitles || []).length
    ? `\n【近期已推送标题】（近10天已入库，供"模糊时间"场景旁证）：\n${recentTitles.slice(0, 80).map(t => `- ${t}`).join('\n')}\n`
    : '';

  return `你是AI资讯时效审查员。请判断每篇文章的"核心新闻事件"（新闻由头）发生的时间，判定它是不是旧闻。

判定方法：
- 新闻由头 = 这篇文章要报道的核心事件本身发生的时间（发布/融资/政策/事故等动作的发生日）
- 区分背景引用：文中更早的日期如果是背景铺垫、历史回顾、引用旧数据，不是本次报道的由头（例："欧盟2024年通过AI法案，8月10日开出首张罚单"，由头是8月10日不是2024年）
- 优先采信内容中的具体日期（"从X月X日起""X月X日宣布""X月X日发布""自X日起"）；全文/摘要都只有"近日/日前/近期/最近/上周"等模糊词时：
  - 若该文的事件主体（产品/公司/事件名）出现在【近期已推送标题】中 → 判 old（跟进/重复报道，说明事件早已发生并推送过）
  - 否则判 unknown（无法确定，放行）
- 例：标题"Anthropic为Claude添加隐形水印"、文中"从8月2日起…"→由头是8月2日（旧闻）
- 例：标题"字节Seedance 2.5发布"、文中"近日发布了…"且近期标题无此产品→判unknown（放行）

【待审查文章】：
${list}

对每篇输出：
- event_date：由头日期，格式YYYY-MM-DD；无法确定给 null
- verdict："old"（由头明确早于${OLD_DAYS}天前，或模糊时间但事件主体已在近期推送标题中）| "fresh"（由头在${OLD_DAYS}天内或unknown）
- reason：一句话判断依据

今天日期：${new Date().toISOString().slice(0, 10)}
${recentBlock}
请严格按以下JSON格式返回，不要输出其他内容：
{"checks": [{"index": 1, "event_date": "2026-08-02", "verdict": "old", "reason": "..."}]}

请为每一篇都返回判定（不要省略任何index）。`;
}

/**
 * 时效校验：剔除由头明确早于3天前的旧闻
 * @param {Array} articles - 已生成摘要/二审后的文章列表
 * @param {Array<string>} [recentTitles] - 近10天已入库标题（模糊时间场景旁证）
 * @returns {{kept: Array, dropped: Array}}
 */
export async function checkFreshness(articles, recentTitles = []) {
  if (!DASHSCOPE_API_KEY || !articles.length) return { kept: articles, dropped: [] };

  const kept = [];
  const dropped = [];

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    const prompt = buildPrompt(batch, recentTitles);
    let checks = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await callQwen([
          { role: 'system', content: '你是严谨的AI资讯时效审查员，只输出JSON。铁律：拿不准的一律判fresh，宁可放过不可误杀。' },
          { role: 'user', content: prompt },
        ]);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error(`返回格式异常: ${response.slice(0, 100)}`);
        const parsed = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(parsed.checks)) throw new Error('checks字段缺失');
        checks = parsed.checks;
        break;
      } catch (err) {
        const reason = err.name === 'TimeoutError' ? '超时（60秒）' : err.message;
        if (attempt < 2) {
          console.warn(`  时效校验第${attempt}次失败，重试: ${reason}`);
        } else {
          console.error(`  时效校验失败，本批${batch.length}条全部放行: ${reason}`);
          batch.forEach(a => kept.push(a));
        }
      }
    }
    if (!checks) continue;

    const byIndex = new Map(checks.map(c => [Number(c.index), c]));
    batch.forEach((a, idx) => {
      const c = byIndex.get(idx + 1);
      // 未返回/异常/verdict非old：放行（fail-open）
      if (!c || c.verdict !== 'old') { kept.push(a); return; }
      dropped.push({ ...a, __event_date: c.event_date || '', __reason: c.reason || '' });
    });
  }

  return { kept, dropped };
}

// 独立运行调试：node ai-freshness.mjs <文章JSON文件>
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const file = process.argv[2];
  if (!file) { console.log('用法: node ai-freshness.mjs <文章JSON文件>'); process.exit(1); }
  const { readFileSync } = await import('fs');
  const articles = JSON.parse(readFileSync(file, 'utf8'));
  const { kept, dropped } = await checkFreshness(articles);
  console.log(`\n结果: 保留 ${kept.length} 条, 剔除旧闻 ${dropped.length} 条`);
  for (const d of dropped) console.log(`  [OLD] ${d.title}（由头 ${d.__event_date || '?'}）: ${d.__reason}`);
}
