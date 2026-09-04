/**
 * 生产数据推送：把本地 articles.db 整库上传到生产服务器（POST /api/sync-upload），
 * 并把资料库存档（data/archive，原文HTML+图片）增量推送到生产服务器：
 * 对照 GET /api/archive-manifest 只打包服务器没有的新目录（POST /api/sync-archive 合并）
 * 用法: node pipeline/sync-push.mjs
 * 配置: pipeline/.env 中设置 SYNC_URL（如 http://1.2.3.4:3000）和 SYNC_TOKEN
 *       未配置时静默跳过（不影响本地开发流程）
 */
import './load-env.mjs';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { syncArchive } from './archive-sync.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const url = (process.env.SYNC_URL || '').trim();
const token = (process.env.SYNC_TOKEN || '').trim();

if (!url || !token) {
  console.log('[sync] 未配置 SYNC_URL/SYNC_TOKEN，跳过推送');
  process.exit(0);
}

const repoRoot = join(__dirname, '..');
const dbFile = join(repoRoot, 'data', 'articles.db');
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

// 资料库存档推送（2026-09-04 改增量同步，替代原"整包上传"）：
// 推送逻辑抽在 archive-sync.mjs（与缺档回填 archive-backfill.mjs 共用）：
// 先拉服务器 manifest，只打包本地 data/archive 中服务器没有的新目录，
// 无新增则跳过推送。服务器端逐目录合并、不动包外存量目录，天然不会误删历史。
// 失败可见铁律不变：manifest 拉取或存档推送失败都退出码1让工作流标红
// （存档丢一次就是永久丢——回填兜底见 archive-backfill.mjs，禁止静默降级整包重传）
const archiveDir = join(repoRoot, 'data', 'archive');
async function pushArchiveOnce() {
  return syncArchive({ url, token, archiveDir });
}
try {
  if (!fs.existsSync(archiveDir)) {
    console.log('[sync] 无存档目录，跳过图片同步');
    process.exit(0);
  }
  try {
    await pushArchiveOnce();
  } catch (e) {
    // 2026-08-27：连续9轮因存档超限/瞬时故障标红的教训，重试一次再判死
    console.warn(`[sync] ${e.message}，30秒后重试一次`);
    await new Promise(r => setTimeout(r, 30000));
    await pushArchiveOnce();
  }
} catch (e) {
  console.error('[sync] 存档推送最终失败:', e.message);
  process.exit(1);
}
