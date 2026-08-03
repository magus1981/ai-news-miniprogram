// 临时核查：确认精评溯源字段（tier/rank/demoted_from/rough）真的落库
import fs from 'node:fs';
import Database from 'better-sqlite3';

const db = new Database('../data/articles.db', { readonly: true });
const rows = db.prepare("select id, ai_score, is_featured, score_detail from articles where date_key = ? order by ai_score desc").all(process.argv[2] || '2026-07-30');
const out = rows.map(r => {
  const d = JSON.parse(r.score_detail || '{}');
  return `${r.id} score=${r.ai_score}${r.is_featured ? ' 精选' : ''} stage=${d.stage} tier=${d.tier} rank=${d.rank}${d.demoted_from ? ' demoted_from=' + d.demoted_from : ''} rough=${d.rough ? 'yes' : 'no'}`;
});
fs.writeFileSync('tmp-detail.txt', `共 ${rows.length} 条\n` + out.join('\n'), 'utf8');
console.log('ROWS=' + rows.length);
