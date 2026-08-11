/**
 * 沙特阿拉伯国家数据与人工智能管理局 SDAIA（sdaia.gov.sa）新闻爬虫
 * 列表页是SharePoint壳，新闻数据由后端API加载：
 *   GET https://sdaia.gov.sa/en/MediaCenter/News/DataSources/NewsByYear.aspx?Year=YYYY
 * 返回自定义 <site ID=".." Title=".." NewsDate="7/20/2026" Category=".." LinkPage=".." /> 元素列表
 * 详情页 https://sdaia.gov.sa/en/MediaCenter/News/Pages/NewsDetails.aspx?NewsID={ID}
 * 2026-08-11 实测无反爬（SharePoint本地部署，匿名开放）；Year=2026返回当年约10条。
 * 日期格式 M/D/YYYY（非补零），需按 / 分割解析。
 */
import * as cheerio from 'cheerio';

const API = 'https://sdaia.gov.sa/en/MediaCenter/News/DataSources/NewsByYear.aspx';
const DETAIL = 'https://sdaia.gov.sa/en/MediaCenter/News/Pages/NewsDetails.aspx?NewsID=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function scrapeSdaia(source) {
  const articles = [];
  const seenUrls = new Set();
  const year = new Date().getFullYear();

  // 抓当年与去年（跨年覆盖7天窗口足够，但兜底防年初空库）
  for (const y of [year, year - 1]) {
    try {
      const resp = await fetch(`${API}?Year=${y}`, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://sdaia.gov.sa/en/MediaCenter/News/Pages/default.aspx',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) { console.error(`  [FAIL] SDAIA爬虫: Year ${y} HTTP ${resp.status}`); continue; }
      // 用 xmlMode 保留自定义 <site> 标签的属性大小写（ID/Title/NewsDate）
      const $ = cheerio.load(await resp.text(), { xmlMode: true });

      $('site').each((_, el) => {
        const id = $(el).attr('ID');
        const title = ($(el).attr('Title') || '').trim();
        const newsDate = $(el).attr('NewsDate') || '';
        if (!title || title.length < 5 || !id) return;
        const href = DETAIL + id;
        if (seenUrls.has(href)) return;
        seenUrls.add(href);

        // 日期 M/D/YYYY
        const m = newsDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        let publishedAt = null;
        if (m) {
          const mm = m[1].padStart(2, '0');
          const dd = m[2].padStart(2, '0');
          const d = new Date(`${m[3]}-${mm}-${dd}T09:00:00+03:00`); // 沙特UTC+3
          if (!isNaN(d.getTime())) publishedAt = d.toISOString();
        }

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
      console.error(`  [FAIL] SDAIA爬虫: Year ${y} ${error.message}`);
    }
  }

  return articles;
}
