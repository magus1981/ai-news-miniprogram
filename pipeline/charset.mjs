/**
 * 字符集安全解码（零外部依赖，仅用 Node 内置 TextDecoder — ICU 完整，
 * 支持 shift_jis / euc-jp / iso-2022-jp / utf-8）。
 *
 * 背景（2026-09-28 事故）：日文政务源（総務省 news.rdf、METI、デジタル庁、各省详情页）
 * 多为 Shift-JIS / EUC-JP。旧代码统一用 resp.text()，Node 内部按 UTF-8 且 errors=replace
 * 解码——对 Shift-JIS 字节流是**不可逆损坏**，产出 U+FFFD(EFBFBD) 乱码写进 content/summary。
 *
 * 解码优先级（严格遵循）：HTTP Content-Type charset → HTML <meta>/XML 声明 encoding → 探测。
 * 探测顺序：utf-8(fatal) → euc-jp(fatal) → shift_jis(fatal) → iso-2022-jp(fatal)，
 * 首个不抛错者胜出；全部失败才退回 utf-8 非致命（此时必然被 mojibake 闸门拦下）。
 *
 * 关键：绝不静默产出乱码。调用方拿到 text 后须用 mojibakeRatio() 自检，
 * 超过阈值一律拒写并告警（见 fetch-content.mjs / collect.mjs 接入点）。
 */

// 编码别名归一（大小写、连字符、常见变体 → TextDecoder 可识别标签）
const LABEL_ALIASES = {
  'utf8': 'utf-8', 'utf-8': 'utf-8',
  'shift_jis': 'shift_jis', 'shift-jis': 'shift_jis', 'sjis': 'shift_jis',
  'cp932': 'shift_jis', 'ms932': 'shift_jis', 'windows-31j': 'shift_jis', 'x-sjis': 'shift_jis',
  'euc-jp': 'euc-jp', 'eucjp': 'euc-jp', 'x-euc-jp': 'euc-jp', 'euc': 'euc-jp',
  'iso-2022-jp': 'iso-2022-jp', 'jis': 'iso-2022-jp', 'iso2022jp': 'iso-2022-jp',
  'gbk': 'gbk', 'gb2312': 'gbk', 'gb-2312': 'gbk', 'euc-cn': 'gbk',
  'gb18030': 'gb18030', 'cp936': 'gbk', 'windows-936': 'gbk', 'ms936': 'gbk',
  'big5': 'big5', 'big5-hkscs': 'big5', 'cp950': 'big5',
  'euc-kr': 'euc-kr', 'euckr': 'euc-kr', 'ksc5601': 'euc-kr', 'cp949': 'euc-kr', 'windows-949': 'euc-kr',
  'utf-16': 'utf-16', 'utf-16le': 'utf-16le', 'utf-16be': 'utf-16be',
};

/** 归一化编码标签；未知/不支持返回 null（TextDecoder 抛错也视作不支持）。 */
export function normalizeLabel(raw) {
  if (!raw) return null;
  const key = String(raw).toLowerCase().trim().replace(/[\s_]/g, m => (m === '_' ? '_' : '')).replace(/[^a-z0-9_-]/g, '');
  const direct = LABEL_ALIASES[String(raw).toLowerCase().trim()] || LABEL_ALIASES[key];
  if (direct) return direct;
  // 兜底：直接问 TextDecoder 认不认这个标签
  try { new TextDecoder(String(raw).toLowerCase().trim()); return String(raw).toLowerCase().trim(); }
  catch { return null; }
}

/** 从 HTTP Content-Type 头取 charset（无则 null）。 */
function charsetFromHeader(contentType) {
  if (!contentType) return null;
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType);
  return normalizeLabel(m && m[1]);
}

/**
 * 从字节流首部嗅探声明编码：
 * - XML 声明 <?xml version="1.0" encoding="Shift_JIS"?>
 * - HTML <meta charset="..."> 或 <meta http-equiv="Content-Type" content="...; charset=...">
 * 只在前 ~4KB（latin1 视角，ASCII 标签可安全定位）内查找。
 */
function charsetFromMarkup(buf) {
  const head = new Uint8Array(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, 4096));
  const ascii = Buffer.from(head).toString('latin1');
  const xml = /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(ascii);
  if (xml) { const l = normalizeLabel(xml[1]); if (l) return l; }
  const metaC = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(ascii);
  if (metaC) { const l = normalizeLabel(metaC[1]); if (l) return l; }
  const metaHttp = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(ascii);
  if (metaHttp) { const l = normalizeLabel(metaHttp[1]); if (l) return l; }
  return null;
}

/** 用 fatal TextDecoder 尝试解码；抛错（字节非法）返回 null。 */
function tryDecode(buf, label) {
  try {
    return new TextDecoder(label, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** U+FFFD 替换符占比（0~1）。空串返回 0。 */
export function mojibakeRatio(text) {
  if (!text || typeof text !== 'string') return 0;
  let bad = 0;
  for (const ch of text) if (ch === '\uFFFD') bad++;
  return bad / text.length;
}

/**
 * 核心：把响应字节按正确的字符集解码为字符串。
 * @param {ArrayBuffer|Buffer} input 原始字节
 * @param {{contentType?: string}} opts HTTP Content-Type 头（可选）
 * @returns {{text: string, encoding: string, declared: string|null, detected: boolean}}
 *   text — 解码结果（可能仍含 U+FFFD，调用方须配合 mojibakeRatio 自检）
 *   encoding — 实际使用的编码
 *   declared — HTTP/meta 显式声明的编码（无则 null）
 *   detected — 是否走了"探测"而非声明
 */
export function decodeBody(input, opts = {}) {
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input instanceof ArrayBuffer ? input : input.buffer, input.byteOffset || 0, input.byteLength);
  if (buf.length === 0) return { text: '', encoding: 'utf-8', declared: null, detected: false };

  // BOM 优先（明确信号）
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)
    return { text: buf.toString('utf8'), encoding: 'utf-8', declared: 'utf-8', detected: false };
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE)
    return { text: buf.toString('utf16le'), encoding: 'utf-16le', declared: 'utf-16le', detected: false };
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF)
    return { text: new TextDecoder('utf-16be').decode(buf), encoding: 'utf-16be', declared: 'utf-16be', detected: false };

  const httpCs = charsetFromHeader(opts.contentType);
  const metaCs = charsetFromMarkup(buf);
  const declared = httpCs || metaCs || null;

  if (declared) {
    // 有显式声明 → 直接按声明解码（非致命：个别非法字节不致整页崩），随后交调用方自检
    const text = new TextDecoder(declared, { fatal: false }).decode(buf);
    return { text, encoding: declared, declared, detected: false };
  }

  // 无声明 → 探测：utf-8(fatal) 最优先（Web 主流），再依次尝试各东亚特异性编码
  // （gb18030/big5 极少抛错、鉴别力低，置于末尾，避免把别家字节误认成中文）
  for (const label of ['utf-8', 'shift_jis', 'euc-jp', 'iso-2022-jp', 'euc-kr', 'gb18030', 'big5']) {
    const text = tryDecode(buf, label);
    if (text !== null) return { text, encoding: label, declared: null, detected: true };
  }
  // 全失败：非致命 utf-8 兜底（会产生 U+FFFD，必被闸门拦下，但仍返回内容避免整轮崩）
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf), encoding: 'utf-8', declared: null, detected: true };
}

/**
 * 便捷封装：给定 fetch Response，读出字节并按正确字符集解码。
 * 用于替换所有 `await resp.text()`。
 * @param {Response} resp
 * @returns {Promise<string>}
 */
export async function readResponseText(resp) {
  const buf = Buffer.from(await resp.arrayBuffer());
  return decodeBody(buf, { contentType: resp.headers.get('content-type') || '' }).text;
}
