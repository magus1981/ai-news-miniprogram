/**
 * 韓国科学技術情報通信部 MSIT（msit.go.kr 과기정통부）報道資料爬虫
 * 官方RSS：https://www.msit.go.kr/user/rss/rss.do?bbsSeqNo=94 （报道资料，UTF-8，约700KB）
 * RSS 2.0但 <pubDate> 非标准RFC822，格式为 YYYY.MM.DD（CDATA包裹），rss-parser无法解析，
 * 故用cheerio xmlMode直接解析。
 * 详情页链接是干净URL（无jsessionid），可直接用。
 * /bbs/list.do 列表端点当前处于维护状态，故走RSS。
 * 2026-08-11 实测无UA要求；非AI条目靠AI筛选闸门过滤。
 */
import * as cheerio from 'cheerio';

const RSS = 'https://www.msit.go.kr/user/rss/rss.do?bbsSeqNo=94';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function scrapeMsit(source) {
  try {
    const resp = await fetch(RSS, {
      headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,application/xml,text/xml,*/*' },
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) { console.error(`  [FAIL] MSIT爬虫: HTTP ${resp.status}`); return []; }
    const text = await resp.text();
    const $ = cheerio.load(text, { xmlMode: true });

    const articles = [];
    const seen = new Set();
    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      if (!title || title.length < 3 || !link || seen.has(link)) return;
      seen.add(link);

      // pubDate 格式 YYYY.MM.DD（非标准）
      const pubRaw = $(el).find('pubDate').text().trim();
      let publishedAt = null;
      const m = pubRaw.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
      if (m) {
        const mm = m[2].padStart(2, '0');
        const dd = m[3].padStart(2, '0');
        const d = new Date(`${m[1]}-${mm}-${dd}T09:00:00+09:00`); // 韩国UTC+9
        if (!isNaN(d.getTime())) publishedAt = d.toISOString();
      } else {
        // 兜底：尝试标准RFC822解析
        const d = new Date(pubRaw);
        if (!isNaN(d.getTime())) publishedAt = d.toISOString();
      }

      articles.push({
        title,
        source_name: source.name,
        source_url: link,
        category: source.category,
        language: source.language,
        source_type: source.source_type,
        content_snippet: title,
        published_at: publishedAt,
      });
    });
    return articles;
  } catch (error) {
    console.error(`  [FAIL] MSIT爬虫: ${error.message}`);
    return [];
  }
}
