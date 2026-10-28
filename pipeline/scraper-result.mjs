/**
 * 爬虫返回值契约（2026-10-28 可观测性修复）
 *
 * 背景：collect.mjs 旧实现对 scraper 型源恒写 error:null，于是"HTTP 200 但解析 0 命中"
 * 与"网络断""被反爬 403""选择器失效"在 source_health 里长得一模一样（raw=0/error 空），
 * 2026-10-21 起 Anthropic 与 DeepSeek 静默归零 8 到 10 天无人发现即为此。
 *
 * 契约：爬虫返回一个数组，并在数组上挂三个可选元数据字段（数组仍是数组，
 * 老调用方 `articles.length`、自测 CLI、既有单测全部不受影响）：
 *   matched      解析阶段命中的卡片数（未经时效过滤），0 即"选择器/页面结构问题"
 *   http_status  列表页 HTTP 状态码，非 2xx 即"被拦/挂了"
 *   error        爬虫内部吞掉的异常文本（网络、解析、反爬）
 * collect 侧用 readScrapeMeta 读出并组成 source_health.error。
 */

/** 在爬虫返回的数组上挂元数据，原数组就地返回（便于 `return withScrapeMeta(arts, {...})`） */
export function withScrapeMeta(articles, meta = {}) {
  const arr = Array.isArray(articles) ? articles : [];
  if (typeof meta.matched === 'number') arr.matched = meta.matched;
  if (typeof meta.http_status === 'number') arr.http_status = meta.http_status;
  if (meta.error) arr.error = String(meta.error).slice(0, 200);
  return arr;
}

/**
 * 读出元数据并压成一行 source_health.error 文本。
 * @param {Array} articles 爬虫返回值（可能不带元数据）
 * @param {{freshCount:number, thrown?:string|null}} ctx collect 侧上下文
 * @returns {string|null} null 表示一切正常；有异常时给可区分的标记串
 */
export function scrapeHealthError(articles, { freshCount = 0, thrown = null } = {}) {
  if (thrown) return `SCRAPER_THROW ${String(thrown).slice(0, 180)}`;
  const matched = typeof articles?.matched === 'number' ? articles.matched : null;
  const status = typeof articles?.http_status === 'number' ? articles.http_status : null;
  const inner = articles?.error || null;
  if (inner) return `SCRAPER_ERROR ${inner}`;
  if (matched === 0) return `PARSED_ZERO http=${status ?? 'n/a'}（页面结构或选择器疑似变更）`;
  if (status !== null && (status < 200 || status >= 300)) return `HTTP ${status}`;
  if (matched === null && articles?.length === 0) return 'ZERO_NO_META（爬虫未上报 http/matched）';
  if (freshCount === 0 && (matched ?? 0) > 0) return `FILTERED_ALL matched=${matched}（出时效窗或全被去重）`;
  return null;
}
