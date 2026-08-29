/**
 * 浙江省人民政府（zj.gov.cn）政策文件库爬虫
 * 页面端是JS渲染，真实数据来自底层JSON接口（无鉴权、无token）：
 *   POST https://zhengce.zj.gov.cn/policyweb/httpservice/getPolicy.do  (表单格式)
 * 返回 {success, params:{policyList:{data:[{title,iid,pubtime(毫秒戳),policyurl,...}],totalNum}}}
 * 详情页 https://zhengce.zj.gov.cn/policyweb/httpservice/showinfo.do?infoid=<iid>
 * 省级过滤参数演变（2026-08-28 修复）：原用 regioncode=330000000000000 过滤省级，
 * 该子库2025年11月起停止同步（返回的全是陈旧条目→连续18天0产出）；接口整体仍健康
 * （省政策文件库前端同样在调用，全库最新到当日）。改用 zccjfl=1（层级=省级）：
 * 实测返回2.4万条全部 level=1（省人大法规/省政府/省部门文件及解读），最新到当日。
 * 网络路径（2026-08-29 修复）：zj.gov.cn 集群拒绝海外IP连接（Actions 直连报 fetch failed、
 * raw=0，国内网络直连正常）。改走"直连8s短超时→经生产服务器国内IP中继代拉"降级
 * （cn-relay，workflow 注入 CN_RELAY_URL/CN_RELAY_TOKEN；本地无中继变量时行为不变）。
 */
import { relayAvailable, relayFetch } from './cn-relay.mjs';

const API = 'https://zhengce.zj.gov.cn/policyweb/httpservice/getPolicy.do';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FORM_HEADERS = {
  'User-Agent': UA,
  'Content-Type': 'application/x-www-form-urlencoded',
  'Accept': 'application/json, text/plain, */*',
};
const PAGES = 3;

// 直连失败后本次进程内固定走中继（避免每页都白等一次超时）
let preferRelay = false;

/**
 * 拉一页响应文本：直连优先（8s短超时），失败降级国内中继；两路都断返回 null
 */
async function fetchPageText(formBody) {
  if (!preferRelay) {
    try {
      const resp = await fetch(API, {
        method: 'POST',
        headers: FORM_HEADERS,
        body: formBody,
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) return await resp.text();
      console.error(`  [WARN] 浙江爬虫: 直连 HTTP ${resp.status}`);
    } catch (e) {
      console.error(`  [WARN] 浙江爬虫: 直连失败(${String(e.cause?.message || e.message).slice(0, 80)})`);
    }
    if (!relayAvailable()) return null; // 本地开发无中继配置：维持原行为
    preferRelay = true;
    console.error('  [INFO] 浙江爬虫: 切换经国内服务器中继代拉');
  }
  try {
    const resp = await relayFetch(API, { method: 'POST', headers: FORM_HEADERS, body: formBody, timeoutMs: 30000 });
    if (!resp.ok) { console.error(`  [FAIL] 浙江爬虫: 中继 HTTP ${resp.status}`); return null; }
    return await resp.text();
  } catch (e) {
    console.error(`  [FAIL] 浙江爬虫: 中继失败(${e.message.slice(0, 80)})`);
    return null;
  }
}

export async function scrapeZhejiang(source) {
  const articles = [];
  const seenUrls = new Set();

  for (let pageIndex = 1; pageIndex <= PAGES; pageIndex++) {
    try {
      const body = new URLSearchParams({
        zccjfl: '1', // 省级文件（替代已停更的 regioncode=330000000000000 子库）
        pageIndex: String(pageIndex),
        pageSize: '20',
        sortKey: '',
      }).toString();

      const text = await fetchPageText(body);
      if (!text) break;
      const json = JSON.parse(text);
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
