/**
 * 对照实验：同事件代表权——用 2026-10-09 的真实事故回放，比较新旧两套口径的结果。
 *
 * 为什么要单独一个实验文件（而不是只加回归用例）：这次改动跨两道闸，
 * 必须能当场演示"只放开第一道闸没有用"，否则 review 的人会以为改 ai-filter 就够了。
 *
 * 旧口径**逐字取自 main HEAD 的 git 对象**，不是凭记忆重写（可复核）：
 *   git show HEAD:pipeline/ai-filter.mjs  L1296-1301  "硬收口：只有指认出有效 A 配对的候选才允许被剔除"
 *                                          —— 一旦有有效配对就无条件丢弃，代码里根本没有分数这个量
 *   git show HEAD:pipeline/ai-dedup.mjs   L157-172   followup 无条件 c.ai_score = min(c, ref-15)，
 *                                          再 <60 地板线剔除
 *
 * 真实素材（生产库 + run 696 日志，北京 2026-10-09 09:05 那轮）：
 *   候选 92 分《数学大爆炸！OpenAI 一夜攻克722个数学难题，准黎曼猜想已被证明》
 *   指认 A36 = 库里 id 2386《OpenAI发布722篇数学成果，涵盖多个未解难题》2026-10-07 / 69 分 / 未精选
 *   日志原文：[CROSS-DROP] [92分] … ← 指认A36《OpenAI发布722篇数学成果…》
 *   后果实测：当日 ai_score>=80 归零，/api/dates 显示 2026-10-09 featured=0（10-08 是 3、10-07 是 6）
 *
 * 用法：node tests/exp-event-representative.mjs
 */
import { applyDupVerdicts, normalizePriorPool, FEATURED_MIN_SCORE } from '../ai-filter.mjs';
import { applyFollowupOutcome } from '../ai-dedup.mjs';

const TODAY = '2026-10-09';

// ── 真实对照池（今日 + 近10天已入库，分数取生产库实测值）──
const POOL = normalizePriorPool([
  { id: 2386, title: 'OpenAI发布722篇数学成果，涵盖多个未解难题', ai_score: 69, date_key: '2026-10-07', category: 'model' },
]);

// ── 本轮真实入选名单（分数取当日库里实测分布；92 分那条是被杀掉的那一条）──
function candidates() {
  return [
    { title: '数学大爆炸！OpenAI 一夜攻克722个数学难题，准黎曼猜想已被证明', ai_score: 92, date_key: TODAY },
    { title: 'OpenAI发布GPT-6.1 Sol Ultrafast版本', ai_score: 79, date_key: TODAY },
    { title: 'Anthropic推出Claude新功能：生成动画解释视频和实时数据仪表板', ai_score: 76, date_key: TODAY },
    { title: '部分数学家呼吁抵制OpenAI，因AI生成的证明充斥领域', ai_score: 75, date_key: TODAY },
  ];
}

// 模型的真实指认结果（run 696 日志）：b1 ← a1
const PAIRS = [{ b: 1, a: 1 }];

// ── 旧口径复现（逐字对应 HEAD 的两段实现）──
function legacyStage1(cands, pairs, pool) {
  const pubN = Math.min(pool.length, 120);
  const drop = new Set(pairs
    .filter(p => Number.isInteger(p.b) && p.b >= 1 && p.b <= cands.length
      && Number.isInteger(p.a) && p.a >= 1 && p.a <= pubN)
    .map(p => p.b - 1));
  return cands.filter((_, i) => !drop.has(i));
}
function legacyStage2(c, ref) {
  if (ref && typeof ref.ai_score === 'number' && typeof c.ai_score === 'number') {
    c.ai_score = Math.min(c.ai_score, ref.ai_score - 15); // 压到原文章之下至少15分
  }
  if (typeof c.ai_score === 'number' && c.ai_score < 60) return null; // 地板线剔除
  c.is_followup = 1;
  c.is_featured = 0;
  return c;
}

const ref = POOL[0];

function report(label, rows) {
  const featureable = rows.filter(a => a.ai_score >= FEATURED_MIN_SCORE);
  console.log(`\n【${label}】`);
  for (const a of rows) {
    console.log(`   ${String(a.ai_score).padStart(4)}分 ${a.is_followup ? '[跟进降级]' : '        '} ${a.title.slice(0, 40)}`);
  }
  console.log(`   → 当日 >=${FEATURED_MIN_SCORE} 分（可精选）: ${featureable.length} 条`);
  return featureable.length;
}

console.log('='.repeat(68));
console.log(`真实事故回放：2026-10-09 run 696（92分一手稿 vs 69分往日二手稿）`);
console.log('='.repeat(68));

// 第二道闸只会作用到"被 AI 判为同事件"的那几条（本实验里就是 b1）；其余按 new 放行，
// 不许在这里顺手压分——那会把 79/76/75 三条也压成 54 分，得出一个假的"改前全灭"。
const linkedTitles = new Set(PAIRS.map(p => candidates()[p.b - 1].title));

// 1) 旧口径：第一道闸把 92 分挡在门外，第二道闸根本没有机会出手
const beforeRows = legacyStage1(candidates(), PAIRS, POOL);
const beforeCount = report('改前·旧口径（跨期查重一律丢弃 → 当日 >=80 归零）', beforeRows);

// 2) 只放开第一道闸（故意演示：第二道不改会怎样）
const vHalf = applyDupVerdicts(candidates(), PAIRS, POOL);
const halfRows = vHalf.kept
  .map(c => (linkedTitles.has(c.title) ? legacyStage2(c, ref) : c))
  .filter(Boolean);
const halfCount = report('只改第一道闸（放行后立刻被跨期去重压分 → 杀戮换个阶段发生）', halfRows);

// 3) 新口径：两道闸都用 event-representative 的同一份判断
const vNew = applyDupVerdicts(candidates(), PAIRS, POOL);
const afterRows = vNew.kept.map(c => {
  if (c.__supersedes) applyFollowupOutcome(c, ref, {}); // 与第二道闸同一口径
  return c;
});
const afterCount = report('改后·代表权按分数（两道闸同一口径）', afterRows);

console.log('\n' + '-'.repeat(68));
console.log(`可精选条数：改前 ${beforeCount} → 只改第一道 ${halfCount} → 两道同改 ${afterCount}`);
console.log(`关键判断：92 分稿在"只改第一道"那一栏依然消失（被压到 ${ref.ai_score - 15} 分撞 60 地板线）`);
console.log(`          —— 所以杀戮只是换了个阶段发生，代表权口径必须写在一处、两道闸共用。`);

process.exit(afterCount > beforeCount && halfCount === beforeCount ? 0 : 1);
