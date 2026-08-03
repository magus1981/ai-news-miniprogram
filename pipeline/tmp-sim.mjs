// 用真正上线的 mergeNearDupTitles 复跑全库：确认它抓到哪几对、有没有误伤。
// 阈值改动后必须复跑这个脚本（见 ai-filter.mjs 的 TITLE_DUP_THRESHOLD 注释）。
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { mergeNearDupTitles, TITLE_DUP_THRESHOLD } from './ai-filter.mjs';

const db = new Database('../data/articles.db', { readonly: true });
const days = db.prepare('SELECT DISTINCT date_key d FROM articles ORDER BY d').all().map(r => r.d);

const out = [`阈值 = ${TITLE_DUP_THRESHOLD}`, ''];
let totalArticles = 0;
let totalDropped = 0;

for (const d of days) {
  const rows = db.prepare('SELECT id, title, original_title, ai_score FROM articles WHERE date_key = ? ORDER BY ai_score DESC').all(d);
  totalArticles += rows.length;
  // 还原AI筛选阶段模型实际看到的文本：那时还没翻译，title 就是源标题
  const input = rows.map(r => ({
    id: r.id,
    title: r.original_title || r.title,
    ai_score: r.ai_score,
    role: 'primary',
  }));
  const res = mergeNearDupTitles(input);
  totalDropped += res.dropped;
  if (res.dropped === 0) continue;
  out.push(`--- ${d}：${rows.length} 条中合并掉 ${res.dropped} 条 ---`);
  for (const a of res.list) {
    if (!a.related_titles || !a.related_titles.length) continue;
    out.push(`  保留 [${a.id}] ${a.title}`);
    for (const t of a.related_titles) out.push(`  并入      ${t}`);
  }
}
out.push('');
out.push(`全库 ${totalArticles} 条，合并掉 ${totalDropped} 条`);
fs.writeFileSync('tmp-sim.txt', out.join('\n') + '\n', 'utf8');
