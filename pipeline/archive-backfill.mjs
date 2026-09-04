/**
 * 存档缺档回填（2026-09-04）
 * 背景：Actions 每轮是全新工作区，某轮存档推送失败而 DB 推送成功时，该批文章
 * 下轮会被 getExistingUrls 去重拦住、永不重采——存档从此永久缺失。
 * 本脚本兜底：读 articles.db 全量 source_url → sha1(url)[:16] 与服务器
 * GET /api/archive-manifest 比对 → 对缺失条目调用 fetch-content.mjs 的
 * archiveArticle 重抓原文+图片（写入暂存目录）→ 复用 archive-sync.mjs 增量推送
 * 合并进服务器存档（与采集链路同一套推送代码，不另写一套）。
 *
 * 限流：每次最多补 20 条（--limit N 可调），条间 1.5s，防对源站瞬时高压。
 * 抓不到的（404/超时/正文过短）追加写 pipeline/archive-missing.log（ISO时间\tURL\t原因），
 * 24h 内不重试（防死链卡住队列），不阻塞退出（exit 0）；基建失败（DB/manifest/推送）exit 1。
 * 大缺口分批补：循环调用本脚本即可（缺失条目按 DB 顺序出队）。
 *
 * 用法: node pipeline/archive-backfill.mjs [--limit 20]
 */
import './load-env.mjs';
import fs from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const url = (process.env.SYNC_URL || '').trim();
const token = (process.env.SYNC_TOKEN || '').trim();
if (!url || !token) {
  console.error('[backfill] 未配置 SYNC_URL/SYNC_TOKEN');
  process.exit(1);
}

const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > -1 ? (parseInt(process.argv[limitIdx + 1], 10) || 20) : 20;
const DAY_MS = 86400e3;

const dbPath = process.env.BACKFILL_DB || join(repoRoot, 'data', 'articles.db');
if (!fs.existsSync(dbPath)) {
  console.error('[backfill] 数据库不存在:', dbPath);
  process.exit(1);
}
// 重抓内容先落暂存目录再增量推送：在服务器上跑时 data/archive 就是服务器实时存档，
// 新目录一落盘 manifest 就会包含它、推送比对永远为空，故必须与真实存档隔离
const stagingDir = join(repoRoot, 'data', 'archive.staging');
const missingLog = join(__dirname, 'archive-missing.log');

process.env.ARCHIVE_DIR = stagingDir;
const { fetchArchiveManifest, syncArchive } = await import('./archive-sync.mjs');
const { archiveArticle } = await import('./fetch-content.mjs');

// 1) DB 全量 source_url → 哈希
const db = new Database(dbPath, { readonly: true });
const rows = db.prepare("SELECT source_url FROM articles WHERE source_url LIKE 'http%'").all();
const hashToUrl = new Map();
for (const r of rows) {
  const h = createHash('sha1').update(r.source_url).digest('hex').slice(0, 16);
  if (!hashToUrl.has(h)) hashToUrl.set(h, r.source_url);
}

// 2) 与服务器 manifest 比对
const manifest = await fetchArchiveManifest(url, token);
const missing = [...hashToUrl.entries()].filter(([h]) => !manifest.has(h));

// 3) 24h 内失败过的跳过（防死链反复占用每批名额）
const recentFails = new Map();
try {
  for (const line of fs.readFileSync(missingLog, 'utf8').split('\n')) {
    const m = line.match(/^(\S+)\t(.+?)\t/);
    if (m) recentFails.set(m[2], m[1]);
  }
} catch {}
const now = Date.now();
const candidates = [];
for (const [, u] of missing) {
  const lastFail = recentFails.get(u);
  if (lastFail && now - Date.parse(lastFail) < DAY_MS) continue;
  candidates.push(u);
  if (candidates.length >= LIMIT) break;
}
console.log(`[backfill] DB ${rows.length} 条(唯一URL ${hashToUrl.size}), 服务器存档 ${manifest.size}, 缺口 ${missing.length}, 本批补 ${candidates.length}/${LIMIT}`);

if (candidates.length === 0) {
  console.log('[backfill] 无可补条目（缺口清零，或剩余均为24h内已失败待重试的死链）');
  process.exit(0);
}

// 4) 逐条重抓（串行+间隔=温和限流）
fs.mkdirSync(stagingDir, { recursive: true });
let ok = 0, fail = 0;
const failLines = [];
for (const u of candidates) {
  try {
    const r = await archiveArticle(u);
    if (r) {
      ok++;
      console.log(`  [OK] 图${r.image_count}张: ${u.slice(0, 90)}`);
    } else {
      fail++;
      failLines.push(`${new Date().toISOString()}\t${u}\t正文过短或提取失败`);
      console.warn(`  [MISS] 正文过短: ${u.slice(0, 90)}`);
    }
  } catch (e) {
    fail++;
    failLines.push(`${new Date().toISOString()}\t${u}\t${String(e.message || e).slice(0, 200)}`);
    console.warn(`  [MISS] ${u.slice(0, 90)}: ${e.message}`);
  }
  await new Promise(r2 => setTimeout(r2, 1500));
}
if (failLines.length) fs.appendFileSync(missingLog, failLines.join('\n') + '\n');
console.log(`[backfill] 本批抓取: 成功 ${ok}, 失败 ${fail}`);

// 5) 增量推送补档（与采集链路同一套代码）
const res = await syncArchive({ url, token, archiveDir: stagingDir });
if (res.pushed) {
  // 推送成功即清空暂存（其内容已全部在服务器），失败则保留供下轮重推
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
console.log(`[backfill] 完成: 补档 ${ok} 条, 本批失败 ${fail} 条（已记 ${missingLog}）`);
