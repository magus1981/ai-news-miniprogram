/**
 * AI总结生成 - 调用通义千问为每篇文章生成500-800字中文精华总结
 */

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

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
      model: 'qwen-plus',
      messages,
      temperature,
      max_tokens: 1500,
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
 * 规范化AI返回的tags对象为 {companies:[], people:[], keywords:[]}，每类最多3个
 */
function normalizeTags(raw) {
  const clean = (arr) => Array.isArray(arr)
    ? [...new Set(arr.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()))].slice(0, 3)
    : [];
  return {
    companies: clean(raw?.companies),
    people: clean(raw?.people),
    keywords: clean(raw?.keywords),
  };
}

const TAGS_SPEC = `"tags": {"companies": ["公司名"], "people": ["人物名"], "keywords": ["关键词"]}（公司用通用英文名如OpenAI、Google DeepMind、阿里巴巴；人物用业界惯用名，惯用中文用中文如黄仁勋、惯用英文用英文如Sam Altman；每类最多3个，没有则空数组）`;

/**
 * 为单篇文章生成中文精华总结（同时提取tags子标签）
 * @param {Object} article - 文章对象
 * @returns {Object} - 带中文标题、总结和tags(JSON字符串)的文章
 */
export async function generateSummary(article) {
  const content = article.content_snippet || article.title;
  const isEnglish = article.language === 'en';

  // 无API Key时直接截取原文作为摘要
  if (!DASHSCOPE_API_KEY) {
    return {
      ...article,
      summary: content.slice(0, 500),
      tags: '[]',
    };
  }

  const prompt = `请为以下AI资讯生成中文精华总结并提取标签。

要求：
1. 总结长度500-800字
2. 结构清晰，包含：
   - 发生了什么（核心事件）
   - 为什么重要（行业影响）
   - 关键数据或引用（如有）
3. 语言精炼专业，避免废话
4. ${isEnglish ? '将英文标题翻译为简洁有力的中文标题' : '保持原标题或适当优化'}
5. 提取标签：文章涉及的主要公司、人物、关键词

来源：${article.source_name}
原标题：${article.title}
内容：${content.slice(0, 2000)}

请严格按以下JSON格式返回：
{"title": "中文标题", "summary": "500-800字精华总结", ${TAGS_SPEC}}`;

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
      return {
        ...article,
        original_title: isEnglish ? article.title : null,
        title: result.title || article.title,
        summary: result.summary || content.slice(0, 500),
        tags: JSON.stringify(tags),
      };

    } catch (err) {
      lastErr = err;
      const reason = err.name === 'TimeoutError' ? '超时（30秒）' : err.message;
      if (attempt < 2) {
        console.error(`总结生成第${attempt}次失败，重试: ${article.title} (${reason})`);
      }
    }
  }

  // 降级：直接使用原始内容截取
  const reason = lastErr.name === 'TimeoutError' ? '超时（30秒）' : lastErr.message;
  console.error(`总结生成失败(重试后仍失败): ${article.title}`, reason);
  return {
    ...article,
    summary: content.slice(0, 500),
    tags: '[]',
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
