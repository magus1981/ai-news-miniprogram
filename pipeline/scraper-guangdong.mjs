/**
 * 广东省人民政府（gd.gov.cn）政策文件爬虫
 * 抓"政务公开/文件库/全部文件"静态列表页（服务端渲染，须带浏览器UA）。
 * 列表结构：<ul class="newsIlist"><li><a href=".../content/post_XXX.html">标题</a><span>2026-08-10</span></li></ul>
 * 翻页：index.html → index_2.html ...；条目链接形如 .../content/post_XXXXXXX.html。
 * 2026-08-11 实测无UA裸请求返回空，带Chrome UA后200。
 */
import * as cheerio from 'cheerio';

const LIST_PAGE = 'http://www.gd.gov.cn/zwgk/wjk/qbwj/index.html';
const MAX_PAGES = 3;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function scrapeGuangdong(source) {
  const articles = [];
  const seenUrls = new Set();

  for (let p = 0; p < MAX_PAGES; p++) {
    const pageUrl = p === 0 ? LIST_PAGE : `http://www.gd.gov.cn/zwgk/wjk/qbwj/index_${p + 1}.html`;
    try {
      const resp = await fetch(pageUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) { console.error(`  [FAIL] 广东爬虫: ${pageUrl} HTTP ${resp.status}`); break; }
      const $ = cheerio.load(await resp.text());

      // 列表条目：优先匹配含 post_ 链接的 li
      $('li a[href*="content/post_"]').each((_, el) => {
        const a = $(el);
        const title = (a.attr('title') || a.text()).trim();
        let href = a.attr('href') || '';
        if (!href || title.length < 5) return;
        try { href = new URL(href, pageUrl).href; } catch { return; }
        if (seenUrls.has(href)) return;
        seenUrls.add(href);

        // 日期在同级 span.date（与 a 所在 span.name 同级）
        const dateText = a.closest('li').find('span.date').text().trim()
          || a.parent().siblings('span.date').text().trim()
          || a.parent().siblings('span').text().trim();
        const m = dateText.match(/(\d{4})-(\d{2})-(\d{2})/);
        const publishedAt = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T09:00:00+08:00`).toISOString() : null;

        articles.push({
          title,
          source_name: source.name,
          source_url: href,
          category: source.category,
          language: source.language,
          source_type: source.source_type,
          content_snippet: title,
          published_at: publishedAt,
        });
      });
    } catch (error) {
      console.error(`  [FAIL] 广东爬虫: ${pageUrl} ${error.message}`);
      break;
    }
  }

  return articles;
}
