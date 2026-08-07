/**
 * 全文抓取模块（零外部依赖）
 * 对AI筛选后的入选文章抓取原文全文，供摘要生成使用并入库存档。
 * 制度性意义：
 * 1. 摘要基于全文而非RSS片段，从根源上减少"看标题脑补"型幻觉
 * 2. 原文入库后，重新生成摘要/事实二审不再依赖重新采集
 * 失败降级：抓取失败的文章保持 content 为空，摘要环节自动退回 snippet
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const FETCH_TIMEOUT_MS = 20000;
const CONCURRENCY = 4;
const MAX_CONTENT_CHARS = 8000;
// 正文有效性下限：低于此长度视为提取失败（多为反爬页/登录墙）
const MIN_CONTENT_CHARS = 200;

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
 * 从HTML中提取正文纯文本（启发式，无DOM库）
 * 优先级：<article> > 常见正文容器class/id > <body>
 */
export function extractText(html) {
  const cleaned = stripNoise(html);

  // 候选1：<article> 标签（取最长的一个，部分站点评论区也用article）
  const articleMatches = [...cleaned.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map(m => m[0]);
  // 候选2：常见正文容器（div/section，class或id含关键字）
  const containerRe = /<(div|section)\b[^>]*(?:class|id)="[^"]*(?:article-content|post-content|entry-content|article__content|content-inner|rich_media_content|post-body|article-body)[^"]*"[\s\S]*?<\/\1>/gi;
  const containerMatches = [...cleaned.matchAll(containerRe)].map(m => m[0]);

  const candidates = [...articleMatches, ...containerMatches, cleaned];

  let best = '';
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
    if (text.length > best.length) best = text;
    // article/容器级候选已足够长就不再回退到全body（全body噪音多）
    if (best.length >= 500 && c !== cleaned) break;
  }
  return best.slice(0, MAX_CONTENT_CHARS);
}

/**
 * 站点专用抓取适配器：常规"fetch页面HTML提正文"对SPA/反爬站点无效，
 * 这些站点按域名走专用通道。适配器返回 string|null，抛错/返回null时不再走通用抓取
 * （通用抓取对这些站点必然拿到壳页/推广页，退回让摘要用snippet更安全）。
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
      const { stdout } = await execFileP('curl', [
        '-sS', '--max-time', String(Math.floor(FETCH_TIMEOUT_MS / 1000)),
        '-A', UA, '-H', 'Accept: application/json',
        `https://www.jiqizhixin.com/api/v1/articles/${slug}`,
      ], { maxBuffer: 8 * 1024 * 1024 });
      const data = JSON.parse(stdout);
      if (!data.content) return null;
      const text = extractText(`<div>${data.content}</div>`);
      return text.length >= MIN_CONTENT_CHARS ? text : null;
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
      return text.length >= 50 ? text : null;
    },
  },
];

/**
 * 抓取单篇文章正文
 * @returns {string|null} 正文文本；失败或过短返回null
 */
export async function fetchArticleContent(url) {
  const adapter = SITE_ADAPTERS.find(a => a.match(url));
  if (adapter) return adapter.fetch(url);

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
  const html = await resp.text();
  const text = extractText(html);
  return text.length >= MIN_CONTENT_CHARS ? text : null;
}

/**
 * 批量抓取入选文章全文（限并发），结果写在 article.content 字段
 * 单篇失败不中断整体，仅告警并保持 content 为空串
 * @param {Array} articles
 * @returns {Array} 同一批文章（原地补充content）
 */
export async function fetchFullContents(articles) {
  let ok = 0;
  let fail = 0;
  const queue = [...articles];

  async function worker() {
    while (queue.length) {
      const a = queue.shift();
      try {
        const text = await fetchArticleContent(a.source_url);
        if (text) {
          a.content = text;
          ok++;
        } else {
          a.content = '';
          fail++;
          console.warn(`  [WARN] 正文过短，退回摘要片段: ${a.title.slice(0, 40)}`);
        }
      } catch (err) {
        a.content = '';
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
  console.log(`全文抓取完成: 成功 ${ok} 条, 失败退回片段 ${fail} 条`);
  return articles;
}
