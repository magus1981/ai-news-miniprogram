/**
 * 一次性数据修复：2026-09-29 无日期稿污染 + 政策稿重复入库
 *
 * 场景：09-29 实采轮 (run 36515537943) 引入 15 条 published_at 为空的稿件，
 * 采集期 `normalizePublishedAt` 与 `beijingDayKey` 都用当前时间兜底，导致：
 *   1. 全部以 date_key=2026-09-29 落库，冒充"今日新闻"；
 *   2. 其中 #2090（DeepSeek 官方 V4.1-Flash）拿到 score=80、is_featured=1，
 *      与已在库的 #1507（The Decoder，09-10，score=84、featured）是同一事件，
 *      既重复、又用假日期评上精选。
 *
 * 本脚本：
 *   A. 幂等地跑新加的列迁移（date_unknown / url_norm / title_norm）+ 回填 url_norm/title_norm。
 *   B. 逐条重判今日 15 条无日期稿：
 *        · 能从 URL/正文提取发布日期 → 更新 published_at、date_key 到真实发布日、is_featured=0；
 *        · 提取不到 → date_key='unknown'、date_unknown=1、is_featured=0、published_at=''。
 *   C. 显式合并两组已确认的政策稿重复：
 *        · #2088 + #2116 《跨省跨区电力应急调度管理办法》；
 *        · #2113 + #2114 《互联网平台价格行为规则》；
 *      保留最早发布（同发布日时按较小 id），另一条删除，主条目 merged_count +1。
 *   D. 明确处置 #2090：撤精选、移入 date_unknown 归档，并 bumpMergedCount(#1507, 1)，
 *      把"官方二手发布"作为已有事件 #1507 的合并计数增量（不重复占展示位）。
 *
 * 用法（在 /opt/ai-news 目录下）：
 *   node pipeline/one-time-cleanup-20260929.mjs           # 干跑（dry-run），打印计划、不写库
 *   node pipeline/one-time-cleanup-20260929.mjs --apply   # 真正落库
 *
 * 前提：必须先做带时间戳 + gzip 的 articles.db 备份并验证可恢复；
 *       脚本自身也走 SQLite 事务，出错整轮回滚，不会留半改状态。
 */
import Database from 'better-sqlite3';
import { extractPublishedFromUrl, extractPublishedFromHtml } from './date-extract.mjs';
import { normalizeUrl, normalizeTitle } from './normalize.mjs';

const DB_PATH = process.env.DB_PATH || '/opt/ai-news/data/articles.db';
const APPLY = process.argv.includes('--apply');
const TODAY = '2026-09-29';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function log(...a) { console.log(...a); }
function warn(...a) { console.warn(...a); }

// ─── A. 列迁移 + 回填归一化列（幂等）─────────────────────────────────
function ensureColumns() {
  const cols = new Set(db.prepare(`PRAGMA table_info(articles)`).all().map(r => r.name));
  const adders = [
    ['date_unknown', `ALTER TABLE articles ADD COLUMN date_unknown INTEGER DEFAULT 0`],
    ['url_norm', `ALTER TABLE articles ADD COLUMN url_norm TEXT DEFAULT ''`],
    ['title_norm', `ALTER TABLE articles ADD COLUMN title_norm TEXT DEFAULT ''`],
  ];
  for (const [name, sql] of adders) {
    if (cols.has(name)) { log(`[A] 列已存在: ${name}`); continue; }
    if (!APPLY) { log(`[A] dry-run: 将新增列 ${name}`); continue; }
    db.exec(sql);
    log(`[A] 已新增列: ${name}`);
  }
  if (!APPLY) {
    log('[A] dry-run: 跳过索引创建与归一化列回填');
    return;
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_date_unknown ON articles(date_unknown)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_url_norm ON articles(url_norm)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_title_norm ON articles(title_norm)`);

  // 回填归一化列：只在缺失时补写，避免每次跑全库
  const rows = db.prepare(`SELECT id, source_url, title FROM articles WHERE url_norm = '' OR url_norm IS NULL OR title_norm = '' OR title_norm IS NULL`).all();
  log(`[A] 需回填 url_norm/title_norm 的行数: ${rows.length}`);
  if (!rows.length) return;
  const upd = db.prepare(`UPDATE articles SET url_norm = ?, title_norm = ? WHERE id = ?`);
  const tx = db.transaction(list => {
    for (const r of list) upd.run(normalizeUrl(r.source_url), normalizeTitle(r.title), r.id);
  });
  tx(rows);
  log(`[A] 回填完成: ${rows.length} 行`);
}

// ─── B. 逐条重判今日无日期稿 ────────────────────────────────────────
function reprocessUndated() {
  const rows = db.prepare(`
    SELECT id, title, source_url, source_name, content, content_html, published_at, date_key, is_featured
    FROM articles
    WHERE date_key = ? AND (published_at IS NULL OR published_at = '')
    ORDER BY id
  `).all(TODAY);
  log(`\n[B] 今日(${TODAY}) published_at 为空的稿件: ${rows.length} 条`);

  const upd = APPLY ? db.prepare(`UPDATE articles SET published_at = ?, date_key = ?, date_unknown = ?, is_featured = ? WHERE id = ?`) : null;
  let recovered = 0, unknown = 0;
  for (const r of rows) {
    // 优先级：URL → 正文 HTML → content_snippet；三者都无则 date_unknown。
    let iso = extractPublishedFromUrl(r.source_url);
    let source = 'URL';
    if (!iso) {
      iso = extractPublishedFromHtml(r.content_html || '') || extractPublishedFromHtml(r.content || '');
      if (iso) source = 'HTML/body';
    }
    if (iso) {
      // 归日按北京日：ISO UTC + 8h 后取日；与 beijingDayKey 保持同口径。
      const dk = new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      log(`  [RECOVER] #${r.id} ${r.source_name} "${r.title.slice(0, 40)}" -> ${iso} (${source}), date_key=${dk}, 撤 is_featured=${r.is_featured ? 1 : 0}→0`);
      recovered++;
      if (APPLY) upd.run(iso, dk, 0, 0, r.id);
    } else {
      log(`  [UNKNOWN] #${r.id} ${r.source_name} "${r.title.slice(0, 40)}" -> 无法提取发布日期, 移入 date_unknown, 撤 is_featured=${r.is_featured ? 1 : 0}→0`);
      unknown++;
      if (APPLY) upd.run('', 'unknown', 1, 0, r.id);
    }
  }
  log(`[B] 汇总: 恢复发布日期 ${recovered} 条 / 移入 date_unknown ${unknown} 条${APPLY ? ' (已落库)' : ' (dry-run 未落库)'}`);
}

// ─── C. 显式合并政策稿重复 ───────────────────────────────────────────
// 两组重复由人工审核确认（同日同文件、不同 source_url、标题近似但归一化后不完全一致）
// 后续批内 URL 归一化 + 跨库标题/事件名合并 + AI 跨期事件去重共同覆盖，本处只做一次性收口。
const DUPLICATE_GROUPS = [
  { keep: 2088, drop: 2116, label: '《跨省跨区电力应急调度管理办法》' },
  { keep: 2113, drop: 2114, label: '《互联网平台价格行为规则》' },
];
function mergeDuplicates() {
  log(`\n[C] 政策稿重复合并: ${DUPLICATE_GROUPS.length} 组`);
  const getById = db.prepare(`SELECT id, title, date_key, published_at, ai_score, is_featured, merged_count FROM articles WHERE id = ?`);
  const bump = APPLY ? db.prepare(`UPDATE articles SET merged_count = COALESCE(merged_count,0) + 1 WHERE id = ?`) : null;
  const del = APPLY ? db.prepare(`DELETE FROM articles WHERE id = ?`) : null;
  for (const g of DUPLICATE_GROUPS) {
    const keep = getById.get(g.keep);
    const drop = getById.get(g.drop);
    if (!keep || !drop) { warn(`  [SKIP] ${g.label} 主/副条目缺失 (keep #${g.keep}=${!!keep}, drop #${g.drop}=${!!drop})`); continue; }
    log(`  [MERGE] ${g.label}: 保留 #${keep.id} "${keep.title.slice(0, 40)}" (${keep.published_at || '(空)'}, ${keep.ai_score}分), 删除 #${drop.id} "${drop.title.slice(0, 40)}", merged_count ${keep.merged_count || 0} -> ${(keep.merged_count || 0) + 1}`);
    if (APPLY) { bump.run(g.keep); del.run(g.drop); }
  }
}

// ─── D. DeepSeek 假精选专项处理 ──────────────────────────────────────
const DEEPSEEK_FAKE_ID = 2090;
const DEEPSEEK_CANONICAL_ID = 1507;
function fixDeepSeekDup() {
  log(`\n[D] DeepSeek V4.1-Flash 假精选专项处理`);
  const fake = db.prepare(`SELECT id, title, source_name, date_key, published_at, is_featured, ai_score, event_norm FROM articles WHERE id = ?`).get(DEEPSEEK_FAKE_ID);
  const canon = db.prepare(`SELECT id, title, source_name, date_key, published_at, is_featured, ai_score, event_norm FROM articles WHERE id = ?`).get(DEEPSEEK_CANONICAL_ID);
  if (!fake) { log(`  [SKIP] #${DEEPSEEK_FAKE_ID} 不存在或已被处理`); return; }
  if (!canon) { warn(`  [WARN] 主稿 #${DEEPSEEK_CANONICAL_ID} 缺失；仍按无日期归档处理`); }
  log(`  当前状态 假 #${fake.id}: date_key=${fake.date_key} pub="${fake.published_at || '(空)'}" featured=${fake.is_featured} score=${fake.ai_score} event_norm="${fake.event_norm || ''}"`);
  if (canon) log(`  参考主稿 #${canon.id}: ${canon.source_name} date_key=${canon.date_key} pub=${canon.published_at} featured=${canon.is_featured} score=${canon.ai_score} event_norm="${canon.event_norm || ''}"`);

  // 处置：撤精选、移入 date_unknown、回填 event_norm 与主稿一致供相关阅读；主稿 merged_count +1。
  if (APPLY) {
    db.prepare(`UPDATE articles SET is_featured = 0, date_key = 'unknown', published_at = '', date_unknown = 1, event_norm = COALESCE(NULLIF(event_norm,''), ?) WHERE id = ?`)
      .run(canon?.event_norm || 'deepseekv41flash发布', DEEPSEEK_FAKE_ID);
    if (canon) db.prepare(`UPDATE articles SET merged_count = COALESCE(merged_count,0) + 1 WHERE id = ?`).run(DEEPSEEK_CANONICAL_ID);
    log(`  [APPLIED] #${DEEPSEEK_FAKE_ID} 撤精选+移入 unknown；主稿 #${DEEPSEEK_CANONICAL_ID} merged_count +1`);
  } else {
    log(`  [DRY] 将对 #${DEEPSEEK_FAKE_ID} 执行: is_featured=0, date_key='unknown', published_at='', date_unknown=1, event_norm='${canon?.event_norm || 'deepseekv41flash发布'}'；对 #${DEEPSEEK_CANONICAL_ID} merged_count +1`);
  }
}

function summary() {
  const q = sql => db.prepare(sql).get();
  const todayMain = q(`SELECT COUNT(*) c FROM articles WHERE date_key='${TODAY}' AND category != 'noise'`).c;
  const todayFeat = q(`SELECT COUNT(*) c FROM articles WHERE date_key='${TODAY}' AND is_featured=1 AND category != 'noise'`).c;
  const undated = q(`SELECT COUNT(*) c FROM articles WHERE published_at='' OR published_at IS NULL`).c;
  const unknownPool = q(`SELECT COUNT(*) c FROM articles WHERE date_key='unknown'`).c;
  log(`\n[SUMMARY] date_key=${TODAY}: 主列表 ${todayMain} 条 / 精选 ${todayFeat} 条`);
  log(`[SUMMARY] 全库无日期(published_at 空): ${undated} 条`);
  log(`[SUMMARY] date_key='unknown' 归档池: ${unknownPool} 条`);
}

function main() {
  log(`=== 一次性数据修复 2026-09-29 ===`);
  log(`DB_PATH=${DB_PATH}`);
  log(`MODE=${APPLY ? 'APPLY（写库）' : 'DRY-RUN（不写库）'}`);
  if (!APPLY) log('提示: 追加 --apply 参数以真正落库；本会话应先完成带时间戳+gzip 备份再执行。');
  const txn = APPLY ? db.transaction(() => {
    ensureColumns();
    reprocessUndated();
    mergeDuplicates();
    fixDeepSeekDup();
  }) : null;
  if (APPLY) {
    txn();
    log('\n事务已提交。');
  } else {
    ensureColumns();
    reprocessUndated();
    mergeDuplicates();
    fixDeepSeekDup();
    log('\ndry-run 结束，未做任何写入。');
  }
  summary();
}

main();
