/**
 * Anthropic News + Research 爬虫
 * anthropic.com 无RSS（/news/rss.xml 404），但列表页为SSR渲染，结构规整：
 * <article><header><p><a class="TopicLink" href="/news/announcements">分类</a></p><time>Oct 26, 2026</time></header>
 *   ...<a href="/news/s1-sec"><h3>标题</h3><p>摘要</p></a></article>
 * 2026-10-21 站点改版：`<time>` 从 `<a>` 内部移到 `<header>` 里，与标题链接成兄弟。
 * 旧实现用 `$(anchor).find('time')` 因此每卡都取不到日期、`if (!timeText) return;` 静默丢光全部卡片，
 * 造成连续 7 天 raw=0 且库里没有任何错误信号（见 ds-probe-20261026.md 第五节）。
 * 现改法：从 anchor 向上找卡片容器（优先 `<article>`，退化到第一个含 `<time>` 的祖先），日期从容器取。
 * 两个列表页都要抓（2026-08-11教训：黎曼猜想研究发在/research/riemann-zeta，
 * 只抓/news导致漏收）：
 * - /news：产品发布/公告
 * - /research：研究论文（对齐/可解释性/数学能力等），AI新闻浓度同样高
 * 实测无反爬，fetch + cheerio 即可（2026-07-28 验证）
 */
import * as cheerio from 'cheerio';
import { withScrapeMeta } from './scraper-result.mjs';

const LIST_PAGES = [
  { url: 'https://www.anthropic.com/news', prefix: '/news/' },
  { url: 'https://www.anthropic.com/research', prefix: '/research/' },
];

/**
 * 采集 Anthropic News
 * @param {Object} source - sources.mjs 中的源配置
 * @returns {Array} 文章数组，附 matched / http_status / error 元数据（scraper-result.mjs）
 */
export async function scrapeAnthropic(source) {
  const articles = [];
  const seenUrls = new Set();
  let matched = 0;      // 解析阶段命中的卡片数（未经时效过滤）
  let noDate = 0;       // 命中但容器内取不到日期的卡片数
  const errors = [];    // 各页失败原因
  let lastStatus = 0;

  for (const { url: pageUrl, prefix } of LIST_PAGES) {
    try {
      const resp = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(20000),
      });
      lastStatus = resp.status;

      if (!resp.ok) {
        console.error(`  [FAIL] Anthropic爬虫: ${pageUrl} HTTP ${resp.status}`);
        errors.push(`HTTP ${resp.status}`);
        continue; // 单页失败不影响另一页
      }

      const html = await resp.text();
      const $ = cheerio.load(html);

      $(`a[href^="${prefix}"]`).each((_, el) => {
        const href = $(el).attr('href') || '';
        const url = `https://www.anthropic.com${href}`;
        if (seenUrls.has(url)) return;

        // 分类链接（TopicLink）指向 /news/announcements 这类栏目页，不是稿件，跳过
        if (/TopicLink/.test($(el).attr('class') || '')) return;

        // 标题：卡片链接内的标题元素优先；图片锚点（无标题元素且文本为空）跳过
        const titleEl = $(el).find('h1, h2, h3, h4, [class*="title" i]').first();
        const title = (titleEl.length ? titleEl.text() : $(el).text()).trim();
        if (title.length < 5) return;

        // 日期：从卡片容器取 <time>（2026-10-21 改版后它与标题链接同级，不在 <a> 内）
        const card = $(el).closest('article').length
          ? $(el).closest('article')
          : $(el).parents().filter((__, p) => $(p).find('time').length > 0).first();
        const timeText = card.length ? card.find('time').first().text().trim() : '';
        matched++;
        if (!timeText) {
          // 不再静默丢卡片：计数上报，改版时 raw 与 matched 能一起反映"解析命中但日期拿不到"
          noDate++;
        }
        const d = timeText ? new Date(timeText) : null;
        const publishedAt = d && !isNaN(d.getTime()) ? d.toISOString() : null;

        // 摘要：部分精选卡片带正文段落
        const snippet = (card.find('p').first().text().trim() || '').replace(title, '').trim();

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
      errors.push(error.message);
    }
  }

  if (noDate) {
    console.warn(`  [WARN] Anthropic爬虫: ${noDate} 张卡片在容器内取不到 <time>（页面结构可能再次变更）`);
  }
  return withScrapeMeta(articles, {
    matched,
    http_status: lastStatus || undefined,
    error: errors.length ? errors.join('; ') : (matched === 0 ? '两列表页均 0 命中' : null),
  });
}
