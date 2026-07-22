/**
 * 历史数据tags回填脚本
 * 为 tags 为空（'[]'/NULL/''）的文章调用AI提取子标签并UPDATE，只改 tags 列
 * 限速：每次请求间隔1秒；失败单篇跳过不影响整体
 *
 * 用法：node backfill-tags.mjs
 */
import './load-env.mjs'; // 必须最先加载
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { extractTags } from './ai-summary.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const Database = (await import('better-sqlite3')).default;
  const dbPath = join(__dirname, '..', 'data', 'articles.db');
  const db = new Database(dbPath); // 读写模式

  const rows = db.prepare(
    `SELECT id, title, summary, content, source_name FROM articles
     WHERE tags = '[]' OR tags IS NULL OR tags = ''`
  ).all();

  console.log(`待回填: ${rows.length} 篇`);
  if (rows.length === 0) {
    db.close();
    return;
  }

  const updateStmt = db.prepare('UPDATE articles SET tags = ? WHERE id = ?');
  let success = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const content = row.summary || row.content || row.title;
    const tags = await extractTags({
      title: row.title,
      content,
      source_name: row.source_name,
    });

    if (tags) {
      updateStmt.run(JSON.stringify(tags), row.id);
      success++;
      console.log(`[${i + 1}/${rows.length}] [OK] id=${row.id} ${row.title.slice(0, 30)} -> ${JSON.stringify(tags).slice(0, 120)}`);
    } else {
      failed++;
      console.log(`[${i + 1}/${rows.length}] [FAIL] id=${row.id} ${row.title.slice(0, 30)}`);
    }

    // 限速1秒
    if (i + 1 < rows.length) await sleep(1000);
  }

  // 校验
  const remaining = db.prepare(
    `SELECT COUNT(*) AS c FROM articles WHERE tags = '[]' OR tags IS NULL OR tags = ''`
  ).get().c;

  console.log('\n=== 回填完成 ===');
  console.log(`成功: ${success} 篇, 失败: ${failed} 篇, 剩余无标签: ${remaining} 篇`);
  db.close();
}

main().catch(err => {
  console.error('回填脚本异常:', err);
  process.exit(1);
});
