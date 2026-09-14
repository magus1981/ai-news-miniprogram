// prune-archive.mjs — 存档图片修剪（每日 04:50 由 crontab 跑）
// 规则：发布 14 天内的普通文章保图；精选保图 60 天（永久保会持续回涨撑爆存档）；
// 其余删除 images/ 只留 article.html（html 只有几 MB，全量永久保留）。
// 目的：存档曾膨胀到 288MB 且每轮全量拉+推，8/21-8/24 曾因超限 413 连续 9 轮标红。
// 修剪后删除打包缓存，下一轮 sync-archive-download 自动重打小包。
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const DB = '/opt/ai-news/data/articles.db';
const ARCH = '/opt/ai-news/data/archive';
const CUT = new Date(Date.now() - 7 * 86400e3).toISOString(); // published_at 存 UTC ISO
const CUT_FEATURED = new Date(Date.now() - 30 * 86400e3).toISOString();

const rows = execSync(`sqlite3 ${DB} "SELECT source_url, is_featured, published_at FROM articles"`, {
  maxBuffer: 64 * 1024 * 1024,
}).toString().split('\n').filter(Boolean);

const keep = new Set();
for (const r of rows) {
  const [url, feat, pub] = r.split('|');
  if (!url) continue;
  const fresh = pub && (feat === '1' ? pub >= CUT_FEATURED : pub >= CUT);
  if (fresh) {
    keep.add(createHash('sha1').update(url).digest('hex').slice(0, 16));
  }
}

let pruned = 0, freed = 0;
for (const d of fs.readdirSync(ARCH)) {
  if (keep.has(d)) continue;
  const imgDir = path.join(ARCH, d, 'images');
  if (!fs.existsSync(imgDir) || !fs.statSync(imgDir).isDirectory()) continue;
  let has = false;
  for (const f of fs.readdirSync(imgDir)) {
    const fp = path.join(imgDir, f);
    freed += fs.statSync(fp).size;
    fs.rmSync(fp, { force: true });
    has = true;
  }
  if (has) pruned++;
}

fs.rmSync('/opt/ai-news/data/archive.tar.gz', { force: true });
console.log(new Date().toISOString(), `pruned ${pruned} 个非精选旧文章图片目录, 释放 ${(freed / 1e6).toFixed(1)} MB, 缓存包已删待重打`);
