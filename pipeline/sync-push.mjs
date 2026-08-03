/**
 * 生产数据推送：把本地 articles.db 整库上传到生产服务器（POST /api/sync-upload）
 * 用法: node pipeline/sync-push.mjs
 * 配置: pipeline/.env 中设置 SYNC_URL（如 http://1.2.3.4:3000）和 SYNC_TOKEN
 *       未配置时静默跳过（不影响本地开发流程）
 */
import './load-env.mjs';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const url = (process.env.SYNC_URL || '').trim();
const token = (process.env.SYNC_TOKEN || '').trim();

if (!url || !token) {
  console.log('[sync] 未配置 SYNC_URL/SYNC_TOKEN，跳过推送');
  process.exit(0);
}

const dbFile = join(__dirname, '..', 'data', 'articles.db');
if (!fs.existsSync(dbFile)) {
  console.error('[sync] 本地数据库不存在:', dbFile);
  process.exit(1);
}

const buf = fs.readFileSync(dbFile);
console.log(`[sync] 上传 ${(buf.length / 1024 / 1024).toFixed(2)} MB -> ${url}`);

try {
  const res = await fetch(url.replace(/\/+$/, '') + '/api/sync-upload', {
    method: 'POST',
    headers: { 'x-sync-token': token, 'content-type': 'application/octet-stream' },
    body: buf,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[sync] 推送失败 (${res.status}): ${text}`);
    process.exit(1);
  }
  console.log('[sync] 推送成功:', text);
} catch (e) {
  console.error('[sync] 网络错误:', e.message);
  process.exit(1);
}
