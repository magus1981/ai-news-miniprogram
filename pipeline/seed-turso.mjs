/**
 * Turso 灌库脚本：把本地 data/articles.db 全量数据灌入 Turso 云数据库
 *
 * 用法：
 *   1. 在 pipeline/.env 配置 TURSO_URL 和 TURSO_AUTH_TOKEN（或直接用环境变量）
 *   2. node seed-turso.mjs
 *
 * 幂等：CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE（按 id / source_url 去重），可重复运行
 * 表结构与本地SQLite完全一致（含 content/tags/key_points 三列）
 */
import './load-env.mjs'; // 必须最先加载
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TURSO_URL = process.env.TURSO_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_AUTH_TOKEN) {
  console.error('错误: 缺少 TURSO_URL 或 TURSO_AUTH_TOKEN');
  console.error('请在 pipeline/.env 中配置，或以环境变量方式传入');
  process.exit(1);
}

// 与本地SQLite完全一致的表结构（含 content/tags/key_points 三列）
const CREATE_TABLE_SQL = `
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
    date_key TEXT NOT NULL,
    content TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    key_points TEXT DEFAULT '[]'
  )`;
const IDX1 = `CREATE INDEX IF NOT EXISTS idx_date_category ON articles(date_key, category)`;
const IDX2 = `CREATE INDEX IF NOT EXISTS idx_featured ON articles(date_key, is_featured)`;

const COLUMNS = [
  'id', 'title', 'original_title', 'source_name', 'source_url', 'category',
  'summary', 'ai_score', 'is_featured', 'published_at', 'collected_at', 'date_key',
  'content', 'tags', 'key_points',
];

async function main() {
  // 1. 读取本地SQLite
  const Database = (await import('better-sqlite3')).default;
  const localPath = join(__dirname, '..', 'data', 'articles.db');
  const local = new Database(localPath, { readonly: true });
  const rows = local.prepare(`SELECT ${COLUMNS.join(', ')} FROM articles`).all();
  local.close();
  console.log(`本地读取: ${localPath}`);
  console.log(`本地行数: ${rows.length}`);
  if (rows.length === 0) {
    console.log('本地无数据，退出');
    return;
  }

  // 2. 连接Turso并建表
  const { createClient } = await import('@libsql/client');
  const turso = createClient({ url: TURSO_URL, authToken: TURSO_AUTH_TOKEN });
  await turso.execute(CREATE_TABLE_SQL);
  await turso.execute(IDX1);
  await turso.execute(IDX2);
  console.log('Turso建表完成（IF NOT EXISTS）');

  // 3. 批量灌入（INSERT OR IGNORE，事务保证效率）
  const insertSQL = `INSERT OR IGNORE INTO articles (${COLUMNS.join(', ')})
    VALUES (${COLUMNS.map(() => '?').join(', ')})`;

  let inserted = 0;
  let skipped = 0;
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const results = await turso.batch(
      batch.map(r => ({ sql: insertSQL, args: COLUMNS.map(c => r[c]) })),
      'write'
    );
    for (const res of results) {
      if (res.rowsAffected > 0) inserted++;
      else skipped++;
    }
    console.log(`灌入进度: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }

  // 4. 计数校验
  const countResult = await turso.execute('SELECT COUNT(*) AS c FROM articles');
  const remoteCount = Number(countResult.rows[0].c);

  console.log('\n=== 灌库完成 ===');
  console.log(`本次新增: ${inserted} 条, 跳过(已存在): ${skipped} 条`);
  console.log(`Turso总行数: ${remoteCount}（本地 ${rows.length} 行）`);
  if (remoteCount < rows.length) {
    console.warn(`警告: Turso行数少于本地，差 ${rows.length - remoteCount} 行，请检查`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('灌库失败:', err.message);
  process.exit(1);
});
