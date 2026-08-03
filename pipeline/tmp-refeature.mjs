// 临时脚本：精选门槛从75提到80后，把当天已入库数据按新门槛回溯一次。
// 只撤销不新增：cap 不变、通过门槛的只会变少，腾出的名额只会落给分数更低的文章，
// 故"提高门槛"在数学上等价于"撤掉低于门槛的精选"，不需要重跑AI（重跑会引入模型判断漂移，
// 那样就分不清结果变化是门槛的效果还是模型的抖动）。
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { FEATURED_MIN_SCORE } from './ai-filter.mjs';

const dateKey = process.argv[2] || '2026-07-30';
const db = new Database('../data/articles.db');
const before = db.prepare('select id, ai_score, title from articles where date_key = ? and is_featured = 1 order by ai_score desc').all(dateKey);
const info = db.prepare('update articles set is_featured = 0 where date_key = ? and is_featured = 1 and ai_score < ?').run(dateKey, FEATURED_MIN_SCORE);
const after = db.prepare('select id, ai_score, title from articles where date_key = ? and is_featured = 1 order by ai_score desc').all(dateKey);
const fmt = rows => rows.map(r => `  ${r.id} ${r.ai_score} ${r.title}`).join('\n');
fs.writeFileSync('tmp-detail.txt',
  `门槛=${FEATURED_MIN_SCORE}  撤销=${info.changes} 条\n改前精选(${before.length}):\n${fmt(before)}\n改后精选(${after.length}):\n${fmt(after)}\n`, 'utf8');
console.log(`REVOKED=${info.changes} FEATURED=${after.length}`);
