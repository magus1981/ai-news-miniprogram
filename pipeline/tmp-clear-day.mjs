// 清空指定 date_key 的当日数据，供全链路重跑（articles / daily_meta / source_health）。
// 用法：node tmp-clear-day.mjs 2026-07-30
import Database from 'better-sqlite3';
const key = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(key || '')) {
  console.error('需要 YYYY-MM-DD 参数');
  process.exit(1);
}
const db = new Database('../data/articles.db');
const a = db.prepare('DELETE FROM articles WHERE date_key = ?').run(key);
const m = db.prepare('DELETE FROM daily_meta WHERE date_key = ?').run(key);
const h = db.prepare('DELETE FROM source_health WHERE date_key = ?').run(key);
console.log(`CLEARED ${key}: articles=${a.changes} meta=${m.changes} health=${h.changes}`);
