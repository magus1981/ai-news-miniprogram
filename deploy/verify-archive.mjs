// 验证服务器存档:目录文件数 + content_html 列填充情况
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const root = dirname(fileURLToPath(import.meta.url));

// 1) 存档目录统计
const archiveDir = path.join(root, 'data', 'archive');
if (!fs.existsSync(archiveDir)) {
  console.log('[archive dir] MISSING: ' + archiveDir);
} else {
  const dirs = fs.readdirSync(archiveDir);
  let html = 0, imgs = 0, total = 0;
  for (const d of dirs) {
    const sub = path.join(archiveDir, d);
    if (!fs.statSync(sub).isDirectory()) continue;
    if (fs.existsSync(path.join(sub, 'article.html'))) html++;
    const imgDir = path.join(sub, 'images');
    if (fs.existsSync(imgDir)) imgs += fs.readdirSync(imgDir).length;
  }
  total = html + imgs;
  console.log(`[archive] 文章目录:${dirs.length} article.html:${html} 图片:${imgs} 文件总数:${total}`);
  console.log('[archive] 目录样例: ' + dirs.slice(0, 5).join(', '));
}

// 2) DB content_html 列
const Database = (await import('better-sqlite3')).default;
const db = new Database(path.join(root, 'data', 'articles.db'), { readonly: true });
const r = db.prepare(`SELECT COUNT(*) c FROM articles WHERE content_html IS NOT NULL AND content_html != ''`).get();
const s = db.prepare(`SELECT SUM(LENGTH(content_html)) s FROM articles`).get();
console.log(`[db] content_html 有值行数: ${r.c} | HTML 总字节: ${s.s || 0}`);
const rows = db.prepare(`SELECT source_name, title FROM articles WHERE content_html != '' ORDER BY id DESC LIMIT 3`).all();
for (const x of rows) console.log(`  - ${x.source_name} | ${(x.title || '').slice(0, 40)}`);
db.close();