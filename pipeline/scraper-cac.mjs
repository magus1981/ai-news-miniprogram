/**
 * 网信办（cac.gov.cn）政策爬虫
 * 补中国政策信源空白：AI治理法规、生成式AI/深度合成/算法备案公告、征求意见稿均在此发布。
 * 两个静态栏目页（服务端渲染，结构规整，无需JS）：
 * - 网信发布（A093702）：备案公告、征求意见、官方发布——AI政策浓度最高
 * - 政策法规（A093703）：法规/规章/规范性文件/政策解读聚合
 * 列表结构：#loadingInfoPage li > h5 a[href*=c_] + div.times（YYYY-MM-DD）
 * 2026-08-07 实测无反爬，普通 UA + fetch 即可；/cms/JsonList 接口被拦故不用
 */
import * as cheerio from 'cheerio';

const LIST_PAGES = [
  'https://www.cac.gov.cn/wxzw/wxfb/A093702index_1.htm',
  'https://www.cac.gov.cn/wxzw/zcfg/A093703index_1.htm',
];

/**
 * 采集网信办政策发布
 * @param {Object} source - sources.mjs 中的源配置（取 name/category/language/source_type）
 * @returns {Array} - 与RSS源相同形状的文章数组
 *   {title, source_name, source_url, category, language, source_type, content_snippet, published_at}
 */
export async function scrapeCac(source) {
  const articles = [];
  const seenUrls = new Set();

  for (const pageUrl of LIST_PAGES) {
    try {
      const resp = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        console.error(`  [FAIL] 网信办爬虫: ${pageUrl} HTTP ${resp.status}`);
        continue; // 单页失败不影响其他页
      }

      const $ = cheerio.load(await resp.text());

      $('#loadingInfoPage li').each((_, el) => {
        const li = $(el);
        const link = li.find('h5 a').first();
        const title = (link.attr('title') || link.text()).trim();
        let href = link.attr('href') || '';
        if (!href || !/\/\d{4}-\d{2}\/\d{2}\/c_\d+\.htm$/.test(href) || title.length < 5) return;
        if (href.startsWith('//')) href = 'https:' + href;
        if (seenUrls.has(href)) return;
        seenUrls.add(href);

        const dateText = li.find('.times').text().trim();
        const m = dateText.match(/(\d{4})-(\d{2})-(\d{2})/);
        const publishedAt = m ? new Date(`${dateText}T09:00:00+08:00`).toISOString() : null;

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
      // 抓取失败降级：跳过该页，不拖垮整个采集流程
      console.error(`  [FAIL] 网信办爬虫: ${pageUrl} ${error.message}`);
    }
  }

  return articles;
}
