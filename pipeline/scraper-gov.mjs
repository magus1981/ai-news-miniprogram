/**
 * 国务院（gov.cn 政策文件库）爬虫
 * 最高权威政策源：“人工智能+”行动意见等国发文件首发地，部门文件也经此统一发布。
 * 走政策文件库底层搜索API（sousuo.www.gov.cn/search-gov/data），JSON返回、按发布时间倒序：
 * - zhengcelibrary_gw：国务院文件（国发/国办发）
 * - zhengcelibrary_bm：部门文件（发改委/科技部/市监总局/数据局等）
 * 文件量级大但AI相关占比低，非AI条目靠AI筛选闸门过滤；官方源享7天时效窗。
 * 2026-08-10 实测普通UA + fetch即可，title字段含<em>高亮标签需剥除
 */
const API_BASE = 'https://sousuo.www.gov.cn/search-gov/data';

// 两类文件库各取最新15条（按发布时间倒序，官方源7天窗口内的都会进来）
const CATS = ['zhengcelibrary_gw', 'zhengcelibrary_bm'];
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
};

/**
 * 采集国务院政策文件库
 * @param {Object} source - sources.mjs 中的源配置（取 name/category/language/source_type）
 * @returns {Array} - 与RSS源相同形状的文章数组
 *   {title, source_name, source_url, category, language, source_type, content_snippet, published_at}
 */
export async function scrapeGov(source) {
  const articles = [];
  const seenUrls = new Set();

  for (const t of CATS) {
    try {
      const params = new URLSearchParams({
        t, q: '', timetype: 'timeqb', mintime: '', maxtime: '',
        sort: 'pubtime', sortType: '1', searchfield: 'title',
        pcodeJiguan: '', childtype: '', subchildtype: '', tsbq: '',
        pubtimeyear: '', puborg: '', pcodeYear: '', pcodeNum: '', filetype: '',
        p: '1', n: '15', inpro: '', bmfl: '', dup: '', orpro: '',
      });
      const resp = await fetch(`${API_BASE}?${params}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        console.error(`  [FAIL] 国务院爬虫: ${t} HTTP ${resp.status}`);
        continue; // 单类失败不影响另一类
      }

      const json = await resp.json();
      const catMap = json?.searchVO?.catMap;
      const list = (catMap && Object.values(catMap)[0]?.listVO) || [];

      for (const d of list) {
        const title = (d.title || '').replace(/<[^>]+>/g, '').trim();
        const href = d.url || '';
        if (!title || !href || title.length < 5 || seenUrls.has(href)) continue;
        seenUrls.add(href);

        // pubtimeStr 形如 "2026.08.03"
        const m = (d.pubtimeStr || '').match(/(\d{4})\.(\d{2})\.(\d{2})/);
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
      }

    } catch (error) {
      console.error(`  [FAIL] 国务院爬虫: ${t} ${error.message}`);
    }
  }

  return articles;
}
