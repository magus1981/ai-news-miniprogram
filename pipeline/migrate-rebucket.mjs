/**
 * 一次性迁移：把历史文章的 date_key 从“采集日”改为“真实发布北京日”，
 * 并按发布日重算各天精选、重生成导语（与 2026-07-30 起的新采集口径对齐）。
 *
 * 起因：旧逻辑用采集当天日期做 date_key，72 小时窗口内昨天/前天的新闻被戳成当天，
 *      导致“今天的清单”混进旧闻（用户反馈）。本脚本把存量数据一次性归位。
 *
 * 安全：运行前自动备份 data/articles.db；date_key 与精选改动在一个事务里完成；
 *      导语重生成为独立的 AI 调用循环（失败只影响该日导语，不回滚数据）。
 *
 * 用法：node migrate-rebucket.mjs           # 试运行，只打印将如何归位，不写库
 *       node migrate-rebucket.mjs --apply   # 真正执行
 */
import './load-env.mjs';
import { copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';
import { beijingDayKey, markFeatured } from './ai-filter.mjs';
import { generateDailyIntro } from './ai-intro.mjs';

const APPLY = process.argv.includes('--apply');
const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, '..', 'data', 'articles.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// 1) 读取全部文章的归日相关字段
const rows = db.prepare(
  'SELECT id, published_at, date_key, ai_score, is_featured, category FROM articles'
).all();

// 2) 计算每篇的新 date_key（发布北京日），统计将移动的条数
const moves = [];
for (const r of rows) {
  const newKey = beijingDayKey(r.published_at);
  if (newKey !== r.date_key) moves.push({ id: r.id, from: r.date_key, to: newKey });
}
console.log(`共 ${rows.length} 篇；date_key 将变化 ${moves.length} 篇`);

// 受影响的发布日全集（用于重算精选 + 重生成导语）：所有文章的新发布日
const affectedDays = [...new Set(rows.map(r => beijingDayKey(r.published_at)))].sort();
console.log(`涉及发布日 ${affectedDays.length} 天: ${affectedDays.join(', ')}`);

if (!APPLY) {
  // 试运行：按新发布日预演各天条数与精选，帮用户核对，不写库
  console.log('\n[试运行] 各发布日归位后的构成（非noise）：');
  for (const day of affectedDays) {
    const list = rows
      .filter(r => r.category !== 'noise' && beijingDayKey(r.published_at) === day)
      .map(r => ({ ai_score: r.ai_score, published_at: null }))
      .sort((a, b) => (b.ai_score || 0) - (a.ai_score || 0));
    const feat = markFeatured(list, { existingCount: 0 });
    console.log(`  ${day}: ${list.length} 条，精选将标 ${feat} 条`);
  }
  console.log('\n未写库。确认无误后加 --apply 执行。');
  db.close();
  process.exit(0);
}

// 3) 备份
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const bak = `${dbPath}.bak-rebucket-${stamp}`;
db.pragma('wal_checkpoint(TRUNCATE)'); // 先把 WAL 落盘再拷贝，保证备份完整
copyFileSync(dbPath, bak);
console.log(`已备份: ${bak}`);

// 4) 事务内：改 date_key + 重算各天精选
const updateKey = db.prepare('UPDATE articles SET date_key = ? WHERE id = ?');
const updateFeat = db.prepare('UPDATE articles SET is_featured = ?, is_breaking = 0 WHERE id = ?');

const applyTx = db.transaction(() => {
  for (const m of moves) updateKey.run(m.to, m.id);

  // 重算精选：每个发布日当作首轮(existingCount=0)从头标，与新采集管线一致。
  // 历史行无 newsness 列（markFeatured 里 undefined!=='retro'，不影响按分取），is_breaking 一律清 0（存量非突发）。
  let featTotal = 0;
  for (const day of affectedDays) {
    const dayRows = db.prepare(
      "SELECT id, ai_score, published_at FROM articles WHERE date_key = ? AND category != 'noise' ORDER BY ai_score DESC"
    ).all(day);
    const marked = markFeatured(dayRows, { existingCount: 0 });
    for (const r of dayRows) updateFeat.run(r.is_featured ? 1 : 0, r.id);
    featTotal += marked;
  }
  return featTotal;
});
const featTotal = applyTx();
console.log(`date_key 已归位 ${moves.length} 篇；各发布日重算精选共 ${featTotal} 条`);

// 5) 重生成导语（独立 AI 调用，逐日；失败只跳过该日）
console.log('\n重生成各发布日导语（AI 调用，逐日）...');
const upsertIntro = db.prepare(
  `INSERT INTO daily_meta (date_key, intro) VALUES (?, ?)
   ON CONFLICT(date_key) DO UPDATE SET intro = excluded.intro, created_at = datetime('now')`
);
let introOk = 0;
for (const day of affectedDays) {
  const arts = db.prepare(
    "SELECT title, category, summary, ai_score, is_featured FROM articles WHERE date_key = ? AND category != 'noise' ORDER BY ai_score DESC"
  ).all(day);
  if (!arts.length) continue;
  try {
    const intro = await generateDailyIntro(arts);
    if (intro) {
      upsertIntro.run(day, intro);
      introOk++;
      console.log(`  [OK] ${day}(${arts.length}条) 导语${intro.length}字`);
    } else {
      console.log(`  [SKIP] ${day} 未生成导语`);
    }
  } catch (err) {
    console.warn(`  [FAIL] ${day} 导语生成失败: ${err.message}`);
  }
  await new Promise(r => setTimeout(r, 800)); // 轻微限速，避免连打
}
console.log(`\n导语重生成完成: ${introOk}/${affectedDays.length} 天`);

db.close();
console.log('迁移完成。');
