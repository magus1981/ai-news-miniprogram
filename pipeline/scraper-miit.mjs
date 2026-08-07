/**
 * 工信部（miit.gov.cn）"文件发布"爬虫
 *
 * 站点页面是JS渲染的，静态抓不到；实际数据来自搜索接口：
 *   GET https://www.miit.gov.cn/search-front-server/api/search/info
 * 参数沿用官方"文件发布"页(/zwgk/zcwj/wjfb/)重定向后的 category=51。
 * 返回 JSON：data.searchResult.dataResults[].data {title, url, jsearch_date}
 *
 * 结果含AI相关的会由采集流水线的AI门槛过滤（与网信办一致）。
 */
const API = 'https://www.miit.gov.cn/search-front-server/api/search/info';
const SITE = 'https://www.miit.gov.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 只保留最近N天（老条目是常驻联系方式类，避免入库）
const RECENT_DAYS = 45;

export async function scrapeMiit(source) {
  const end = new Date();
  const begin = new Date(end.getTime() - RECENT_DAYS * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const qs = new URLSearchParams({
    websiteid: '110000000000000',
    scope: 'basic',
    q: '',
    pg: '20',
    cateid: '51',
    dateField: 'deploytime',
    begin: fmt(begin),
    end: fmt(end),
    level: '6',
    sortFields: '-deploytime',
    p: '1',
  });

  let data;
  try {
    const resp = await fetch(`${API}?${qs}`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': `${SITE}/search/wjfb.html` },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (err) {
    console.warn(`[WARN] 工信部爬虫: 请求失败 ${err.message}`);
    return [];
  }

  const results = data?.data?.searchResult?.dataResults;
  if (!Array.isArray(results)) {
    console.warn(`[WARN] 工信部爬虫: 响应结构异常 code=${data?.code} msg=${data?.message}`);
    return [];
  }

  const articles = [];
  for (const item of results) {
    const d = item?.data;
    if (!d?.title || !d.url) continue;
    // 站外链接（如申诉系统）跳过
    let url = d.url;
    if (url.startsWith('/')) url = SITE + url;
    if (!url.includes('miit.gov.cn')) continue;
    // 日期：jsearch_date 为 YYYY-MM-DD
    const dateText = d.jsearch_date;
    if (!dateText || Number.isNaN(Date.parse(dateText))) continue;
    const publishedAt = new Date(`${dateText}T09:00:00+08:00`).toISOString();
    if (Date.now() - Date.parse(publishedAt) > RECENT_DAYS * 24 * 3600 * 1000) continue;

    articles.push({
      title: d.title.trim(),
      source_name: source.name,
      source_url: url,
      category: source.category,
      language: source.language,
      source_type: source.source_type,
      content_snippet: d.title.trim(),
      published_at: publishedAt,
    });
  }
  return articles;
}
