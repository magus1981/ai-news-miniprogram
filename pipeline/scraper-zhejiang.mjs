/**
 * 浙江省人民政府（zj.gov.cn）政策文件库爬虫
 * 页面端是JS渲染，真实数据来自底层JSON接口（无鉴权、无token）：
 *   POST https://zhengce.zj.gov.cn/policyweb/httpservice/getPolicy.do  (表单格式)
 * 请求参数：regioncode=330000000000000（省级部门文件过滤）+ pageIndex/pageSize
 * 返回 {success, params:{policyList:{data:[{title,iid,pubtime(毫秒戳),policyurl,...}],totalNum}}}
 * 详情页 https://zhengce.zj.gov.cn/policyweb/httpservice/showinfo.do?infoid=<iid>
 * 2026-08-11 实测无UA要求；全库含省市县各级文件，必须按regioncode过滤省级。
 */
const API = 'https://zhengce.zj.gov.cn/policyweb/httpservice/getPolicy.do';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REGION_PROVINCIAL = '330000000000000';
const PAGES = 3;

export async function scrapeZhejiang(source) {
  const articles = [];
  const seenUrls = new Set();

  for (let pageIndex = 1; pageIndex <= PAGES; pageIndex++) {
    try {
      const body = new URLSearchParams({
        regioncode: REGION_PROVINCIAL,
        pageIndex: String(pageIndex),
        pageSize: '20',
        sortKey: '',
      });
      const resp = await fetch(API, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json, text/plain, */*' },
        body: body.toString(),
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) { console.error(`  [FAIL] 浙江爬虫: page ${pageIndex} HTTP ${resp.status}`); break; }
      const json = await resp.json();
      const list = json?.params?.policyList?.data;
      if (!Array.isArray(list) || list.length === 0) break;

      for (const r of list) {
        const title = (r.title || '').trim();
        if (!title || title.length < 5) continue;
        const iid = r.iid;
        const href = r.policyurl || (iid ? `https://zhengce.zj.gov.cn/policyweb/httpservice/showinfo.do?infoid=${iid}` : '');
        if (!href || seenUrls.has(href)) continue;
        seenUrls.add(href);

        // pubtime 为毫秒时间戳
        let publishedAt = null;
        if (typeof r.pubtime === 'number' && r.pubtime > 0) {
          const d = new Date(r.pubtime);
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
      }
    } catch (error) {
      console.error(`  [FAIL] 浙江爬虫: page ${pageIndex} ${error.message}`);
      break;
    }
  }

  return articles;
}
