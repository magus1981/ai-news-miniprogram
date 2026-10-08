/**
 * 素材闸门（material gate）——摘要/二审共用的"有没有料、料能不能用"判定
 *
 * 制度性背景（2026-10-08 假新闻事故 id 2228「特朗普签行政令：美国政府全面封杀AI」，92分进精选）：
 * 真实事件是 2026-09-29 行政令把联邦用语 AI 改称 Super Intelligence(SI)，只改称呼、不禁技术。
 * 新智元官网 aiera.com.cn 是 JS 异步渲染，全文抓取只拿到 112 字页面壳
 * （"…· 新智元官网 / ASI 爆点… / 正在取这篇稿子…"），而旧管线在两处把**标题当正文**喂给模型：
 *   ai-summary  content = hasFullText ? content : (content_snippet || title)
 *   ai-review   material  = 同一个 fallback
 * 加上爬虫列表卡片 `content_snippet: title` 的占位约定，模型看到的是"标题+标题"，
 * 于是凭"封杀AI"四个字脑补出一条不存在的禁令，并且拿了全篇最高分。
 * 二手素材（合并稿件片段、旁证标题）只作补充上下文，永不单独构成本条的素材。
 *
 * 本模块把三件事收敛成一处，供 ai-summary / ai-review / collect 共用：
 * 1. pickMaterial      —— 唯一取料路径，没料返回 null（调用方必须隔离，不得调模型、不得写 articles）
 * 2. looksLikePageShell —— 壳页识别：JS 渲染站抓回来的页面骨架不再被当作"全文"
 * 3. groundedAssertions —— 事实断言必须能回指素材正文，回指不上的要点逐条丢弃
 * 设计原则与 verifyQuote 一致：宁缺毋滥。少一条新闻是可接受的损失，编一条新闻不是。
 */

// 素材长度下限：与既有 hasFullText 口径一致（ai-summary/ai-review 原本就用 200 字判"有无全文"）
export const MIN_MATERIAL_CHARS = 200;

// 隔离原因码（写进 _proc_reason 前缀，最终落 articles_quarantine.reason，供人工回捞与日报统计）
export const QUARANTINE_REASONS = {
  MISSING_BODY: 'missing_body',      // 无可用素材：抓不到正文，且片段也只是标题占位/壳页
  UNGROUNDED_SUMMARY: 'ungrounded_summary', // 素材有，但模型写的硬事实一条都回指不上正文
};
// 失败环节标识：沿用 2026-09-28 建好的 articles_quarantine.failed_stage 口径
export const QUARANTINE_STAGE = 'material';

/**
 * 壳页/拦截页占位串。命中即说明抓到的是页面骨架，不是稿子正文。
 * 分两档，因为中文关键词裸匹配会误伤正常行文（2026-10-08 自检：
 * 极客公园 5093 字真稿因正文含"环境异常"四字被误判为壳页）：
 *  - STRONG：语义唯一，只可能出现在壳页/拦截页 → 全文任意位置命中即判壳
 *  - WEAK  ：日常行文也可能用到的词 → 仅当它出现在"短行"上（页面级 boilerplate 独占一行）才判壳
 */
const SHELL_MARKERS_STRONG = [
  '正在取这篇稿子',   // 新智元 aiera.com.cn JS 渲染占位（2026-10-08 事故站）
  '页面走丢了',
  '页面不存在',
  '页面未找到',
  '打开微信阅读',
  '请在微信客户端打开',
  '点击屏幕右上方',
  '登录后可见',
  '登录后查看',
  '登录阅读全文',
  '原文已被删除',
  '内容已被删除',
  '该文章已撤回',
  '请开启JavaScript',
  '请启用JavaScript',
  '需要启用JavaScript',
  '请启用 JS',
];
const SHELL_MARKERS_WEAK = ['环境异常', '安全验证', '访问过于频繁', '加载失败', '出错了'];
// 短行上限：壳页占位文案都独占一行且很短；正文里的同类词在长句中
const SHELL_MARKER_LINE_MAX = 40;

// "404" 单独匹配会误伤正文里的数字（型号/编号/百分比），故只认 HTTP 语义的组合写法
const SHELL_REGEXES = [
  /404\s*(not\s*found|页面|错误)/i,
  /\bnot\s*found\b/i,
  /HTTP\s*\/?\s*1\.[01]\s+404/,
];

// 导航/装饰行特征（壳页正文的主体就是这些）：栏目名、社交按钮、页脚署名。
// 只用于识别"整行都是壳"的短句——正文里出现"值得关注"的句子不能被当成导航扔掉，
// 故配合 NAV_LINE_MAX 使用（2026-10-08 自检：真稿 5093 字被误判为壳，就是这个长度闸没加）。
const NAV_LINE_RE = /(关注|点赞|在看|分享|扫码|订阅|举报|广告|版权|免责|上一篇|下一篇|返回首页|目录|标签|来源|编辑|记者|审核|责任编辑|扫码关注|阅读原文|点击阅读)/;
const NAV_LINE_MAX = 24;

/**
 * 压缩空白（与 ai-summary.verifyQuote 同口径：跨换行/全半角空格的比对都先去掉空白）
 */
export function squash(s) {
  return String(s || '').replace(/\s+/g, '');
}

/**
 * 剥掉导航/装饰行后剩下的"可读正文"。
 * 判定条件严格：短行（≤24字）且命中导航特征才丢；长行一律保留，避免误杀正文。
 */
export function readableBody(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !(l.length <= NAV_LINE_MAX && NAV_LINE_RE.test(l)))
    .join('\n');
}

/**
 * 壳页识别：命中占位串，或剥掉导航行后可读正文不足下限，都判壳。
 * @param {string} text 抓回来的正文
 * @returns {boolean} true = 这是壳页/拦截页，不能当素材
 */
export function looksLikePageShell(text) {
  const raw = String(text || '');
  if (!raw.trim()) return true;
  for (const re of SHELL_REGEXES) if (re.test(raw)) return true;
  if (SHELL_MARKERS_STRONG.some(m => raw.includes(m))) return true;
  // WEAK 词只看短行：正文长句里出现"环境异常/安全验证"是正常行文
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.some(l => l.length <= SHELL_MARKER_LINE_MAX && SHELL_MARKERS_WEAK.some(m => l.includes(m)))) return true;
  return readableBody(raw).length < MIN_MATERIAL_CHARS;
}

/**
 * 唯一取料路径（ai-summary 与 ai-review 必须共用本函数，两处口径不一致就是 2228 的成因）。
 * 顺序：全文 content → RSS/爬虫真实摘要 content_snippet → null。
 * title 永不作为素材：标题是被加工的对象，不是加工的原料。
 * @param {Object} article - {content, content_snippet, title}
 * @returns {{material: string, hasFullText: boolean, from: ('content'|'snippet'), chars: number}|null}
 *          null = 无可用素材，调用方必须走隔离，不得调模型、不得写 articles
 */
export function pickMaterial(article) {
  if (!article) return null;
  const full = String(article.content || '');
  if (full.length >= MIN_MATERIAL_CHARS && !looksLikePageShell(full)) {
    return { material: full, hasFullText: true, from: 'content', chars: full.length };
  }
  const snippet = String(article.content_snippet || '').trim();
  const title = String(article.title || '').trim();
  // 爬虫列表卡片惯用 `content_snippet: title` 占位（新智元/各政务站），
  // 这类片段与标题等价，用等于/包含标题即视为无料，堵掉"标题换个字段名再进来"
  const isTitlePlaceholder = !!snippet
    && (snippet === title || (!!title && (snippet.includes(title) || title.includes(snippet))));
  if (snippet.length >= MIN_MATERIAL_CHARS && !isTitlePlaceholder && !looksLikePageShell(snippet)) {
    return { material: snippet, hasFullText: false, from: 'snippet', chars: snippet.length };
  }
  return null;
}

/**
 * 给文章打隔离标记。沿用 2026-09-28 已有的加工失败约定（_proc_failed / _proc_reason），
 * 不另造一套：collect.mjs 的 fail-fast 写库闸门 isHalfProduct 已按 _proc_failed 分流，
 * 命中者一律不进 articles，改由 db.insertQuarantine 写入 articles_quarantine（含全文快照，
 * 供 reprocess-quarantine.mjs 在补抓成功后重跑入主列表）。
 * 用 _ 前缀临时字段，与管线既有约定一致，不入库。
 */
export function markQuarantine(article, reason, detail = '') {
  return {
    ...article,
    _proc_failed: true,
    _proc_reason: detail ? `${reason}: ${String(detail).slice(0, 280)}` : reason,
    _proc_stage: QUARANTINE_STAGE,
  };
}

/** 该条目是否已被闸门判隔离 */
export function isQuarantined(article) {
  return article?._proc_failed === true;
}

/** 取出隔离原因码（'missing_body: …' → 'missing_body'）；未被隔离时返回 '' */
export function quarantineReason(article) {
  if (!isQuarantined(article)) return '';
  return String(article._proc_reason || '').split(':')[0].trim();
}

// ─────────────────────────────────────────────────────────────────────────
// 事实断言回指校验（verifyQuote 的泛化）
//
// verifyQuote 只治"金句"一个字段，且 hasFullText=false 时传空串直接跳过——
// 而 2228 编出来的东西全在 key_points / takeaway / summary 里，一个字都没校验。
// 本函数把"逐字回指素材"的检查推广到所有承载硬事实的字段。
//
// 判定口径（防误杀优先）：只抽"错了就是假新闻"的硬 token——数字（含小数/百分比/千分位）、
// 英文专有名词、书名号/引号内的实体名。软表述（"引发关注""被认为"）不做字面比对。
// token 在素材里 squash 包含检查找不到 → 该条断言丢弃；全部丢弃 → 整条判 fail 走隔离。
// ─────────────────────────────────────────────────────────────────────────

// 英文专有名词候选：至少 2 字符且含大写（GPT-6、OpenAI、Anthropic、SI），排除纯小写虚词
const PROPER_NOUN_RE = /[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*/g;
// 数字串：千分位、小数、百分比、带单位量（37.19%、1,000、500亿、2.8万亿、320 billion、66万块）。
// 前置 (?<![A-Za-z0-9.]) 是必须的：否则 "GB300" 会被抠出一个裸 "300" 当硬事实，
// 而 "300" 在任意正文里都能撞见——校验瞬间失去意义（2026-10-08 首版自检踩到）。
const NUMBER_RE = /(?<![A-Za-z0-9.])\d[\d,]*(?:\.\d+)?(?:\s*(?:%|％|万亿|千亿|billion|trillion|million|billion|万|亿|千|GB|TB|ms|秒|分钟|小时|天|周|月|年|美元|元|人民币|块|台|颗|人|次|倍))?/gi;
// 中文引号/书名号内的实体（「」『』“”《》〈〉）
const QUOTED_ENTITY_RE = /[「『“《〈]([^」』”》〉]{2,30})[」』”》〉]/g;

const STOPWORDS = new Set([
  'AI', 'A', 'I', 'IT', 'B2B', 'B2C', 'API', 'CEO', 'CTO', 'CFO', 'COO', 'GPU', 'CPA', 'TPM',
  'GB', 'TB', 'KB', 'MB', 'MS', 'K', 'M', 'B', 'T', 'PM', 'AM', 'US', 'UK', 'EU', 'TV', 'ID',
  'GPT', // 裸系列名常见于各类报道，单独出现不足以判定事实出处（带版本号时按 GPT-6 整体比对）
]);

/**
 * 从一条断言里抽出硬事实 token（数字 / 英文专有名词 / 引号内实体）
 * @returns {string[]} 已 squash 的 token 列表
 */
export function hardTokens(text) {
  const s = String(text || '');
  if (!s.trim()) return [];
  const out = new Set();

  for (const m of s.matchAll(NUMBER_RE)) {
    const tok = squash(m[0]);
    // 纯年份/纯单数字噪声太大（"2026年""1个"），要求带量词或本身是多位数串
    if (tok.length >= 2) out.add(tok);
  }
  for (const m of s.matchAll(QUOTED_ENTITY_RE)) {
    const tok = squash(m[1]);
    if (tok.length >= 2) out.add(tok);
  }
  for (const m of s.matchAll(PROPER_NOUN_RE)) {
    const raw = m[0];
    if (raw.length < 2) continue;
    if (!/[A-Z]/.test(raw)) continue;           // 全小写：不是专有名词
    const up = raw.toUpperCase();
    if (STOPWORDS.has(up) || STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;            // 纯数字交给 NUMBER_RE
    out.add(squash(raw));
  }
  return [...out];
}

/**
 * 事实断言回指校验：逐条核对 key_points / takeaway 里的硬事实 token 是否见于素材正文。
 * @param {Object} params
 * @param {string[]} params.keyPoints - 核心要点数组
 * @param {string} params.takeaway    - 一句话要点（可空）
 * @param {string} params.body        - 素材正文（pickMaterial 的 material，永不为空串）
 * @returns {{key_points: string[], takeaway: string, dropped: Array<{field,value,missing}>, ok: boolean}}
 *          ok=false 表示一条断言都没留下（模型写的内容与正文完全对不上）→ 调用方隔离
 */
export function groundedAssertions({ keyPoints = [], takeaway = '', body = '' } = {}) {
  const hay = squash(body);
  const dropped = [];

  const check = (field, value) => {
    const tokens = hardTokens(value);
    if (!tokens.length) return true;           // 无硬事实的软表述：不做字面比对，放行
    const missing = tokens.filter(t => !hay.includes(t));
    if (missing.length) {
      dropped.push({ field, value: String(value).slice(0, 120), missing: missing.slice(0, 6) });
      return false;
    }
    return true;
  };

  const points = (Array.isArray(keyPoints) ? keyPoints : [])
    .filter(p => typeof p === 'string' && p.trim())
    .filter(p => check('key_points', p));

  const keptTakeaway = String(takeaway || '').trim() ? check('takeaway', takeaway) : false;

  // 判 fail 的口径是"写出来的断言全都被证伪"，不是"什么都没有"：
  // 模型偶尔会只给 summary 不给 key_points/takeaway，那是格式退化，不是造假，
  // 若按"存活断言数为 0"判 fail 就会把这类正常稿误杀（闸门一旦误杀，运维就会去关掉它）。
  const ok = dropped.length === 0 || points.length > 0 || keptTakeaway;
  return {
    key_points: points,
    takeaway: keptTakeaway ? String(takeaway).trim() : '',
    dropped,
    ok,
  };
}

/**
 * 无全文素材不得占精选位（collect 在全文抓取后调用）。
 * 精选是"今日必读"的推荐位，一条连正文都没抓到的稿子不该出现在那里。
 * 注意只看 hasFullText：素材来自真实 RSS 摘要（snippet）的稿子仍不配精选——
 * 摘要片段是别人写的二手料，撑不起"必读"的可信度承诺（2228 就是靠片段位里的标题进精选的）。
 * @param {Array} list - 已带 is_featured 的入选文章（原地修改）
 * @returns {number} 被摘掉精选标的篇数
 */
export function demoteFeaturedWithoutFullText(list) {
  if (!Array.isArray(list)) return 0;
  let demoted = 0;
  for (const a of list) {
    if (!a?.is_featured) continue;
    const mat = pickMaterial(a);
    if (!mat?.hasFullText) {
      a.is_featured = false;
      demoted++;
      console.warn(`  [DEMOTE] 无全文素材，摘除精选位: ${String(a.title || '').slice(0, 40)}`);
    }
  }
  return demoted;
}
