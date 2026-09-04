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
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const execFileP = promisify(execFile);

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
// 先拉服务器 manifest（GET /api/archive-manifest），只打包本地 data/archive 中
// 服务器没有的一级目录（增量 tar），无新增则跳过推送。服务器端逐目录合并、
// 不动包外存量目录，天然不会误删历史。
// 失败可见铁律不变：manifest 拉取或存档推送失败都退出码1让工作流标红
// （存档丢一次就是永久丢，禁止静默降级整包重传）
const archiveDir = join(repoRoot, 'data', 'archive');
async function pushArchiveOnce() {
  // 1) 拉服务器存量目录清单
  const mres = await fetch(url.replace(/\/+$/, '') + '/api/archive-manifest', {
    headers: { 'x-sync-token': token },
  });
  if (!mres.ok) throw new Error(`manifest 拉取失败 (${mres.status}): ${await mres.text()}`);
  const remoteDirs = new Set(await mres.json());
  // 2) 对比本地：只打包服务器没有的新目录
  const localDirs = fs.readdirSync(archiveDir, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name).sort();
  const newDirs = localDirs.filter(d => !remoteDirs.has(d));
  if (newDirs.length === 0) {
    console.log(`[sync] 存档无新增目录（本地 ${localDirs.length} = 服务器 ${remoteDirs.size}），跳过存档推送`);
    return;
  }
  const tmpTar = join(repoRoot, 'data', 'archive.upload.tgz');
  try {
    // 增量包：tar -C data/archive 直接以目录名打包（无 archive/ 前缀），
    // 服务器解包后逐目录合并（兼容带/不带前缀两种形态）
    await execFileP('tar', ['-czf', tmpTar, '-C', archiveDir, ...newDirs], { timeout: 180000 });
  } catch (e) {
    console.error('[sync] 存档打包失败:', e.message);
    process.exit(1);
  }
  const abuf = fs.readFileSync(tmpTar);
  fs.rmSync(tmpTar, { force: true });
  console.log(`[sync] 增量推送存档: ${newDirs.length} 个新目录, ${(abuf.length / 1024 / 1024).toFixed(2)} MB -> ${url}`);
  const ares = await fetch(url.replace(/\/+$/, '') + '/api/sync-archive', {
    method: 'POST',
    headers: { 'x-sync-token': token, 'content-type': 'application/gzip' },
    body: abuf,
  });
  const atext = await ares.text();
  if (!ares.ok) throw new Error(`存档推送失败 (${ares.status}): ${atext}`);
  console.log('[sync] 存档推送成功:', atext);
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
