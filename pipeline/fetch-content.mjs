/**
 * 全文抓取+资料库存档模块（零外部依赖）
 * 对AI筛选后的入选文章抓取原文全文，供摘要生成使用并入库存档。
 * 制度性意义：
 * 1. 摘要基于全文而非RSS片段，从根源上减少"看标题脑补"型幻觉
 * 2. 原文入库后，重新生成摘要/事实二审不再依赖重新采集
 * 3. 资料库（2026-08-10 起）：同时保留正文HTML快照并下载图片到本地，
 *    快照存 content_html 随库同步，图片存 data/archive/{hash}/images/ 随存档通道同步
 * 失败降级：抓取失败的文章保持 content 为空，摘要环节自动退回 snippet
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const execFileP = promisify(execFile);

// curl-impersonate（Chrome TLS指纹）：机器之心等站点WAF按TLS指纹拦截，OpenSSL curl被重定向；
// 工作流会下载 curl_chrome119 到 pipeline/bin/，本地无则回退系统curl
const IMPERSONATE_CANDIDATES = [
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'curl_chrome119'),
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'curl_chrome116'),
];
const CURL_BIN = IMPERSONATE_CANDIDATES.find(p => fs.existsSync(p)) || 'curl';

const FETCH_TIMEOUT_MS = 20000;
const CONCURRENCY = 4;
const MAX_CONTENT_CHARS = 8000;
// 正文有效性下限：低于此长度视为提取失败（多为反爬页/登录墙）
const MIN_CONTENT_CHARS = 200;

// 资料库存档目录（data/archive/{url哈希}/article.html + images/）
const ARCHIVE_ROOT = process.env.ARCHIVE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'archive');
// 单篇图片数量/单张大小上限：防失控页面拖垮采集轮
const MAX_IMAGES_PER_ARTICLE = 20;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * HTML实体解码（覆盖常见实体，足够正文阅读用）
 */
function decodeEntities(s) {
  const map = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
    '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–',
    '&ldquo;': '“', '&rdquo;': '”', '&lsquo;': '‘', '&rsquo;': '’',
    '&hellip;': '…', '&middot;': '·', '&copy;': '©',
  };
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-zA-Z]+;/g, m => map[m] || ' ');
}

/**
 * 去掉HTML中的非正文噪音标签（含内容一起删）
 */
function stripNoise(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, '');
}

/**
 * 从HTML中提取正文（启发式，无DOM库）
 * 优先级：<article> > 常见正文容器class/id > <body>
 * @returns {{text: string, html: string}} 同一候选容器的纯文本与HTML快照
 */
function pickContent(html) {
  const cleaned = stripNoise(html);

  // 候选1：<article> 标签（取最长的一个，部分站点评论区也用article）
  const articleMatches = [...cleaned.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map(m => m[0]);
  // 候选2：常见正文容器（div/section，class或id含关键字）
  const containerRe = /<(div|section)\b[^>]*(?:class|id)="[^"]*(?:article-content|post-content|entry-content|article__content|content-inner|rich_media_content|post-body|article-body)[^"]*"[\s\S]*?<\/\1>/gi;
  const containerMatches = [...cleaned.matchAll(containerRe)].map(m => m[0]);

  const candidates = [...articleMatches, ...containerMatches, cleaned];

  let bestText = '';
  let bestHtml = '';
  for (const c of candidates) {
    // 块级标签转换行，其余标签剥掉
    const text = decodeEntities(
      c.replace(/<\/(p|div|li|h[1-6]|blockquote|tr|section)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
    )
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(line => line.length >= 8) // 过滤导航/按钮类短行
      .join('\n');
    if (text.length > bestText.length) {
      bestText = text;
      bestHtml = c;
    }
    // article/容器级候选已足够长就不再回退到全body（全body噪音多）
    if (bestText.length >= 500 && c !== cleaned) break;
  }
  return { text: bestText.slice(0, MAX_CONTENT_CHARS), html: bestHtml };
}

/**
 * 从HTML中提取正文纯文本（兼容旧导出，供摘要/评论等模块使用）
 */
export function extractText(html) {
  return pickContent(html).text;
}

/**
 * 提取文章HTML快照（与 extractText 同一候选容器，去噪音后原样保留）
 */
export function extractHtml(html) {
  return pickContent(html).html;
}

/**
 * 解析HTML中的图片引用（src/data-src/data-original 兜底懒加载）
 * @returns {Array<{src: string, raw: string, alt: string}>} src为绝对URL，raw为原文属性值（供改写）
 */
function extractImageRefs(html, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (name) => {
      const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i');
      return tag.match(re)?.[1] || null;
    };
    const raw = attr('src') || attr('data-src') || attr('data-original');
    if (!raw) continue;
    let abs;
    try { abs = new URL(raw, baseUrl).href; } catch { continue; }
    if (/^data:/i.test(abs)) continue; // 内联base64图不落盘
    if (!/\.(jpe?g|png|webp|gif)(?:[?#]|$)/i.test(abs)) continue; // 只收位图
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ src: abs, raw, alt: attr('alt') || '' });
  }
  return out;
}

/**
 * 下载单张图片到 {dir}/images/{序号}.{ext}
 * 带 Referer（多数国内站点防盗链按来源校验）
 * @returns {Promise<string|null>} 本地文件名；null=图标/占位图被过滤（不落盘、不算失败）
 */
async function downloadImage(url, dir, index, referer) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Referer': referer,
      'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const ctype = resp.headers.get('content-type') || '';
  if (!/^image\//i.test(ctype)) throw new Error(`非图片内容: ${ctype || 'unknown'}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 1024) return null; // 图标/1px占位图（几百字节），不落盘
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`超限 ${(buf.length / 1024 / 1024).toFixed(1)}MB`);
  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[ctype] || 'jpg';
  const fname = `images/${String(index).padStart(4, '0')}.${ext}`;
  const full = path.join(dir, fname);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf);
  return fname;
}

/**
 * 资料库存档：抓取正文文本+HTML快照，下载图片并重写引用为本地路径
 * @param {string} url 文章URL
 * @returns {Promise<{text: string, html: string, image_count: number, image_fail: number, image_skip: number}|null>}
 *   失败或正文过短返回null（与旧 fetchArticleContent 语义一致）
 */
export async function archiveArticle(url) {
  const adapter = SITE_ADAPTERS.find(a => a.match(url));
  let text = '';
  let html = '';

  if (adapter) {
    const r = await adapter.fetch(url);
    if (!r) return null;
    text = r.text;
    html = r.html;
  } else {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const ctype = resp.headers.get('content-type') || '';
    if (ctype && !/html|xml|text/i.test(ctype)) throw new Error(`非HTML内容: ${ctype}`);
    const pageHtml = await resp.text();
    const picked = pickContent(pageHtml);
    text = picked.text;
    html = picked.html;
  }

  if (!text) return null;

  // 按URL哈希建目录：同一URL跨轮复采复用目录（覆盖更新），不会重复占盘
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 16);
  const dir = path.join(ARCHIVE_ROOT, hash);

  const refs = extractImageRefs(html, url).slice(0, MAX_IMAGES_PER_ARTICLE);
  const rawMap = {};
  let imageCount = 0;
  let imageFail = 0;
  let imageSkip = 0;
  for (let i = 0; i < refs.length; i++) {
    try {
      const fname = await downloadImage(refs[i].src, dir, i + 1, url);
      if (fname) {
        // 按原文属性值改写（而非绝对URL）：兼容协议相对地址 //cdn/… 这类
        // 页面里不出现绝对URL、split绝对URL改不到的情况
        rawMap[refs[i].raw] = `archive/${hash}/${fname}`;
        imageCount++;
      } else {
        imageSkip++;
      }
    } catch (err) {
      imageFail++;
      console.warn(`  [WARN] 图片下载失败 ${refs[i].src.slice(0, 90)}: ${err.message}`);
    }
  }

  // 快照中图片引用改写为本地相对路径（随库/静态服务可回显）
  let snapshot = html;
  for (const [raw, local] of Object.entries(rawMap)) {
    if (raw.length > 4) snapshot = snapshot.split(raw).join(local);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'article.html'), snapshot, 'utf8');

  return { text, html: snapshot, image_count: imageCount, image_fail: imageFail, image_skip: imageSkip };
}

/**
 * 代理模式下的HTTP请求：配了 PROXY_URL/PROXY_TOKEN 就走生产服务器国内IP代拉
 * （机器之心等站点对海外IP封锁，2026-08-07），否则返回null由调用方直连
 */
async function proxyFetchJson(spec) {
  if (!process.env.PROXY_URL || !process.env.PROXY_TOKEN) return null;
  const resp = await fetch(process.env.PROXY_URL.replace(/\/$/, '') + '/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': process.env.PROXY_TOKEN },
    body: JSON.stringify(spec),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS + 5000),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`代理请求失败: ${data.error || resp.status}`);
  return data;
}

/**
 * 站点专用抓取适配器：常规"fetch页面HTML提正文"对SPA/反爬站点无效，
 * 这些站点按域名走专用通道。适配器返回 {text, html}|null，
 * 抛错/返回null时不再走通用抓取（通用抓取对这些站点必然拿到壳页/推广页，
 * 退回让摘要用snippet更安全）。
 *
 * 机器之心（2026-07-30 实测）：文章页为SPA无服务端渲染（正文提取仅十几字），
 * WAF按TLS指纹拦截Node fetch重定向到推广页，但公开JSON端点 /api/v1/articles/{slug}
 * 用系统curl可直接返回含HTML全文的content字段；GraphQL的description/simpleContent已返回空。
 *
 * 网信办（2026-08-07 实测）：详情页服务端渲染无WAF，正文在 <DIV id=BodyLabel> 容器内，
 * 通用提取器的容器class白名单不含该 id，需专用适配器定向截取。
 */
const SITE_ADAPTERS = [
  {
    match: (url) => url.includes('jiqizhixin.com/articles/'),
    fetch: async (url) => {
      const slug = url.match(/articles\/([^/?#]+)/)?.[1];
      if (!slug) return null;
      const apiUrl = `https://www.jiqizhixin.com/api/v1/articles/${slug}`;
      let stdout;
      const proxied = await proxyFetchJson({ url: apiUrl, method: 'GET', headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (proxied) {
        stdout = proxied.body;
      } else {
        ({ stdout } = await execFileP(CURL_BIN, [
          '-sS', '--max-time', String(Math.floor(FETCH_TIMEOUT_MS / 1000)),
          '-A', UA, '-H', 'Accept: application/json',
          apiUrl,
        ], { maxBuffer: 8 * 1024 * 1024 }));
      }
      const data = JSON.parse(stdout);
      if (!data.content) return null;
      const html = `<div>${data.content}</div>`;
      const text = extractText(html);
      return text.length >= MIN_CONTENT_CHARS ? { text, html } : null;
    },
  },
  {
    match: (url) => url.includes('cac.gov.cn'),
    fetch: async (url) => {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      const html = await resp.text();
      // 正文容器 <DIV id=BodyLabel>（属性无引号）；内部还嵌套子div，
      // 简单正则非贪婪会在子div处截断，用深度计数取完整容器
      const open = html.search(/<div[^>]*id=["']?BodyLabel["']?/i);
      let bodyHtml = html;
      if (open >= 0) {
        let depth = 0;
        let end = html.length;
        for (const m of html.slice(open).matchAll(/<\/?div\b[^>]*>/gi)) {
          depth += m[0][1] === '/' ? -1 : 1;
          if (depth === 0) { end = open + m.index + m[0].length; break; }
        }
        bodyHtml = html.slice(open, end);
      }
      const text = extractText(bodyHtml);
      // 公告类正文天然短（备案清单就一两段），低于常规阈值也保留，
      // 只有真正提不出东西才返回null退回标题
      return text.length >= 50 ? { text, html: bodyHtml } : null;
    },
  },
  {
    match: (url) => url.includes('miit.gov.cn'),
    fetch: async (url) => {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      const html = await resp.text();
      // 正文容器 <div class="ccontent center" id="con_con">，服务端直出；
      // 同样用深度计数取完整容器，避免嵌套div截断
      const open = html.search(/<div[^>]*id=["']?con_con["']?/i);
      let bodyHtml = html;
      if (open >= 0) {
        let depth = 0;
        let end = html.length;
        for (const m of html.slice(open).matchAll(/<\/?div\b[^>]*>/gi)) {
          depth += m[0][1] === '/' ? -1 : 1;
          if (depth === 0) { end = open + m.index + m[0].length; break; }
        }
        bodyHtml = html.slice(open, end);
      }
      const text = extractText(bodyHtml);
      return text.length >= 50 ? { text, html: bodyHtml } : null;
    },
  },
];

/**
 * 批量抓取入选文章全文+资料库存档（限并发），结果写在 article.content / article.content_html
 * 单篇失败不中断整体，仅告警并保持 content 为空串
 * @param {Array} articles
 * @returns {Array} 同一批文章（原地补充content/content_html）
 */
export async function fetchFullContents(articles) {
  let ok = 0;
  let fail = 0;
  let imgTotal = 0;
  const queue = [...articles];

  async function worker() {
    while (queue.length) {
      const a = queue.shift();
      try {
        const arch = await archiveArticle(a.source_url);
        if (arch) {
          a.content = arch.text;
          a.content_html = arch.html;
          a.image_count = arch.image_count;
          ok++;
          imgTotal += arch.image_count;
          if (arch.image_count || arch.image_fail || arch.image_skip) {
            console.log(`  [ARCHIVE] 图${arch.image_count}存/${arch.image_fail}败/${arch.image_skip}跳: ${a.title.slice(0, 40)}`);
          }
        } else {
          a.content = '';
          a.content_html = '';
          fail++;
          console.warn(`  [WARN] 正文过短，退回摘要片段: ${a.title.slice(0, 40)}`);
        }
      } catch (err) {
        a.content = '';
        a.content_html = '';
        fail++;
        const reason = err.name === 'TimeoutError' ? `超时(${FETCH_TIMEOUT_MS / 1000}s)` : err.message;
        console.warn(`  [WARN] 全文抓取失败(${reason})，退回摘要片段: ${a.title.slice(0, 40)}`);
      }
      // 精选文章无全文=摘要只能基于RSS片段，主体/数字极易缺失或脑补
      // （2026-07-29深信服CyberGym事故根源），必须显式告警供人工复核
      if (a.is_featured && !a.content) {
        console.warn(`  [ALERT] 精选文章无全文素材，摘要可靠性降级，建议人工复核: ${a.title.slice(0, 40)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`全文抓取完成: 成功 ${ok} 条, 失败退回片段 ${fail} 条, 存档图片 ${imgTotal} 张`);
  return articles;
}