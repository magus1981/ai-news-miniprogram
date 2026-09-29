/**
 * 发布日期提取（date-extract）
 *
 * 背景（2026-09-29 事故修复）：RSS/爬虫返回无 `published_at` 时，
 * 旧代码用 `new Date().toISOString()` 兜底 → 旧闻冒充今日稿；且 date_key 归到今天，
 * 参与精选评分、污染"今日"主列表。修复：入库前尽力从 URL / 正文 / 页面 meta 提取发布日期；
 * 仍提不到的标 date_unknown（不进今日主列表、不评精选、仅 scope=all 可见）。
 *
 * 本模块只提供纯函数，不做副作用；调用方在 collect.mjs / db 清理脚本里决定"提不到"的处置。
 */

// URL 中常见的日期段样式（覆盖国内政务站 + 通用博客 CMS）：
//   /202510/t20251013_1400924.html          发改委/网信办/工信部等 gov CMS
//   /2026/09/29/slug                        WordPress / Medium / 多数海外媒体
//   /2026-09-29/slug                        部分 CMS
//   /20260929/slug                          紧凑段
//   /?p=123&m=20260929                      少数
// 严格：y ∈ [2015, 2100]，mo ∈ [1,12]，d ∈ [1,31]；返回 UTC ISO。
export function extractPublishedFromUrl(url) {
  if (!url) return null;
  const u = String(url);
  let m;

  // 优先：gov CMS 的 /YYYYMM/tYYYYMMDD 结构（发改委、网信办、工信部、上海等）
  m = u.match(/\/(\d{6})\/t(\d{8})[_\-.]/);
  if (m) {
    const iso = ymdToIso(m[2]);
    if (iso) return iso;
  }

  // 通用 /YYYY/MM/DD/ 或 /YYYY-MM-DD/
  m = u.match(/(?:^|[^0-9])(\d{4})[\/\-_.](\d{1,2})[\/\-_.](\d{1,2})(?:[^0-9]|$)/);
  if (m) {
    const ymd = `${m[1]}${String(m[2]).padStart(2, '0')}${String(m[3]).padStart(2, '0')}`;
    const iso = ymdToIso(ymd);
    if (iso) return iso;
  }

  // 紧凑 /YYYYMMDD/
  m = u.match(/(?:^|[^0-9])(20[12]\d(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01]))(?:[^0-9]|$)/);
  if (m) {
    const iso = ymdToIso(m[1]);
    if (iso) return iso;
  }

  return null;
}

/**
 * 从正文 HTML / snippet 中提取发布日期。
 * 顺序：
 *   1. `<meta property="article:published_time" content="...">`
 *   2. `<meta name="pubdate|publishdate|date" content="...">`
 *   3. `<meta itemprop="datePublished" content="...">`
 *   4. JSON-LD `"datePublished":"..."`
 *   5. `<time datetime="...">` / `<time>2025年10月13日</time>`
 *   6. 中文正文 "2025年10月13日"（≥2015）
 *   7. ISO-like "2025-10-13"（≥2015）
 */
export function extractPublishedFromHtml(html) {
  if (!html) return null;
  const h = String(html).slice(0, 240000); // head + 首屏够用了；防超长正文拖慢
  let m;
  m = h.match(/<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|og:published_time|pubdate|publishdate|weibo: article:create_at|date)["'][^>]*content=["']([^"']+)["']/i)
    || h.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["'](?:article:published_time|og:published_time|pubdate|publishdate|date)["']/i);
  if (m) { const d = parseDateLoose(m[1]); if (d) return d; }

  m = h.match(/["']datePublished["']\s*[:=]\s*["']([^"']+)["']/i);
  if (m) { const d = parseDateLoose(m[1]); if (d) return d; }

  m = h.match(/<time[^>]+datetime=["']([^"']+)["']/i);
  if (m) { const d = parseDateLoose(m[1]); if (d) return d; }

  // 中文正文 "2025年10月13日"
  m = h.match(/(20[12]\d)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) {
    const ymd = `${m[1]}${String(m[2]).padStart(2, '0')}${String(m[3]).padStart(2, '0')}`;
    const iso = ymdToIso(ymd);
    if (iso) return iso;
  }

  // 正文裸 ISO
  m = h.match(/\b(20[12]\d)[-\u2013\/](\d{1,2})[-\u2013\/](\d{1,2})\b/);
  if (m) {
    const ymd = `${m[1]}${String(m[2]).padStart(2, '0')}${String(m[3]).padStart(2, '0')}`;
    const iso = ymdToIso(ymd);
    if (iso) return iso;
  }

  return null;
}

/**
 * 综合提取：按 URL → HTML/snippet 顺序，返回 ISO 字符串或 null。
 * @param {{source_url?:string, content_html?:string, content_snippet?:string, content?:string}} art
 * @returns {string|null}
 */
export function resolvePublishedAt(art) {
  if (!art) return null;
  const fromUrl = extractPublishedFromUrl(art.source_url);
  if (fromUrl) return fromUrl;
  const fromHtml = extractPublishedFromHtml(art.content_html || art.content || art.content_snippet);
  if (fromHtml) return fromHtml;
  return null;
}

/** YYYYMMDD → UTC ISO；越界（<2015 或 >2100，或月日非法）返回 null。 */
function ymdToIso(yyyymmdd) {
  if (!/^\d{8}$/.test(yyyymmdd)) return null;
  const y = +yyyymmdd.slice(0, 4);
  const mo = +yyyymmdd.slice(4, 6);
  const da = +yyyymmdd.slice(6, 8);
  if (y < 2015 || y > 2100) return null;
  if (mo < 1 || mo > 12) return null;
  if (da < 1 || da > 31) return null;
  // UTC 当日 01:00，避开时区临界；下游 beijingDayKey 加 8h 恰好归为当日北京。
  const d = new Date(Date.UTC(y, mo - 1, da, 1, 0, 0));
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** 宽松日期解析：ISO / RFC2822 / "2025-10-13 09:00" 等。 */
function parseDateLoose(str) {
  if (!str) return null;
  const s = String(str).trim();
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 2015 || y > 2100) return null;
  return d.toISOString();
}
