/**
 * The Hill Tech 直连爬虫（WordPress REST API）
 * 美国国会/立法/监管动态，非AI内容靠AI筛选闸门过滤。
 * 2026-08-11 从RSS切换为直连：原 /policy/technology/feed/ 存在5-9小时更新滞后
 * （文章发布后数小时才进feed，2026-08-11凌晨实测漏收Sanders/Zuckerberg等4条当日稿）。
 * WP REST API(wp-json/wp/v2/posts?categories=27)文章一发布即可见，带精确GMT时间戳；
 * 分类ID 27 来自栏目页 <link rel="alternate" type="application/json" href=".../categories/27">。
 * 2026-08-11 实测普通UA + fetch即可，返回标准JSON。
 */
import * as cheerio from 'cheerio';

const API_URL = 'https://thehill.com/wp-json/wp/v2/posts?categories=27&per_page=20&orderby=date&order=desc&_fields=link,title,date_gmt,excerpt';

/**
 * 采集 The Hill Technology 栏目最新文章
 * @param {Object} source - sources.mjs 中的源配置（取 name/category/language/source_type）
 * @returns {Array} - 与RSS源相同形状的文章数组
 *   {title, source_name, source_url, category, language, source_type, content_snippet, published_at}
 */
export async function scrapeTheHill(source) {
  const articles = [];
  const seenUrls = new Set();

  try {
    const resp = await fetch(API_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      console.error(`  [FAIL] The Hill爬虫: HTTP ${resp.status}`);
      return articles;
    }

    const posts = await resp.json();
    if (!Array.isArray(posts)) {
      console.error('  [FAIL] The Hill爬虫: 返回非数组');
      return articles;
    }

    const $ = cheerio.load('<html></html>'); // 仅借用其HTML实体解码/去标签能力

    for (const post of posts) {
      const href = post.link || '';
      const title = decodeHtml($, post.title?.rendered || '');
      if (!href || title.length < 5 || seenUrls.has(href)) continue;
      seenUrls.add(href);

      // date_gmt 形如 "2026-08-10T19:41:07"（WP REST 的GMT时间不带时区后缀）
      const publishedAt = post.date_gmt ? new Date(`${post.date_gmt}Z`).toISOString() : null;
      const snippet = decodeHtml($, post.excerpt?.rendered || '').slice(0, 500) || title;

      articles.push({
        title,
        source_name: source.name,
        source_url: href,
        category: source.category,
        language: source.language,
        source_type: source.source_type,
        content_snippet: snippet,
        published_at: publishedAt,
      });
    }

  } catch (error) {
    console.error(`  [FAIL] The Hill爬虫: ${error.message}`);
  }

  return articles;
}

/** 解码WP返回的HTML实体并去标签（标题含 &#8217; 等实体，摘要含 <p> 标签） */
function decodeHtml($, html) {
  return $('<div>').html(html || '').text().replace(/\s+/g, ' ').trim();
}
