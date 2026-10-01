/**
 * 量子位网页爬虫
 * 量子位RSS源(https://www.qbitai.com/feed)实测不可用，改为抓取列表页HTML
 * 抓取URL/选择器/相对时间解析逻辑沿用一代项目(ai-tracker-server)已验证的实现
 * 实测无反爬，fetch + cheerio 即可
 */
import * as cheerio from 'cheerio';

const QBITAI_URL = 'https://www.qbitai.com/category/资讯';
const ARTICLE_URL_PATTERN = /qbitai\.com\/\d{4}\/\d{2}\/.+\.html$/;

/**
 * 解析相对时间（如"4小时前"）为ISO日期字符串
 *
 * 2026-10-01 修复（"小程序今天没更新"排查中定位）：量子位列表页对 24–72 小时内的稿子
 * 只写"昨天 15:58 / 前天 18:56 / 今天 08:30"这类中文日名，旧实现只认
 * "N分钟前 / N小时前 / N天前 / YYYY-MM-DD"，遇到日名一律返回 null；
 * 叠加 2026-09-29 的 date_unknown 通道（无日期稿不再冒充今日新稿、不进 AI 筛选、
 * 不进"今日"主列表），结果是量子位最近一到两天的稿子被整批关进 date_key='unknown'，
 * 首页从此看不见这个源。实测列表页 20 个时间标签里 12 个是"昨天/前天"，
 * 旧实现只解析出 8 个。
 *
 * 时区口径：列表页这些标签是**北京墙钟**，而 Actions runner 在 UTC。
 * 因此先把"现在"折算到北京日历日，再按 +08:00 解释标签上的时分，最后返回 UTC 的 ISO 串。
 * collect.mjs 侧统一用 beijingDayKey(published_at) 归北京日，两端口径一致。
 *
 * 标签不带时刻时（极少见）取当日 12:00，既不谎报上午也不谎报深夜，
 * 且不会因时区换算跨到相邻日。识别不了的一律返回 null，交给 date_unknown 通道，
 * 绝不猜日期。
 *
 * 导出仅供单测使用（tests/test-pure.mjs 之外的纯函数面）。
 */
export function parseRelativeTime(text) {
  const now = Date.now();
  const cleaned = String(text || '').trim();

  const minMatch = cleaned.match(/^(\d+)\s*分钟前/);
  if (minMatch) return new Date(now - parseInt(minMatch[1]) * 60 * 1000).toISOString();

  const hourMatch = cleaned.match(/^(\d+)\s*小时前/);
  if (hourMatch) return new Date(now - parseInt(hourMatch[1]) * 3600 * 1000).toISOString();

  const dayMatch = cleaned.match(/^(\d+)\s*天前/);
  if (dayMatch) return new Date(now - parseInt(dayMatch[1]) * 86400000).toISOString();

  // 中文日名：今天/今日、昨天/昨日、前天 + 可选 HH:MM
  const cnDayMatch = cleaned.match(/^(今天|今日|昨天|昨日|前天)(?:\s*(\d{1,2}):(\d{2}))?/);
  if (cnDayMatch) {
    const back = { '今天': 0, '今日': 0, '昨天': 1, '昨日': 1, '前天': 2 }[cnDayMatch[1]];
    const hh = cnDayMatch[2] !== undefined ? parseInt(cnDayMatch[2], 10) : 12;
    const mi = cnDayMatch[3] !== undefined ? parseInt(cnDayMatch[3], 10) : 0;
    if (hh > 23 || mi > 59) return null; // 越界不猜
    const bj = new Date(now + 8 * 3600 * 1000); // 用 UTC getter 读出的就是北京墙钟
    return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(),
      bj.getUTCDate() - back, hh - 8, mi)).toISOString();
  }

  const dateMatch = cleaned.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (dateMatch) return new Date(`${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`).toISOString();

  return null;
}

/**
 * 采集量子位资讯
 * @param {Object} source - sources.mjs 中的源配置（取 category/language/source_type）
 * @returns {Array} - 与RSS源相同形状的文章数组
 *   {title, source_name, source_url, category, language, source_type, content_snippet, published_at}
 *   published_at 可能为 null（列表页时间解析失败时），由 collect.mjs 的时效过滤统一处理
 */
export async function scrapeQbitai(source) {
  try {
    const resp = await fetch(QBITAI_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      console.error(`  [FAIL] 量子位爬虫: HTTP ${resp.status}`);
      return [];
    }

    const html = await resp.text();
    const $ = cheerio.load(html);
    const articles = [];
    const seenUrls = new Set();

    // 找所有文章链接
    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).text().trim();

      if (!ARTICLE_URL_PATTERN.test(href) || title.length < 5) return;
      if (seenUrls.has(href)) return;
      seenUrls.add(href);

      // 尝试从父元素中获取摘要和时间
      const parent = $(el).closest('.excerpt, .post-item, .article-item, .item, li, div').first();

      // 摘要：找父元素中的摘要文本
      let summary = '';
      const summaryEl = parent.find('.excerpt, .summary, .desc, .description, p').first();
      if (summaryEl.length) {
        summary = summaryEl.text().trim();
      }
      // 如果摘要太短，用标题
      if (summary.length < 20) summary = title;

      // 时间
      let publishedAt = null;
      const timeEl = parent.find('.time, .date, time').first();
      if (timeEl.length) {
        publishedAt = parseRelativeTime(timeEl.text());
      }

      articles.push({
        title,
        source_name: source.name,
        source_url: href,
        category: source.category,
        language: source.language,
        source_type: source.source_type,
        content_snippet: summary.slice(0, 2000),
        published_at: publishedAt, // ISO串或null
      });
    });

    return articles;

  } catch (error) {
    // 抓取失败降级：返回空数组，不拖垮整个采集流程
    console.error(`  [FAIL] 量子位爬虫: ${error.message}`);
    return [];
  }
}
