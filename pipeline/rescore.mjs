/**
 * 全库重评：用现行评分标准（档位+全局排名+日配额）重打历史文章的分数
 *
 * 为什么需要它：评分标准经历过多次演进（2026-07-30 从单一总分制改为档位排名制并加锚点），
 * 演进之前入库的分数是旧尺子量的——「阿里云适配Kimi K3」97分（现行锚点标定62）就是实例。
 * 新旧分混在同一个榜单里排序（如 /api/archive 按分数排）对新文章天然不公平。
 *
 * 用法：
 *   node rescore.mjs                 # 干跑：只打印每篇 旧分->新分 与精选变化，不写库
 *   node rescore.mjs --apply         # 落库（先自动备份 data/articles.db）
 *   node rescore.mjs --days 2026-07-22,2026-07-23   # 只重评指定日期（默认：所有含旧标准分的天）
 *
 * 口径与采集管线完全一致（同一套函数，不是复刻）：
 * - 逐天调用 refineScores：档位配额是"日"配额，跨天混跑会让配额失去意义；
 *   每天附带该天视角的近10天已入库标题作旧闻对照，与当时采集所见一致
 * - 衍生稿沿用 applyRoleCeiling 封顶72（role 从旧 score_detail 里读，读不到按当事方处理）
 * - 精选用 markFeatured 整天重算（>=80才给、预算5条、宁缺毋滥）；
 *   is_breaking 是"当时的突发"标记，重评后分数掉出85的顺带摘掉，仍够85的保留
 * - 旧的 score_detail 会整体嵌进新 detail 的 rough 字段，旧分可追溯
 */
import './load-env.mjs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { refineScores, applyRoleCeiling, markFeatured, RECENT_TITLE_DAYS, scoreBandLabel } from './ai-filter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'articles.db');

const APPLY = process.argv.includes('--apply');
const daysArg = process.argv[process.argv.indexOf('--days') + 1];
const ONLY_DAYS = process.argv.includes('--days') && daysArg ? daysArg.split(',') : null;

if (!process.env.DASHSCOPE_API_KEY) {
  console.error('FATAL: DASHSCOPE_API_KEY 未设置（应在 pipeline/.env 配置），重评必须走真模型，退出');
  process.exit(1);
}

const db = new Database(DB_PATH);

// 默认重评范围：还有旧标准分的天（refined 记号是 2026-07-30 改档位制后才有的）
const targetDays = ONLY_DAYS || db.prepare(`
  SELECT date_key FROM articles WHERE category != 'noise'
  GROUP BY date_key
  HAVING SUM(CASE WHEN score_detail LIKE '%"stage":"refined"%' THEN 1 ELSE 0 END) < COUNT(*)
  ORDER BY date_key
`).all().map(r => r.date_key);

if (targetDays.length === 0) {
  console.log('没有需要重评的日期（全库都已是现行口径）');
  process.exit(0);
}
console.log(`${APPLY ? '【落库模式】' : '【干跑模式，不写库】'} 待重评 ${targetDays.length} 天: ${targetDays.join(', ')}\n`);

if (APPLY) {
  const bak = `${DB_PATH}.bak-rescore-${new Date().toISOString().slice(0, 10)}`;
  await db.backup(bak);
  console.log(`已备份: ${bak}\n`);
}

const updateStmt = db.prepare(
  'UPDATE articles SET ai_score = ?, score_detail = ?, is_featured = ?, is_breaking = ? WHERE id = ?'
);

let failedDays = [];
for (const day of targetDays) {
  const rows = db.prepare(`
    SELECT id, title, source_name, summary, content, ai_score, is_featured, is_breaking, published_at, score_detail
    FROM articles WHERE category != 'noise' AND date_key = ?
    ORDER BY ai_score DESC
  `).all(day);
  if (rows.length === 0) continue;

  // 该天视角的旧闻对照：它之前10天已入库的标题（与采集时 getRecentTitles 同口径）
  const recentTitles = db.prepare(`
    SELECT title FROM articles
    WHERE category != 'noise' AND date_key < ? AND date_key >= date(?, '-${RECENT_TITLE_DAYS} days')
    ORDER BY date_key DESC
  `).all(day, day).map(r => r.title);
  const recentBlock = recentTitles.length
    ? `\n近${RECENT_TITLE_DAYS}天已推送过的文章标题（判定novelty与旧闻的唯一依据，务必逐条比对产品名/事件主体）：\n${recentTitles.slice(0, 120).map(t => `- ${t}`).join('\n')}\n`
    : '';

  // 组装成 refineScores 期望的形状；role 尽力从旧 detail 恢复
  const candidates = rows.map(r => {
    let role = 'primary';
    try { role = JSON.parse(r.score_detail || '{}').role || 'primary'; } catch { /* 旧格式，按当事方 */ }
    return {
      id: r.id, title: r.title, source_name: r.source_name, role,
      content_snippet: (r.summary || r.content || '').slice(0, 200),
      ai_score: r.ai_score, score_detail: r.score_detail,
      published_at: r.published_at,
    };
  });

  console.log(`==== ${day}（${rows.length}条）====`);
  const ok = await refineScores(candidates, recentBlock);
  if (!ok) {
    // 保留旧分比写入降级分诚实：这天整体还是旧尺，榜单失真状况不变坏
    console.error(`  [跳过] ${day} 精评失败，该天维持旧分\n`);
    failedDays.push(day);
    continue;
  }
  applyRoleCeiling(candidates);

  // 精选整天重算：按新分降序走首轮规则（>=80、预算5、条数25%封顶）
  candidates.sort((a, b) => b.ai_score - a.ai_score);
  markFeatured(candidates, {});

  const oldById = new Map(rows.map(r => [r.id, r]));
  for (const c of candidates) {
    const old = oldById.get(c.id);
    // 突发标记只摘不加：重评不是"当时"，造不出新突发；掉出85的说明当初就标错了
    const breaking = old.is_breaking && c.ai_score >= 85 ? 1 : 0;
    const feat = c.is_featured ? 1 : 0;
    const delta = c.ai_score - old.ai_score;
    const flags = [
      old.is_featured !== feat ? (feat ? '+精选' : '-精选') : '',
      old.is_breaking && !breaking ? '-突发' : '',
    ].filter(Boolean).join(' ');
    console.log(`  ${String(old.ai_score).padStart(3)} -> ${String(c.ai_score).padStart(3)} (${delta >= 0 ? '+' : ''}${delta}) ${scoreBandLabel(c.ai_score)} ${flags} | ${c.title.slice(0, 42)}`);
    if (APPLY) updateStmt.run(c.ai_score, c.score_detail, feat, breaking, c.id);
  }
  console.log('');
}

if (failedDays.length) console.warn(`以下日期精评失败、维持旧分，可单独重跑: --days ${failedDays.join(',')}`);
console.log(APPLY ? '重评已落库。' : '干跑结束，未写库。确认无误后加 --apply 落库。');
db.close();
