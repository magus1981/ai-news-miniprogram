/**
 * TC260（全国信息安全标准化技术委员会）爬虫
 * AI安全标准事实基准：《生成式人工智能服务安全基本要求》、深度合成标识等大模型
 * 合规依据均出自该委；征求意见稿/标准发布公告是AI政策浓度最高的栏目。
 * 首页为服务端渲染（layui静态块），.info-item 含 .title a 与 .date（征求时间区间），
 * 2026-08-10 实测普通UA + fetch即可，无需JS。
 * 非AI条目（大量传统网络安全国标）靠AI筛选闸门过滤；官方源享7天时效窗。
 */
import * as cheerio from 'cheerio';

const HOME_URL = 'https://www.tc260.org.cn/';

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
    const resp = await fetch(HOME_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      console.error(`  [FAIL] TC260爬虫: HTTP ${resp.status}`);
      return articles;
    }

    const $ = cheerio.load(await resp.text());

    $('.info-item').each((_, el) => {
      const item = $(el);
      const link = item.find('.title a').first();
      const title = link.text().trim();
      let href = link.attr('href') || '';
      if (!href || title.length < 5) return;
      if (href.startsWith('/')) href = 'https://www.tc260.org.cn' + href;
      if (seenUrls.has(href)) return;
      seenUrls.add(href);

      // .date 形如 "征求时间 2026-08-04 至 2026-10-03"，取起始日期作为发布日期
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
