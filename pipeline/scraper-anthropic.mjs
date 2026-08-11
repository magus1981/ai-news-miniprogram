/**
 * Anthropic News + Research 爬虫
 * anthropic.com 无RSS（/news/rss.xml 404），但列表页为SSR渲染，结构规整：
 * <a href="/news/xxx"><time>Jul 27, 2026</time><span>分类</span><span>标题</span></a>
 * 两个列表页都要抓（2026-08-11教训：黎曼猜想研究发在/research/riemann-zeta，
 * 只抓/news导致漏收）：
 * - /news：产品发布/公告
 * - /research：研究论文（对齐/可解释性/数学能力等），AI新闻浓度同样高
 * 实测无反爬，fetch + cheerio 即可（2026-07-28 验证）
 */
import * as cheerio from 'cheerio';

const LIST_PAGES = [
  { url: 'https://www.anthropic.com/news', prefix: '/news/' },
  { url: 'https://www.anthropic.com/research', prefix: '/research/' },
];

/**
 * 采集 Anthropic News
 * @param {Object} source - sources.mjs 中的源配置
 * @returns {Array} - 与RSS源相同形状的文章数组
 */
export async function scrapeAnthropic(source) {
  const articles = [];
  const seenUrls = new Set();

  for (const { url: pageUrl, prefix } of LIST_PAGES) {
    try {
      const resp = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(20000),
      });

      if (!resp.ok) {
        console.error(`  [FAIL] Anthropic爬虫: ${pageUrl} HTTP ${resp.status}`);
        continue; // 单页失败不影响另一页
      }

      const html = await resp.text();
      const $ = cheerio.load(html);

      $(`a[href^="${prefix}"]`).each((_, el) => {
        const href = $(el).attr('href') || '';
        const url = `https://www.anthropic.com${href}`;
        if (seenUrls.has(url)) return;

        // 标题：优先取卡片内的标题元素，退化为链接全文本
        const titleEl = $(el).find('h2, h3, [class*="title" i]').first();
        const title = (titleEl.length ? titleEl.text() : $(el).text()).trim();
        if (title.length < 5) return;

        // 日期：卡片内的 <time> 文本（如 "Jul 27, 2026"），无time元素的导航链接跳过
        const timeText = $(el).find('time').first().text().trim();
        if (!timeText) return;
        const d = new Date(timeText);
        const publishedAt = isNaN(d.getTime()) ? null : d.toISOString();

        // 摘要：部分精选卡片带正文段落
        const snippet = $(el).find('p').first().text().trim();

        seenUrls.add(url);
        articles.push({
          title,
          source_name: source.name,
          source_url: url,
          category: source.category,
          language: source.language,
          source_type: source.source_type,
          content_snippet: (snippet || title).slice(0, 2000),
          published_at: publishedAt, // ISO串或null（官方源null放行）
        });
      });

    } catch (error) {
      // 抓取失败降级：跳过该页，不拖垮整个采集流程
      console.error(`  [FAIL] Anthropic爬虫: ${pageUrl} ${error.message}`);
    }
  }

  return articles;
}
