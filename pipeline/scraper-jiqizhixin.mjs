/**
 * 机器之心网页爬虫
 * 机器之心RSS源(https://www.jiqizhixin.com/rss)已下线（302跳转至付费数据服务页），
 * 列表页为React SPA无服务端渲染，改为调用其站内GraphQL接口(/graphql)采集。
 *
 * 实测要点（2026-07 验证）：
 * - 需先GET /articles 取 Cookie + csrf-token，POST时带 X-CSRF-Token，否则报"请刷新页面重试"
 * - 站点WAF按TLS指纹拦截 Node 原生 fetch（实测几乎100%被重定向到"数据服务"推广页），
 *   而 curl(Schannel) 100% 放行，故HTTP层通过 child_process 调用系统 curl（Windows自带）
 * - timelines 查询的 union content 字段遇到 MemberOnlyContent（会员专享置顶条目）会触发服务端500，
 *   故分两步：先只取 id/contentType/cursor（不会500），再按连续Article段带content查询，跳过会员条目
 * - publishedAt 格式为 "2026/07/22 16:58"（北京时间），手动按 +08:00 解析
 * 只取列表第一页，与量子位爬虫同一套超时/降级标准
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileP = promisify(execFile);

// curl-impersonate（模拟Chrome TLS指纹）：机器之心WAF 2026-08-07起按TLS指纹拦截，
// OpenSSL系 curl/wget 全被重定向到推广页，只有Chrome指纹能过。
// Actions 工作流会下载 curl_chrome119 到 pipeline/bin/；本地开发无此文件则回退系统curl（Windows Schannel指纹可过）
const IMPERSONATE_CANDIDATES = [
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'curl_chrome119'),
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'curl_chrome116'),
];
const CURL_BIN = IMPERSONATE_CANDIDATES.find(p => fs.existsSync(p)) || 'curl';

const SITE = 'https://www.jiqizhixin.com';
const LIST_PAGE_URL = `${SITE}/articles`;
const GRAPHQL_URL = `${SITE}/graphql`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_SEC = 15;
const MAX_ARTICLES = 20; // 只取第一页
const TIMELINE_SIZE = 30; // 时间线窗口（含少量非文章条目，多取一些兜底）

// 第一步：只取ID/类型/游标（不触碰union content，避免会员条目导致服务端500）
const TIMELINE_IDS_QUERY = `{ timelines(first: ${TIMELINE_SIZE}) { edges { cursor node { id contentType } } } }`;
// 第二步：按连续Article段取内容
const SEGMENT_QUERY = (first, after) =>
  `{ timelines(first: ${first}${after ? `, after: "${after}"` : ''}) { edges { node { id contentType content { __typename ...on Article { path title publishedAt description simpleContent } } } } } }`;

/**
 * 调用系统curl（WAF对Node fetch的TLS指纹几乎全部拦截，curl稳定放行）
 * 2026-08-07 补充：机器之心 WAF 开始拦海外IP（Actions 的 curl 被重定向到推广页），
 * 配置 PROXY_URL/PROXY_TOKEN 时改走生产服务器（国内IP）的 /api/proxy 代拉，
 * 本地开发不设这两个变量即直连。
 * @returns {Promise<{status: number, headers: string, body: string}>}
 */
async function curlFetch(url, { method = 'GET', headers = {}, body = null } = {}) {
  // 代理模式：借服务器国内IP绕海外封锁
  if (process.env.PROXY_URL && process.env.PROXY_TOKEN) {
    const resp = await fetch(process.env.PROXY_URL.replace(/\/$/, '') + '/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-token': process.env.PROXY_TOKEN },
      body: JSON.stringify({ url, method, headers, body }),
      signal: AbortSignal.timeout(TIMEOUT_SEC * 1000 + 5000),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(`代理请求失败: ${data.error || resp.status}`);
    // 把 setCookies 拼回类HTTP头格式，与直连模式的下游解析逻辑保持一致
    const cookieHeaders = (data.setCookies || []).map(c => `set-cookie: ${c}`).join('\r\n');
    return { status: data.status, headers: cookieHeaders, body: data.body };
  }

  const args = ['-sS', '-i', '--max-time', String(TIMEOUT_SEC)];
  for (const [k, v] of Object.entries(headers)) {
    args.push('-H', `${k}: ${v}`);
  }
  if (method === 'POST') {
    args.push('-X', 'POST');
    if (body != null) args.push('--data-raw', body);
  }
  args.push(url);

  let stdout;
  try {
    ({ stdout } = await execFileP(CURL_BIN, args, { maxBuffer: 8 * 1024 * 1024 }));
  } catch (err) {
    // curl非零退出（超时/网络错误等）
    throw new Error(`curl失败: ${err.message.slice(0, 150)}`);
  }

  // -i 输出：响应头与 body 以空行分隔（只按第一个空行切分）
  const sep = stdout.indexOf('\r\n\r\n');
  const head = sep >= 0 ? stdout.slice(0, sep) : '';
  const respBody = sep >= 0 ? stdout.slice(sep + 4) : stdout;
  const statusMatch = head.match(/^HTTP\/[\d.]+ (\d+)/);
  return { status: statusMatch ? parseInt(statusMatch[1]) : 0, headers: head, body: respBody };
}

/**
 * 解析机器之心时间格式 "2026/07/22 16:58"（北京时间）为ISO字符串
 */
function parsePublishedAt(text) {
  const m = (text || '').trim().match(/(\d{4})\/(\d{1,2})\/(\d{1,2})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:${s || '00'}+08:00`;
    const t = new Date(iso);
    if (!isNaN(t.getTime())) return t.toISOString();
  }
  // 兜底：尝试直接解析（ISO等其他格式）
  const t = new Date(text);
  return isNaN(t.getTime()) ? null : t.toISOString();
}

/**
 * GET列表页，获取CSRF令牌和会话Cookie（WAF概率性拦截时重试最多3次）
 */
async function fetchCsrfContext() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await curlFetch(LIST_PAGE_URL, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });
      if (res.status !== 200) throw new Error(`列表页 HTTP ${res.status}`);
      const tokenMatch = res.body.match(/csrf-token" content="([^"]+)"/);
      if (!tokenMatch) throw new Error('未找到CSRF令牌（可能被WAF拦截到推广页）');
      const cookies = [];
      for (const m of res.headers.matchAll(/^set-cookie:\s*([^;\r\n]+)/gim)) {
        cookies.push(m[1]);
      }
      return { token: tokenMatch[1], cookie: cookies.join('; ') };
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        console.error(`  [WARN] 机器之心爬虫: 第${attempt}次获取页面失败(${err.message})，1秒后重试`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  throw lastErr;
}

/**
 * 发起GraphQL查询
 */
async function gql(query, ctx) {
  const res = await curlFetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-Token': ctx.token,
      ...(ctx.cookie ? { 'Cookie': ctx.cookie } : {}),
    },
    body: JSON.stringify({ query }),
  });
  if (res.status !== 200) throw new Error(`GraphQL HTTP ${res.status}`);
  const data = JSON.parse(res.body);
  if (data.errors) throw new Error(`GraphQL错误: ${JSON.stringify(data.errors).slice(0, 200)}`);
  return data.data;
}

/**
 * 采集机器之心资讯
 * @param {Object} source - sources.mjs 中的源配置（取 category/language/source_type）
 * @returns {Array} - 与RSS源相同形状的文章数组
 *   {title, source_name, source_url, category, language, source_type, content_snippet, published_at}
 */
export async function scrapeJiqizhixin(source) {
  try {
    const ctx = await fetchCsrfContext();

    // 第一步：取时间线条目ID/类型/游标
    const idData = await gql(TIMELINE_IDS_QUERY, ctx);
    const edges = idData?.timelines?.edges || [];
    if (edges.length === 0) {
      console.error('  [FAIL] 机器之心爬虫: 时间线为空');
      return [];
    }

    // 把连续的Article条目划分为段（跳过MemberOnlyContent等会触发500的条目）
    const segments = [];
    let current = null;
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (edge.node.contentType === 'Article') {
        if (!current) {
          current = { after: i > 0 ? edges[i - 1].cursor : null, count: 0 };
          segments.push(current);
        }
        current.count++;
      } else {
        current = null;
      }
    }

    // 第二步：逐段取文章内容
    const articles = [];
    const seenUrls = new Set();
    for (const seg of segments) {
      if (articles.length >= MAX_ARTICLES) break;
      const want = Math.min(seg.count, MAX_ARTICLES - articles.length);
      try {
        const data = await gql(SEGMENT_QUERY(want, seg.after), ctx);
        for (const edge of data?.timelines?.edges || []) {
          const c = edge.node.content;
          if (edge.node.contentType !== 'Article' || !c || !c.path) continue;
          const url = SITE + c.path;
          const title = (c.title || '').trim();
          if (!title || seenUrls.has(url)) continue;
          seenUrls.add(url);
          const snippet = (c.description || c.simpleContent || title).trim();
          articles.push({
            title,
            source_name: source.name,
            source_url: url,
            category: source.category,
            language: source.language,
            source_type: source.source_type,
            content_snippet: snippet.slice(0, 2000),
            published_at: parsePublishedAt(c.publishedAt), // ISO串或null，由collect.mjs时效过滤统一处理
          });
        }
      } catch (segErr) {
        // 单段失败（如窗口内混入会员条目）：跳过该段，不影响其他段
        console.error(`  [WARN] 机器之心爬虫: 分段查询失败，跳过 ${seg.count} 条: ${segErr.message}`);
      }
    }

    return articles;

  } catch (error) {
    // 抓取失败降级：返回空数组，不拖垮整个采集流程
    console.error(`  [FAIL] 机器之心爬虫: ${error.message}`);
    return [];
  }
}
