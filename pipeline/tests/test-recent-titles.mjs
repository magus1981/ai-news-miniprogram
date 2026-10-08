/**
 * 对照池回归闸：getRecentTitles 不得把 date_key='unknown' 的归期失败稿
 * 送进 AI 筛选的「旧闻对照 / 跨期查重」参考池。
 *
 * 为什么单独成文件而不并进 test-pure.mjs：那份的制度是「不碰数据库」，
 * 而病灶就在 SQL 的字符串比较上（SQLite 里 'unknown' > 任何 'YYYY-MM-DD'），
 * 纯函数层根本测不到。本闸只碰一次性临时库，不调 AI、不碰生产数据。
 *
 * 用法：node tests/test-recent-titles.mjs   （在 pipeline 目录下）
 *
 * 安全：脚本会把 db.mjs 写死路径上的 ../data/articles.db 暂存为 .pretest-*，
 * 跑完（含异常）原样还原，绝不在既有库上留痕。
 */
import { existsSync, renameSync, rmSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 本文件在 pipeline/tests/ 下，而 db.mjs 的 LOCAL_MODE 路径是 pipeline/../data/articles.db，
// 即 <项目根>/data —— 少算一层就会把库建到 pipeline/data 而 db.mjs 读到另一份空库，
// 于是"池里没有幽灵"变成真空通过（2026-10-08 第一次跑就这样骗过了自己）。
const dataDir = join(__dirname, '..', '..', 'data');
const dbPath = join(dataDir, 'articles.db'); // 必须与 db.mjs 的 LOCAL_MODE 路径一致
const bakPath = dbPath + '.pretest';

mkdirSync(dataDir, { recursive: true });

// —— 暂存既有库（本地开发库可能真有数据，不许被测试污染）——
const hadDb = existsSync(dbPath);
if (hadDb) renameSync(dbPath, bakPath);

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`);
  }
}

// UTC 日键：db.mjs 里的 date('now','-N days') 同样是 UTC 口径，避免测试随时辰抖动
function dayKey(offsetDays) {
  return new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
}

const SCHEMA = `CREATE TABLE articles (
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
  date_key TEXT NOT NULL
)`;

// —— 造一次性测试库 ——
// 幽灵桶：归期失败（date_key='unknown'），按设计从不上任何日页，只在 scope=all 可见。
// 标题取自 2026-10-08 生产库里真实存在、且当天确实压死了头条入选的两条。
const ghosts = [
  { title: 'OpenAI 光速上新 GPT-6.1 Sol！一晚上 25 项更新', original_title: 'GHOST_SOL OpenAI ships GPT-6.1 Sol' },
  { title: '刚刚，GPT-6 Astra 接上宇树 G1，把厨房收拾了', original_title: 'GHOST_ASTRA GPT-6 Astra cleans kitchen' },
];
for (let i = ghosts.length; i < 20; i++) {
  ghosts.push({ title: `GHOST_PAD ${i} 幽灵占位稿`, original_title: `GHOST_PAD ${i} ghost filler` });
}

const seed = [];
// 窗口内真实日页稿：offset 0..8 每天 21 条（共 189 条），外加 offset 9 的一条「窗口最旧一天」
for (let off = 0; off <= 8; off++) {
  for (let i = 0; i < 21; i++) seed.push({ date_key: dayKey(off), original_title: `REAL day${off} item${i}`, title: `真实在池稿 第${off}天 ${i}` });
}
seed.push({ date_key: dayKey(9), original_title: 'REAL_OLDEST_IN_WINDOW 窗口最旧一天', title: '窗口最旧一天' });
// 超窗老稿：不得因为任何改动混进池
seed.push({ date_key: dayKey(30), original_title: 'OUT_OF_WINDOW 三十天前老稿', title: '三十天前老稿' });

const raw = new Database(dbPath);
raw.pragma('journal_mode = WAL');
raw.exec(SCHEMA);
const ins = raw.prepare(
  'INSERT INTO articles (title, original_title, source_name, source_url, category, ai_score, published_at, date_key) VALUES (?,?,?,?,?,?,?,?)'
);
let urlSeq = 0;
const tx = raw.transaction(() => {
  for (const g of ghosts) {
    ins.run(g.title, g.original_title, '测试幽灵源', `https://example.test/ghost/${++urlSeq}`, 'model', 88, `${dayKey(999)}T00:00:00.000Z`, 'unknown');
  }
  for (const s of seed) {
    ins.run(s.title, s.original_title, '测试真实源', `https://example.test/real/${++urlSeq}`, 'model', 70, `${s.date_key}T00:00:00.000Z`, s.date_key);
  }
});
tx();
raw.close();

// —— 走真实代码路径（db.mjs 在 import 时就按上面的路径打开库）——
const { getRecentTitles } = await import('../db.mjs');
const pool = await getRecentTitles(10);

const joined = pool.join('\n');

// 仪器自检：池子必须是"装满了东西"的状态，否则后面的"池里没有 X"全是真空通过
check(`仪器自检：对照池非空且读到的是 ${dbPath}`, pool.length >= 180, `实际 ${pool.length} 条 —— 路径或造数没生效，本闸此刻不可信`);
check('对照池：不得含 unknown 幽灵稿（GHOST_SOL）', !joined.includes('GHOST_SOL'), '归期失败稿被判成「已发布」，会把同事件真新闻当旧闻重报杀掉');
check('对照池：不得含 unknown 幽灵稿（GHOST_ASTRA）', !joined.includes('GHOST_ASTRA'), '同上');
check('对照池：不得含任何 unknown 条目', !/GHOST_/.test(joined), '哨兵桶必须整体排除，与 getRecentEvents 的 date_key != \'unknown\' 口径对齐');
check('对照池：窗口内真实日页稿照常入选（第 0 天）', pool.some(t => String(t).startsWith('REAL day0')), '排除 unknown 不许误伤真实对照');
check('对照池：窗口最旧一天不得被幽灵挤掉（LIMIT 200 截断）', pool.some(t => String(t).includes('REAL_OLDEST_IN_WINDOW')), '池按 date_key DESC 截断，幽灵排在最前会吃掉名额');
check('对照池：超窗老稿（30 天前）仍被窗口挡住', !joined.includes('OUT_OF_WINDOW'), '本次改动不得顺手放宽对照窗口');
check('对照池条数：只含窗口内真实稿 190 条', pool.length === 190, `实际 ${pool.length} 条`);

// —— 还原 ——
rmSync(dbPath, { force: true });
rmSync(dbPath + '-wal', { force: true });
rmSync(dbPath + '-shm', { force: true });
if (hadDb) renameSync(bakPath, dbPath);

if (failures) {
  console.log(`\n${failures} 条 FAIL —— 对照池被 unknown 污染的问题仍在（或改动误伤了正常对照）`);
  process.exit(1);
}
console.log('\n全部 PASS：对照池只认真正上过日页的稿');
