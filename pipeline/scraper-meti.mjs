/**
 * 日本経済産業省（meti.go.jp）プレスリリース爬虫
 * 抓 /press/ ニュースリリース列表页（服务端渲染）。
 * 列表结构：<ul class="clearfix float_li"><li class="clearfix">
 *   <div class="left txt_box"><p>2026年8月10日</p><a class="cut_txt" href="/press/2026/08/20260810001.html">标题</a></div></li>
 * 日期格式 YYYY年M月D日；报道URL内嵌日期 /press/YYYY/MM/YYYYMMDDxxx.html。
 *
 * ⚠️ 经产省站位于 AWS CloudFront + WAF 之后：纯HTTP抓取不稳定，
 *    带完整浏览器UA有时200、有时返回202(WAF challenge)。
 *    采集管线内已带2次重试（见collect.mjs fetchSource的RETRY逻辑），
 *    此爬虫内部再重试1次；持续失败时返回空数组，由信源健康告警(7天)兜底。
 *    若长期被拦，建议改用浏览器内核抓取或PR TIMES转载站。
 */
import * as cheerio from 'cheerio';

const LIST = 'https://www.meti.go.jp/press/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SITE = 'https://www.meti.go.jp';

export async function scrapeMeti(source) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(LIST, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en;q=0.9',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) {
        console.warn(`  [WARN] 経産省爬虫: HTTP ${resp.status}${attempt < 2 ? '，重试' : ''}`);
        if (attempt < 2) { await new Promise(r => setTimeout(r, 3000)); continue; }
        return [];
      }
      const html = await resp.text();
      if (html.length < 1000) {
        // WAF challenge 返回空壳
        console.warn(`  [WARN] 経産省爬虫: 响应体过短(${html.length}字节)，疑似WAF challenge${attempt < 2 ? '，重试' : ''}`);
        if (attempt < 2) { await new Promise(r => setTimeout(r, 3000)); continue; }
        return [];
      }
      const $ = cheerio.load(html);
      const articles = [];
      const seen = new Set();

      $('ul.float_li li, ul.clearfix li').each((_, el) => {
        const li = $(el);
        const a = li.find('a.cut_txt').first();
        const title = (a.attr('title') || a.text()).trim();
        let href = a.attr('href') || '';
        if (!href || !title || title.length < 5) return;
        if (href.startsWith('/')) href = SITE + href;
        if (seen.has(href)) return;
        seen.add(href);

        // 日期在相邻 p 标签
        const dateText = li.find('p').first().text().trim();
        const m = dateText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
        let publishedAt = null;
        if (m) {
          const mm = m[2].padStart(2, '0');
          const dd = m[3].padStart(2, '0');
          const d = new Date(`${m[1]}-${mm}-${dd}T09:00:00+09:00`);
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

      return articles;
    } catch (error) {
      console.warn(`  [WARN] 経産省爬虫: ${error.message}${attempt < 2 ? '，重试' : ''}`);
      if (attempt < 2) { await new Promise(r => setTimeout(r, 3000)); continue; }
      return [];
    }
  }
  return [];
}
