/**
 * 上海市人民政府（shanghai.gov.cn）政策文件库爬虫
 * 页面端是Vue SPA，真实数据来自底层JSON接口（无鉴权、无token）：
 *   POST https://www.shanghai.gov.cn/gwk/policy/page  body: {"current":1,"size":10}
 * 返回 data.records[]：{title, publishDate("2026-07-31 16:07:48"), originUrl, siteId, businessId, origin, genre}
 * 单页size上限10，按 current 翻页；不要加搜索参数（会导致500）。
 * AI相关占比低，靠AI筛选闸门过滤；官方源享7天时效窗。
 * 2026-08-11 实测普通UA + fetch即可，Content-Type须为application/json。
 */
const API = 'https://www.shanghai.gov.cn/gwk/policy/page';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PAGES = 3; // 首批约30条，足够覆盖7天窗口

export async function scrapeShanghai(source) {
  const articles = [];
  const seenUrls = new Set();

  for (let current = 1; current <= PAGES; current++) {
    try {
      const resp = await fetch(API, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
        body: JSON.stringify({ current, size: 10 }),
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) { console.error(`  [FAIL] 上海爬虫: page ${current} HTTP ${resp.status}`); break; }
      const json = await resp.json();
      const records = json?.data?.records;
      if (!Array.isArray(records) || records.length === 0) break;

      for (const r of records) {
        const title = (r.title || '').trim();
        let href = r.originUrl || '';
        if (!title || title.length < 5) continue;
        // originUrl 为空时（市政府本级文件）构造详情页链接
        if (!href) {
          // 详情接口需 businessId，此处用占位：列表条目本身可作为来源
          href = `https://www.shanghai.gov.cn/gwk/policy/detail?siteId=${encodeURIComponent(r.siteId || '')}&businessId=${encodeURIComponent(r.businessId || '')}`;
        }
        if (seenUrls.has(href)) continue;
        seenUrls.add(href);

        // publishDate 形如 "2026-07-31 16:07:48"，按北京时间
        const m = (r.publishDate || '').match(/(\d{4})-(\d{2})-(\d{2})/);
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
      }
    } catch (error) {
      console.error(`  [FAIL] 上海爬虫: page ${current} ${error.message}`);
      break;
    }
  }

  return articles;
}
