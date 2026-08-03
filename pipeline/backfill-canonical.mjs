/**
 * 存量标签归一回填：把 articles.tags 里的实体别名统一为规范名（中文优先）。
 * 纯词典变换、不调用AI；仅当归一后与原值不同才 UPDATE，只改 tags 列。
 *
 * 用法：
 *   node backfill-canonical.mjs        # 应用
 *   node backfill-canonical.mjs --dry  # 仅预览变更，不写库（--dry-run 亦可）
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { canonicalizeTagsObject } from './tag-canonical.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');

async function main() {
  const Database = (await import('better-sqlite3')).default;
  const dbPath = join(__dirname, '..', 'data', 'articles.db');
  const db = new Database(dbPath);

  const rows = db.prepare(
    `SELECT id, title, tags FROM articles WHERE tags IS NOT NULL AND tags != '' AND tags != '[]'`
  ).all();
  console.log(`扫描: ${rows.length} 篇有标签的文章${DRY ? '（预览模式）' : ''}`);

  const updateStmt = db.prepare('UPDATE articles SET tags = ? WHERE id = ?');
  let changed = 0;

  const apply = db.transaction((items) => {
    for (const it of items) updateStmt.run(it.tags, it.id);
  });
  const pending = [];

  for (const row of rows) {
    let parsed;
    try { parsed = JSON.parse(row.tags); }
    catch { console.log(`  [SKIP] id=${row.id} tags非法JSON`); continue; }

    const before = JSON.stringify(parsed);
    const after = JSON.stringify(canonicalizeTagsObject(parsed));
    if (before !== after) {
      changed++;
      pending.push({ id: row.id, tags: after });
      if (changed <= 40) {
        console.log(`  id=${row.id} ${String(row.title).slice(0, 24)}\n     - ${before}\n     + ${after}`);
      }
    }
  }

  if (!DRY && pending.length) apply(pending);

  console.log(`\n=== ${DRY ? '预览' : '回填'}完成 ===`);
  console.log(`需归一: ${changed} 篇 / 共 ${rows.length} 篇${DRY ? '（未写库）' : '（已写库）'}`);
  db.close();
}

main().catch(err => { console.error('回填异常:', err); process.exit(1); });
