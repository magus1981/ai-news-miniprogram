/**
 * 素材闸门回归测试（2026-10-08 假新闻事故 id 2228 专项）——零成本、离线、可重复。
 *
 * 为什么单独建一个文件而不进 tests/test-pure.mjs：本文件的四个样本全部取自生产库真实行，
 * 且要跑通"取料 → 摘要 → 二审 → 写库分区"的完整链路（含一次性临时 sqlite 库），
 * 与 test-pure 的纯函数层不是一个量级。常驻跑法仍是 `node tests/test-pure.mjs`。
 *
 * 用法：node _test_gates.mjs        （在 pipeline 目录下；不需要任何 API Key、不联网调模型）
 *
 * 安全性：
 * - 模型端点被替换为本地 127.0.0.1 桩服务（DASHSCOPE_API_URL），绝不产生真实调用与费用；
 * - 数据库被替换为临时文件（ARTICLES_DB_PATH），绝不碰开发库，更不可能碰生产库；
 * - 桩服务会统计调用次数，"隔离样本必须零模型调用"是硬断言——这是本次止血的核心。
 *
 * 四个样本（生产库真实行，只读取回）：
 *   ① id 2228 新智元「特朗普签行政令：美国政府全面封杀AI」——112 字壳页，事故主角，已人工下架
 *   ② id 2271 新智元「Hinton、Bengio等22位巨头联名警告」——142 字壳页，同类未爆弹
 *   ③ id 2372 量子位「阶跃…STEPX Neo」774 字真全文、92 分、在精选——必须放行，不得误杀
 *   ④ The Verge AI RSS 真实 description 377 字（非标题占位）——必须放行
 *
 * 2026-10-12 校准追加（articles_quarantine 隔离表原文快照，误杀/拦杀双向回归）：
 *   ⑤ 89 分《AI「读心」》418 字 / ⑥ 75 分《Claude 封号潮》464 字——"标题开头+长摘要"正样本，改后必须放行
 *   ⑦ 新智元大逃杀 0 字 / ⑧ 一图读懂 27 字标题复读 / ⑨⑩ UAE 96/115 字 / ⑪ Nvidia 163 字 HN 卡片——负样本，不得放水
 *   红灯分级三档（fatal/batch/routine）以 classifyQuarantineAlert 纯函数逐档断言
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// ───────────────────────── 环境与夹具准备（必须在 import 被测模块之前） ─────────────────────────
const TMP_DB = path.join(os.tmpdir(), `ai-news-gates-${process.pid}-${Date.now()}.db`);
process.env.ARTICLES_DB_PATH = TMP_DB;   // 隔离到临时库
delete process.env.TURSO_URL;
delete process.env.TURSO_AUTH_TOKEN;

let STUB_CALLS = 0;
let stubPayload = null;
const stubServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    STUB_CALLS++;
    const payload = typeof stubPayload === 'function' ? stubPayload(raw) : stubPayload;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
  });
});
await new Promise(resolve => stubServer.listen(0, '127.0.0.1', resolve));
process.env.DASHSCOPE_API_URL = `http://127.0.0.1:${stubServer.address().port}/v1/chat/completions`;
process.env.DASHSCOPE_API_KEY = 'regression-stub-key';

const {
  pickMaterial, looksLikePageShell, groundedAssertions, gateFeaturedMaterialTier,
  isQuarantined, quarantineReason,
  QUARANTINE_REASONS, QUARANTINE_STAGE, MIN_MATERIAL_CHARS, SNIPPET_TRUST_MIN_CHARS,
} = await import('./material.mjs');
// 红灯分级纯函数（2026-10-12）：collect.mjs 顶部无副作用（main 有 isMain 保护），可安全 import
const { classifyQuarantineAlert } = await import('./collect.mjs');
const { generateSummary } = await import('./ai-summary.mjs');
const { reviewSummary } = await import('./ai-review.mjs');
const { applyClickbaitCeiling, CLICKBAIT_SCORE_CEILING, markFeatured } = await import('./ai-filter.mjs');
// 复用 2026-09-28 已有的隔离队列，不另造一套：闸门只负责打 _proc_failed/_proc_reason，
// 真正落库由 collect 的 isHalfProduct 分流 + db.insertQuarantine 完成
const { initDB, insertArticles, insertQuarantine } = await import('./db.mjs');
const Database = (await import('better-sqlite3')).default;

// ───────────────────────── 真实样本（生产库原文，未作改写） ─────────────────────────
const SHELL_2228 = '突发！特朗普签行政令：美国政府全面封杀「AI」 · 新智元官网\nASI 爆点ASI 启示录ASI 坐标ASI 新天地\nApocalypse · ASI 启示录\n突发！特朗普签行政令：美国政府全面封杀「AI」\n正在取这篇稿子…';
const S1 = {
  label: '① id 2228 新智元 封杀AI（112字壳页·事故主角）',
  title: '特朗普签行政令：美国政府全面封杀AI',
  source_name: '新智元',
  source_url: 'https://aiera.com.cn/2026-10-02/other/admin/116545/x',
  category: 'policy',
  language: 'zh',
  published_at: '2026-10-02T00:04:02.000Z',
  date_key: '2026-10-02',
  ai_score: 92,
  is_featured: 1,
  content: SHELL_2228,
  content_snippet: '',   // 爬虫已改掉 `content_snippet: title`
  // ↓ 事故当时模型真的写出来的东西（下架前从库里原样带出），用于验证第二道网
  __fake_points: ['特朗普签署行政命令，禁止AI技术在美国的使用和发展', '该行政令对AI行业将产生重大影响'],
  __fake_takeaway: '特朗普签署行政令，全面禁止AI技术',
};
const SHELL_2271 = 'Hinton、Bengio等22位巨头重磅联名！AI开始造AI，智能爆炸逼近 · 新智元官网\nASI 爆点ASI 启示录ASI 坐标ASI 新天地\nApocalypse · ASI 启示录\nHinton、Bengio等22位巨头重磅联名！AI开始造AI，智能爆炸逼近\n正在取这篇稿子…';
const S2 = {
  label: '② id 2271 新智元 Hinton联名（142字壳页·同类未爆弹）',
  title: 'Hinton、Bengio等22位巨头联名警告：AI开始造AI，智能爆炸逼近',
  source_name: '新智元',
  source_url: 'https://aiera.com.cn/2026-10-05/other/admin/117002/y',
  category: 'technology',
  language: 'zh',
  published_at: '2026-10-05T00:04:00.000Z',
  date_key: '2026-10-05',
  ai_score: 89,
  is_featured: 1,
  content: SHELL_2271,
  content_snippet: '',
};
const FULL_2372 = '大模型原生智能体手机STEPX Neo将于10月13日正式发布 – 量子位\n大模型原生智能体手机STEPX Neo将于10月13日正式发布\n2026-10-08\n10:15:37\n10月8日消息，阶跃终端将于10月13日在上海举办“Ready Builder One”主题发布会，推出旗下首款大模型原生智能体手机STEPX Neo。\n据悉，STEPX Neo在模型、系统、硬件等方面皆为智能体原生打造，本次发布会除新品亮相外，还将公布阶跃终端在生态合作方面的最新进展。\n本文由阶跃终端提供，量子位获授权转载，观点归原作者所有。\n版权所有，未经授权不得以任何形式转载及使用，违者必究。\n扫码分享至朋友圈\n追踪人工智能新趋势，报道科技行业新突破';
const S3 = {
  label: `③ id 2372 量子位 STEPX Neo（真正文·生产库774字去掉尾部相关链接后${FULL_2372.length}字·92分·在精选）`,
  title: '阶跃终端将于10月13日发布大模型原生智能体手机STEPX Neo',
  source_name: '量子位',
  source_url: 'https://www.qbitai.com/2026/10/08/stepx-neo.html',
  category: 'company',
  language: 'zh',
  published_at: '2026-10-08T02:15:37.000Z',
  date_key: '2026-10-08',
  ai_score: 92,
  is_featured: 1,
  content: FULL_2372,
  content_snippet: '',
  real_takeaway: '阶跃终端将于10月13日在上海发布大模型原生智能体手机STEPX Neo。',
  real_points: ['阶跃终端定于10月13日在上海举办发布会，推出STEPX Neo。', 'STEPX Neo在模型、系统、硬件等方面皆为智能体原生打造。'],
};
const RSS_SNIPPET = 'OpenAI is bringing new tools to ChatGPT for Teens, a mode for teens introduced in August with safeguards and break reminders, to help users with the college application process. "College Planner brings together application requirements, deadlines, tasks, and financial-aid steps for schools on a student\'s list in one plan," OpenAI says. "Students applying to several [...]';
const S4 = {
  label: `④ The Verge AI RSS 真实摘要片段（${RSS_SNIPPET.length}字·非标题占位）`,
  title: 'ChatGPT is getting college planning tools',
  original_title: 'ChatGPT is getting college planning tools',
  source_name: 'The Verge AI',
  source_url: 'https://www.theverge.com/ai-artificial-intelligence/1005000/chatgpt-college-planner',
  category: 'company',
  language: 'en',
  published_at: '2026-10-08T09:00:00.000Z',
  date_key: '2026-10-08',
  ai_score: 81,
  is_featured: 1,
  content: '',            // RSS 源没有全文，正常
  content_snippet: RSS_SNIPPET,
  real_takeaway: 'OpenAI为ChatGPT for Teens新增College Planner大学申请工具。',
  real_points: ['OpenAI is bringing new tools to ChatGPT for Teens', 'College Planner brings together application requirements, deadlines, tasks, and financial-aid steps'],
};

// ───────────────── 2026-10-12 校准样本（生产隔离表 articles_quarantine 只读取回原文快照） ─────────────────
// 正样本：两条"标题开头 + 数百字真实 RSS 摘要"的头条级稿，曾被 snippet.includes(title) 一刀切误杀，改后必须放行
const S5_SNIPPET = 'AI「读心」新突破：凭脑扫描还原人眼所见 下一站是「读梦」？\n据媒体当地时间周六报道，以色列魏茨曼科学研究所教授 Michal Irani 团队近期开发出名为 Brain-IT 的 AI 模型。该模型能够通过分析功能性磁共振成像（fMRI）数据，重建受试者观看图像时的视觉画面。\n据官方新闻稿，该模型能以极高的准确度还原受试者所看到的画面。研究团队通过创新的反向翻译方法补齐脑数据不足的短板，相比传统模型，该模型画面还原更精准，且大幅缩短个人适配扫描时长，技术优势显著。\n目前该技术仅支持静态图像还原，研究团队正拓展至听觉、动态视频解码，终极目标是实现「读梦」。但梦境画面变化极快，受限于脑部扫描设备速度，视频与梦境解码仍存在较大技术难题，有待后续突破。\n部分神经科学家对 Brain-IT 模型的能力给予高度评价，认为其有望用于神经系统疾病患者的治疗。但也有人担忧，这项技术可能遭到滥用，被用来强行获取个人的思想信息。（来源：财联社）';
const S5 = {
  label: `⑤ 89分 极客公园《AI「读心」》(${S5_SNIPPET.length}字长摘要·曾被误杀·正样本)`,
  title: 'AI「读心」新突破：凭脑扫描还原人眼所见',
  source_name: '极客公园',
  source_url: 'https://www.geekpark.net/news/regression-s5-mind-reading',
  category: 'technology',
  language: 'zh',
  published_at: '2026-10-11T01:00:00.000Z',
  date_key: '2026-10-11',
  ai_score: 89,
  is_featured: 1,
  content: '',
  content_snippet: S5_SNIPPET,
};
const S5_TAKEAWAY = 'Brain-IT 模型能通过分析 fMRI 数据重建受试者的视觉画面。';
const S5_POINTS = ['以色列魏茨曼科学研究所 Michal Irani 团队开发出 Brain-IT 模型', '该技术有望用于神经系统疾病患者的治疗，也有人担忧其被滥用'];
const S6_SNIPPET = 'Claude 爆发大规模封号潮：半年封杀 1140 万个账号申诉后仅 4.2 万翻案\n10 月 11 日，据媒体报道，近期 Claude 账号封禁问题引发开发者讨论。受到关注的一项数据来自 Anthropic 今年 7 月发布的报告：2026 年上半年，平台累计封禁约 1140 万个账号；收到约 39.8 万次申诉，其中约 4.2 万次申诉成功。报告未披露完整的封禁原因分布，仅凭这些数字也无法判断近期封号是否增加，但申诉结果使平台的封禁标准和复核机制受到关注。\nAnthropic 列出的违规情形包括利用服务从事违法活动、侵犯隐私，以及违反地区使用限制等。今年上半年，Anthropic 还向相关儿童安全组织提交了超过 1.5 万起报告。\n此外，Anthropic 近期修订了 Claude 使用政策，计划自 11 月 12 日起禁止用户在没有明显目的的情况下，反复对模型实施极端残忍行为。公司称，新规针对的是极端情形；用户表达不满、反驳模型、创作黑暗题材内容，以及开展模型测试与研究，不属于该项禁令的范围。（来源：快科技）';
const S6 = {
  label: `⑥ 75分 极客公园《Claude 封号潮》(${S6_SNIPPET.length}字长摘要·曾被误杀·正样本)`,
  title: 'Claude 爆发大规模封号潮：半年封杀 1140 万个账号申诉后仅 4.2 万翻案',
  source_name: '极客公园',
  source_url: 'https://www.geekpark.net/news/regression-s6-clause-ban',
  category: 'company',
  language: 'zh',
  published_at: '2026-10-12T01:00:00.000Z',
  date_key: '2026-10-12',
  ai_score: 75,
  is_featured: 1,
  content: '',
  content_snippet: S6_SNIPPET,
};
const S6_TAKEAWAY = 'Anthropic 报告显示 2026 上半年封禁约 1140 万个账号，申诉成功约 4.2 万次。';
const S6_POINTS = ['报告未披露完整的封禁原因分布', '自 11 月 12 日起禁止无明显目的的对模型极端残忍行为'];
// 负样本：必须仍被拦（全部取自隔离表真实行，逐条不得放水）
const N1 = {
  label: '⑦ 80分 新智元《大逃杀》(content=0字 snippet=0字·真壳页·负样本)',
  title: '全球17大顶级AI实验室大逃杀！惨遭集体翻车，GPT-5.6与Opus断层领先',
  source_name: '新智元', source_url: 'https://aiera.com.cn/regression-n1',
  category: 'technology', language: 'zh', published_at: '2026-10-11T00:00:00.000Z', date_key: '2026-10-11',
  ai_score: 80, is_featured: 0, content: '', content_snippet: '',
};
const N2_TITLE = '一图读懂 | 中共中央 国务院关于发展新质生产力的意见';
const N2 = {
  label: '⑧ 79分 国家数据局《一图读懂》(snippet=27字且与标题等同·图解页·负样本)',
  title: N2_TITLE, original_title: N2_TITLE,
  source_name: '国家数据局', source_url: 'https://www.nda.gov.cn/regression-n2',
  category: 'policy', language: 'zh', published_at: '2026-10-11T00:00:00.000Z', date_key: '2026-10-11',
  ai_score: 79, is_featured: 0, content: '', content_snippet: N2_TITLE,
};
const N3 = {
  label: '⑨ UAE AI News《rank first 70.1%》(snippet=96字·低于200下限·负样本)',
  title: 'UAE ranks first globally in AI adoption among working-age population at 70.1 per cent - Gulf News',
  source_name: 'UAE AI News', source_url: 'https://u.ae/regression-n3',
  category: 'policy', language: 'en', published_at: '2026-10-11T00:00:00.000Z', date_key: '2026-10-11',
  ai_score: 66, is_featured: 0, content: '',
  content_snippet: 'UAE ranks first globally in AI adoption among working-age population at 70.1 per cent  Gulf News',
};
const N4 = {
  label: '⑩ UAE AI News《AI firefighting》(snippet=115字·低于200下限·负样本)',
  title: 'UAE turns to AI to fight fires: Find out how it will save residents, firefighters and protect properties - Gulf News',
  source_name: 'UAE AI News', source_url: 'https://u.ae/regression-n4',
  category: 'policy', language: 'en', published_at: '2026-10-11T00:00:00.000Z', date_key: '2026-10-11',
  ai_score: 68, is_featured: 0, content: '',
  content_snippet: 'UAE turns to AI to fight fires: Find out how it will save residents, firefighters and protect properties  Gulf News',
};
// 生产库原文（10-12 隔离表，Hacker News AI / 84 分）：片段是 HN 机器人卡片元数据
// （Article URL / Comments URL / Points / Comments），4 行结构化字段、零正文句子。
// 它既不含标题（走不到"标题占位"分支），也达不到 300 字信任下限，
// 必须靠 MIN_MATERIAL_CHARS=200 这道闸拦下——校准后这条闸不得放宽。
const N5_SNIPPET = 'Article URL: https://www.ft.com/content/052610c5-22b4-4dd4-932e-b7f9f0628b6a\nComments URL: https://news.ycombinator.com/item?id=50035886\nPoints: 114\n# Comments: 80';
const N5 = {
  label: `⑪ 84分 Hacker News AI《Nvidia/Reflection AI》(snippet=${N5_SNIPPET.length}字HN卡片元数据·不含标题·负样本)`,
  title: "Nvidia in talks to acquire US 'open' model startup Reflection AI",
  original_title: "Nvidia in talks to acquire US 'open' model startup Reflection AI",
  source_name: 'Hacker News AI', source_url: 'https://news.ycombinator.com/item?id=50035886',
  category: 'company', language: 'en', published_at: '2026-10-11T00:00:00.000Z', date_key: '2026-10-11',
  ai_score: 84, is_featured: 0, content: '',
  content_snippet: N5_SNIPPET,
};

// ───────────────────────── 断言框架 ─────────────────────────
const RESULTS = [];
const CASES = [];
const T = (sample, desc, fn) => CASES.push({ sample, desc, fn });
const eq = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};
const ok = (cond, what) => { if (!cond) throw new Error(`断言失败: ${what}`); };

await initDB();
// 独立只读探针连接：直接查临时库断言行数/隔离记录，不依赖被测模块的读写接口，
// 避免"用写库函数验证写库结果"的自证
const probe = new Database(TMP_DB, { readonly: true });
const countOf = (table) => probe.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const rowOf = (sql, ...args) => probe.prepare(sql).get(...args);

// ═════════════ 样本① 2228：壳页 + 缺正文 → 隔离，零模型调用，绝不进 articles ═════════════
T(S1.label, '壳页识别命中（"正在取这篇稿子"占位串）', () => eq(looksLikePageShell(S1.content), true, 'looksLikePageShell'));
T(S1.label, `正文仅${SHELL_2228.length}字，低于${MIN_MATERIAL_CHARS}字下限亦判无料`, () => ok(SHELL_2228.length < MIN_MATERIAL_CHARS, '壳页长度应低于素材下限'));
T(S1.label, 'pickMaterial 返回 null（爬虫修正后 snippet 为空）', () => eq(pickMaterial(S1), null, 'pickMaterial'));
T(S1.label, 'pickMaterial 返回 null（旧数据 snippet=标题占位，同样不得当素材）', () => eq(pickMaterial({ ...S1, content_snippet: S1.title }), null, 'pickMaterial(标题占位)'));
T(S1.label, 'generateSummary 不调模型即隔离，reason=missing_body', async () => {
  STUB_CALLS = 0;
  const r = await generateSummary({ ...S1 });
  eq(STUB_CALLS, 0, '模型调用次数');
  eq(quarantineReason(r), QUARANTINE_REASONS.MISSING_BODY, '隔离原因');
  eq(r._proc_stage, QUARANTINE_STAGE, '失败环节');
  eq(r.summary, '', '摘要必须为空（不得凭标题编稿）');
});
T(S1.label, 'reviewSummary 同样零模型调用并保持隔离标记', async () => {
  STUB_CALLS = 0;
  const r = await reviewSummary({ ...S1, summary: '凭标题编出来的假摘要' });
  eq(STUB_CALLS, 0, '模型调用次数');
  eq(quarantineReason(r), QUARANTINE_REASONS.MISSING_BODY, '隔离原因');
});
T(S1.label, '第二道网补位说明：2228 的编造全为纯中文软表述，无硬 token 可锤——它由素材闸门拦下，而非回指校验（此断言记录分工，防止误以为回指校验万能）', () => {
  const g = groundedAssertions({ keyPoints: S1.__fake_points, takeaway: S1.__fake_takeaway, body: SHELL_2228 });
  // 明确断言：这条编造稿确实拦在素材闸门（pickMaterial=null），而不是靠 token 比对
  eq(pickMaterial(S1), null, '素材闸门必须拦住 2228');
  eq(g.key_points.length, S1.__fake_points.length, '纯中文软表述无硬 token，回指校验按设计放行');
});
T(S1.label, '第二道网：编造的数字与专有名词在真正文上全部回指不上', () => {
  const g = groundedAssertions({
    keyPoints: ['行政令要求2029年前关停全部AI数据中心', 'OpenAI与Anthropic已各自缴纳50亿美元罚款'],
    takeaway: '禁令覆盖12个联邦部门',
    body: S3.content,
  });
  eq(g.ok, false, '回指校验结论');
  eq(g.key_points.length, 0, '存活要点数');
  ok(g.dropped.length === 3, '三条断言应全部被丢弃');
});
T(S1.label, '标题党封顶：92 分压到 79 且不得进精选', () => {
  const a = { title: S1.title, ai_score: 92, score_detail: JSON.stringify({ score: 92, tier: '重磅' }) };
  eq(applyClickbaitCeiling([a]), 1, '封顶篇数');
  eq(a.ai_score, CLICKBAIT_SCORE_CEILING, '封顶后分数');
  ok(JSON.parse(a.score_detail).clickbait_flag, 'score_detail 必须记 flag');
  const b = { title: S1.title, ai_score: 92, newsness: 'new' };
  eq(markFeatured([b], { now: Date.now() }), 0, '事故稿不得被标精选');
});
T(S1.label, '复用 2026-09-28 已有隔离队列：闸门产出 _proc_failed，collect 写库闸门据此分流', async () => {
  const before = countOf('articles');
  const q = await generateSummary({ ...S1 });
  // collect.mjs 的 isHalfProduct 第一条判据就是 a._proc_failed === true，这里按同一契约断言
  eq(q._proc_failed, true, '必须用既有 _proc_failed 约定，而非另造标记字段');
  await insertQuarantine([q]);
  eq(countOf('articles'), before, 'articles 行数不得变化（隔离稿绝不进主列表）');
  const row = rowOf('SELECT reason, failed_stage, title, ai_score, content FROM articles_quarantine WHERE source_url = ?', S1.source_url);
  ok(row, '隔离记录必须存在');
  ok(String(row.reason).startsWith(QUARANTINE_REASONS.MISSING_BODY), '隔离原因落库值');
  eq(row.failed_stage, QUARANTINE_STAGE, '失败环节落库值');
  // 全文快照一并留存，reprocess-quarantine.mjs 补抓成功后可直接重跑
  ok(String(row.content).includes('正在取这篇稿子'), '须留存原始壳页正文供重跑/复核');
});

// ═════════════ 样本② 2271：同上 ═════════════
T(S2.label, '壳页识别命中', () => eq(looksLikePageShell(S2.content), true, 'looksLikePageShell'));
T(S2.label, '正文 142 字，低于素材下限', () => ok(SHELL_2271.length < MIN_MATERIAL_CHARS, '壳页长度应低于素材下限'));
T(S2.label, 'pickMaterial 返回 null', () => eq(pickMaterial(S2), null, 'pickMaterial'));
T(S2.label, 'generateSummary 零模型调用并隔离', async () => {
  STUB_CALLS = 0;
  const r = await generateSummary({ ...S2 });
  eq(STUB_CALLS, 0, '模型调用次数');
  eq(quarantineReason(r), QUARANTINE_REASONS.MISSING_BODY, '隔离原因');
});
T(S2.label, '写库分区：不进 articles', async () => {
  const before = countOf('articles');
  await insertQuarantine([await generateSummary({ ...S2 })]);
  eq(countOf('articles'), before, 'articles 行数不得变化');
  ok(rowOf('SELECT 1 FROM articles_quarantine WHERE source_url = ?', S2.source_url), '隔离记录必须存在');
});
T(S2.label, '无可用素材的稿子不得占精选位', () => {
  const a = { ...S2, is_featured: true };
  const r = gateFeaturedMaterialTier([a]);
  eq(r.demoted, 1, '被摘除精选数');
  eq(a.is_featured, false, '精选位');
});

// ═════════════ 样本③ 2372：真全文高分稿，必须放行（防误杀） ═════════════
T(S3.label, '不判壳', () => eq(looksLikePageShell(S3.content), false, 'looksLikePageShell'));
T(S3.label, 'pickMaterial 判定有全文', () => eq(pickMaterial(S3)?.hasFullText, true, 'hasFullText'));
T(S3.label, '真实要点全部回指得上正文（dropped=0，零误杀）', () => {
  const g = groundedAssertions({ keyPoints: S3.real_points, takeaway: S3.real_takeaway, body: S3.content });
  eq(g.ok, true, '回指校验结论');
  eq(g.dropped.length, 0, '被丢弃断言数');
});
T(S3.label, 'generateSummary 正常放行（模型调用 1 次、无隔离标记）', async () => {
  STUB_CALLS = 0;
  stubPayload = { title: S3.title, takeaway: S3.real_takeaway, key_points: S3.real_points, summary: '阶跃终端将于10月13日在上海发布首款大模型原生智能体手机STEPX Neo。', category: 'company', tags: { companies: ['阶跃终端'], people: [], keywords: [], regions: [] } };
  const r = await generateSummary({ ...S3 });
  eq(STUB_CALLS, 1, '模型调用次数');
  eq(isQuarantined(r), false, '正常稿不得被打隔离标记');
  ok(r.summary && r.summary.length > 0, '摘要必须生成');
});
T(S3.label, '精选位保留（有全文，不该被降级误伤，也不打摘要级标记）', () => {
  const a = { ...S3, is_featured: true };
  const r = gateFeaturedMaterialTier([a]);
  eq(r.demoted, 0, '被摘除精选数');
  eq(r.marked, 0, '摘要级标记数');
  eq(a.is_featured, true, '精选位');
});
T(S3.label, '正常稿写入 articles 成功', async () => {
  stubPayload = { title: S3.title, takeaway: S3.real_takeaway, key_points: S3.real_points, summary: '阶跃终端发布STEPX Neo。', category: 'company', tags: {} };
  const r = await generateSummary({ ...S3 });
  const { inserted } = await insertArticles([r]);
  eq(inserted, 1, 'articles 新增行数');
});

// ═════════════ 样本④ 真实 RSS 摘要片段：必须放行，但不得占精选位 ═════════════
T(S4.label, 'pickMaterial 采信真实摘要片段（非标题占位）', () => {
  const m = pickMaterial(S4);
  ok(m, '应返回可用素材');
  eq(m.hasFullText, false, 'hasFullText');
  eq(m.from, 'snippet', '素材来源');
});
T(S4.label, 'generateSummary 正常放行（片段素材也进模型，不再退回标题）', async () => {
  STUB_CALLS = 0;
  stubPayload = { title: S4.title, takeaway: S4.real_takeaway, key_points: S4.real_points, summary: 'OpenAI 为青少年模式的 ChatGPT for Teens 增加大学申请规划工具。', category: 'company', tags: {} };
  const r = await generateSummary({ ...S4 });
  eq(STUB_CALLS, 1, '模型调用次数');
  eq(isQuarantined(r), false, '正常稿不得被打隔离标记');
});
T(S4.label, '片段稿保留精选位并打摘要级标记（2026-10-12 撤销一刀切：material_level=summary 入 score_detail，不建新列）', () => {
  const a = { ...S4, is_featured: true, score_detail: '{"score":81,"tier":"重要"}' };
  const r = gateFeaturedMaterialTier([a]);
  eq(r.demoted, 0, '被摘除精选数');
  eq(r.marked, 1, '摘要级标记数');
  eq(a.is_featured, true, '精选位');
  eq(JSON.parse(a.score_detail).material_level, 'summary', 'score_detail.material_level');
  eq(JSON.parse(a.score_detail).tier, '重要', '原有子分字段不得被覆盖丢失');
});
T(S4.label, '反例：片段与标题等同（爬虫占位）时判无料', () => {
  eq(pickMaterial({ ...S4, content_snippet: S4.title }), null, 'pickMaterial(标题占位)');
});

// ═════════════ 通用防误杀：普通标题不被封顶 ═════════════
T('通用', '正常标题不被标题党封顶', () => {
  const a = { title: '阶跃终端将于10月13日发布大模型原生智能体手机STEPX Neo', ai_score: 92, score_detail: '{}' };
  eq(applyClickbaitCeiling([a]), 0, '封顶篇数');
  eq(a.ai_score, 92, '分数不得被改动');
});
T('通用', '软表述要点（无硬事实 token）不被回指校验误杀', () => {
  const g = groundedAssertions({ keyPoints: ['这一举措引发了行业广泛讨论'], takeaway: '', body: '任意正文内容' });
  eq(g.ok, true, '回指校验结论');
  eq(g.dropped.length, 0, '被丢弃断言数');
});
T('通用', '模型只给 summary 不给要点/要点句时不算造假（格式退化不等于编造，防误杀）', () => {
  const g = groundedAssertions({ keyPoints: [], takeaway: '', body: S3.content });
  eq(g.ok, true, '回指校验结论');
});

// ═════════════ 2026-10-12 正样本⑤⑥：长摘要开头含标题，必须放行（防误杀） ═════════════
for (const [S, TAKEAWAY, POINTS] of [[S5, S5_TAKEAWAY, S5_POINTS], [S6, S6_TAKEAWAY, S6_POINTS]]) {
  T(S.label, `片段原始长度 ≥${SNIPPET_TRUST_MIN_CHARS} 且开头含标题（旧版误杀触发条件成立）`, () => {
    ok(S.content_snippet.length >= SNIPPET_TRUST_MIN_CHARS, `长度应≥信任下限，实际 ${S.content_snippet.length}`);
    ok(S.content_snippet.includes(S.title), '样本必须确实以标题开头');
  });
  T(S.label, 'pickMaterial 采信为 snippet 级素材（不再判标题占位）', () => {
    const m = pickMaterial(S);
    ok(m, '应返回可用素材');
    eq(m.from, 'snippet', '素材来源');
    eq(m.hasFullText, false, 'hasFullText');
  });
  T(S.label, '不判壳页', () => eq(looksLikePageShell(S.content_snippet), false, 'looksLikePageShell'));
  T(S.label, 'generateSummary 正常放行（模型调用 1 次、无隔离标记）', async () => {
    STUB_CALLS = 0;
    stubPayload = { title: S.title, takeaway: TAKEAWAY, key_points: POINTS, summary: '回归桩摘要：内容全部取自素材片段。', category: S.category, tags: {} };
    const r = await generateSummary({ ...S });
    eq(STUB_CALLS, 1, '模型调用次数');
    eq(isQuarantined(r), false, '正常稿不得被打隔离标记');
    ok(r.summary && r.summary.length > 0, '摘要必须生成');
  });
  T(S.label, '精选保留并打摘要级标记（material_level=summary 复用 score_detail，不建新列）', () => {
    const a = { ...S, is_featured: true };
    const rr = gateFeaturedMaterialTier([a]);
    eq(rr.demoted, 0, '被摘除精选数');
    eq(rr.marked, 1, '摘要级标记数');
    eq(a.is_featured, true, '精选位');
    eq(JSON.parse(a.score_detail).material_level, 'summary', 'score_detail.material_level');
  });
}

// ═════════════ 2026-10-12 负样本⑦⑧⑨⑩⑪：不得放水，逐条仍拦 ═════════════
for (const N of [N1, N2, N3, N4, N5]) {
  T(N.label, 'pickMaterial 返回 null（仍判无料）', () => eq(pickMaterial({ ...N }), null, 'pickMaterial'));
  T(N.label, 'generateSummary 零模型调用并隔离 missing_body', async () => {
    STUB_CALLS = 0;
    const r = await generateSummary({ ...N });
    eq(STUB_CALLS, 0, '模型调用次数');
    eq(quarantineReason(r), QUARANTINE_REASONS.MISSING_BODY, '隔离原因');
    eq(r._proc_stage, QUARANTINE_STAGE, '失败环节');
  });
}
T(N5.label, '反例前提：片段确实不含标题（所以拦住它靠的是 200 字下限，不是标题占位分支）', () => {
  ok(!N5.content_snippet.includes(N5.title), '片段不应含标题');
  ok(N5.content_snippet.length < MIN_MATERIAL_CHARS, `长度应低于素材下限，实际 ${N5.content_snippet.length}`);
});
T(N2.label, '反例补强：短"标题复读"（<300字）无论包含还是等同都必须拦下', () => {
  eq(pickMaterial({ ...N2, content_snippet: N2.title, title: N2.title }), null, '标题等同占位');
  const partial = N2.title.slice(0, 12);
  eq(pickMaterial({ ...N2, content_snippet: partial }), null, '短片段包含关系占位（<200字下限亦拦）');
});

// ═════════════ 2026-10-12 红灯分级三档 ═════════════
T('红灯分级', '常规隔离（隔离2/新增4，占比33%未过5条且…）——按公式 2/(2+4)=33%>30% → batch', () =>
  eq(classifyQuarantineAlert({ quarantinedCount: 2, admittedCount: 4 }), 'batch', '档位'));
T('红灯分级', '常规：隔离2/新增8 → 20% 且 <5 条 → routine（exit 0，Actions 转绿）', () =>
  eq(classifyQuarantineAlert({ quarantinedCount: 2, admittedCount: 8 }), 'routine', '档位'));
T('红灯分级', '常规：隔离3/新增17 → 15% → routine（run 720 那轮若新增足够即转绿）', () =>
  eq(classifyQuarantineAlert({ quarantinedCount: 3, admittedCount: 17 }), 'routine', '档位'));
T('红灯分级', '批量：单轮隔离 ≥5 条（占比再低也红）', () =>
  eq(classifyQuarantineAlert({ quarantinedCount: 5, admittedCount: 20 }), 'batch', '档位'));
T('红灯分级', '批量：隔离/(新增+隔离) >30%（2/5=40%）', () =>
  eq(classifyQuarantineAlert({ quarantinedCount: 2, admittedCount: 3 }), 'batch', '档位'));
T('红灯分级', '边界：30% 整（3/10）不越线 → routine', () =>
  eq(classifyQuarantineAlert({ quarantinedCount: 3, admittedCount: 7 }), 'routine', '档位'));
T('红灯分级', 'fatal：欠费/鉴权类隔离优先级最高', () =>
  eq(classifyQuarantineAlert({ quarantinedCount: 1, admittedCount: 10, fatalArrears: true }), 'fatal', '档位'));
T('红灯分级', '零新增（0入库+2隔离）→ 占比100% → batch（当日颗粒无收必须叫人）', () =>
  eq(classifyQuarantineAlert({ quarantinedCount: 2, admittedCount: 0 }), 'batch', '档位'));

// ───────────────────────── 执行与报表 ─────────────────────────
const results = [];
for (const c of CASES) {
  let verdict = 'PASS', msg = '';
  try {
    await c.fn();
  } catch (err) {
    verdict = 'FAIL';
    msg = err.message;
  }
  results.push({ sample: c.sample, desc: c.desc, verdict, msg });
  console.log(`${verdict}  ${c.sample} | ${c.desc}${msg ? `\n      ↳ ${msg}` : ''}`);
}

const failed = results.filter(r => r.verdict === 'FAIL');
const passed = results.length - failed.length;

console.log('\n════════════════ 回归结果汇总 ═════════════════');
console.log('样本                                          断言  通过  失败');
const bySample = new Map();
for (const r of results) {
  if (!bySample.has(r.sample)) bySample.set(r.sample, { total: 0, pass: 0 });
  const s = bySample.get(r.sample);
  s.total++;
  if (r.verdict === 'PASS') s.pass++;
}
for (const [sample, s] of bySample) {
  console.log(`${sample.padEnd(46)} ${String(s.total).padStart(4)}  ${String(s.pass).padStart(4)}  ${String(s.total - s.pass).padStart(4)}`);
}
console.log(`─────────────────────────────────────────────────────`);
console.log(`合计 ${results.length} 条断言，通过 ${passed}，失败 ${failed.length} → ${failed.length ? 'FAIL' : 'ALL PASS'}`);

probe.close();
// 临时库留在系统临时目录交给 OS 回收，本脚本不执行任何删除动作（红线：不碰 rm/unlink）
stubServer.close();
console.log(`（临时库未删除，可由系统临时目录回收：${TMP_DB}）`);
process.exit(failed.length ? 1 : 0);
