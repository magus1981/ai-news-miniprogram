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
import http from 'http';
import https from 'https';
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

const size = fs.statSync(dbFile).size;
console.log(`[sync] 上传 ${(size / 1024 / 1024).toFixed(2)} MB -> ${url}`);

// 整库上传改流式 POST：Node 自带 fetch(undici) 有 300 秒总超时，而 38MB 跨境上传实测
// 就要 4-5 分钟（约 150KB/s）——9/21~10/8 的 81 次标红里 62 次掐在 301 秒的 fetch failed，
// 那一轮的新闻就此永久没进生产库。这里总时长不设上限，只按"有没有进展"判死：
// 上传阶段连续 2 分钟字节数不前进、或发完连续 5 分钟没等到响应，才掐断重传
// （整库上传是覆盖式，重传同一份内容安全）。
// 注意别用 req.setTimeout/socket 空闲超时替代它：本地实测慢速上传（3 分钟只写不读）
// 会在 120 秒被 socket 空闲计时器误杀，因为它只认读事件。
const NO_PROGRESS_MS = 120000;
const NO_RESPONSE_MS = 300000;
const ATTEMPTS = 3;
const endpoint = url.replace(/\/+$/, '') + '/api/sync-upload';

function postOnce() {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint);
    const lib = u.protocol === 'https:' ? https : http;
    const src = fs.createReadStream(dbFile);
    let settled = false;
    let lastMove = Date.now();
    let bodySent = false;
    const fail = (msg) => { if (!settled) { settled = true; clearInterval(watchdog); src.destroy(); reject(new Error(msg)); } };
    const done = (val) => { if (!settled) { settled = true; clearInterval(watchdog); resolve(val); } };
    const watchdog = setInterval(() => {
      const idle = Date.now() - lastMove;
      const limit = bodySent ? NO_RESPONSE_MS : NO_PROGRESS_MS;
      if (idle > limit) {
        fail(bodySent ? `发完 ${size} 字节后 ${Math.round(limit / 1000)}s 无响应` : `${Math.round(limit / 1000)}s 无上传进展`);
        req.destroy();
      }
    }, 5000);
    const req = lib.request(u, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(size),
        'x-sync-token': token,
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => done({ status: res.statusCode, body }));
    });
    // pipe 会按对端背压自动暂停，所以"从文件读出多少字节"就是链路真实前进的量
    src.on('data', () => { lastMove = Date.now(); });
    req.on('finish', () => { bodySent = true; lastMove = Date.now(); });
    req.on('error', e => fail(`网络错误: ${e.message}`));
    src.on('error', e => { req.destroy(); fail(`读取本地库失败: ${e.message}`); });
    src.pipe(req);
  });
}

let ok = false;
let lastMsg = '';
for (let i = 1; i <= ATTEMPTS; i++) {
  try {
    const res = await postOnce();
    if (res.status >= 200 && res.status < 300) {
      console.log('[sync] 推送成功:', res.body);
      ok = true;
      break;
    }
    lastMsg = `推送失败 (${res.status}): ${res.body}`;
    // 4xx 是服务器明确拒绝（如防误清库的 409），原样重传没有意义，直接判死
    if (res.status < 500 && res.status !== 408 && res.status !== 429) break;
  } catch (e) {
    lastMsg = e.message;
  }
  if (i < ATTEMPTS) {
    console.warn(`[sync] ${lastMsg} —— ${i * 30} 秒后重传（第 ${i + 1}/${ATTEMPTS} 次）`);
    await new Promise(r => setTimeout(r, i * 30000));
  }
}
if (!ok) {
  console.error('[sync] 整库推送最终失败:', lastMsg);
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
