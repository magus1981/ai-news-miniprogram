/**
 * 本地开发API服务器 - 零依赖，直接读取本地SQLite
 * 用法: node local-server.mjs
 * 默认端口: 3000
 */
import { createServer } from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import dns from 'dns/promises';
import { SOURCES, alertThreshold } from './pipeline/sources.mjs';

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3000;
const dbPath = join(__dirname, 'data', 'articles.db');
// 资料库存档目录（data/archive/{url哈希}/，与仓库 data/ 同根，供静态回显与同步打包）
const archiveDir = join(__dirname, 'data', 'archive');
// 存档上传体上限（单轮正常几MB~几十MB，防异常膨胀）
const MAX_ARCHIVE_UPLOAD = 1024 * 1024 * 1024;
// 生产数据同步开关：设置 SYNC_TOKEN 环境变量后启用 POST /api/sync-upload（本地开发不设即关闭）
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';

// ── 令牌分域（2026-09-14 安全审计）───────────────────────────────────
// 原先整库读写、存档读写、代拉中继共用同一个 SYNC_TOKEN，且服务裸 HTTP 无 TLS：
// token 在链路/日志/systemd unit 里泄露一次，就等于把"整库替换"交出去。
// 现按能力拆三域，各自未配置时回落 SYNC_TOKEN —— Actions 侧不改也不断链，
// 逐步在 GitHub secrets 里换成专用 token 即可彻底隔离爆炸半径：
//   DB_TOKEN       整库读/写  /api/sync-download, /api/sync-upload
//   ARCHIVE_TOKEN  存档读/写  /api/archive-manifest, /api/sync-archive-download, /api/sync-archive
//   PROXY_TOKEN    代拉中继  /api/proxy
const DB_TOKEN = process.env.DB_TOKEN || SYNC_TOKEN;
const ARCHIVE_TOKEN = process.env.ARCHIVE_TOKEN || SYNC_TOKEN;
const PROXY_TOKEN = process.env.PROXY_TOKEN || SYNC_TOKEN;

// 恒定时间比较：避免按字节早退造成的 token 猜解侧信道
function tokenOk(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
// 门控端点统一鉴权：expected 为空视为该能力整体关闭（403），token 不符 401
function authOrFail(res, req, expected, disabledMsg) {
  if (!expected) { sendJSON(res, 403, { error: disabledMsg }); return false; }
  if (!tokenOk(req.headers['x-sync-token'], expected)) { sendJSON(res, 401, { error: 'unauthorized' }); return false; }
  return true;
}

// ── SSRF 防护：目标主机解析到的地址必须全部为公网单播 ─────────────────
// 覆盖 环回/私有/链路本地/云元数据（阿里云 100.100.100.200 落在 100.64/10 内）
// /运营商级 NAT/组播/保留段，以及 IPv6 的 ::1、fc00::/7、fe80::/10、ff00::/12。
function isBlockedIp(ip) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT + 阿里云元数据
    if (a === 169 && b === 254) return true;                     // 链路本地 + AWS/GCP 元数据
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;                       // 192.0.0.0/24 + 192.0.2.0/24 TEST-NET
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 224 || a === 240 || a === 255) return true;        // 组播/保留/广播
    return false;
  }
  const s = ip.toLowerCase().replace(/%.*$/, '');
  if (s === '::' || s === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;                 // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(s)) return true;                 // fe80::/10
  if (/^ff/.test(s)) return true;                                // 组播
  if (/^2001:0?000:/.test(s.replace(/^2001:db8:/, '2001:0db8:'))) return false;
  if (/^::ffff:/.test(s)) return isBlockedIp(s.split('::ffff:')[1]);
  return false;
}
async function assertPublicTarget(hostname) {
  const clean = hostname.replace(/^\[|\]$/g, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(clean) || /^[0-9a-f:]+$/.test(clean) && clean.includes(':')) {
    if (isBlockedIp(clean)) throw new Error('blocked target ip');
    return;
  }
  let addrs;
  try { addrs = await dns.lookup(clean, { all: true, verbatim: true }); }
  catch { throw new Error('unresolved host'); }
  if (!addrs.length) throw new Error('unresolved host');
  for (const a of addrs) if (isBlockedIp(a.address)) throw new Error('blocked target host');
}

// 中继限流：滑窗计数，防 token 泄露后被当免费代理池滥用
const PROXY_MAX_PER_MIN = Number(process.env.PROXY_MAX_PER_MIN || 120);
const PROXY_ALLOWED_METHODS = new Set(['GET', 'POST', 'HEAD']); // 禁 PUT/DELETE 等写方法
let proxyHits = [];
function proxyRateLimited() {
  const now = Date.now();
  proxyHits = proxyHits.filter(t => now - t < 60000);
  if (proxyHits.length >= PROXY_MAX_PER_MIN) return true;
  proxyHits.push(now);
  return false;
}

// 相关报道检索窗口（openDb 预编译语句依赖，须前置声明）
const RELATED_WINDOW_DAYS = 30;

let db = null;
let relatedCandidateStmt = null;

// 打开/重开数据库（sync 换库后调用）
function openDb() {
  db = new Database(dbPath, { readonly: true });
  relatedCandidateStmt = db.prepare(`
    SELECT id, title, date_key, source_name, ai_score, tags, event_norm FROM articles
    WHERE id != ? AND category != 'noise'
      AND date_key < ? AND date_key >= date(?, '-${RELATED_WINDOW_DAYS} days')
    ORDER BY date_key DESC
  `);
}

try {
  openDb();
  console.log(`数据库已连接: ${dbPath}`);
} catch (err) {
  console.error(`无法打开数据库: ${dbPath}`);
  console.error('请先运行: cd pipeline && node collect.mjs --init');
  process.exit(1);
}

// CORS + JSON 响应
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-sync-token',
  });
  res.end(JSON.stringify(data));
}

// 解析URL参数
function parseQuery(url) {
  const params = new URL(url, 'http://localhost').searchParams;
  return Object.fromEntries(params.entries());
}

// 解析tags列为对象（历史数据为JSON对象字符串，解析失败返回null）
function parseTags(raw) {
  if (!raw || raw === '[]') return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return null;
  } catch {
    return null;
  }
}

// 解析key_points列为数组（解析失败返回[]）
function parseKeyPoints(raw) {
  if (!raw || raw === '[]') return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 递归统计目录下文件数（含子目录；供存档同步防误清校验）
function countFiles(dir) {
  let n = 0;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) n += countFiles(join(dir, ent.name));
      else n++;
    }
  } catch {}
  return n;
}

// 当前采集轮的起点时刻（UTC 字符串）：四轮在北京时间 8/11/14/20 点触发，对应 UTC 0/3/6/12 点。
// 本轮起点之后入库的文章带 is_new 标，下一轮开始后自动失效——前端无需任何配置
function roundStartUTC(now = new Date()) {
  const HOURS = [0, 3, 6, 12];
  const start = HOURS.filter(x => x <= now.getUTCHours()).pop();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), start, 0, 0))
    .toISOString().slice(0, 19).replace('T', ' ');
}

// 给列表行附加解析后的tags对象
function withParsedTags(row) {
  const isNew = !!row.collected_at && row.collected_at >= roundStartUTC();
  return { ...row, tags: parseTags(row.tags), is_featured: !!row.is_featured, is_breaking: !!row.is_breaking, is_new: isNew };
}

// 构造tag的LIKE匹配值：匹配tags JSON里任一数组包含该值，剥离引号/LIKE通配符防注入
function tagLikePattern(tag) {
  const clean = String(tag).replace(/["%_\\]/g, '');
  return `%"${clean}"%`;
}

// ===== 欠费期降级兜底：取当日「未加工但非垃圾」条目（见 MAIN_FALLBACK_* 常量注释）=====
// U+FFFD 占比（按字符数）；空串按满密度处理（无正文可用即不可展示）
function fffdPct(s) {
  if (!s) return 100;
  return (s.match(/\uFFFD/g) || []).length * 100 / s.length;
}
// 垃圾过滤三道闸：标题空/超短、标题含任何乱码位、正文缺失或严重截断或乱码超标。
// 任何一道不过就不展示——兜底只救「空白」，不救「垃圾」。
function fallbackEntryClean(title, body) {
  const t = String(title || '').trim();
  return t.length > 2 && fffdPct(t) === 0
    && fffdPct(body) <= FALLBACK_MAX_FFFD_PCT
    && (body || '').length >= FALLBACK_MIN_BODY_CHARS;
}

// 两个兜底池（当日）：
//   A. articles 表里 takeaway 为空的未加工/半成品（正常管线不该有，防 fail-fast 漏网）；
//   B. articles_quarantine 里因 AI 服务报错被隔离的稿件（欠费主场景）。
// 因低分被闸掉但已加工完的稿不进池——那会把加工稿错标成「未加工」，反向冒充。
// 返回 { items, cause }：items 按发布时间倒序、已序列化到列表卡片所需形状；
// cause 供前端横幅措辞（arrearage=欠费，ai_service_error=其他接口故障）。
function collectDegradedFallback(dateKey, need) {
  const pool = [];
  let cause = 'ai_service_error';

  const rawRows = db.prepare(`
    SELECT id, title, source_name, source_url, category, published_at, collected_at,
           CASE WHEN COALESCE(content,'') <> '' THEN content ELSE COALESCE(summary,'') END AS body
    FROM articles
    WHERE date_key = ? AND category != 'noise'
      AND (takeaway IS NULL OR TRIM(takeaway) = '')
  `).all(dateKey);
  for (const r of rawRows) {
    if (!fallbackEntryClean(r.title, r.body)) continue;
    pool.push({
      id: r.id, title: r.title.trim(), source_name: r.source_name, source_url: r.source_url,
      category: r.category, published_at: r.published_at, collected_at: r.collected_at,
    });
  }

  let quarRows = [];
  try {
    quarRows = db.prepare(`
      SELECT rowid AS qrow, title, source_name, source_url, category, published_at, reason,
             CASE WHEN COALESCE(content,'') <> '' THEN content ELSE COALESCE(content_snippet,'') END AS body
      FROM articles_quarantine
      WHERE date_key = ? AND category != 'noise'
    `).all(dateKey);
  } catch { /* 隔离表尚未创建（老库）时静默跳过 */ }
  for (const r of quarRows) {
    if (!looksLikeAiServiceFailure(r.reason)) continue; // 垃圾隔离不进兜底
    if (!fallbackEntryClean(r.title, r.body)) continue;
    if (/Arrearage|Access denied|overdue/i.test(String(r.reason))) cause = 'arrearage';
    pool.push({
      id: `q${r.qrow}`, title: r.title.trim(), source_name: r.source_name, source_url: r.source_url,
      category: r.category, published_at: r.published_at, collected_at: null,
    });
  }

  // 两池按 URL 去重（同稿既在表内又在隔离的罕见兜底），再按发布时间倒序取前 need 条
  const seen = new Set();
  const deduped = pool.filter(r => (seen.has(r.source_url) ? false : seen.add(r.source_url)));
  deduped.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));

  return {
    cause,
    items: deduped.slice(0, Math.max(0, need)).map(r => ({
      ...r,
      tags: {},
      summary: '',
      takeaway: '',
      ai_score: null,   // 加工未完成就没有可信评分，宁可不显示也不误导
      is_featured: false,
      is_breaking: false,
      is_new: false,
      degraded: true,   // 前端据此打「未加工」标，绝不冒充加工稿
    })),
  };
}

// 相关报道检索（纯SQL+内存打分，无LLM）
//
// 旧实现是「逐个标签值查、命中一个就算相关、按日期倒序取3条」，等价于
// 「同公司最近三条」——OpenAI 一家在库里就占 26 条，第一个公司标签直接把
// 3 个坑填满，拿到的是「OpenAI 最近发生的三件事」而不是「这条新闻的前情」。
// 现在改成分层判定：只有下面四层之一命中才算相关，够不上就返回空、模块整块不显示。
//
//   A event   : event_norm 相同（采集时的事件聚类名，同一件事的后续进展）
//   B topic   : 主体交集>=1 且 话题交集>=1（同一家公司在同一条线上的动作）
//   C thread  : 话题交集>=2（同一条技术线的不同玩家）
//
// 刻意没有“仅主体交集”这一层（2026-07-31 实测结论，别再加回来）：
// 只看公司重合时 18 条命中里大半是噪声；改成要求重合度(Jaccard>=0.6)只滤掉4条，
// 因为 [OpenAI, Anthropic] 是全库最常见的公司对，两篇都挂它 Jaccard 能到 1.0，
// 但它只说明“这两篇都是行业大稿”；再改成“共享主体至少一个稀有”，小窗口下
// “稀有”又失真（语料早期候选只二十条，Anthropic 也能算稀有）。三次补丁都在加
// 新的例外，说明“同一组当事方”本身就不是相关信号。真正有价值的那类（如“SSI 获
// 英伟达投资”↔“SSI 与 Nvidia 合作”）本质上就是同一事件，由 A 层接管。
//
// 层级决定排序优先级，层内再按 IDF 加权分（稀有标签比大路标签更能说明相关）、
// 最后按日期。窗口限当前发布日「之前」30天内——含当日的话最先被填进来的
// 往往是用户刚在首页看过的同日新闻，「此前」两个字就没兑现。
const RELATED_LIMIT = 3;
// 层级权重（决定排序，不参与门槛判定）
const RELATION_RANK = { event: 3, topic: 2, thread: 1 };
const RELATION_LABEL = { event: '事件进展', topic: '同一话题', thread: '相关话题' };

// 补读区配额（见 /api/catchup）：只回捞最近三天，再往前的漏读就让它过去——
// 断更一周回来时糊 50 条上去，等于把日报变成收件箱，比漏读更糟。
// 配额按天递减而不是一个扁平的总数：主场景是「隔一天回来」，昨天漏的十来条
// 应该基本都给他；而更早的那几天只需给个精华尾巴。扁平总数会造成昨天吃完配额、
// 前天只剩一条的残组（展示上就是一个“前天 · 1 条”的尴尬分组）。
const CATCHUP_WINDOW_DAYS = 3;
const CATCHUP_TOP_DAY_LIMIT = 10;   // 最近那一天（通常就是昨天）
const CATCHUP_OLDER_DAY_LIMIT = 3;  // 更早的每天

// 往期重要（见 /api/archive）的回捞窗口。
// 30 天不是为了限量，是为了防变陈：排序纯按重要度，没有窗口的话一年后最顶上还是
// 今天这几篇——那就不是「往期重要新闻」而是名人堂了。窗口让旧条目自然过期。
const ARCHIVE_WINDOW_DAYS = 30;

// 排序用的时间衰减：每过一天有效分减 0.5（只影响排序，展示仍用原分）。
// 用户定的方向：日期要是权重之一。力度用实测定的——全库分数集中在 60-97，
// 0.5/天意味着旧文章每老一周需多 3.5 分才能压住新文章，30 天前的要多 15 分；
// 0.3 几乎不改变排序（白加），1.0 则让 89 分新闻压过 9 天前的 95 分（喧宾夺主）。
const ARCHIVE_DECAY_PER_DAY = 0.5;

// ===== 欠费期降级兜底（2026-09-29，仅展示层，不动采集管线）=====
// 背景：DashScope 欠费后 AI 加工全线失败，fail-fast 把当日稿件整批送进
// articles_quarantine，articles 表当日 0 条；首页质量闸只放加工合格的稿，
// 于是主列表空掉（09-29 实测）。充值恢复前首页不能空白，这里在 scope=main
// 的首页主列表场景做降级：当日合格稿不足 MAIN_FALLBACK_MIN_QUALIFIED 条时，
// 自动追加「未加工但非垃圾」的当日条目，凑到至少 MAIN_FALLBACK_TARGET 条。
// 兜底条目一律带 degraded=true，前端必须显式标注「未加工」，绝不冒充加工稿；
// 乱码/空标题/严重截断的真垃圾继续隔离。一旦当日合格稿 ≥ 阈值，兜底自动
// 停止注入，无需回滚改动。query.fallback=0 可强制关闭（调试用）。
const MAIN_FALLBACK_MIN_QUALIFIED = 5;   // 当日合格稿低于此数才触发兜底
const MAIN_FALLBACK_TARGET = 10;         // 触发后至少凑到的条数
const FALLBACK_MIN_BODY_CHARS = 60;      // 正文/片段低于此字数视为严重截断，不展示
const FALLBACK_MAX_FFFD_PCT = 5;         // 正文 U+FFFD 占比超过 5% 视为乱码，不展示

// ===== 政策稿主列表降档（2026-09-29，仅展示层，不动采集与评分）=====
// 政策稿是官方通稿体、缺技术冲击词，AI 评分系统性偏低，65 分主列表闸会把 60-64 档
// 的政策进展整段挡在首页外。注意 ai-filter 的「每日政策保底 2 条」只保底**入库**，
// 管不到**展示**——入库后再被 65 分闸拦掉，保底配额等于白给。故展示层单独给政策
// 维度降到 60 分，让两道闸口径接得上。
// 红线：只降分数档，不降质量档——非政策稿仍是 65，加工合格三条件（takeaway 非空、
// summary 无 U+FFFD、title 无 U+FFFD）一律照旧，半成品不会因为这条改动蒙混过关。
const MAINLIST_POLICY_MIN_SCORE = 60;
// 政策源名单直接从 pipeline/sources.mjs 派生，不手抄，避免与信源配置漂移。
// 必须再叠 source_type==='official'：The Hill / Politico 在信源配置里 category 也是
// 'policy'（政策线媒体），但它们是媒体不是政策发布主体——若只按 category 筛，
// 实测会放出一条 The Hill 的 opinion 专栏（63 分）进主列表，那不是"政策稿放宽"的本意。
// official 政策源即发改委/工信部/网信办/国务院/各省市府等，与需求点名的口径一致。
// 另：articles.category 是逐篇复核结果、可能与信源默认分类不一致（如 Ars Technica AI
// 的政策稿判成 policy），故 category='policy' 与官方政策源两条取并集，任一命中即算政策稿。
const POLICY_SOURCE_NAMES = SOURCES
  .filter(s => s.category === 'policy' && s.source_type === 'official')
  .map(s => s.name);

// 判定「AI 服务故障导致的隔离」而非「垃圾内容导致的隔离」：
// 只有 failed_stage 卡在加工环节、且 reason 明确是 DashScope 侧报错的才进兜底池。
const FALLBACK_API_ERROR_PATTERNS = [
  'Arrearage', 'Access denied', 'InvalidApiKey', 'Throttling', 'API错误',
  'api error', 'timeout', '超时', '429', '500', '502', '503',
];
function looksLikeAiServiceFailure(reason) {
  const s = String(reason || '');
  return FALLBACK_API_ERROR_PATTERNS.some(p => s.includes(p));
}

// 在一个AI资讯应用里这些词命中了也不说明相关。注意不能靠词频(IDF)压掉它们——
// 库里带"AI"标签的只有7条，频次很低但语义为零，IDF 反而会给它高权重。
const GENERIC_TAG_VALUES = new Set([
  'ai', 'a.i.', '人工智能', 'ai技术', 'ai模型', 'ai应用', 'ai产业', 'ai公司',
  '大模型', '大语言模型', 'llm', 'llms', 'agi', '生成式ai', 'genai',
  '机器学习', 'machine learning', '深度学习', 'deep learning', '神经网络',
  'artificial intelligence', 'ai model', 'ai industry',
]);

// 取某几类标签的有效值（小写去重、剔除通用无意义词）
function tagValues(tags, fields) {
  if (!tags) return [];
  const out = new Set();
  for (const f of fields) {
    for (const v of Array.isArray(tags[f]) ? tags[f] : []) {
      const n = String(v).trim().toLowerCase();
      if (n && !GENERIC_TAG_VALUES.has(n)) out.add(n);
    }
  }
  return [...out];
}

function findRelated(row, tags) {
  const selfSubj = tagValues(tags, ['companies', 'people']);
  const selfTopic = tagValues(tags, ['keywords']);
  const selfEvent = String(row.event_norm || '').trim();
  if (!selfSubj.length && !selfTopic.length && !selfEvent) return [];

  const rows = relatedCandidateStmt.all(row.id, row.date_key, row.date_key);
  if (!rows.length) return [];

  // IDF 在候选窗口内现算：一个标签的区分力取决于「最近一个月它出现得多不多」，
  // 用全库口径会被历史数据稀释
  const df = new Map();
  const cands = rows.map(r => {
    const t = parseTags(r.tags);
    const subj = tagValues(t, ['companies', 'people']);
    const topic = tagValues(t, ['keywords']);
    for (const v of new Set([...subj, ...topic])) df.set(v, (df.get(v) || 0) + 1);
    return { row: r, subj, topic };
  });
  const total = cands.length + 1;
  const idf = v => Math.log(total / ((df.get(v) || 0) + 1)) + 0.3;

  const picked = [];
  for (const c of cands) {
    const subjHit = c.subj.filter(v => selfSubj.includes(v));
    const topicHit = c.topic.filter(v => selfTopic.includes(v));
    const sameEvent = !!selfEvent && String(c.row.event_norm || '').trim() === selfEvent;

    let relation = '';
    if (sameEvent) relation = 'event';
    else if (subjHit.length && topicHit.length) relation = 'topic';
    else if (topicHit.length >= 2) relation = 'thread';
    else continue; // 单个标签重合、或只是同一批公司，一律不算相关，宁可不显示

    const weight = [...topicHit].reduce((s, v) => s + 2 * idf(v), 0)
      + [...subjHit].reduce((s, v) => s + idf(v), 0);
    picked.push({ row: c.row, relation, weight });
  }

  picked.sort((a, b) =>
    (RELATION_RANK[b.relation] - RELATION_RANK[a.relation])
    || (b.weight - a.weight)
    || (a.row.date_key < b.row.date_key ? 1 : -1)
  );

  return picked.slice(0, RELATED_LIMIT).map(p => ({
    id: p.row.id,
    title: p.row.title,
    date_key: p.row.date_key,
    source_name: p.row.source_name,
    relation: p.relation,
    relationLabel: RELATION_LABEL[p.relation],
  }));
}

// 路由处理
function handleRequest(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const query = parseQuery(req.url);

  // OPTIONS预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }

  // GET /api/sync-download（供 GitHub Actions 采集前拉取当前库，保持历史连续）
  if (req.method === 'GET' && pathname === '/api/sync-download') {
    if (!authOrFail(res, req, DB_TOKEN, 'sync disabled')) return;
    // 下载前强制WAL checkpoint：WAL模式下近期提交（含服务器端手工补录）可能还留在
    // -wal文件里，只传主库文件会丢数据，下一轮整库回推将其永久冲掉
    // （2026-08-11事故：黎曼补录条目因此丢失）。服务连接是readonly，
    // checkpoint需临时读写连接；失败不阻断下载（退化为旧行为）
    try {
      const ckpt = new Database(dbPath);
      ckpt.pragma('wal_checkpoint(TRUNCATE)');
      ckpt.close();
    } catch (e) { console.error('[sync] WAL checkpoint失败:', e.message); }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="articles.db"',
    });
    fs.createReadStream(dbPath).pipe(res);
    return;
  }

  // GET /api/archive-manifest（2026-09-04 增量存档配套：返回 data/archive 下所有一级目录名，
  // 供推送方对比后只打包本地新增目录，实现增量同步。响应为 JSON 字符串数组，几百KB内）
  if (req.method === 'GET' && pathname === '/api/archive-manifest') {
    if (!authOrFail(res, req, ARCHIVE_TOKEN, 'sync disabled')) return;
    let names = [];
    if (fs.existsSync(archiveDir)) {
      names = fs.readdirSync(archiveDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
    }
    return sendJSON(res, 200, names);
  }

  // GET /api/sync-archive-download（整包下载存量存档）
  // 【已退役】2026-09-04 存档改增量合并后，GitHub Actions 采集链路不再调用本端点；
  // 保留仅作兼容/未来整包迁移用。客户端打包/推送逻辑见仓库 pipeline/sync-push.mjs
  // 实现：预打包到 data/archive.tar.gz 缓存再流式发文件（Windows bsdtar 的
  // "-czf -" 管道输出会挂起，写文件正常；mtime 比目录旧时自动重建）
  if (req.method === 'GET' && pathname === '/api/sync-archive-download') {
    if (!authOrFail(res, req, ARCHIVE_TOKEN, 'sync disabled')) return;
    if (!fs.existsSync(archiveDir)) return sendJSON(res, 404, { error: 'no archive yet' });
    (async () => {
      try {
        const bundlePath = join(__dirname, 'data', 'archive.tar.gz');
        const needBuild = !fs.existsSync(bundlePath)
          || fs.statSync(archiveDir).mtimeMs > fs.statSync(bundlePath).mtimeMs;
        if (needBuild) {
          await execFileP('tar', ['-czf', bundlePath, '-C', join(__dirname, 'data'), 'archive'], { timeout: 120000 });
        }
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Disposition': 'attachment; filename="archive.tar.gz"',
        });
        fs.createReadStream(bundlePath).pipe(res);
      } catch (e) {
        console.error('[sync] 存档打包失败:', e.message);
        if (!res.headersSent) return sendJSON(res, 500, { error: e.message });
        res.destroy();
      }
    })();
    return;
  }

  // POST /api/proxy（供 GitHub Actions 采集时借国内IP代拉被海外封锁的站点，
  // 2026-08-07：机器之心 WAF 开始拦海外IP，Actions 上 curl 被重定向到推广页）
  // 请求体：{url, method?, headers?, body?}；返回 {status, contentType, body}，body 上限 2MB
  if (req.method === 'POST' && pathname === '/api/proxy') {
    if (!authOrFail(res, req, PROXY_TOKEN, 'proxy disabled')) return;
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const spec = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        // —— 目标校验（2026-09-14 加固）——
        // 旧实现只查 https:// 前缀便把 headers/body 原样转发且 redirect:'follow'，
        // 拿到 token 者可用 302 弹到内网/云元数据（SSRF），或把本机当任意站点的代理。
        const method = String(spec.method || 'GET').toUpperCase();
        if (!PROXY_ALLOWED_METHODS.has(method)) return sendJSON(res, 400, { error: 'method not allowed' });
        let target;
        try { target = new URL(spec.url || ''); } catch { return sendJSON(res, 400, { error: 'bad url' }); }
        if (target.protocol !== 'https:') return sendJSON(res, 400, { error: 'https only' });
        if (target.port && target.port !== '443') return sendJSON(res, 400, { error: 'port not allowed' });
        if (proxyRateLimited()) {
          res.setHeader('Retry-After', '60');
          return sendJSON(res, 429, { error: 'relay rate limited' });
        }
        try { await assertPublicTarget(target.hostname); }
        catch (e) { return sendJSON(res, 400, { error: 'blocked target: ' + e.message }); }
        // 剥掉逐跳头，避免把客户端连接层语义带进二次请求
        const fwdHeaders = {};
        for (const [k, v] of Object.entries(spec.headers || {})) {
          const lk = String(k).toLowerCase();
          if (['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'expect'].includes(lk)) continue;
          fwdHeaders[k] = v;
        }
        // 手动跟随重定向，逐跳重做协议/端口/私网校验（302 弹内网是旧版的主要缺口）
        let resp, url = target.toString();
        for (let hop = 0; ; hop++) {
          resp = await fetch(url, {
            method,
            headers: fwdHeaders,
            body: method === 'POST' && spec.body != null ? spec.body : undefined,
            redirect: 'manual',
            signal: AbortSignal.timeout(20000),
          });
          if (![301, 302, 303, 307, 308].includes(resp.status)) break;
          const loc = resp.headers.get('location');
          if (!loc || hop >= 3) return sendJSON(res, 502, { error: 'redirect refused' });
          let next;
          try { next = new URL(loc, url); } catch { return sendJSON(res, 502, { error: 'bad redirect' }); }
          if (next.protocol !== 'https:' || (next.port && next.port !== '443')) return sendJSON(res, 502, { error: 'redirect blocked' });
          try { await assertPublicTarget(next.hostname); }
          catch (e) { return sendJSON(res, 502, { error: 'redirect blocked: ' + e.message }); }
          url = next.toString();
        }
        let body = await resp.text();
        if (body.length > 2 * 1024 * 1024) body = body.slice(0, 2 * 1024 * 1024);
        return sendJSON(res, 200, {
          status: resp.status,
          contentType: resp.headers.get('content-type') || '',
          setCookies: typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [],
          body,
        });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    });
    return;
  }

  // POST /api/sync-archive（资料库存档同步：接收 tar.gz 增量包，解包后逐目录合并进 data/archive）
  // 2026-09-04 起：同目录名覆盖、不动包外其他目录——存档全量永久保留，不再整包替换
  if (req.method === 'POST' && pathname === '/api/sync-archive') {
    if (!authOrFail(res, req, ARCHIVE_TOKEN, 'sync disabled')) return;
    const tmpTar = join(__dirname, 'data', 'archive.upload.tgz');
    // 流式落盘（2026-08-24：存档已涨到200MB+，旧实现在内存Buffer.concat整包，
    // 1.6GB内存的服务器有OOM风险；改边收边写文件，内存占用恒定为流缓冲）
    let received = 0, oversized = false, finished = false;
    const ws = fs.createWriteStream(tmpTar);
    req.on('data', c => {
      received += c.length;
      if (received > MAX_ARCHIVE_UPLOAD && !oversized) {
        oversized = true;
        req.destroy();
        ws.destroy();
        fs.rmSync(tmpTar, { force: true });
        if (!finished) { finished = true; return sendJSON(res, 413, { error: 'archive too large' }); }
      }
    });
    req.pipe(ws);
    ws.on('close', async () => {
      if (oversized || finished) return;
      finished = true;
      const tmpDir = join(__dirname, 'data', 'archive.new');
      try {
        if (received < 100) return sendJSON(res, 400, { error: 'payload too small' });
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.mkdirSync(tmpDir, { recursive: true });
        await execFileP('tar', ['-xzf', tmpTar, '-C', tmpDir], { timeout: 120000 });
        // 兼容两种打包形态：整包 `tar -C data archive`（包内带 archive/ 前缀，
        // 解到临时目录后需剥掉一层避免 archive/archive 嵌套）；
        // 增量包 `tar -C data/archive <目录...>`（解出来就是一级目录本身）
        const inner = join(tmpDir, 'archive');
        if (fs.existsSync(inner) && fs.statSync(inner).isDirectory()) {
          const flat = join(__dirname, 'data', 'archive.new.flat');
          fs.rmSync(flat, { recursive: true, force: true });
          fs.renameSync(inner, flat);
          fs.rmSync(tmpDir, { recursive: true, force: true });
          fs.renameSync(flat, tmpDir);
        }
        // 2026-09-04 存档机制改增量合并（替代原"解包原子替换"）：
        // 只合并包内出现的目录，其余服务器存量目录一概不动——
        // 天然不会误删历史，故原"防误清文件数校验"（老包一半规则）随之废除。
        fs.mkdirSync(archiveDir, { recursive: true });
        const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
        let merged = 0;
        for (const ent of entries) {
          const src = join(tmpDir, ent.name);
          const dst = join(archiveDir, ent.name);
          // 同名覆盖：先删同名再整体搬入（rename 无法覆盖非空目录）
          fs.rmSync(dst, { recursive: true, force: true });
          fs.renameSync(src, dst);
          merged++;
        }
        const total = countFiles(archiveDir);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(tmpTar, { force: true });
        console.log(`[sync] 存档增量合并: ${merged} 个目录, 共 ${total} 个文件`);
        return sendJSON(res, 200, { ok: true, merged_dirs: merged, files: total });
      } catch (e) {
        try { fs.rmSync(tmpTar, { force: true }); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        console.error('[sync] 存档更新失败:', e.message);
        return sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }

  // POST /api/sync-upload（生产数据同步：整库上传+校验+原子替换）
  // 仅当设置了 SYNC_TOKEN 环境变量时启用。上传方携带 x-sync-token 头。
  if (req.method === 'POST' && pathname === '/api/sync-upload') {
    if (!authOrFail(res, req, DB_TOKEN, 'sync disabled')) return;
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const tmpPath = dbPath + '.upload';
      try {
        const buf = Buffer.concat(chunks);
        if (buf.length < 4096) return sendJSON(res, 400, { error: 'payload too small' });
        fs.writeFileSync(tmpPath, buf);
        // 校验：能打开且含articles表
        const test = new Database(tmpPath);
        const cnt = test.prepare('SELECT COUNT(*) AS t FROM articles').get().t;
        // 墓碑保护（2026-08-07 教训：手工删除的文章会被下一轮 Actions 整库上传复活，
        // 谷歌重复新闻 628 删完次日又回来了）：上传库里若含墓碑名单中的 id，
        // 直接在上传副本中删掉再替换。
        let tombIds = [];
        try {
          tombIds = db.prepare('SELECT article_id FROM deleted_tombstones').all().map(r => r.article_id);
          if (tombIds.length) {
            const stmt = test.prepare('DELETE FROM articles WHERE id = ?');
            for (const id of tombIds) stmt.run(id);
          }
        } catch {}
        test.close();
        // 防误清库：新库条数不足现有库一半时拒绝替换（Actions/本地采集异常时
        // 避免拿一个接近空的库把服务器历史数据整个抹掉）
        let cur = 0;
        try { cur = db.prepare('SELECT COUNT(*) AS t FROM articles').get().t; } catch {}
        if (cur > 0 && cnt < Math.ceil(cur / 2)) {
          fs.unlinkSync(tmpPath);
          return sendJSON(res, 409, { error: `refused: incoming ${cnt} < half of current ${cur}` });
        }
        // 覆盖目标文件：先关旧句柄，再整文件复制（不用 rename——Windows 上
        // rename 无法覆盖被 SQLite 打开过的文件会报 EPERM，Linux 无此问题）
        const old = db; db = null;
        try { old.close(); } catch {}
        fs.copyFileSync(tmpPath, dbPath);
        // 2026-08-05 事故教训：覆盖主文件后必须清掉残留的 -wal/-shm，
        // 否则 openDb 会拿旧 WAL 去套新主文件，整库必坏（当时小程序全量 500）
        for (const suffix of ['-wal', '-shm']) {
          try { fs.unlinkSync(dbPath + suffix); } catch {}
          try { fs.unlinkSync(tmpPath + suffix); } catch {}
        }
        fs.unlinkSync(tmpPath);
        openDb();
        // 上传库不含墓碑表，替换后需回写，否则墓碑只生效一轮
        if (tombIds.length) {
          try {
            const w = new Database(dbPath);
            w.exec('CREATE TABLE IF NOT EXISTS deleted_tombstones (article_id INTEGER PRIMARY KEY, deleted_at TEXT DEFAULT (datetime(\'now\')))');
            const ins = w.prepare('INSERT OR IGNORE INTO deleted_tombstones (article_id) VALUES (?)');
            for (const id of tombIds) ins.run(id);
            w.close();
          } catch {}
        }
        console.log(`[sync] 数据库已更新: ${cnt} 篇文章`);
        return sendJSON(res, 200, { ok: true, articles: cnt });
      } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch {}
        if (!db) { try { openDb(); } catch {} }
        console.error('[sync] 失败:', e.message);
        return sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }

  try {
    // GET /api/featured
    if (pathname === '/api/featured') {
      const date = query.date || new Date().toISOString().split('T')[0];
      const rows = db.prepare(`
        SELECT id, title, original_title, source_name, source_url, category, summary, takeaway, ai_score, is_featured, is_breaking, date_key, published_at, collected_at, tags
        FROM articles WHERE date_key = ? AND is_featured = 1 AND category != 'noise'
        ORDER BY ai_score DESC
      `).all(date);

      // 今日导语（daily_meta表可能尚未创建，缺失时返回null，前端不展示）
      let intro = null;
      try {
        intro = db.prepare('SELECT intro FROM daily_meta WHERE date_key = ?').get(date)?.intro || null;
      } catch { /* 表不存在时忽略 */ }

      return sendJSON(res, 200, { date, count: rows.length, intro, articles: rows.map(withParsedTags) });
    }

    // GET /api/articles（tag参数与category/date/page可叠加；date=all 表示不限日期；
    // tag_type 限定只在 tags 的指定字段内精确匹配，避免跨字段撞字符串；
    // min_scores 为逗号分隔的下限列表（如 90,80），命中任一下限即保留，支持重要性多选筛选）
    if (pathname === '/api/articles') {
      const date = query.date === 'all' ? null : (query.date || new Date().toISOString().split('T')[0]);
      const category = query.category;
      const tag = query.tag;
      const tagType = ['companies', 'people', 'keywords', 'regions'].includes(query.tag_type) ? query.tag_type : null;
      const page = Math.max(1, parseInt(query.page) || 1);
      const limit = Math.min(50, parseInt(query.limit) || 20);
      const offset = (page - 1) * limit;
      // 重要性筛选：只认 0-100 的数字档位下限，非法值直接忽略；
      // 每个下限是严格档位区间（如 80 = 80-89），不是“≥80”
      const minScores = String(query.min_scores || '')
        .split(',').map(s => parseInt(s, 10)).filter(n => n > 0 && n <= 100);
      // 首页质量闸（2026-09-28 修复）：默认 scope=main 只回"精选 或 ai_score>=65"、
      // 且已真正加工过（takeaway 非空、summary 无 U+FFFD 乱码）的条目；边缘稿(56-64分)、
      // 未加工/半成品一律不占主列表，交给前端"全部/更多"入口用 scope=all 拉取。宁缺毋滥，绝不硬凑 20 条。
      const scope = query.scope === 'all' ? 'all' : 'main';

      // 动态拼接WHERE条件
      const where = [`category != 'noise'`]; // 噪音文章不在任何列表展示
      const args = [];
      if (scope === 'main') {
        // 政策稿按 MAINLIST_POLICY_MIN_SCORE 降档放行，其余仍须 65（口径见常量注释）。
        // 注意：占位符与其参数必须在这里同步 push——where 数组的拼接顺序决定 args 的消费顺序，
        // 插到 date/category 之后会把整条 SQL 的参数错位。
        // POLICY_SOURCE_NAMES 为空时不能拼 `source_name IN ()`（SQLite 语法错误会让首页
        // 整个 500），故按名单长度分支——没名单就只认 articles.category。
        const policyArms = POLICY_SOURCE_NAMES.length
          ? `(category = 'policy' OR source_name IN (${POLICY_SOURCE_NAMES.map(() => '?').join(',')}))`
          : `(category = 'policy')`;
        where.push(`(is_featured = 1 OR ai_score >= 65 OR (ai_score >= ? AND ${policyArms}))`);
        args.push(MAINLIST_POLICY_MIN_SCORE, ...POLICY_SOURCE_NAMES);
        where.push(`takeaway IS NOT NULL AND TRIM(takeaway) <> ''`);
        where.push(`(summary IS NULL OR instr(summary, char(65533)) = 0)`);
        where.push(`instr(COALESCE(title,''), char(65533)) = 0`);
      }
      if (date) { where.push('date_key = ?'); args.push(date); }
      if (category && category !== 'all') { where.push('category = ?'); args.push(category); }
      if (tag) {
        if (tagType) {
          // 精确匹配：只在指定字段数组内找该标签（json_each展开数组逐项比对）
          where.push('json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags, ?) WHERE json_each.value = ?)');
          args.push(`$.${tagType}`, String(tag));
        } else {
          // 无tag_type时降级为全JSON模糊匹配（兼容旧版前端）
          where.push('tags LIKE ?'); args.push(tagLikePattern(tag));
        }
      }
      if (minScores.length) {
        // 多选并集：每个档位一个 [min, min+10) 区间；90 档封顶不设上限
        const conds = minScores.map(() => '(ai_score >= ? AND ai_score < ?)').join(' OR ');
        where.push(`(${conds})`);
        for (const m of minScores) { args.push(m, m >= 90 ? 999 : m + 10); }
      }
      const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const total = db.prepare(`SELECT COUNT(*) as t FROM articles ${whereSQL}`).get(...args).t;
      const rows = db.prepare(`
        SELECT id, title, source_name, source_url, category, takeaway, ai_score, is_featured, is_breaking, date_key, published_at, collected_at, tags, date_unknown
        FROM articles ${whereSQL}
        ORDER BY date_key DESC, ai_score DESC LIMIT ? OFFSET ?
      `).all(...args, limit, offset);

      // 2026-09-29 事故修复：无发布日期稿件以 date_key='unknown'、date_unknown=1 归档；
      // 只在 scope=all 里出现（scope=main 与具体日期查询天然过滤掉），条目上带 date_unknown: true
      // 供前端渲染"日期未知"标识；published_at 为空串时前端也不显示时间线，避免误导。
      const articles = rows.map(r => {
        const parsed = withParsedTags(r);
        if (r.date_unknown) parsed.date_unknown = true;
        return parsed;
      });

      // 欠费期降级兜底：只在「首页主列表」形态介入——scope=main、指定了具体日期、
      // 未叠加标签/分类/重要性筛选、第一页，且当日合格稿不足阈值。
      // 合格稿一律置顶，兜底条目只追加在尾部并带 degraded=true；
      // 充值恢复后当日合格稿 ≥ 阈值，此段整体不再触发（自动失效，无需回滚）。
      let fallback = { items: [], cause: null };
      const fallbackEligible = scope === 'main' && query.fallback !== '0'
        && date && !tag && (!category || category === 'all')
        && !minScores.length && page === 1
        && total < MAIN_FALLBACK_MIN_QUALIFIED;
      if (fallbackEligible) {
        fallback = collectDegradedFallback(date, MAIN_FALLBACK_TARGET - total);
      }
      const merged = articles.concat(fallback.items);

      return sendJSON(res, 200, {
        date: date || 'all', category: category || 'all', tag: tag || null, scope,
        page, page_size: limit,
        total: total + fallback.items.length,
        has_more: offset + merged.length < total,
        // degraded 仅在真正注入了兜底条目时为 true；qualified_total 供前端核对口径
        degraded: fallback.items.length > 0,
        ...(fallback.items.length ? {
          degraded_count: fallback.items.length,
          degraded_reason: fallback.cause,
          qualified_total: total,
        } : {}),
        articles: merged,
      });
    }

    // GET /api/tags（聚合tags计数；计数口径与标签落地页一致——
    // noise不展示故不计入；regions标签页只显示政策类文章，故只统计policy类，
    // 避免出现"标签条显示中国8条、点进去0条政策"的口径错位）
    if (pathname === '/api/tags') {
      const rows = db.prepare(`SELECT category, tags FROM articles WHERE tags LIKE '{%' AND category != 'noise'`).all();
      const counters = { companies: {}, people: {}, keywords: {}, regions: {} };

      for (const row of rows) {
        const obj = parseTags(row.tags);
        if (!obj) continue;
        for (const key of Object.keys(counters)) {
          if (key === 'regions' && row.category !== 'policy') continue; // 国别只计政策类
          const arr = obj[key];
          if (!Array.isArray(arr)) continue;
          // 同一篇文章内同一标签只计一次
          for (const name of new Set(arr.filter(t => typeof t === 'string' && t.trim()))) {
            const n = name.trim();
            counters[key][n] = (counters[key][n] || 0) + 1;
          }
        }
      }

      // companies/people 为白名单制、regions 枚举有限，总量有界，全量返回（前端负责收纳）；
      // keywords 无白名单约束、长尾无界，仍取 Top 30
      const top = (counter, limit = Infinity) => Object.entries(counter)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, limit);

      return sendJSON(res, 200, {
        companies: top(counters.companies),
        people: top(counters.people),
        keywords: top(counters.keywords, 30),
        regions: top(counters.regions),
      });
    }

    // GET /api/source-health（信源健康总览：各源连续0产出天数/最近活跃日/告警状态）
    if (pathname === '/api/source-health') {
      let rows = [];
      try {
        rows = db.prepare(`
          SELECT source_name, date_key, fetched, raw, error FROM source_health
          WHERE date_key >= date('now', '-14 days') ORDER BY date_key DESC
        `).all();
      } catch { /* 表未创建（尚未跑过新版采集），所有源返回 no_data */ }

      const bySource = new Map();
      for (const r of rows) {
        if (!bySource.has(r.source_name)) bySource.set(r.source_name, []);
        bySource.get(r.source_name).push(r);
      }

      const sources = SOURCES.map(s => {
        const recs = bySource.get(s.name) || [];
        const threshold = alertThreshold(s);
        let zeroDays = 0;
        for (const r of recs) {
          if (r.fetched === 0) zeroDays++;
          else break;
        }
        const latest = recs[0] || null;
        const status = !recs.length
          ? 'no_data'
          : (recs.length >= threshold && zeroDays >= threshold ? 'alert' : 'ok');
        return {
          name: s.name,
          official: s.source_type === 'official',
          threshold,
          zero_days: zeroDays,
          last_active: recs.find(r => r.fetched > 0)?.date_key || null,
          latest_date: latest?.date_key || null,
          latest_fetched: latest ? latest.fetched : null,
          latest_error: latest?.error || null,
          status,
        };
      });
      // 告警源排前面，其余保持配置顺序
      sources.sort((a, b) => (b.status === 'alert') - (a.status === 'alert'));

      return sendJSON(res, 200, {
        alert_count: sources.filter(s => s.status === 'alert').length,
        sources,
      });
    }

    // GET /api/dates（往期日报索引：有内容的日期倒序+篇数/精选数，供首页日期面板）
    if (pathname === '/api/dates') {
      const rows = db.prepare(`
        SELECT date_key, COUNT(*) AS total, SUM(is_featured) AS featured
        FROM articles WHERE category != 'noise'
        GROUP BY date_key ORDER BY date_key DESC
      `).all();
      return sendJSON(res, 200, {
        dates: rows.map(r => ({ date: r.date_key, total: r.total, featured: r.featured || 0 })),
      });
    }

    // GET /api/catchup（补读：用户上次离开后才入库、但发布日已翻页的文章）
    //
    // 解决的是一个纯阅读侧问题：采集分 8/14/20 三轮，早上只出几条。用户 8 点看完就走，
    // 14 点和 20 点入库的那十来条就再没有露脸机会——第二天首页只显示「今天」的桶，
    // 昨天白天的新闻整批静默蒸发。这里按「入库时间」而不是「发布日」重新捞一遍。
    //
    // 判定用 collected_at：入库语句是 INSERT OR IGNORE，同一条 URL 只会写一次，
    // 所以它是可靠的「这条第一次出现在应用里的时刻」，不会被后续重跑刷新。
    // date_key < today 是为了不和首页「今日」列表重复——今天的桶已经整个铺在页面上了。
    // 顺带修好一个既有盲区：发布日在过去、但今天才被采到的文章（源站延迟收录），
    // 过去只会落进用户已经读完的旧桶里，等于永不可见，现在会出现在补读区。
    //
    // since 解析不出来时 datetime() 返回 NULL，比较结果为 NULL、一条不返回——
    // 宁可整块不显示，也不要因为参数异常把历史存量整批倒给用户。
    if (pathname === '/api/catchup') {
      const since = query.since;
      const before = query.before || new Date().toISOString().split('T')[0];
      if (!since) return sendJSON(res, 200, { total: 0, articles: [] });

      const filter = `
        FROM articles
        WHERE category != 'noise'
          AND takeaway IS NOT NULL AND TRIM(takeaway) <> ''
          AND instr(COALESCE(title,''), char(65533)) = 0
          AND (summary IS NULL OR instr(summary, char(65533)) = 0)
          AND date_key < ? AND date_key >= date(?, '-${CATCHUP_WINDOW_DAYS} days')
          AND collected_at > datetime(?)
      `;
      const args = [before, before, since];
      const total = db.prepare(`SELECT COUNT(*) AS t ${filter}`).get(...args).t;
      // 窗函数做“每天取前N”：rn 是天内排名，day_rn 是第几新的一天（每天一个名次，
      // 所以用 DENSE_RANK 而不是 ROW_NUMBER）。天内排序以精选优先，被截掉的一定是分低的。
      const rows = db.prepare(`
        SELECT id, title, source_name, source_url, category, takeaway, ai_score, is_featured, is_breaking, published_at, collected_at, tags, date_key
        FROM (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY date_key ORDER BY is_featured DESC, ai_score DESC) AS rn,
            DENSE_RANK() OVER (ORDER BY date_key DESC) AS day_rn
          ${filter}
        )
        WHERE rn <= CASE WHEN day_rn = 1 THEN ${CATCHUP_TOP_DAY_LIMIT} ELSE ${CATCHUP_OLDER_DAY_LIMIT} END
        ORDER BY day_rn, rn
      `).all(...args);

      return sendJSON(res, 200, { since, before, total, articles: rows.map(withParsedTags) });
    }

    // GET /api/archive（往期重要：比 before 更早的新闻，按重要度而不是时间排序）
    //
    // 为什么需要它：子分类的日产量是结构性偏低的，不是偶发。实测最近 7 天：
    // 基建 4 天为 0、观点 3 天为 0、政策从没超过 1 条。只展当日的话，这些栏目
    // 点进去就是一片空白，而它们恰恰不是不重要（基建均分 85.1，全库最高）。
    //
    // 排序是「重要度为主、新鲜度为辅」：有效分 = ai_score - 离现在天数 × ARCHIVE_DECAY_PER_DAY。
    // 展示的分数徽章仍是原分，所以会出现 94 分排在 96 分上面的情况（新 7 天可抵 3.5 分），
    // 这是有意的取舍：用户对"旧闻越陈越往后"的直觉比分数严格单调更重要。同有效分时新的在前。
    if (pathname === '/api/archive') {
      const before = query.before || new Date().toISOString().split('T')[0];
      const category = query.category;
      const limit = Math.min(30, parseInt(query.limit) || 10);

      const where = [`category != 'noise'`,
        // 半成品不展示：无 takeaway 或标题/摘要含 U+FFFD（与首页质量闸同口径）
        `takeaway IS NOT NULL AND TRIM(takeaway) <> ''`,
        `(summary IS NULL OR instr(summary, char(65533)) = 0)`,
        `instr(COALESCE(title,''), char(65533)) = 0`,
        `date_key < ?`, `date_key >= date(?, '-${ARCHIVE_WINDOW_DAYS} days')`];
      const args = [before, before];
      if (category && category !== 'all') { where.push('category = ?'); args.push(category); }
      const filter = `FROM articles WHERE ${where.join(' AND ')}`;

      const total = db.prepare(`SELECT COUNT(*) AS t ${filter}`).get(...args).t;
      const rows = db.prepare(`
        SELECT id, title, source_name, source_url, category, takeaway, ai_score, is_featured, is_breaking, published_at, collected_at, tags, date_key
        ${filter}
        ORDER BY ai_score - (julianday(?) - julianday(date_key)) * ${ARCHIVE_DECAY_PER_DAY} DESC, date_key DESC
        LIMIT ?
      `).all(...args, before, limit);

      return sendJSON(res, 200, {
        before, category: category || 'all', total, articles: rows.map(withParsedTags),
      });
    }

    // GET /api/article/:id
    const articleMatch = pathname.match(/^\/api\/article\/(\d+)$/);
    if (articleMatch) {
      const id = articleMatch[1];
      const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
      if (!row) return sendJSON(res, 404, { error: '文章不存在' });
      const tags = parseTags(row.tags);
      return sendJSON(res, 200, {
        ...row,
        tags,
        key_points: parseKeyPoints(row.key_points),
        is_featured: !!row.is_featured,
        related: findRelated(row, tags), // 此前相关报道（分层判定，见 findRelated；够不上相关则为空数组）
      });
    }

    // GET /archive/...（资料库静态文件：文章HTML快照与图片，图片引用为 archive/{hash}/images/xx）
    const archiveFileMatch = pathname.match(/^\/archive\/(.+)$/);
    if (archiveFileMatch) {
      const rel = decodeURIComponent(archiveFileMatch[1]);
      const file = join(archiveDir, rel);
      // 路径穿越防护：规范化后必须仍在 archiveDir 内
      if (!file.startsWith(archiveDir + path.sep)) return sendJSON(res, 403, { error: 'forbidden' });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJSON(res, 404, { error: 'not found' });
      const ext = path.extname(file).toLowerCase();
      const mime = {
        '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
      }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // 404
    sendJSON(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error('API错误:', err);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
}

const server = createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`\n本地API服务器已启动: http://localhost:${PORT}`);
  console.log(`接口列表:`);
  console.log(`  GET /api/featured?date=YYYY-MM-DD`);
  console.log(`  GET /api/articles?category=&date=&page=&tag=`);
  console.log(`  GET /api/tags`);
  console.log(`  GET /api/source-health`);
  console.log(`  GET /api/dates`);
  console.log(`  GET /api/catchup?since=<ISO时间>&before=YYYY-MM-DD`);
  console.log(`  GET /api/archive?category=&before=YYYY-MM-DD&limit=`);
  console.log(`  GET /api/article/:id`);
  console.log(`  GET /archive/<hash>/...（资料库静态文件）`);
  console.log(`\n小程序开发时请确保此服务器运行中`);
});
