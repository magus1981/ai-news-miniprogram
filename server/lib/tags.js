/**
 * tags / key_points 解析工具（与 local-server.mjs 保持同一逻辑）
 */

// 解析tags列为对象（历史数据为JSON对象字符串，解析失败返回null）
function parseTags(raw) {
  if (!raw || raw === '[]') return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return null;
  } catch {
    return null;
  }
}

// 解析key_points列为数组（解析失败返回[]）
function parseKeyPoints(raw) {
  if (!raw || raw === '[]') return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 构造tag的LIKE匹配值：剥离引号/LIKE通配符防注入
function tagLikePattern(tag) {
  const clean = String(tag).replace(/["%_\\]/g, '');
  return `%"${clean}"%`;
}

module.exports = { parseTags, parseKeyPoints, tagLikePattern };
