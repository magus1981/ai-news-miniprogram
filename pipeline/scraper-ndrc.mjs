/**
 * 国家发展改革委（ndrc.gov.cn）政策发布爬虫
 * 抓"信息公开/政策发布"下五个子栏目的静态列表页（服务端渲染，结构规整）：
 * - fzggwling 委令 / ghxwj 规范性文件 / ghwb 规划文本 / gg 公告 / tz 通知
 * AI+/数字经济/算力类政策主要落在"通知"与"规范性文件"子栏目。
 * 列表结构：<ul class="u-list"><li><a href="./202608/t20260810_xxx.html" title="标题">标题</a><span>2026/08/10</span></li>
 * 2026-08-11 实测普通UA + fetch即可，无反爬；index.html为JS跳转壳，须直接抓子栏目根。
 */
import * as cheerio from 'cheerio';

const LIST_PAGES = [
  // 'fzggwling' 子栏目实测404，已移除；委令类文件少，其他四个子栏目覆盖足够
  'https://www.ndrc.gov.cn/xxgk/zcfb/ghxwj/',
  'https://www.ndrc.gov.cn/xxgk/zcfb/ghwb/',
  'https://www.ndrc.gov.cn/xxgk/zcfb/gg/',
  'https://www.ndrc.gov.cn/xxgk/zcfb/tz/',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * 采集发改委政策发布
 * @param {Object} source - sources.mjs 中的源配置
 * @returns {Array} 文章数组
 */
export async function scrapeNdrc(source) {
  const articles = [];
  const seenUrls = new Set();

  for (const pageUrl of LIST_PAGES) {
    try {
      const resp = await fetch(pageUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        console.error(`  [FAIL] 发改委爬虫: ${pageUrl} HTTP ${resp.status}`);
        continue;
      }
      const $ = cheerio.load(await resp.text());

      $('ul.u-list li').each((_, el) => {
        const li = $(el);
        const a = li.find('a').first();
        const title = (a.attr('title') || a.text()).trim();
        let href = a.attr('href') || '';
        if (!href || title.length < 5) return;
        try { href = new URL(href, pageUrl).href; } catch { return; }
        if (seenUrls.has(href)) return;
        seenUrls.add(href);

        const dateText = li.find('span').text().trim();
        const m = dateText.match(/(\d{4})\/(\d{2})\/(\d{2})/);
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
      console.error(`  [FAIL] 发改委爬虫: ${pageUrl} ${error.message}`);
    }
  }

  return articles;
}
