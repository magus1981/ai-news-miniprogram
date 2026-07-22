/**
 * AI筛选评分 - 调用通义千问(DashScope)对文章进行重要性评分
 * 标准：权威性、准确性、及时性
 */

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

if (!DASHSCOPE_API_KEY) {
  console.warn('警告: DASHSCOPE_API_KEY 未设置，AI筛选将使用降级策略（按来源权重排序）');
}

/**
 * 调用通义千问API
 */
async function callQwen(messages, temperature = 0.3) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'qwen-plus',
      messages,
      temperature,
    }),
    signal: AbortSignal.timeout(30000), // 30秒超时，防止API挂起拖垮管线
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DashScope API错误 ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

/**
 * 对一批文章进行AI评分筛选
 * @param {Array} articles - 采集到的原始文章列表
 * @returns {Array} - 带评分的文章，按分数降序，取Top 10-20
 */
export async function filterArticles(articles) {
  if (articles.length === 0) return [];

  // 无API Key时直接使用降级策略
  if (!DASHSCOPE_API_KEY) {
    return fallbackFilter(articles);
  }

  // 构建文章摘要列表供AI评估
  const articleList = articles.map((a, i) => 
    `[${i + 1}] 来源:${a.source_name} | 标题:${a.title} | 摘要:${(a.content_snippet || '').slice(0, 150)}`
  ).join('\n');

  const prompt = `你是一位资深AI行业分析师。请对以下今日采集的AI资讯进行重要性评分。

评分标准（满分100）：
- 权威性(40分)：来源是否权威（官方博客>顶级媒体>普通媒体），内容是否为一手信息
- 准确性(30分)：是否有具体数据/事实支撑，而非泛泛而谈或标题党
- 及时性(30分)：是否是当天/近期重大事件，而非旧闻翻炒或日常琐碎

请严格按以下JSON格式返回，不要添加其他内容：
{"scores": [{"index": 1, "score": 85}, {"index": 2, "score": 72}, ...]}

只返回评分>=60的文章。如果所有文章都低于60分，返回空数组。

今日采集的文章（共${articles.length}条）：
${articleList}`;

  try {
    const response = await callQwen([
      { role: 'system', content: '你是AI行业资讯评估专家，只输出JSON格式结果。' },
      { role: 'user', content: prompt },
    ]);

    // 解析JSON响应
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('AI筛选返回格式异常:', response.slice(0, 200));
      return fallbackFilter(articles);
    }

    const result = JSON.parse(jsonMatch[0]);
    const scoredArticles = result.scores
      .map(s => ({
        ...articles[s.index - 1],
        ai_score: s.score,
      }))
      .filter(a => a.ai_score) // 移除无效索引
      .sort((a, b) => b.ai_score - a.ai_score);

    // 取Top 10-20条
    const selected = scoredArticles.slice(0, 20);
    
    // 标记Top 3-5为今日必读
    const featuredCount = Math.min(5, Math.max(3, Math.floor(selected.length * 0.25)));
    selected.forEach((a, i) => {
      a.is_featured = i < featuredCount;
    });

    console.log(`AI筛选完成: ${articles.length}条 -> ${selected.length}条入选, ${featuredCount}条精选`);
    return selected;

  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.error('AI筛选超时（30秒），使用降级策略');
    } else {
      console.error('AI筛选失败，使用降级策略:', err.message);
    }
    return fallbackFilter(articles);
  }
}

/**
 * 降级筛选策略：AI不可用时按来源权重+时间排序
 */
function fallbackFilter(articles) {
  const sourceWeights = {
    'official': 90,
    'media': 70,
  };

  const scored = articles.map(a => ({
    ...a,
    ai_score: sourceWeights[a.source_type] || 60,
    is_featured: false,
  })).sort((a, b) => b.ai_score - a.ai_score);

  const selected = scored.slice(0, 15);
  selected.slice(0, 3).forEach(a => { a.is_featured = true; });

  console.log(`降级筛选: 选取 ${selected.length} 条`);
  return selected;
}
