/**
 * 北京市人民政府（beijing.gov.cn）政策法规爬虫
 * 抓"政策文件/政策法规"静态列表页（服务端渲染）。
 * 列表结构：<li><i class="flag">是</i><a href="./202608/t20260810_xxx.html" title="标题">标题</a><span>2026-08-10</span></li>
 * 翻页：index_2.html ... index_N.html（按规律请求即可）。
 * 2026-08-11 实测无反爬、无token；"政策文件库"路径(404)与搜索API均不可用，故只抓静态列表。
 */
import * as cheerio from 'cheerio';

const LIST_PAGE = 'https://www.beijing.gov.cn/zhengce/zhengcefagui/index.html';
const MAX_PAGES = 1; // 首页已含最新~350条，7天窗口足够，多页会拉入大量历史条目
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function scrapeBeijing(source) {
  const articles = [];
  const seenUrls = new Set();

  for (let p = 0; p < MAX_PAGES; p++) {
    const pageUrl = p === 0 ? LIST_PAGE : `https://www.beijing.gov.cn/zhengce/zhengcefagui/index_${p + 1}.html`;
    try {
      const resp = await fetch(pageUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) { console.error(`  [FAIL] 北京爬虫: ${pageUrl} HTTP ${resp.status}`); break; }
      const $ = cheerio.load(await resp.text());

      $('li a[title]').each((_, el) => {
        const a = $(el);
        const title = (a.attr('title') || a.text()).trim();
        let href = a.attr('href') || '';
        // 只保留含日期格式的政策文件链接（./YYYYMM/tYYYYMMDD_xxx.html）
        if (!href || title.length < 5 || !/t\d{8}_/.test(href)) return;
        try { href = new URL(href, pageUrl).href; } catch { return; }
        if (seenUrls.has(href)) return;
        seenUrls.add(href);

        // 日期在相邻 span
        const dateText = a.next('span').text().trim() || a.parent().find('span').text().trim();
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
      console.error(`  [FAIL] 北京爬虫: ${pageUrl} ${error.message}`);
      break;
    }
  }

  return articles;
}
