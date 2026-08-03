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

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
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
 * 审校单篇文章的摘要，返回（可能被修正过的）文章对象
 * @param {Object} article - 已生成摘要的文章（含 content/content_snippet/related_titles）
 */
export async function reviewSummary(article) {
  if (!DASHSCOPE_API_KEY || !article.summary) return article;

  const hasFullText = (article.content || '').length >= 200;
  const material = hasFullText ? article.content : (article.content_snippet || article.title);
  const relatedBlock = (article.related_titles || []).length
    ? `\n同一事件其他媒体报道标题（可作为公司归属等事实的旁证）：\n${article.related_titles.map(t => `- ${t}`).join('\n')}\n`
    : '';
  // 同来源多稿合并的素材也是正式素材：摘要被要求整合这些稿件的硬事实，
  // 若二审只看保留篇原文，会把这些事实当成"凭空编造"打回（互相矛盾的两道制度）
  const mergedBlock = (article.related_snippets || []).length
    ? `\n【同来源合并素材】本条新闻合并了 ${article.source_name} 同期关于此事的其余稿件，以下内容与上方原文同等有效，摘要引用它们的事实不算编造：\n${article.related_snippets.map(s => `- ${s.title}：${s.snippet}`).join('\n')}\n`
    : '';

  const prompt = `你是事实核查员。请对照【原文素材】审校【待审摘要】，只核查事实错误，不评判文风与详略。

核查清单（仅限以下类型，逐项对照素材）：
1. 数字/金额/百分比与素材是否矛盾（如素材50亿写成80亿）
2. 公司归属与人物头衔是否张冠李戴；模型/产品名是否被误当成公司名
3. 缩写展开是否错误：摘要把缩写展开成全称时，若展开与素材或你确知的事实不符（如把SSI展开成另一家机构的名字）才算错误；展开正确则不算，即使素材只写了缩写
4. 摘要中是否存在素材（含旁证标题）和公认事实都无法支撑的具体新事实（编造的数据、不存在的机构/产品）
5. 语义是否与素材相反（如"驳回"写成"批准"、"否认"写成"承认"）

判定规则（核心：宁可漏检，绝不误伤）：
- 只有"会误导读者对事实认知"的实质性错误才算fail：数字错、张冠李戴、语义反转、凭空编造
- 以下一律不算错误：日期精度问题（如只写"7月中旬"未写年份）、详略取舍、措辞风格、数字的合理换算（如28.9M写成2890万）、补充业界公认的真实背景（如某人的公开履历、公司的正确全称）
- 素材是${hasFullText ? '原文全文，可逐项核对，但仍只标记实质性错误' : '内容片段（非全文）：只标记与片段明确矛盾的事实，片段没提到的内容不等于编造，不要因为片段短就否定摘要'}
- 拿不准的一律判pass；只要没有确凿的实质性错误，就必须返回pass
- 确有实质性错误时才返回fail，并给出修正后的完整摘要：只改错误处及其牵连语句（修正时优先采用素材中的正确数值，如素材说50亿就写回50亿，不要删掉数值），其余逐字原样保留；若tags里的公司/人物也错了，一并修正

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
        return {
          ...article,
          title: result.fixed.title || article.title,
          summary: result.fixed.summary,
          tags: result.fixed.tags ? JSON.stringify(normalizeTags(result.fixed.tags)) : article.tags,
          // 结构化字段同步修正（审稿未返回则保留原值）
          takeaway: typeof result.fixed.takeaway === 'string' && result.fixed.takeaway.trim()
            ? result.fixed.takeaway.trim().slice(0, 60) : article.takeaway,
          key_points: Array.isArray(result.fixed.key_points)
            ? JSON.stringify(normalizeKeyPoints(result.fixed.key_points)) : article.key_points,
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
