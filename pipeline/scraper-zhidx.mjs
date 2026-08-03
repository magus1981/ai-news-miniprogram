/**
 * 智东西/芯东西 爬虫（两级抓取）
 * zhidx.com/feed 已坏（HTTP 500），列表页为SSR但不含发布时间，
 * 故采用两级方案：列表页取"链接+标题"，详情页取日期（<div class="time">2026/07/28<）
 * 详情页仅对列表前N条并发抓取，控制请求量；实测无反爬（2026-07-28 验证）
 *
 * 两个入口共用一套逻辑：
 * - scrapeZhidx:    智东西"人工智能"分类页（大厂AI动态）
 * - scrapeXindongxi: 芯东西子刊首页（芯片/算力，补infra维度）
 */
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ARTICLE_URL_PATTERN = /^https?:\/\/zhidx\.com\/p\/\d+\.html$/;
const MAX_DETAIL_FETCH = 15; // 详情页抓取上限（每源每次采集）
const DETAIL_CONCURRENCY = 4;

/**
 * 从详情页HTML中提取发布日期（<div class="time">2026/07/28 或同类）
 */
function extractDate(html) {
  const m = html.match(/class="[^"]*time[^"]*"[^>]*>\s*(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T12:00:00+08:00`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 通用抓取：列表页收集链接 -> 详情页并发补日期
 */
async function scrapeZhidxSite(listUrl, source) {
  try {
    const resp = await fetch(listUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      console.error(`  [FAIL] ${source.name}爬虫: HTTP ${resp.status}`);
      return [];
    }

    const $ = cheerio.load(await resp.text());
    const items = [];
    const seenUrls = new Set();

    $('a[href*="zhidx.com/p/"]').each((_, el) => {
      const href = ($(el).attr('href') || '').split('?')[0];
      const title = ($(el).attr('title') || $(el).text()).trim();
      if (!ARTICLE_URL_PATTERN.test(href) || title.length < 8) return;
      if (seenUrls.has(href)) return;
      seenUrls.add(href);

      // 摘要：列表项中的描述文本（智东西 .info-left-desc）
      const desc = $(el).closest('li, .item').find('.info-left-desc, .desc, p').first().text().trim();
      items.push({ href, title, desc });
    });

    // 详情页补日期（仅前N条，并发限流）
    const targets = items.slice(0, MAX_DETAIL_FETCH);
    const articles = [];
    for (let i = 0; i < targets.length; i += DETAIL_CONCURRENCY) {
      const batch = targets.slice(i, i + DETAIL_CONCURRENCY);
      const results = await Promise.all(batch.map(async it => {
        let publishedAt = null;
        try {
          const r = await fetch(it.href, {
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(15000),
          });
          if (r.ok) publishedAt = extractDate(await r.text());
        } catch { /* 单篇失败不影响其他 */ }
        return { ...it, publishedAt };
      }));
      articles.push(...results);
    }

    return articles.map(it => ({
      title: it.title,
      source_name: source.name,
      source_url: it.href,
      category: source.category,
      language: source.language,
      source_type: source.source_type,
      content_snippet: (it.desc || it.title).slice(0, 2000),
      published_at: it.publishedAt, // ISO串或null（无日期由时效过滤统一处理）
    }));

  } catch (error) {
    // 抓取失败降级：返回空数组，不拖垮整个采集流程
    console.error(`  [FAIL] ${source.name}爬虫: ${error.message}`);
    return [];
  }
}

/** 智东西"人工智能"分类 */
export async function scrapeZhidx(source) {
  return scrapeZhidxSite('https://zhidx.com/p/category/%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD', source);
}

/** 芯东西子刊（芯片/算力） */
export async function scrapeXindongxi(source) {
  return scrapeZhidxSite('https://zhidx.com/aichip001', source);
}
