/**
 * TC260（全国信息安全标准化技术委员会）爬虫
 * AI安全标准事实基准：《生成式人工智能服务安全基本要求》、深度合成标识等大模型
 * 合规依据均出自该委；征求意见稿/标准发布公告是AI政策浓度最高的栏目。
 * 首页为服务端渲染（layui静态块），.info-item 含 .title a 与 .date（征求时间区间），
 * 2026-08-10 实测普通UA + fetch即可，无需JS。
 * 非AI条目（大量传统网络安全国标）靠AI筛选闸门过滤；官方源享7天时效窗。
 */
import * as cheerio from 'cheerio';
import { relayAvailable, relayFetch } from './cn-relay.mjs';

const HOME_URL = 'https://www.tc260.org.cn/';
const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// 直连失败后本次进程内固定走中继（避免白等超时；2026-08-29 复盘：tc260.org.cn
// 对 Actions 美国 runner 断连，raw 从 6/轮跌到 0，症状与浙江同类——国内政务站屏蔽海外IP）
let preferRelay = false;

/**
 * 拉首页 HTML：直连优先（8s短超时），失败降级国内中继；两路都断返回 null
 */
async function fetchHomeText() {
  if (!preferRelay) {
    try {
      const resp = await fetch(HOME_URL, { headers: PAGE_HEADERS, signal: AbortSignal.timeout(8000) });
      if (resp.ok) return await resp.text();
      console.error(`  [WARN] TC260爬虫: 直连 HTTP ${resp.status}`);
    } catch (e) {
      console.error(`  [WARN] TC260爬虫: 直连失败(${String(e.cause?.message || e.message).slice(0, 80)})`);
    }
    if (!relayAvailable()) return null; // 本地开发无中继配置：维持原行为
    preferRelay = true;
    console.error('  [INFO] TC260爬虫: 切换经国内服务器中继代拉');
  }
  try {
    const resp = await relayFetch(HOME_URL, { method: 'GET', headers: PAGE_HEADERS, timeoutMs: 30000 });
    if (!resp.ok) { console.error(`  [FAIL] TC260爬虫: 中继 HTTP ${resp.status}`); return null; }
    return await resp.text();
  } catch (e) {
    console.error(`  [FAIL] TC260爬虫: 中继失败(${e.message.slice(0, 80)})`);
    return null;
  }
}

/**
 * 采集TC260首页公告（征求意见/发布通知）
 * @param {Object} source - sources.mjs 中的源配置（取 name/category/language/source_type）
 * @returns {Array} - 与RSS源相同形状的文章数组
 *   {title, source_name, source_url, category, language, source_type, content_snippet, published_at}
 */
export async function scrapeTc260(source) {
  const articles = [];
  const seenUrls = new Set();

  try {
    const text = await fetchHomeText();
    if (text === null) return articles;

    const $ = cheerio.load(text);

    // 2026-08-31 适配改版：首页公告列表由 .info-item 迁移为 ul.inList > li > a
    // （a 带 title 属性与 href 相对路径，发布日期在 a 内 span.date，形如 2026-08-12）
    $('.inList li a').each((_, el) => {
      const item = $(el);
      const title = (item.attr('title') || item.text()).trim();
      let href = item.attr('href') || '';
      if (!href || title.length < 5) return;
      if (href.startsWith('/')) href = 'https://www.tc260.org.cn' + href;
      if (seenUrls.has(href)) return;
      seenUrls.add(href);

      // span.date 为发布日期（旧版是"征求时间 X 至 Y"取起始日，新版直接给单日）
      const dateText = item.find('.date').text();
      const m = dateText.match(/(\d{4})-(\d{2})-(\d{2})/);
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
    console.error(`  [FAIL] TC260爬虫: ${error.message}`);
  }

  return articles;
}
