/**
 * 量子位网页爬虫
 * 量子位RSS源(https://www.qbitai.com/feed)实测不可用，改为抓取列表页HTML
 * 抓取URL/选择器/相对时间解析逻辑沿用一代项目(ai-tracker-server)已验证的实现
 * 实测无反爬，fetch + cheerio 即可
 */
import * as cheerio from 'cheerio';

const QBITAI_URL = 'https://www.qbitai.com/category/资讯';
const ARTICLE_URL_PATTERN = /qbitai\.com\/\d{4}\/\d{2}\/.+\.html$/;

/**
 * 解析相对时间（如"4小时前"）为ISO日期字符串
 */
function parseRelativeTime(text) {
  const now = Date.now();
  const cleaned = text.trim();

  const minMatch = cleaned.match(/(\d+)\s*分钟前/);
  if (minMatch) return new Date(now - parseInt(minMatch[1]) * 60 * 1000).toISOString();

  const hourMatch = cleaned.match(/(\d+)\s*小时前/);
  if (hourMatch) return new Date(now - parseInt(hourMatch[1]) * 3600 * 1000).toISOString();

  const dayMatch = cleaned.match(/(\d+)\s*天前/);
  if (dayMatch) return new Date(now - parseInt(dayMatch[1]) * 86400 * 1000).toISOString();

  const dateMatch = cleaned.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (dateMatch) return new Date(`${dateMatch[1]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[3].padStart(2,'0')}`).toISOString();

  return null;
}

/**
 * 采集量子位资讯
 * @param {Object} source - sources.mjs 中的源配置（取 category/language/source_type）
 * @returns {Array} - 与RSS源相同形状的文章数组
 *   {title, source_name, source_url, category, language, source_type, content_snippet, published_at}
 *   published_at 可能为 null（列表页时间解析失败时），由 collect.mjs 的时效过滤统一处理
 */
export async function scrapeQbitai(source) {
  try {
    const resp = await fetch(QBITAI_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      console.error(`  [FAIL] 量子位爬虫: HTTP ${resp.status}`);
      return [];
    }

    const html = await resp.text();
    const $ = cheerio.load(html);
    const articles = [];
    const seenUrls = new Set();

    // 找所有文章链接
    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).text().trim();

      if (!ARTICLE_URL_PATTERN.test(href) || title.length < 5) return;
      if (seenUrls.has(href)) return;
      seenUrls.add(href);

      // 尝试从父元素中获取摘要和时间
      const parent = $(el).closest('.excerpt, .post-item, .article-item, .item, li, div').first();

      // 摘要：找父元素中的摘要文本
      let summary = '';
      const summaryEl = parent.find('.excerpt, .summary, .desc, .description, p').first();
      if (summaryEl.length) {
        summary = summaryEl.text().trim();
      }
      // 如果摘要太短，用标题
      if (summary.length < 20) summary = title;

      // 时间
      let publishedAt = null;
      const timeEl = parent.find('.time, .date, time').first();
      if (timeEl.length) {
        publishedAt = parseRelativeTime(timeEl.text());
      }

      articles.push({
        title,
        source_name: source.name,
        source_url: href,
        category: source.category,
        language: source.language,
        source_type: source.source_type,
        content_snippet: summary.slice(0, 2000),
        published_at: publishedAt, // ISO串或null
      });
    });

    return articles;

  } catch (error) {
    // 抓取失败降级：返回空数组，不拖垮整个采集流程
    console.error(`  [FAIL] 量子位爬虫: ${error.message}`);
    return [];
  }
}
