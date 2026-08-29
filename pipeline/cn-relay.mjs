/**
 * 国内IP中继代拉（cn-relay）
 * 背景（2026-08-29 浙江复盘）：部分国内政务站直接切断海外IP连接（Actions runner fetch
 * 报 "fetch failed"，非403而是TCP层不放行），本地/生产服务器（阿里云国内IP）可通。
 * 复用生产服务器 local-server.mjs 已有的 POST /api/proxy 端点（x-sync-token 鉴权，
 * 服务端 Node fetch 转发目标请求，返回 {status, contentType, body}）。
 *
 * 环境变量（workflow 从 secrets.SYNC_URL/SYNC_TOKEN 注入，与机器之心的 PROXY_URL
 * 刻意分开命名——那条通道会切换 jiqizhixin 的抓取路径，勿混用）：
 *   CN_RELAY_URL   中继服务器基址（不含末尾斜杠），如 http(s)://host:port
 *   CN_RELAY_TOKEN 中继鉴权 token
 *
 * 用法：relayAvailable() 为 true 时用 relayFetch 代替 fetch，返回类 Response
 * （{ok, status, text()}），下游解析逻辑零改动。
 */

export function relayAvailable() {
  return !!(process.env.CN_RELAY_URL && process.env.CN_RELAY_TOKEN);
}

/**
 * 经中继代拉一个请求
 * @param {string} url 目标URL（中继限制 https://）
 * @param {{method?: string, headers?: Object, body?: string|null, timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, status: number, text: () => Promise<string>}>}
 */
export async function relayFetch(url, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
  const base = (process.env.CN_RELAY_URL || '').replace(/\/+$/, '');
  const resp = await fetch(`${base}/api/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': process.env.CN_RELAY_TOKEN },
    body: JSON.stringify({ url, method, headers, body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`中继错误: ${data.error || `HTTP ${resp.status}`}`);
  return {
    ok: data.status >= 200 && data.status < 300,
    status: data.status,
    text: async () => data.body,
  };
}
