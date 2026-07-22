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
 * 为单篇文章生成中文精华总结
 * @param {Object} article - 文章对象
 * @returns {Object} - 带中文标题和总结的文章
 */
export async function generateSummary(article) {
  const content = article.content_snippet || article.title;
  const isEnglish = article.language === 'en';

  // 无API Key时直接截取原文作为摘要
  if (!DASHSCOPE_API_KEY) {
    return {
      ...article,
      summary: content.slice(0, 500),
    };
  }

  const prompt = `请为以下AI资讯生成中文精华总结。

要求：
1. 总结长度500-800字
2. 结构清晰，包含：
   - 发生了什么（核心事件）
   - 为什么重要（行业影响）
   - 关键数据或引用（如有）
3. 语言精炼专业，避免废话
4. ${isEnglish ? '将英文标题翻译为简洁有力的中文标题' : '保持原标题或适当优化'}

来源：${article.source_name}
原标题：${article.title}
内容：${content.slice(0, 2000)}

请严格按以下JSON格式返回：
{"title": "中文标题", "summary": "500-800字精华总结"}`;

  try {
    const response = await callQwen([
      { role: 'system', content: '你是AI行业资深编辑，擅长将技术资讯提炼为简洁有力的中文总结。只输出JSON格式。' },
      { role: 'user', content: prompt },
    ]);

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(`总结生成格式异常: ${article.title}`);
      return {
        ...article,
        title: article.title,
        summary: content.slice(0, 500),
      };
    }

    const result = JSON.parse(jsonMatch[0]);
    return {
      ...article,
      original_title: isEnglish ? article.title : null,
      title: result.title || article.title,
      summary: result.summary || content.slice(0, 500),
    };

  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.error(`总结生成超时（30秒）: ${article.title}`);
    } else {
      console.error(`总结生成失败: ${article.title}`, err.message);
    }
    // 降级：直接使用原始内容截取
    return {
      ...article,
      summary: content.slice(0, 500),
    };
  }
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
