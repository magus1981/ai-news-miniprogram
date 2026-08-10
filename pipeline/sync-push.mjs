/**
 * 生产数据推送：把本地 articles.db 整库上传到生产服务器（POST /api/sync-upload），
 * 并把资料库存档（data/archive，原文HTML+图片）打包为 tar.gz 一起推送（POST /api/sync-archive）
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

// 资料库存档推送（best-effort 之上的严格模式：存档丢一次就是永久丢，必须失败可见）：
// DB 已推成功，存档推失败时退出码1让工作流标红，但服务器数据不受影响，
// 下一轮会先拉回旧存档再增量，仅本轮图片丢失。
const archiveDir = join(repoRoot, 'data', 'archive');
try {
  if (!fs.existsSync(archiveDir)) {
    console.log('[sync] 无存档目录，跳过图片同步');
    process.exit(0);
  }
  const tmpTar = join(repoRoot, 'data', 'archive.upload.tgz');
  try {
    // Windows/Linux 均带 tar（bsdtar/GNU tar），-C repoRoot/data 后打包 archive 目录名
    await execFileP('tar', ['-czf', tmpTar, '-C', join(repoRoot, 'data'), 'archive'], { timeout: 180000 });
  } catch (e) {
    console.error('[sync] 存档打包失败:', e.message);
    process.exit(1);
  }
  const abuf = fs.readFileSync(tmpTar);
  fs.rmSync(tmpTar, { force: true });
  console.log(`[sync] 上传存档 ${(abuf.length / 1024 / 1024).toFixed(2)} MB -> ${url}`);
  const ares = await fetch(url.replace(/\/+$/, '') + '/api/sync-archive', {
    method: 'POST',
    headers: { 'x-sync-token': token, 'content-type': 'application/gzip' },
    body: abuf,
  });
  const atext = await ares.text();
  if (!ares.ok) {
    console.error(`[sync] 存档推送失败 (${ares.status}): ${atext}`);
    process.exit(1);
  }
  console.log('[sync] 存档推送成功:', atext);
} catch (e) {
  console.error('[sync] 存档推送网络错误:', e.message);
  process.exit(1);
}
