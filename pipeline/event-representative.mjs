/**
 * 同事件「代表权」唯一口径（2026-10-09 用户定调：同事件保留 ai_score 高者为代表）
 *
 * 为什么需要这一个文件：代表权这件事被两道闸各自实现过一遍，口径不一致就会互相抵消。
 *   · 第一道 ai-filter.crossRoundDedup（入选阶段，标题级）——原口径写死"命中已发布事件
 *     一律丢弃、优先保留已发布篇"，对分数完全盲视。
 *   · 第二道 ai-dedup.dedupAgainstRecent（写库前，内容级）——followup 一律把候选分数
 *     压到对照稿之下至少 15 分，再强制 is_featured=0。
 * 2026-10-09 实测代价：92 分一手稿《OpenAI 一夜攻克722个数学难题》被 69 分的 10-07
 * 二手稿《OpenAI发布722篇数学成果》在第一道挡在门外；当日 ai_score>=80 归零，
 * /api/dates 显示 featured=0，首页精选栏整天空掉（前几日 3/6/5/4 条）。
 * 只放开第一道没有用——放行后第二道会把 92 压到 54，再被 60 分地板线剔掉，
 * 杀戮只是换了个阶段发生。所以口径必须只有一份实现，两道闸都从这里取判断。
 *
 * 规则（用户已定）：
 *   甲 同事件两条稿，谁报道得更强（ai_score 更高）谁做代表，不按入库先后。
 *   乙 代表权翻转只在"候选确实更强"时发生；任一方没有分数 → 维持现状（保守，宁漏勿错）。
 *   丙 往日历史页不回改：对照稿属于它那一天的日页，新稿做当日的代表，两者用 related_to
 *     串联供"相关阅读"；同日同事件才动库（沿用 selectByQuota 已验证的 __replaces 顶替通道）。
 */

/** 更强判定所需的最小分差：0＝严格更高即可（分数本身是整数档位，不设额外门槛） */
export const SCORE_MARGIN = 0;

/**
 * 候选是否比对照稿更强的报道（纯函数）
 * @param {number|string} candScore - 候选 ai_score
 * @param {number|string} refScore - 已发布对照稿 ai_score
 * @returns {boolean} true=候选该做代表
 */
export function isStrongerReport(candScore, refScore) {
  // 关键：null/undefined/'' 一律视为"没有分数"，不能靠 Number() 转——Number(null)===0、
  // Number('')===0，那样对照池里一条没评分的旧稿会被当成"0 分"，任何候选都比它强，
  // "对照池只给标题时退回旧行为"这条保护会被静默穿透（测试反例抓到过一次）。
  const toNum = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const c = toNum(candScore);
  const r = toNum(refScore);
  if (!Number.isFinite(c) || !Number.isFinite(r)) return false;
  return c - r > SCORE_MARGIN;
}

/**
 * 该次代表权翻转要怎么落地（纯函数）
 * @param {Object} cand - 候选文章（需 date_key / ai_score）
 * @param {Object} ref - 对照稿（需 date_key / ai_score / id / title / category）
 * @returns {'same_day'|'cross_day'|null} null=不翻转，按现状处理
 *   · same_day：与对照稿同属一个发布日 → 走 __replaces 顶替（写库阶段先删被汰条目），
 *     否则同一事件在同一天占两个位、双双精选；政策类对照稿一律不顶（政策稿有保底配额，
 *     删它会打穿那道机制，宁可让旧稿留着）。
 *   · cross_day：对照稿在往日 → 候选做当日代表，历史日页不动，只记 related_to 串联。
 */
export function supersedeKind(cand, ref) {
  if (!cand || !ref) return null;
  if (!isStrongerReport(cand.ai_score, ref.ai_score)) return null;
  const candDay = String(cand.date_key || '');
  const refDay = String(ref.date_key || '');
  if (!candDay || !refDay) return null; // 日期不齐：无法判断是否同页，不翻转
  if (candDay === refDay) {
    if (String(ref.category || '') === 'policy') return null;
    return 'same_day';
  }
  return 'cross_day';
}
