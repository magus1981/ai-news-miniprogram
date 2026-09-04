/**
 * 存档增量同步模块（2026-09-04 从 sync-push.mjs 抽出共用）：
 * 对照服务器 GET /api/archive-manifest，把 archiveDir 中服务器没有的一级目录
 * 增量打包推送（POST /api/sync-archive，服务器端逐目录合并、同名覆盖、不动包外存量）。
 * 调用方：sync-push.mjs（每轮采集后）、archive-backfill.mjs（缺档回填）——勿另写一套。
 */
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';

const execFileP = promisify(execFile);

/** 拉取服务器存量存档一级目录名清单（Set） */
export async function fetchArchiveManifest(url, token) {
  const res = await fetch(url.replace(/\/+$/, '') + '/api/archive-manifest', {
    headers: { 'x-sync-token': token },
  });
  if (!res.ok) throw new Error(`manifest 拉取失败 (${res.status}): ${await res.text()}`);
  return new Set(await res.json());
}

/**
 * 增量推送：只打包本地 archiveDir 中服务器没有的目录，无新增则跳过。
 * @param {{url:string, token:string, archiveDir:string}} opts
 * @returns {Promise<{pushed:boolean, newDirs:string[], sizeMB:number}>}
 *   pushed=false 表示无新增目录，未发生上传
 */
export async function syncArchive({ url, token, archiveDir }) {
  const remoteDirs = await fetchArchiveManifest(url, token);
  const localDirs = fs.readdirSync(archiveDir, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name).sort();
  const newDirs = localDirs.filter(d => !remoteDirs.has(d));
  if (newDirs.length === 0) {
    console.log(`[sync] 存档无新增目录（本地 ${localDirs.length} = 服务器 ${remoteDirs.size}），跳过存档推送`);
    return { pushed: false, newDirs: [], sizeMB: 0 };
  }
  const tmpTar = join(archiveDir, '..', 'archive.upload.tgz');
  await execFileP('tar', ['-czf', tmpTar, '-C', archiveDir, ...newDirs], { timeout: 180000 });
  const abuf = fs.readFileSync(tmpTar);
  fs.rmSync(tmpTar, { force: true });
  console.log(`[sync] 增量推送存档: ${newDirs.length} 个新目录, ${(abuf.length / 1024 / 1024).toFixed(2)} MB -> ${url}`);
  const res = await fetch(url.replace(/\/+$/, '') + '/api/sync-archive', {
    method: 'POST',
    headers: { 'x-sync-token': token, 'content-type': 'application/gzip' },
    body: abuf,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`存档推送失败 (${res.status}): ${text}`);
  console.log('[sync] 存档推送成功:', text);
  return { pushed: true, newDirs, sizeMB: abuf.length / 1024 / 1024 };
}
