/**
 * AI二审（事实核对）- 摘要生成后的最后一道防线
 * 制度性保障：一审（qwen-max生成摘要）可能出现"看素材脑补"型幻觉（如SSI被展开成错误全称），
 * 二审用独立的审稿视角把摘要与原文素材逐项对照，只核事实不改文风：
 * - 数字/金额/时间是否与素材一致
 * - 公司归属/人物头衔是否有素材依据（模型名不得当公司名）
 * - 缩写展开是否为素材明确给出（否则必须保持缩写）
 * - 摘要中是否存在素材完全没有的"新事实"（编造）
 * 发现问题时由审稿模型直接给出修正稿，代码侧替换；二审自身失败则放行原稿（安全网不是闸门）
 */
import { normalizeTags, normalizeKeyPoints } from './ai-summary.mjs';
import { pickMaterial, groundedAssertions, markQuarantine, isQuarantined, QUARANTINE_REASONS, MIN_MATERIAL_CHARS } from './material.mjs';

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
// 与 ai-summary 同一约定：DASHSCOPE_API_URL 仅供回归测试桩服务使用，线上不设该变量
const API_URL = process.env.DASHSCOPE_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
// 二审与摘要同为强事实性任务（每天仅20篇），默认旗舰模型；可用 REVIEW_MODEL 覆盖
const REVIEW_MODEL = process.env.REVIEW_MODEL || 'qwen-max';

async function callReviewer(messages) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify({
      model: REVIEW_MODEL,
      messages,
      temperature: 0.2, // 审稿要保守，低温度减少"审出"不存在的问题
      max_tokens: 1500,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DashScope API错误 ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

/**
 * 安全解析库里存的 JSON 数组字段（key_points 是 JSON 字符串）。
 * 解析失败返回 []——回指校验宁可把要点当空处理，也不能因脏数据抛异常打断整轮采集。
 */
function safeParseArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 审校单篇文章的摘要，返回（可能被修正过的）文章对象
 * @param {Object} article - 已生成摘要的文章（含 content/content_snippet/related_titles）
 */
export async function reviewSummary(article) {
  // 素材闸门放在 API Key 判断之前：有没有料是稿件本身的属性，与当轮是否配置了模型无关。
  // 放在后面会让"无 Key 降级跑"的那一轮漏掉隔离标记，稿件直接写进 articles。
  if (isQuarantined(article)) return article; // 已被摘要环节判死的稿不再送审：它没有素材可审

  // 与 ai-summary 共用同一个取料函数（2026-10-08 事故复盘：二审原先用 `(content_snippet || title)`
  // 这同一个 fallback，等于审稿人和写稿人看着同一份"标题当正文"的假素材——二审自然挑不出毛病，
  // 安全网和被护的对象拿到了同样的错误输入，这道防线形同虚设）
  const mat = pickMaterial(article);
  if (!mat) {
    console.warn(`  [QUARANTINE] 二审无可用素材，隔离不入库: ${String(article.title || '').slice(0, 45)}`);
    return markQuarantine(
      article,
      QUARANTINE_REASONS.MISSING_BODY,
      `content=${(article.content || '').length}字, content_snippet=${(article.content_snippet || '').length}字（低于${MIN_MATERIAL_CHARS}字下限、或与标题等同、或为壳页）`,
    );
  }
  const hasFullText = mat.hasFullText;
  const material = mat.material;

  if (!DASHSCOPE_API_KEY || !article.summary) return article;
  const relatedBlock = (article.related_titles || []).length
    ? `\n同一事件其他媒体报道标题（可作为公司归属等事实的旁证）：\n${article.related_titles.map(t => `- ${t}`).join('\n')}\n`
    : '';
  // 同来源多稿合并的素材也是正式素材：摘要被要求整合这些稿件的硬事实，
  // 若二审只看保留篇原文，会把这些事实当成"凭空编造"打回（互相矛盾的两道制度）
  const mergedBlock = (article.related_snippets || []).length
    ? `\n【同来源合并素材】本条新闻合并了 ${article.source_name} 同期关于此事的其余稿件，以下内容与上方原文同等有效，摘要引用它们的事实不算编造：\n${article.related_snippets.map(s => `- ${s.title}：${s.snippet}`).join('\n')}\n`
    : '';

  // 回指比对范围 = 交给审稿模型的素材集合，一字不差地同一口径（见 ai-summary 同名变量注释）
  const groundingCorpus = [
    material,
    ...(article.related_snippets || []).map(s => `${s.title || ''} ${s.snippet || ''}`),
    ...(article.related_titles || []),
  ].join('\n');

  const prompt = `你是事实核查员。请对照【原文素材】审校【待审摘要】，只核查事实错误，不评判文风与详略。

核查清单（仅限以下类型，逐项对照素材）：
1. 数字/金额/百分比与素材是否矛盾（如素材50亿写成80亿）。金额必须做跨语言单位换算核对：素材中的英文金额（$500 billion / $50M / trillion等）先精确换算成中文再比对——1 million=100万、1 billion=10亿、1 trillion=1万亿、$500 billion=5000亿美元；摘要数字与素材差10倍/100倍（如素材$500 billion、摘要写500亿美元）属于确凿数字错误，必须判fail并改回正确换算值
2. 公司归属与人物头衔是否张冠李戴；模型/产品名是否被误当成公司名
3. 缩写展开是否错误：摘要把缩写展开成全称时，若展开与素材或你确知的事实不符（如把SSI展开成另一家机构的名字）才算错误；展开正确则不算，即使素材只写了缩写
4. 摘要中是否存在素材（含旁证标题）和公认事实都无法支撑的具体新事实（编造的数据、不存在的机构/产品）
5. 语义是否与素材相反（如"驳回"写成"批准"、"否认"写成"承认"）

判定规则（核心：宁可漏检，绝不误伤）：
- 只有"会误导读者对事实认知"的实质性错误才算fail：数字错、张冠李戴、语义反转、凭空编造
- 以下一律不算错误：日期精度问题（如只写"7月中旬"未写年份）、详略取舍、措辞风格、数字的正确换算（如$28.9M写成2890万美元）、补充业界公认的真实背景（如某人的公开履历、公司的正确全称）；但换算错位数的（如$500 billion写成500亿美元、$1 trillion写成10亿美元）是确凿错误，必须fail
- 素材是${hasFullText ? '原文全文，可逐项核对，但仍只标记实质性错误' : '内容片段（非全文）：只标记与片段明确矛盾的事实，片段没提到的内容不等于编造，不要因为片段短就否定摘要'}
- 拿不准的一律判pass；只要没有确凿的实质性错误，就必须返回pass
- 确有实质性错误时才返回fail，并给出修正后的完整摘要：只改错误处及其牵连语句（修正时优先采用素材中的正确数值并做精确换算：素材说$500 billion就写回5000亿美元、素材说50亿就写回50亿，不要删掉数值也不要换算错位数），其余逐字原样保留；若tags里的公司/人物也错了，一并修正

【原文素材】（${hasFullText ? '全文' : '片段'}）：
${material.slice(0, hasFullText ? 6000 : 2000)}
${mergedBlock}${relatedBlock}
【待审摘要】
标题：${article.title}
一句话要点：${article.takeaway || '（无）'}
核心要点：${article.key_points || '[]'}
摘要：${article.summary}
标签：${article.tags || '{}'}
（注：原文金句字段已由程序逐字比对原文，无需你核查）

请严格按以下JSON格式返回，不要输出其他内容：
通过时：{"verdict": "pass"}
不通过时：{"verdict": "fail", "issues": ["错误1的简述", ...], "fixed": {"title": "修正后标题（没改动就原样返回）", "takeaway": "修正后一句话要点（没改动就原样返回）", "key_points": ["修正后核心要点数组（没改动就原样返回）"], "summary": "修正后完整摘要", "tags": {"companies": [], "people": [], "keywords": [], "regions": []}}}`;

  const messages = [
    { role: 'system', content: '你是严谨的AI资讯事实核查员，只输出JSON格式。铁律：宁可漏检，绝不误伤——只有会误导读者的确凿事实错误才能判fail，风格、详略、精度、正确的背景知识一律放行。' },
    { role: 'user', content: prompt },
  ];

  // 失败重试1次，仍失败则放行原稿（二审是安全网，不能因自身故障阻塞管线）
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await callReviewer(messages);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error(`AI返回中未找到JSON: ${response.slice(0, 100)}`);
      const result = JSON.parse(jsonMatch[0]);

      if (result.verdict === 'pass') return article;

      if (result.verdict === 'fail' && result.fixed?.summary) {
        console.log(`  [二审打回] ${article.title.slice(0, 40)}`);
        for (const issue of result.issues || []) console.log(`    - ${issue}`);
        const fixedTakeaway = typeof result.fixed.takeaway === 'string' && result.fixed.takeaway.trim()
          ? result.fixed.takeaway.trim().slice(0, 60) : article.takeaway;
        const fixedPoints = Array.isArray(result.fixed.key_points)
          ? normalizeKeyPoints(result.fixed.key_points)
          : normalizeKeyPoints(safeParseArray(article.key_points));
        // 二审的修正稿同样要过回指闸门：审稿模型改错了也会"修出"正文里没有的数字/主体，
        // 修完不复检等于给幻觉开了一扇免检后门（2026-10-08 事故的教训就是没人回查正文）
        const grounding = groundedAssertions({
          keyPoints: fixedPoints,
          takeaway: fixedTakeaway,
          body: groundingCorpus,
        });
        if (!grounding.ok) {
          console.warn(`  [QUARANTINE] 二审修正稿硬事实全部回指不上正文，隔离不入库: ${String(article.title || '').slice(0, 45)}`);
          for (const d of grounding.dropped.slice(0, 4)) {
            console.warn(`      · [${d.field}] ${d.value} ← 正文查无 ${d.missing.join(' / ')}`);
          }
          return markQuarantine(
            {
              ...article,
              title: result.fixed.title || article.title,
              summary: result.fixed.summary,
              tags: result.fixed.tags ? JSON.stringify(normalizeTags(result.fixed.tags)) : article.tags,
              takeaway: fixedTakeaway,
              key_points: JSON.stringify(fixedPoints),
            },
            QUARANTINE_REASONS.UNGROUNDED_SUMMARY,
            `二审修正稿: ${grounding.dropped.slice(0, 8).map(d => `[${d.field}] ${d.value} ← 正文查无 ${d.missing.join(' / ')}`).join(' ; ')}`,
          );
        }
        if (grounding.dropped.length) {
          console.warn(`  [GROUND] 二审修正稿丢弃回指不上正文的断言 ${grounding.dropped.length} 条: ${String(article.title || '').slice(0, 40)}`);
          for (const d of grounding.dropped) {
            console.warn(`      · [${d.field}] ${d.value} ← 正文查无 ${d.missing.join(' / ')}`);
          }
        }
        return {
          ...article,
          title: result.fixed.title || article.title,
          summary: result.fixed.summary,
          tags: result.fixed.tags ? JSON.stringify(normalizeTags(result.fixed.tags)) : article.tags,
          // 结构化字段同步修正（审稿未返回则保留原值），且已通过回指校验
          takeaway: grounding.takeaway || fixedTakeaway,
          key_points: JSON.stringify(grounding.key_points),
        };
      }
      // verdict异常或fail却没给修正稿：视为审稿无效，放行原稿
      console.warn(`  [二审异常] verdict=${result.verdict}，放行原稿: ${article.title.slice(0, 40)}`);
      return article;

    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        const reason = err.name === 'TimeoutError' ? '超时（60秒）' : err.message;
        console.error(`  二审第${attempt}次失败，重试: ${article.title.slice(0, 40)} (${reason})`);
      }
    }
  }
  console.error(`  二审失败(重试后仍失败)，放行原稿: ${article.title.slice(0, 40)}`, lastErr.message);
  return article;
}

/**
 * 批量二审（带并发控制），返回审校后的文章列表并打印通过率
 * @param {Array} articles - 已生成摘要的文章列表
 * @param {number} concurrency - 并发数（默认3，与摘要环节一致避免限流）
 */
export async function reviewSummaries(articles, concurrency = 3) {
  const results = [];
  let fixedCount = 0;

  for (let i = 0; i < articles.length; i += concurrency) {
    const batch = articles.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(async a => {
      const reviewed = await reviewSummary(a);
      if (reviewed.summary !== a.summary || reviewed.tags !== a.tags || reviewed.title !== a.title) fixedCount++;
      return reviewed;
    }));
    results.push(...batchResults);

    if (i + concurrency < articles.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log(`二审进度: ${Math.min(i + concurrency, articles.length)}/${articles.length}`);
  }

  console.log(`二审完成: ${articles.length} 篇, 打回修正 ${fixedCount} 篇`);
  return results;
}
