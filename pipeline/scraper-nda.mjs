/**
 * 国家数据局（nda.gov.cn）爬虫
 * 数据要素×AI政策核心出口：行业高质量数据集建设、数据产权登记、公共数据开发利用等
 * 文件均在此发布（2023年新设机构，发文活跃）。通知公告栏目（tzgg）政策密度最高。
 * 列表页为服务端渲染静态HTML：li > a[title][href*=tzgg] + 相邻 span（YYYY.MM.DD）。
 * 2026-08-10 实测普通UA + fetch即可，无需JS。
 * 非AI条目（课题征集/大赛公告等）靠AI筛选闸门过滤；官方源享7天时效窗。
 */
import * as cheerio from 'cheerio';

const LIST_URL = 'https://www.nda.gov.cn/sjj/zwgk/tzgg/list/index_pc_1.html';

/**
 * 采集国家数据局通知公告
 * @param {Object} source - sources.mjs 中的源配置（取 name/category/language/source_type）
 * @returns {Array} - 与RSS源相同形状的文章数组
 *   {title, source_name, source_url, category, language, source_type, content_snippet, published_at}
 */
export async function scrapeNda(source) {
  const articles = [];
  const seenUrls = new Set();

  try {
    const resp = await fetch(LIST_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      console.error(`  [FAIL] 数据局爬虫: HTTP ${resp.status}`);
      return articles;
    }

    const $ = cheerio.load(await resp.text());

    $('li a[href*="/tzgg/"][title]').each((_, el) => {
      const link = $(el);
      const title = (link.attr('title') || link.text()).trim();
      let href = link.attr('href') || '';
      if (!href || title.length < 5) return;
      if (href.startsWith('/')) href = 'https://www.nda.gov.cn' + href;
      if (seenUrls.has(href)) return;
      seenUrls.add(href);

      // 相邻 span 形如 "2026.07.22"
      const dateText = link.closest('li').find('span').text().trim();
      const m = dateText.match(/(\d{4})\.(\d{2})\.(\d{2})/);
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
    console.error(`  [FAIL] 数据局爬虫: ${error.message}`);
  }

  return articles;
}
