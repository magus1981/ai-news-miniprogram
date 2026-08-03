import Database from 'better-sqlite3';
import fs from 'node:fs';
const key = process.argv[2] || new Date().toISOString().split('T')[0];
const db = new Database('../data/articles.db', { readonly: true });
const rows = db.prepare(`SELECT id, ai_score s, is_featured f, is_breaking b, source_name src, title, score_detail
  FROM articles WHERE date_key = ? ORDER BY s DESC`).all(key);
const out = [];
const band = (s) => s >= 90 ? '重磅' : s >= 80 ? '重要' : s >= 70 ? '值得看' : s >= 60 ? '可看' : '边缘';
out.push(`=== ${key} 共 ${rows.length} 条 ===`);
const distinct = new Set(rows.map(r => r.s));
out.push(`分数范围 ${Math.min(...rows.map(r => r.s))}-${Math.max(...rows.map(r => r.s))} | distinct=${distinct.size}`);
const byBand = {};
for (const r of rows) byBand[band(r.s)] = (byBand[band(r.s)] || 0) + 1;
out.push(`档位分布: ${Object.entries(byBand).map(([k, v]) => `${k}=${v}`).join(' ')}`);
out.push('');
for (const r of rows) {
  let d = {};
  try { d = JSON.parse(r.score_detail || '{}'); } catch { d = {}; }
  const flags = [r.f ? '精选' : '', r.b ? '突发' : ''].filter(Boolean).join('/');
  out.push(`[${r.id}] ${r.s} ${band(r.s)} ${flags ? '(' + flags + ')' : ''} | ${d.stage || 'rough'} | ${d.role || '?'}${d.capped_from ? ` capped<-${d.capped_from}` : ''} | ${r.src}`);
  out.push(`      ${r.title}`);
  if (d.reason) out.push(`      理由: ${d.reason}`);
}
fs.writeFileSync('tmp-check.txt', out.join('\n') + '\n', 'utf8');
