// Test a DB file given as argv[2] (default data/articles.db) — run from /opt/ai-news
import Database from 'better-sqlite3';
const path = process.argv[2] || 'data/articles.db';
try {
  const db = new Database(path, { readonly: true });
  console.log('integrity:', JSON.stringify(db.pragma('integrity_check')));
  try {
    const c = db.prepare('SELECT COUNT(*) AS n FROM articles').get();
    const m = db.prepare('SELECT MAX(id) AS m FROM articles').get();
    console.log('articles:', c.n, 'max id:', m.m);
  } catch (e) {
    console.log('query FAIL:', e.message);
  }
  db.close();
} catch (e) {
  console.log('open FAIL:', e.message);
}
