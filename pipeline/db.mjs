/**
 * 数据库连接与写入
 * 本地模式：TURSO_URL未设置时，使用本地SQLite文件（零注册）
 * 云端模式：设置TURSO_URL后，使用Turso云数据库
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TURSO_URL = process.env.TURSO_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const LOCAL_MODE = !TURSO_URL;

let db;

if (LOCAL_MODE) {
  // 本地模式：使用 better-sqlite3
  const Database = (await import('better-sqlite3')).default;
  const dbPath = join(__dirname, '..', 'data', 'articles.db');
  // 确保data目录存在
  const { mkdirSync } = await import('fs');
  mkdirSync(join(__dirname, '..', 'data'), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  console.log(`本地模式: 数据库文件 ${dbPath}`);
} else {
  // 云端模式：使用 Turso
  const { createClient } = await import('@libsql/client');
  db = createClient({ url: TURSO_URL, authToken: TURSO_AUTH_TOKEN });
  console.log('云端模式: Turso');
}

/**
 * 初始化数据表
 */
export async function initDB() {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      original_title TEXT,
      source_name TEXT NOT NULL,
      source_url TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      summary TEXT,
      ai_score REAL,
      is_featured INTEGER DEFAULT 0,
      published_at TEXT NOT NULL,
      collected_at TEXT DEFAULT (datetime('now')),
      date_key TEXT NOT NULL
    )`;
  const idx1 = `CREATE INDEX IF NOT EXISTS idx_date_category ON articles(date_key, category)`;
  const idx2 = `CREATE INDEX IF NOT EXISTS idx_featured ON articles(date_key, is_featured)`;

  if (LOCAL_MODE) {
    db.exec(createTableSQL);
    db.exec(idx1);
    db.exec(idx2);
  } else {
    await db.execute(createTableSQL);
    await db.execute(idx1);
    await db.execute(idx2);
  }
  console.log('数据库表初始化完成');
}

/**
 * 批量插入文章
 */
export async function insertArticles(articles) {
  let inserted = 0;
  let skipped = 0;

  const insertSQL = `INSERT OR IGNORE INTO articles 
    (title, original_title, source_name, source_url, category, summary, ai_score, is_featured, published_at, date_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  for (const article of articles) {
    const args = [
      article.title,
      article.original_title || null,
      article.source_name,
      article.source_url,
      article.category,
      article.summary || null,
      article.ai_score || null,
      article.is_featured ? 1 : 0,
      article.published_at,
      article.date_key,
    ];

    try {
      if (LOCAL_MODE) {
        const result = db.prepare(insertSQL).run(...args);
        if (result.changes > 0) inserted++;
        else skipped++;
      } else {
        await db.execute({ sql: insertSQL, args });
        inserted++;
      }
    } catch (err) {
      if (err.message?.includes('UNIQUE constraint')) {
        skipped++;
      } else {
        console.error(`插入失败: ${article.title}`, err.message);
        skipped++;
      }
    }
  }

  console.log(`写入完成: 新增 ${inserted} 条, 跳过 ${skipped} 条(重复)`);
  return { inserted, skipped };
}
