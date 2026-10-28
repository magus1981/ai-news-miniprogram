/**
 * DeepSeek 官方（deepseek.com）发布监控爬虫
 *
 * 背景（2026-08-13）：DeepSeek-V4-Pro-0813 深夜上线，媒体稿早上才发，
 * 09:05采集轮没抓到——重大模型发布只盯媒体稿必然滞后。官网为SSR，发布当轮即可采到，
 * 比媒体转载早几小时到几天。无反爬（普通浏览器UA即可，2026-08-13实测）。
 *
 * 2026-10-28 改版适配（ds-probe-20261026.md 第一、二节）：
 * 官网 2026-10-17 重建首页，公告文案从首页迁到 /news/ 列表页，且用词从
 * "DeepSeek-V4-Pro 正式版发布"（连字符）改为 "DeepSeek V4.1 Flash 正式发布"（空格）。
 * 旧的"首页正则找公告文案"因此 0 命中，连续 10 天 raw=0，库里 error 恒空。
 * 现按卡片结构解析 /news/：
 *   a.ds-news-hero-card / a.ds-news-list-item
 *     ├ span.text-ds-description  中文日期（"2026 年 9 月 10 日"，北京墙钟）
 *     ├ h2 / h3                   标题
 *     └ p.ds-text-body-sm         摘要
 *   href                          真实文章页 /news/<slug>/（旧版合成的 /release/<ver> 实测 404）
 * 首页公告文案正则保留为兜底：/news/ 挂了或再次改版时仍能出稿，但版本号
 * 同时接受连字符与空格两种写法。
 * 日期：卡片里有真实发布日期，填进 published_at；提不到日期时返回 '' 走 date_unknown 通道
 * （collect.mjs normalizePublishedAt 口径，不再冒充"发布日=采集日"）。
 */
import * as cheerio from 'cheerio';
import { pathToFileURL } from 'url';
import { withScrapeMeta } from './scraper-result.mjs';

const HOME = 'https://www.deepseek.com/';
const NEWS_LIST = 'https://www.deepseek.com/news/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 兜底：匹配 "DeepSeek-V4-Pro 正式版发布..." 公告（截断到引号/换行转义处）
const RELEASE_RE = /DeepSeek-[A-Za-z0-9.\-]*\s*(?:正式版)?发布[^"\\]{0,150}/g;
// 版本号：连字符（DeepSeek-V3.2-Exp）与空格（DeepSeek V4.1 Flash）两种写法都要接受
const VERSION_RE = /DeepSeek[- ]([A-Za-z0-9][A-Za-z0-9.\-]*(?:\s+[A-Z][A-Za-z0-9.\-]*)?)/;

/**
 * 解析中文日期 "2026 年 9 月 10 日" 为 ISO 串。
 * 列表页日期是北京墙钟且不带时刻，取当日 12:00+08:00，避免时区换算跨到相邻日。
 * @returns {string} ISO 串；识别不了返回 ''（交 date_unknown 通道，绝不猜日期）
 */
export function parseChineseDate(text) {
  const m = String(text || '').match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) return '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return new Date(`${y}-${pad(mo)}-${pad(d)}T12:00:00+08:00`).toISOString();
}

/** 首页公告文案兜底路径（/news/ 无命中时使用） */
function scrapeHomeFallback(html, source, articles, seenUrls) {
  const matches = [...html.matchAll(RELEASE_RE)]
    .map(m => m[0].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim())
    .filter((v, i, a) => a.indexOf(v) === i); // 页面内同一公告多次内嵌，去重

  for (const text of matches) {
    const ver = (text.match(VERSION_RE) || [])[1]?.replace(/\s+/g, '-');
    if (!ver || text.length < 12 || seenUrls.has(ver)) continue;
    seenUrls.add(ver);
    articles.push({
      title: text.length > 60 ? text.slice(0, 60) + '…' : text,
      source_name: source.name,
      source_url: `${HOME}release/${ver}`,
      category: source.category,
      language: source.language,
      source_type: source.source_type,
      content_snippet: text.slice(0, 300),
      published_at: '', // 兜底文案无日期，走 date_unknown，不冒充采集日
    });
  }
}

/**
 * 采集 DeepSeek 官方发布公告
 * @param {Object} source - sources.mjs 中的源配置
 * @returns {Array} 文章数组，附 matched / http_status / error 元数据（scraper-result.mjs）
 */
export async function scrapeDeepseek(source) {
  const articles = [];
  const seenUrls = new Set();
  let matched = 0;
  let httpStatus = 0;
  let error = null;

  try {
    const resp = await fetch(NEWS_LIST, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(20000),
    });
    httpStatus = resp.status;
    if (!resp.ok) {
      console.error(`  [FAIL] DeepSeek官方爬虫: ${NEWS_LIST} HTTP ${resp.status}`);
      error = `HTTP ${resp.status}`;
    } else {
      const $ = cheerio.load(await resp.text());
      $('a.ds-news-hero-card, a.ds-news-list-item, a[href^="/news/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (!/^\/news\/[^/]+\/?$/.test(href)) return; // 排除 /news/ 自身与栏目锚点
        const url = `https://www.deepseek.com${href}`;

        const titleEl = $(el).find('h1, h2, h3, h4').first();
        const title = titleEl.text().trim();
        if (title.length < 5) return; // 图片/说明性锚点没有标题元素
        matched++;
        if (seenUrls.has(url)) return;
        seenUrls.add(url);

        const dateSpan = $(el).find('span').filter((_, s) => parseChineseDate($(s).text())).first();
        const publishedAt = parseChineseDate(dateSpan.text());
        const snippet = $(el).find('p').filter((_, p) => $(p).text().trim().length > 10).last().text().trim();

        articles.push({
          title,
          source_name: source.name,
          source_url: url,
          category: source.category,
          language: source.language,
          source_type: source.source_type,
          content_snippet: (snippet || title).slice(0, 2000),
          published_at: publishedAt, // ISO 串；提不到日期为 '' → date_unknown 通道
        });
      });
    }
  } catch (err) {
    console.error(`  [FAIL] DeepSeek官方爬虫: ${NEWS_LIST} ${err.message}`);
    error = err.message;
  }

  if (!articles.length) {
    // /news/ 无产出时回退首页公告文案正则，保持旧路径可用
    console.warn('  [WARN] DeepSeek官方爬虫: /news/ 列表未命中卡片，回退首页公告文案');
    try {
      const resp2 = await fetch(HOME, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(20000),
      });
      httpStatus = resp2.status || httpStatus;
      if (resp2.ok) {
        scrapeHomeFallback(await resp2.text(), source, articles, seenUrls);
        matched = articles.length;
      } else {
        error = `${error ? error + '; ' : ''}HOME HTTP ${resp2.status}`;
      }
    } catch (err) {
      error = `${error ? error + '; ' : ''}HOME ${err.message}`;
    }
  }

  return withScrapeMeta(articles, { matched, http_status: httpStatus || undefined, error });
}

// 独立运行调试：node scraper-deepseek.mjs
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const arts = await scrapeDeepseek({ name: 'DeepSeek 官方', category: 'technology', language: 'zh', source_type: 'official' });
  console.log(`\n抓到 ${arts.length} 条 (matched=${arts.matched}, http=${arts.http_status ?? 'n/a'}, error=${arts.error ?? 'none'})`);
  arts.forEach(a => console.log(' -', a.title, '|', a.source_url, '|', a.published_at));
}
