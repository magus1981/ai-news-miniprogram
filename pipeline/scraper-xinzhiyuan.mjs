/**
 * 新智元网页爬虫
 * 官网 aiera.com.cn 为标准WordPress站，但RSS feed实测已坏（HTTP 500），改抓列表页HTML
 * 列表结构规整：article.entry-card > h2.entry-title a + time[datetime]（ISO时间戳）
 * 翻页 /page/N/ 可用，抓前2页共约20条，提高对采集中断的回补深度
 * 2026-07-31 实测无反爬，fetch + cheerio 即可
 */
import * as cheerio from 'cheerio';

const LIST_PAGES = ['https://aiera.com.cn/', 'https://aiera.com.cn/page/2/'];
// 文章URL形如 aiera.com.cn/2026/07/31/other/admin/106656/xxx/
const ARTICLE_URL_PATTERN = /aiera\.com\.cn\/\d{4}\/\d{2}\/\d{2}\//;

/**
 * 采集新智元资讯
 * @param {Object} source - sources.mjs 中的源配置（取 name/category/language/source_type）
 * @returns {Array} - 与RSS源相同形状的文章数组
 *   {title, source_name, source_url, category, language, source_type, content_snippet, published_at}
 */
export async function scrapeXinzhiyuan(source) {
  const articles = [];
  const seenUrls = new Set();

  for (const pageUrl of LIST_PAGES) {
    try {
      const resp = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        console.error(`  [FAIL] 新智元爬虫: ${pageUrl} HTTP ${resp.status}`);
        continue; // 单页失败不影响其他页
      }

      const $ = cheerio.load(await resp.text());

      $('article.entry-card').each((_, el) => {
        const card = $(el);
        const titleEl = card.find('h2.entry-title a, .entry-title a').first();
        const title = titleEl.text().trim();
        const href = titleEl.attr('href') || '';

        if (!ARTICLE_URL_PATTERN.test(href) || title.length < 5) return;
        if (seenUrls.has(href)) return;
        seenUrls.add(href);

        // 列表卡片无摘要文本，用标题占位；正文由 fetch-content 阶段抓详情页补全
        const publishedAt = card.find('time[datetime]').attr('datetime') || null;

        articles.push({
          title,
          source_name: source.name,
          source_url: href,
          category: source.category,
          language: source.language,
          source_type: source.source_type,
          content_snippet: title,
          published_at: publishedAt ? new Date(publishedAt).toISOString() : null,
        });
      });

    } catch (error) {
      // 抓取失败降级：跳过该页，不拖垮整个采集流程
      console.error(`  [FAIL] 新智元爬虫: ${pageUrl} ${error.message}`);
    }
  }

  return articles;
}
