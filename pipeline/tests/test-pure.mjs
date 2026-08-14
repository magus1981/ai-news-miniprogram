/**
 * 常驻回归测试（纯函数层）——零成本、秒级，不调用AI、不碰数据库。
 *
 * 制度：任何涉及 词典白名单/标签不变量/查重解析 的改动，改完必须跑本文件；
 * 新暴露的问题修复后，把对应用例补充进来（两向：正例防漏、反例防误伤）。
 *
 * 用法：node tests/test-pure.mjs   （在 pipeline 目录下）
 *       npm run test:pure         （在项目根目录）
 */
import { canonicalizeName, canonicalizeTagsObject } from '../tag-canonical.mjs';
import { applyTagInvariants } from '../classify-rules.mjs';
import {
  parseDupIndexes, parseDupGroups, normalizeSubScores, detectScoreCollapse, mergeIntoKept,
  applyTierRanks, applyRoleCeiling, pickKept, markFeatured, mergeNearDupTitles, scoreBandLabel,
  selectByQuota, policyQuotaPicks, beijingDayKey, pickRefineCandidates,
  DERIVATIVE_SCORE_CEILING, FEATURED_MIN_SCORE, TITLE_DUP_THRESHOLD, REFINE_TIERS,
} from '../ai-filter.mjs';
import { verifyQuote, normalizeKeyPoints } from '../ai-summary.mjs';

const CASES = [];
const T = (desc, fn) => CASES.push([desc, fn]);

// ── 公司白名单（词典即花名册，未命中不入库；精确匹配不做子串） ──
T('公司: OpenAI 保留', () => canonicalizeName('company', 'OpenAI') === 'OpenAI');
T('公司: 大小写修正 openai→OpenAI', () => canonicalizeName('company', 'openai') === 'OpenAI');
T('公司: 别名归一 TSMC→台积电', () => canonicalizeName('company', 'TSMC') === '台积电');
T('公司: 杂牌公司剔除', () => canonicalizeName('company', '正奇未来') === '');
T('公司: 蚂蚁集团独立不并入阿里', () => canonicalizeName('company', '蚂蚁集团') === '蚂蚁集团');
T('公司: 别名 蚂蚁百灵→蚂蚁集团', () => canonicalizeName('company', '蚂蚁百灵') === '蚂蚁集团');

// ── 人物白名单（大咖库） ──
T('人物: 王兴兴 保留', () => canonicalizeName('person', '王兴兴') === '王兴兴');
T('人物: 别名 Wang Xingxing→王兴兴', () => canonicalizeName('person', 'Wang Xingxing') === '王兴兴');
T('人物: 路人姓名剔除', () => canonicalizeName('person', '张三丰') === '');

// ── 国别白名单（只收国家/地区级，城市归并所属国） ──
T('国别: 伦敦→英国', () => canonicalizeName('region', '伦敦') === '英国');
T('国别: London→英国', () => canonicalizeName('region', 'London') === '英国');
T('国别: 硅谷→美国', () => canonicalizeName('region', '硅谷') === '美国');
T('国别: EU→欧盟', () => canonicalizeName('region', 'EU') === '欧盟');
T('国别: 中国 原样保留', () => canonicalizeName('region', '中国') === '中国');
T('国别: 未入册地名剔除', () => canonicalizeName('region', '火星') === '');
T('国别: ["英国","伦敦"]归并去重只剩英国', () => {
  const t = canonicalizeTagsObject({ regions: ['英国', '伦敦'] });
  return t.regions.length === 1 && t.regions[0] === '英国';
});
T('关键词: 不做归一', () => canonicalizeTagsObject({ keywords: ['伦敦'] }).keywords[0] === '伦敦');

// ── 标签不变量（regions 政策专属，代码层强制） ──
const baseTags = { companies: ['OpenAI'], people: ['王兴兴'], keywords: ['监管'], regions: ['美国'] };
T('不变量: company分类regions清空', () => applyTagInvariants('company', baseTags).regions.length === 0);
T('不变量: opinion分类regions清空', () => applyTagInvariants('opinion', baseTags).regions.length === 0);
T('不变量: policy分类regions保留', () => {
  const t = applyTagInvariants('policy', baseTags);
  return t.regions.length === 1 && t.regions[0] === '美国';
});
T('不变量: 其他维度不受影响', () => {
  const t = applyTagInvariants('company', baseTags);
  return t.companies[0] === 'OpenAI' && t.people[0] === '王兴兴' && t.keywords[0] === '监管';
});
T('不变量: 原对象不被改动', () => {
  applyTagInvariants('company', baseTags);
  return baseTags.regions.length === 1;
});

// ── 查重响应解析容错（LLM编号输出偶带前缀/未加引号，裸JSON.parse会静默失效） ──
T('跨期dup: 正常JSON', () => JSON.stringify(parseDupIndexes('{"dup": [1, 3]}')) === '[1,3]');
T('跨期dup: 未加引号B前缀', () => JSON.stringify(parseDupIndexes('{"dup": [B1, B3]}')) === '[1,3]');
T('跨期dup: 字符串混B前缀', () => JSON.stringify(parseDupIndexes('{"dup": ["1", "B3"]}')) === '[1,3]');
T('跨期dup: 空数组', () => parseDupIndexes('{"dup": []}').length === 0);
T('跨期dup: 垃圾输入返回空', () => parseDupIndexes('乱七八糟').length === 0);
T('终审dup: 正常分组', () => JSON.stringify(parseDupGroups('{"duplicates": [[1,5],[3,9,12]]}')) === '[[1,5],[3,9,12]]');
T('终审dup: 未加引号B前缀分组', () => JSON.stringify(parseDupGroups('{"duplicates": [[B1, B5]]}')) === '[[1,5]]');
T('终审dup: 字符串编号分组', () => JSON.stringify(parseDupGroups('{"duplicates": [["1","5"]]}')) === '[[1,5]]');
T('终审dup: 空数组', () => parseDupGroups('{"duplicates": []}').length === 0);
T('终审dup: duplicates非数组返回空', () => parseDupGroups('{"duplicates": "none"}').length === 0);
T('终审dup: 垃圾输入返回空', () => parseDupGroups('乱七八糟').length === 0);

// ── 金句程序校验（引用必须逐字来自原文，两向：正例放行、改写/编造拦截） ──
const QUOTE_SRC = '深信服此次成绩背后的技术路线是\nAgent Swarm 多智能体协同：围绕不同安全假设展开相互隔离的并行探查。';
T('金句: 逐字引用通过', () => verifyQuote('Agent Swarm 多智能体协同', QUOTE_SRC) === 'Agent Swarm 多智能体协同');
T('金句: 空白/换行差异容忍', () => verifyQuote('技术路线是Agent Swarm 多智能体协同', QUOTE_SRC) !== '');
T('金句: 首尾引号剥离后校验', () => verifyQuote('“围绕不同安全假设展开相互隔离的并行探查”', QUOTE_SRC) === '围绕不同安全假设展开相互隔离的并行探查');
T('金句: 改写不逐字则丢弃', () => verifyQuote('Agent Swarm多代理协作', QUOTE_SRC) === '');
T('金句: 原文为空一律丢弃', () => verifyQuote('Agent Swarm 多智能体协同', '') === '');
T('金句: 过短(<8字)丢弃', () => verifyQuote('技术路线', QUOTE_SRC) === '');
T('金句: 非字符串输入返回空', () => verifyQuote(null, QUOTE_SRC) === '' && verifyQuote(['x'], QUOTE_SRC) === '');

// ── 核心要点规范化 ──
T('要点: 非数组返回空', () => normalizeKeyPoints('不是数组').length === 0);
T('要点: 空串/非字符串剔除', () => JSON.stringify(normalizeKeyPoints(['要点A', '', null, '  '])) === '["要点A"]');
T('要点: 超4条截断', () => normalizeKeyPoints(['1', '2', '3', '4', '5']).length === 4);
T('要点: 单条超80字截断', () => normalizeKeyPoints(['长'.repeat(100)])[0].length === 80);

// ── 子分制评分（总分一律由代码求和，不采信模型自算的总分） ──
T('子分: 总分=三项子分之和', () => normalizeSubScores({ impact: 34, facts: 26, novelty: 25 }).score === 85);
T('子分: 忽略模型自算的错误总分', () => normalizeSubScores({ impact: 10, facts: 10, novelty: 10, score: 99 }).score === 30);
T('子分: 越界截断到各自量程', () => {
  const d = normalizeSubScores({ impact: 90, facts: 50, novelty: 40 });
  return d.impact === 40 && d.facts === 30 && d.novelty === 30 && d.score === 100;
});
T('子分: 负值/非数归零', () => {
  const d = normalizeSubScores({ impact: -5, facts: 'abc', novelty: 12 });
  return d.impact === 0 && d.facts === 0 && d.score === 12;
});
T('子分: 三项全缺时回退到模型总分并标降级', () => {
  const d = normalizeSubScores({ score: 72 });
  return d.score === 72 && d.degraded === true;
});
T('子分: 全缺且无总分为0（不静默变高分）', () => normalizeSubScores({}).score === 0);
T('子分: 部分子分存在时不算降级', () => normalizeSubScores({ impact: 20 }).degraded === undefined);

// ── 分数塌缩检测（同分过半说明模型没逐篇判断，精选退化为按采集顺序抽签） ──
const mk = (scores) => scores.map(s => ({ ai_score: s }));
T('塌缩: 90/70两档批发被识别（2026-07-30真实分布）', () => {
  const c = detectScoreCollapse(mk([90, 90, 90, 90, 90, 90, 90, 70, 70, 70, 70, 70, 70, 70, 70]));
  return c !== null && c.score === 70 && c.count === 8;
});
T('塌缩: 分数分散不告警', () => detectScoreCollapse(mk([88, 84, 79, 75, 71, 66, 62, 58])) === null);
T('塌缩: 样本不足6篇不判（避免误报）', () => detectScoreCollapse(mk([80, 80, 80, 80, 80])) === null);
T('塌缩: 非数组返回null', () => detectScoreCollapse(null) === null);

// ── 同事件合并（同来源多稿带素材汇成一条，异源只留标题供事实校对） ──
T('合并: 同来源带摘要素材并计数', () => {
  const kept = { title: 'GPT-5.6发布', source_name: 'OpenAI Blog' };
  mergeIntoKept(kept, { title: '两个API设置提升基准成绩', source_name: 'OpenAI Blog', content_snippet: '正文片段' });
  mergeIntoKept(kept, { title: '高管演示', source_name: 'OpenAI Blog', content_snippet: '演示片段' });
  return kept.merged_same_source === 2
    && kept.related_snippets.length === 2
    && kept.related_snippets[0].snippet === '正文片段'
    && kept.related_titles.length === 2;
});
T('合并: 异源只留标题不带素材（防把他家报道当成官方事实）', () => {
  const kept = { title: '某模型发布', source_name: 'OpenAI Blog' };
  mergeIntoKept(kept, { title: '媒体解读该模型', source_name: '机器之心', content_snippet: '解读正文' });
  return kept.related_titles.length === 1
    && kept.merged_same_source === undefined
    && kept.related_snippets === undefined;
});
T('合并: 摘要素材截断到300字', () => {
  const kept = { title: 'A', source_name: 'S' };
  mergeIntoKept(kept, { title: 'B', source_name: 'S', content_snippet: '长'.repeat(500) });
  return kept.related_snippets[0].snippet.length === 300;
});
T('合并: 缺参不报错', () => mergeIntoKept(null, { title: 'x' }) === null);

// ── 阶段2 档位+排名合成分数（档位优先：配额压制、档内拉开，机制上杜绝同分批发）──
T('精评: 覆盖粗排分并记录 stage/tier/rank/rough', () => {
  const c = [{ ai_score: 63, score_detail: '{"impact":25,"facts":18,"novelty":20,"score":63}' }];
  const n = applyTierRanks(c, [{ index: 1, tier: '重要', rank: 1, reason: '量级接近SSI获50亿美元投资' }]);
  const d = JSON.parse(c[0].score_detail);
  // 孤篇取档中点：孤篇重要≠当天最强，不该自动拿档顶
  return n === 1 && c[0].ai_score === 85 && d.stage === 'refined' && d.tier === '重要' && d.rank === 1 && d.rough.impact === 25;
});
T('精评: 同档多篇按排名拉开且不重复（2026-07-30 十五条同为82分的回归）', () => {
  const c = Array.from({ length: 6 }, () => ({}));
  applyTierRanks(c, c.map((_, i) => ({ index: i + 1, tier: '值得看', rank: i + 1 })));
  const scores = c.map(a => a.ai_score);
  return scores[0] === 79 && scores[5] === 70 && new Set(scores).size === 6
    && scores.every(s => s >= 70 && s <= 79);
});
T('精评: 重磅配额1条，超配的按排名末位降为重要并记 demoted_from', () => {
  const c = [{}, {}];
  applyTierRanks(c, [{ index: 1, tier: '重磅', rank: 2 }, { index: 2, tier: '重磅', rank: 1 }]);
  const d0 = JSON.parse(c[0].score_detail);
  const d1 = JSON.parse(c[1].score_detail);
  return d1.tier === '重磅' && c[1].ai_score === 92 // 孤篇重磅=中点，恰与锚点最高分92同口径
    && d0.tier === '重要' && d0.demoted_from === '重磅' && c[0].ai_score === 85;
});
T('精评: 重要配额3条，第4名起降入值得看', () => {
  const c = Array.from({ length: 5 }, () => ({}));
  applyTierRanks(c, c.map((_, i) => ({ index: i + 1, tier: '重要', rank: i + 1 })));
  const tiers = c.map(a => JSON.parse(a.score_detail).tier);
  return tiers.join(',') === '重要,重要,重要,值得看,值得看'
    && c[3].ai_score <= 79 && JSON.parse(c[3].score_detail).demoted_from === '重要';
});
T('精评: 模型没给重磅就没有90+分——配额只压不抬（多数天0条重磅的口径）', () => {
  const c = [{}, {}, {}];
  applyTierRanks(c, [
    { index: 1, tier: '重要', rank: 1 },
    { index: 2, tier: '值得看', rank: 2 },
    { index: 3, tier: '可看', rank: 3 },
  ]);
  return c.every(a => a.ai_score < 90) && c[0].ai_score === 85;
});
T('精评: 15篇全塞同一档也不会同分扎堆（事故形态复现，与塌缩检测双保险）', () => {
  const c = Array.from({ length: 15 }, () => ({}));
  applyTierRanks(c, c.map((_, i) => ({ index: i + 1, tier: '重要', rank: i + 1 })));
  // 前3条留在重要档，其余12条降入值得看；任何分数的同分篇数都远低于报警线
  return detectScoreCollapse(c) === null && new Set(c.map(a => a.ai_score)).size >= 10;
});
T('精评: rank缺失/非法时退回入场顺序（粗排分降序），不报错', () => {
  const c = [{ ai_score: 88 }, { ai_score: 66 }];
  const n = applyTierRanks(c, [{ index: 1, tier: '值得看' }, { index: 2, tier: '值得看', rank: 'abc' }]);
  return n === 2 && c[0].ai_score === 79 && c[1].ai_score === 70;
});
T('精评: 越界index与未知档位跳过，不污染已有分', () => {
  const c = [{ ai_score: 63 }];
  const n = applyTierRanks(c, [{ index: 5, tier: '重要', rank: 1 }, { index: 1, tier: '超神', rank: 2 }]);
  return n === 0 && c[0].ai_score === 63;
});
T('精评: 非数组输入返回0', () => applyTierRanks(null, []) === 0 && applyTierRanks([], '{}') === 0);
T('精评: 档位表护栏——配额与区间必须与档位标签同口径（防随手改表）', () => {
  const byKey = Object.fromEntries(REFINE_TIERS.map(t => [t.key, t]));
  return byKey['重磅'].quota === 1 && byKey['重要'].quota === 3
    && REFINE_TIERS.every(t => scoreBandLabel(t.min) === t.key && scoreBandLabel(t.max) === t.key);
});

// ── 衍生稿封顶（两向：该压的压住、主稿不能误伤） ──
T('封顶: 衍生稿高分被压到上限并记录原分', () => {
  // 「阿里云适配Kimi K3」历史上拿到全库最高的97分，高于「Kimi K3发布」本身的89分
  const list = [{ ai_score: 97, role: 'derivative', score_detail: '{"score":97}' }];
  const n = applyRoleCeiling(list);
  return n === 1
    && list[0].ai_score === DERIVATIVE_SCORE_CEILING
    && JSON.parse(list[0].score_detail).capped_from === 97;
});
T('封顶: 只降不升，本就低于上限的衍生稿不动', () => {
  const list = [{ ai_score: 55, role: 'derivative' }];
  return applyRoleCeiling(list) === 0 && list[0].ai_score === 55;
});
T('封顶: 主稿高分不受影响（防误伤）', () => {
  const list = [{ ai_score: 92, role: 'primary' }, { ai_score: 88 }];
  return applyRoleCeiling(list) === 0 && list[0].ai_score === 92 && list[1].ai_score === 88;
});
T('封顶: score_detail 不可解析时仍完成封顶', () => {
  const list = [{ ai_score: 95, role: 'derivative', score_detail: '不是JSON' }];
  return applyRoleCeiling(list) === 1 && list[0].ai_score === DERIVATIVE_SCORE_CEILING;
});

// ── 同事件簇保留篇：主稿优先于衍生稿 ──
T('主从: 主稿分低仍胜衍生稿', () => {
  const deriv = { title: '阿里云适配Kimi K3', role: 'derivative', ai_score: 97 };
  const main = { title: 'Moonshot发布Kimi K3', role: 'primary', ai_score: 89 };
  const [winner, loser] = pickKept(deriv, main);
  return winner === main && loser === deriv;
});
T('主从: 已保留主稿时衍生稿高分也不抢位', () => {
  const main = { role: 'primary', ai_score: 80 };
  const deriv = { role: 'derivative', ai_score: 95 };
  return pickKept(main, deriv)[0] === main;
});
T('主从: 同为主稿时仍按分数高低（防误换）', () => {
  const low = { role: 'primary', ai_score: 70 };
  const high = { role: 'primary', ai_score: 85 };
  return pickKept(low, high)[0] === high && pickKept(high, low)[0] === high;
});
T('主从: role 缺失归为主稿', () => pickKept({ ai_score: 60 }, { role: 'derivative', ai_score: 99 })[0].ai_score === 60);

// ── 精选宁缺毋滥（历史上首轮硬凑3条，使“65分就能进精选”） ──
const mkA = (scores) => scores.map(s => (typeof s === 'number' ? { ai_score: s } : s));
T('精选: 首轮只有门槛上那一条能进（不凑数）', () => {
  const sel = mkA([FEATURED_MIN_SCORE, 79, 78, 76, 75, 74, 72, 70, 68, 66, 63, 60]);
  return markFeatured(sel, { existingCount: 0 }) === 1 && sel[0].is_featured === true && sel[1].is_featured === false;
});
T('精选: “值得看”档顶的79分进不了精选（门槛从75提到80的回归）', () => {
  // 2026-07-30 复跑里一篇79分的融资稿进了精选，而它不是全行业必读
  const sel = mkA([79, 78, 77, 76]);
  return markFeatured(sel, { existingCount: 0 }) === 0 && scoreBandLabel(79) === '值得看';
});
T('精选: 首轮全场低于门槛时精选为0', () => {
  const sel = mkA([74, 70, 68, 65, 63, 60, 60, 58, 57, 56, 56, 56]);
  return markFeatured(sel, { existingCount: 0 }) === 0;
});
T('精选: 首轮够门槛时仍受25%上限', () => {
  const sel = mkA([92, 88, 80, 76, 75, 70, 65, 63, 60, 60, 58, 56]);
  return markFeatured(sel, { existingCount: 0 }) === 3 && sel[3].is_featured === false;
});
T('精选: 衍生稿封顶后制度性进不了精选', () => {
  const sel = mkA([{ ai_score: 97, role: 'derivative' }, { ai_score: 96, role: 'derivative' }, 90, 88]);
  applyRoleCeiling(sel);
  sel.sort((a, b) => b.ai_score - a.ai_score);
  const marked = markFeatured(sel, { existingCount: 0 });
  return DERIVATIVE_SCORE_CEILING < FEATURED_MIN_SCORE && marked === 1 && sel[0].ai_score === 90;
});
T('精选: retro 旧闻重报不进精选', () => {
  const sel = mkA([{ ai_score: 95, newsness: 'retro' }, { ai_score: 90 }]);
  return markFeatured(sel, { existingCount: 0 }) === 1 && sel[0].is_featured === false && sel[1].is_featured === true;
});
T('精选: 增量轮仍守80分高线（不因新门槛而放水）', () => {
  const sel = mkA([90, 82, 78]);
  return markFeatured(sel, { existingCount: 10, existingFeatured: 2 }) === 2 && sel[2].is_featured === false;
});
T('精选: 临时字段 role/event_key 不入库', () => {
  const sel = [{ ai_score: 90, role: 'primary', event_key: 'e1' }];
  markFeatured(sel, { existingCount: 0 });
  return sel[0].role === undefined && sel[0].event_key === undefined;
});

// ── 标题近重复合并（代码层查重，补AI层的漏）──
// 下面三条正例是全库实测出的全部历史漏例：四层查重全部没拦住，两篇都发了出去。
// 改阈值前先跑 tmp-sim.mjs 复测全库，再看这几条。
const mkT = (...titles) => titles.map((t, i) => ({ title: t, ai_score: 90 - i, role: 'primary' }));

T('标题查重: Trump机器人禁令两稿合并（2026-07-30 双双进精选的回归）', () => {
  const res = mergeNearDupTitles(mkT(
    'Trump administration bans foreign-made humanoid robots in move targeting China',
    'Trump administration bans foreign-made robots and power gear amid fears of Chinese influence',
  ));
  return res.dropped === 1 && res.list.length === 1;
});
T('标题查重: 百度Agent登顶两稿合并（2026-07-22 漏例）', () => {
  const res = mergeNearDupTitles(mkT(
    '百度文心助手任务Agent登顶全球智能体权威榜单，刷新行业性能基准',
    '百度文心助手任务Agent登顶全球智能体权威榜单，首获国际智能体能力综合冠军',
  ));
  return res.dropped === 1;
});
T('标题查重: Jack Dorsey发布Buzz两稿合并（2026-07-21 漏例，相似度仅0.59）', () => {
  const res = mergeNearDupTitles(mkT(
    'Jack Dorsey launches Buzz to combine team chat, AI agents and Git hosting',
    'Jack Dorsey is taking on Slack with Buzz, a group chat platform for teams and their AI agents',
  ));
  return res.dropped === 1;
});
T('标题查重: 只差版本号的两次发布不得合并（Dice高达0.91的最危险误伤）', () => {
  const res = mergeNearDupTitles(mkT(
    'OpenAI正式发布GPT-6旗舰模型并开放API接入',
    'OpenAI正式发布GPT-5旗舰模型并开放API接入',
  ));
  return res.dropped === 0 && res.list.length === 2;
});
T('标题查重: 短标题不由代码硬并（苹果Mac vs iPad 类误伤）', () => {
  const res = mergeNearDupTitles(mkT('苹果发布新款Mac', '苹果发布新款iPad'));
  return res.dropped === 0;
});
T('标题查重: 同一事件只一方带数字时仍能合并', () => {
  const res = mergeNearDupTitles(mkT(
    'Trump administration bans foreign-made humanoid robots in move targeting China',
    'Trump administration bans foreign-made humanoid robots, 30 day deadline for importers',
  ));
  return res.dropped === 1;
});
T('标题查重: 主稿优先——衍生稿分更高也要让位给主稿', () => {
  const res = mergeNearDupTitles([
    { title: 'Trump administration bans foreign-made humanoid robots in move targeting China', ai_score: 95, role: 'derivative' },
    { title: 'Trump administration bans foreign-made humanoid robots amid China fears', ai_score: 80, role: 'primary' },
  ]);
  return res.dropped === 1 && res.list[0].role === 'primary';
});
T('标题查重: 被剔除篇标题挂到保留篇供多源校对', () => {
  const res = mergeNearDupTitles(mkT(
    'Trump administration bans foreign-made humanoid robots in move targeting China',
    'Trump administration bans foreign-made robots and power gear amid fears of Chinese influence',
  ));
  return res.list[0].related_titles.length === 1
    && res.list[0].related_titles[0].includes('power gear');
});
T('标题查重: 无关标题不误伤', () => {
  const res = mergeNearDupTitles(mkT(
    'OpenAI open-sources Codex Security CLI to help developers find and fix vulnerabilities',
    'Apple tops Nvidia as world\u2019s most valuable company after record quarter',
    'Deepmind dismantles its AlphaFold team as key authors leave for Anthropic',
  ));
  return res.dropped === 0 && res.list.length === 3;
});
T('标题查重: 阈值在实测区间内（护栏，防随手调大调小）', () => {
  return TITLE_DUP_THRESHOLD >= 0.5 && TITLE_DUP_THRESHOLD <= 0.6;
});
T('标题查重: 空与单条输入不报错', () => {
  return mergeNearDupTitles([]).dropped === 0
    && mergeNearDupTitles(null).list.length === 0
    && mergeNearDupTitles([{ title: 'x', ai_score: 1 }]).list.length === 1;
});

// ── 档位标签（与 SCORE_BANDS 及前台 fmt.wxs 三处必须同口径）──
T('档位: 90分为重磅、边界不偏移', () => scoreBandLabel(90) === '重磅' && scoreBandLabel(89) === '重要');
T('档位: 精选门槛落在“重要”档（精选必为重要档以上）', () => scoreBandLabel(FEATURED_MIN_SCORE) === '重要');
T('档位: 衍生稿封顶值72落在值得看（进不了重要档）', () => scoreBandLabel(DERIVATIVE_SCORE_CEILING) === '值得看');
T('档位: 59分及以下为边缘', () => scoreBandLabel(59) === '边缘' && scoreBandLabel(0) === '边缘');

// ── 塌缩检测的度量对象与阈值（为何从30条候选挪到最终名单）──
T('塌缩: 6/15 同分在最终名单上报警（2026-07-30 全程没报警的回归）', () => {
  const list = [...Array(6).fill(75), 82, 82, 78, 76, 72, 72, 70, 70, 68].map(s => ({ ai_score: s }));
  const c = detectScoreCollapse(list);
  return !!c && c.score === 75 && c.count === 6 && c.total === 15;
});
T('塌缩: 同样这6条同分摆进30条候选就被稀释成不报警（故须量最终名单）', () => {
  const list = [...Array(6).fill(75), ...Array(24).fill(0).map((_, i) => 50 + i)].map(s => ({ ai_score: s }));
  return detectScoreCollapse(list) === null;
});
T('塌缩: 4/15 同分不报警（正常的分数聚集不算异常）', () => {
  const list = [...Array(4).fill(75), 90, 88, 85, 82, 80, 78, 76, 72, 70, 68, 66].map(s => ({ ai_score: s }));
  return detectScoreCollapse(list) === null;
});
T('塌缩: 小名单 3/6 同分不报警（count 下限护栏）', () => {
  return detectScoreCollapse([75, 75, 75, 90, 80, 70].map(s => ({ ai_score: s }))) === null;
});

// ── 发布北京日归日（2026-07-30 用户反馈：昨天中午的新闻不该出现在今天页）──
// published_at 存 UTC，必须 +8h 再取自然日，否则北京凌晨 0-8 点的文章会差一天。
T('归日: 北京中午的新闻归当天', () => beijingDayKey('2026-07-29T04:00:00Z') === '2026-07-29');
T('归日: UTC 前一天傍晚跨到北京次日（+8h 边界）', () => beijingDayKey('2026-07-29T16:30:00Z') === '2026-07-30');
T('归日: UTC 前一天午后仍属北京当天（+8h 边界另一侧）', () => beijingDayKey('2026-07-29T15:30:00Z') === '2026-07-29');
T('归日: 北京 00:30 归当天而非前一天', () => beijingDayKey('2026-07-30T00:30:00+08:00') === '2026-07-30');
T('归日: 缺失/非法日期兜底为合法 YYYY-MM-DD', () => {
  return /^\d{4}-\d{2}-\d{2}$/.test(beijingDayKey(null)) && /^\d{4}-\d{2}-\d{2}$/.test(beijingDayKey('不是日期'));
});

// ── 跨发布日各自独立结算日配额（一轮采集跨多个发布日时，昨天补采不得挤占今天名额）──
// filterArticles 在编排层按 beijingDayKey 分桶后对每个桶单独调 selectByQuota，故这里直接验证分桶独立性。
T('跨日配额: 今天首轮取满、昨天增量按余额各算各的', () => {
  const today = mkA([90, 85, 80, 76, 72, 68, 64, 60, 58, 56, 55]); // 首轮(existingCount=0)
  const yesterday = mkA([88, 82, 78, 70, 66]); // 昨天已入库18条(existingCount=18)，余额仅2
  const selToday = selectByQuota(today, 0);
  const selYest = selectByQuota(yesterday, 18);
  // 今天首轮至少凑到10条；昨天只剩 20-18=2 条余额
  return selToday.length >= 10 && selYest.length === 2;
});
T('跨日配额: 昨天已满(20)只放行>=85突发，今天不受影响', () => {
  const selToday = selectByQuota(mkA([76, 74, 72, 70, 68, 66, 64, 62, 60, 60, 60]), 0);
  const selYestFull = selectByQuota(mkA([90, 84, 80]), 20); // 昨天已满
  return selToday.length >= 10 && selYestFull.length === 1 && selYestFull[0].ai_score === 90;
});
T('政策保护通道: 官方政策>=70配额已满也保送，且不占配额', () => {
  const list = mkA([{ ai_score: 72, source_type: 'official', category: 'policy' }, 90, 84]);
  const sel = selectByQuota(list, 20); // 当日已满：普通通道只放>=85突发
  return sel.length === 2 && sel[0].ai_score === 72 && sel[1].ai_score === 90;
});
T('政策保护通道: <70不保送，每轮上限2条', () => {
  const list = mkA([
    { ai_score: 75, source_type: 'official', category: 'policy' },
    { ai_score: 74, source_type: 'official', category: 'policy' },
    { ai_score: 71, source_type: 'official', category: 'policy' },
    { ai_score: 69, source_type: 'official', category: 'policy' },
  ]);
  const sel = selectByQuota(list, 20);
  return sel.map(a => a.ai_score).join(',') === '75,74';
});
T('政策保护通道: 非官方源的政策文章不享保送', () => {
  const list = mkA([{ ai_score: 78, source_type: 'media', category: 'policy' }, 90]);
  const sel = selectByQuota(list, 20);
  return sel.length === 1 && sel[0].ai_score === 90;
});

// ── 精评候选按日发布日分配（2026-08-14 事故：全局Top-N被存量稿占满，当日320条新稿只选出1条）──
// 固定发布日（UTC时刻，北京日确定），不依赖测试运行时的真实时钟
const mkDay = (scores, iso) => scores.map(s => ({ ai_score: s, published_at: iso }));
const YEST = '2026-08-13T02:00:00.000Z'; // 北京 2026-08-13 10:00
const TODAY = '2026-08-14T02:00:00.000Z'; // 北京 2026-08-14 10:00
T('精评候选: 已满日存量稿不得占满名额，当日稿保底进精评（事故复现）', () => {
  // 旧全局Top-6 = 昨天6条存量稿（粗评高分但昨天配额已满永远选不上），当日1条都进不了精评
  const list = [...mkDay([89, 84, 80, 79, 78, 76], YEST), ...mkDay([75, 74, 73, 72, 71, 70], TODAY)];
  const picked = pickRefineCandidates(list, { '2026-08-13': { existingCount: 20 }, '2026-08-14': { existingCount: 5 } }, 6);
  const todayN = picked.filter(a => a.published_at === TODAY).length;
  return picked.length === 6 && todayN >= 3;
});
T('精评候选: 已满日只放>=80突发候选且至多2条', () => {
  const list = mkDay([89, 84, 80, 79, 78], YEST);
  const picked = pickRefineCandidates(list, { '2026-08-13': { existingCount: 20 } }, 30);
  return picked.map(a => a.ai_score).join(',') === '89,84';
});
T('精评候选: 全部日已满时不做全局补齐（存量稿不再白耗精评名额）', () => {
  const list = [...mkDay([90, 85, 70], YEST), ...mkDay([66, 64], TODAY)];
  const picked = pickRefineCandidates(list, { '2026-08-13': { existingCount: 20 }, '2026-08-14': { existingCount: 20 } }, 30);
  return picked.map(a => a.ai_score).join(',') === '90,85';
});
T('精评候选: 未满日多时各日均分保底名额，剩余名额全局补齐', () => {
  const d1 = '2026-08-12T02:00:00.000Z';
  // 昨天已满且无>=80突发候选；今天与前天未满各保底 floor(9/2)=4 条，剩1席由全局补齐捞回昨天79分稿
  const list = [...mkDay([79, 78, 77, 76], YEST), ...mkDay([75, 74, 73, 72, 71], TODAY), ...mkDay([70, 69, 68, 67], d1)];
  const picked = pickRefineCandidates(list, { '2026-08-13': { existingCount: 20 }, '2026-08-14': { existingCount: 8 }, '2026-08-12': { existingCount: 0 } }, 9);
  const perDay = dk => picked.filter(a => a.published_at === dk).length;
  return picked.length === 9 && perDay(TODAY) === 4 && perDay(d1) === 4 && perDay(YEST) === 1;
});
T('精评候选: 候选不足limit时不报错且全部入选', () => {
  const list = mkDay([88, 76], TODAY);
  const picked = pickRefineCandidates(list, {}, 30);
  return picked.length === 2;
});

// ── 政策保底配额（2026-08-12 修复：从"当日全量去重稿件"补入，而非精评Top-30候选池）──
// 生产事故复盘：政策稿AI评分系统性低分，进不了精评Top-30候选池（当日12个政策源全抓到
// 原始稿、候选池最低40分仍无一政策稿），原实现只扫候选池→保底永不触发。
T('政策保底: 政策稿未进候选池也能从全量池补入（当日0政策稿入选补满2条）', () => {
  const day = '2026-08-12';
  const tech = mkA([84, 80, 79, 78, 72, 70, 66, 62, 60, 55, 50, 45, 40, 38, 36]);
  const policyLow = mkA([40, 58, 57]).map(a => ({ ...a, category: 'policy' })); // 打乱顺序验证按分降序取
  const byDayFull = new Map([[day, [...tech, ...policyLow]]]);
  const already = tech.slice(0, 4); // 已入选4条科技稿（当天已有10条）
  const picks = policyQuotaPicks(byDayFull, new Map([[day, already]]), { [day]: { existingCount: 10 } });
  return picks.length === 2
    && picks.every(a => a.category === 'policy')
    && picks[0].ai_score === 58
    && picks[1].ai_score === 57;
});
T('政策保底: 低于56分下限的政策稿不补入（宁缺毋滥，2026-08-13噪音事故回归）', () => {
  const day = '2026-08-13';
  const byDayFull = new Map([[day, [
    { ai_score: 80, category: 'company' },
    { ai_score: 44, category: 'policy' }, // The Hill 诉讼稿
    { ai_score: 10, category: 'policy' }, // 政治花边
  ]]]);
  const picks = policyQuotaPicks(byDayFull, new Map(), { [day]: { existingCount: 5 } });
  return picks.length === 0;
});
T('政策保底: 当日已入选1条政策稿则只补1条', () => {
  const day = '2026-08-12';
  const policySel = { ai_score: 58, category: 'policy', source_url: 'gov/1' };
  const byDayFull = new Map([[day, [
    { ai_score: 62, category: 'company' },
    policySel,
    { ai_score: 58, category: 'policy', source_url: 'gov/2' },
    { ai_score: 35, category: 'policy', source_url: 'gov/3' },
  ]]]);
  const picks = policyQuotaPicks(byDayFull, new Map([[day, [policySel]]]), { [day]: { existingCount: 5 } });
  return picks.length === 1 && picks[0].source_url === 'gov/2';
});
T('政策保底: 当日名额已满(20)不挤占科技稿', () => {
  const day = '2026-08-12';
  const byDayFull = new Map([[day, [
    { ai_score: 80, category: 'company' },
    { ai_score: 45, category: 'policy' },
  ]]]);
  const already = mkA([82, 80, 79, 78, 77, 76, 75, 74, 73, 72]); // 已入选10条+已有10条=满20
  const picks = policyQuotaPicks(byDayFull, new Map([[day, already]]), { [day]: { existingCount: 10 } });
  return picks.length === 0;
});
T('政策保底: 已入选文章不被重复补入', () => {
  const day = '2026-08-12';
  const selPolicy = { ai_score: 60, category: 'policy', source_url: 'gov/dup' };
  const byDayFull = new Map([[day, [
    { ai_score: 70, category: 'company' },
    selPolicy,
    { ai_score: 60, category: 'policy', source_url: 'gov/other' },
  ]]]);
  const picks = policyQuotaPicks(byDayFull, new Map([[day, [selPolicy]]]), { [day]: { existingCount: 0 } });
  return picks.length === 1 && picks[0].source_url === 'gov/other';
});
T('政策保底: 非政策稿不补，各发布日独立结算', () => {
  const d1 = '2026-08-12';
  const d2 = '2026-08-11';
  const byDayFull = new Map([
    [d1, [{ ai_score: 55, category: 'technology' }, { ai_score: 44, category: 'funding' }]],
    [d2, [{ ai_score: 62, category: 'policy' }, { ai_score: 58, category: 'policy' }]],
  ]);
  const picks = policyQuotaPicks(byDayFull, new Map(), {});
  return picks.length === 2 && picks.every(a => a.category === 'policy');
});
T('跨日精选: 昨天增量精选走 5-已精选 预算且守80分线', () => {
  const yest = mkA([90, 82, 78]); // 昨天已精选2条
  const marked = markFeatured(yest, { existingCount: 15, existingFeatured: 2 });
  // 预算=5-2=3，但只有 >=80 的两条够格，78分那条挡在外
  return marked === 2 && yest[2].is_featured === false;
});
T('跨日精选: 昨天精选预算已满(existingFeatured=5)一条都不再加', () => {
  return markFeatured(mkA([92, 88]), { existingCount: 18, existingFeatured: 5 }) === 0;
});

// ── 执行 ──
let pass = 0;
const failed = [];
for (const [desc, fn] of CASES) {
  let ok = false;
  try { ok = fn(); } catch { ok = false; }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${desc}`);
  if (ok) pass++; else failed.push(desc);
}
console.log(`\n${pass}/${CASES.length} PASS${failed.length ? `，失败: ${failed.join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
