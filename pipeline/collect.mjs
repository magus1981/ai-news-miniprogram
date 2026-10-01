/**
 * 采集主流程：RSS/爬虫采集 -> AI筛选 -> AI总结 -> 写入数据库
 * 
 * 用法：
 *   node collect.mjs           # 正常采集
 *   node collect.mjs --init    # 仅初始化数据库表
 *   node collect.mjs --health  # 仅采集+记录信源健康（不跑AI、不入库文章，供排查信源）
 */
import './load-env.mjs'; // 必须最先加载：后续模块在求值时读取 process.env
import Parser from 'rss-parser';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { SOURCES, alertThreshold, isGlobalSource } from './sources.mjs';
import { filterArticles, RECENT_TITLE_DAYS, beijingDayKey } from './ai-filter.mjs';
import { fetchFullContents } from './fetch-content.mjs';
import { readResponseText, mojibakeRatio } from './charset.mjs';
import { generateSummaries } from './ai-summary.mjs';
import { reviewSummaries } from './ai-review.mjs';
import { generateDailyIntro } from './ai-intro.mjs';
import { initDB, insertArticles, getRecentTitles, getExistingUrls, saveDailyIntro, recordSourceHealth, getSourceHealthHistory, getHoursSinceLastFetch, getDayCounts, getDayArticlesForQuota, deleteArticleById, getArticlesByDate, getRecentEvents, insertQuarantine, findExistingByTitleNorm, findExistingByEventNorm, bumpMergedCount } from './db.mjs';
import { dedupAgainstRecent } from './ai-dedup.mjs';
import { checkFreshness } from './ai-freshness.mjs';
import { splitRoundups } from './roundup-split.mjs';
import { auditMisses } from './miss-audit.mjs';
import { resolvePublishedAt, extractPublishedFromUrl, extractPublishedFromHtml } from './date-extract.mjs';
import { normalizeUrl, normalizeTitle, isDedupableTitle } from './normalize.mjs';
import { scrapeQbitai } from './scraper-qbitai.mjs';
import { scrapeJiqizhixin } from './scraper-jiqizhixin.mjs';
import { scrapeAnthropic } from './scraper-anthropic.mjs';
import { scrapeZhidx, scrapeXindongxi } from './scraper-zhidx.mjs';
import { scrapeXinzhiyuan } from './scraper-xinzhiyuan.mjs';
import { scrapeCac } from './scraper-cac.mjs';
import { scrapeMiit } from './scraper-miit.mjs';
import { scrapeGov } from './scraper-gov.mjs';
import { scrapeTc260 } from './scraper-tc260.mjs';
import { scrapeNda } from './scraper-nda.mjs';
import { scrapeTheHill } from './scraper-thehill.mjs';
import { scrapeSoumu } from './scraper-soumu.mjs';
import { scrapeMeti } from './scraper-meti.mjs';
import { scrapeMsit } from './scraper-msit.mjs';
import { scrapeSdaia } from './scraper-sdaia.mjs';
import { scrapeNdrc } from './scraper-ndrc.mjs';
import { scrapeBeijing } from './scraper-beijing.mjs';
import { scrapeShanghai } from './scraper-shanghai.mjs';
import { scrapeZhejiang } from './scraper-zhejiang.mjs';
import { scrapeGuangdong } from './scraper-guangdong.mjs';
import { scrapeJiangsu } from './scraper-jiangsu.mjs';
import { scrapeDeepseek } from './scraper-deepseek.mjs';

const parser = new Parser();

// 仅采集最近36小时内的文章（2026-08-27 由72h收紧：UAE Google News等聚合源40-60小时
// 晚到的陈旧稿大量占用日配额，是"质量下滑"的直接来源；36h仍足够覆盖跨时区正常延迟。
// 低频官方博客不受影响——官方源走 OFFICIAL_WINDOW_DAYS=7天）
const HOURS_WINDOW = 36;
// 官方源（政府站）周更级频率，72h窗口对它太苛刻：漏一次即永久丢失
// （2026-08-10教训：网信办08-07征求意见稿超窗后又被配额竞争挤掉）。
// 每天采4轮，新发布首轮就会抓到；放宽到7天纯为防“漏一次=永久丢”。
const OFFICIAL_WINDOW_DAYS = 7;
// 未来日期容忍上限：超过当前时间+1天的一律剔除
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

// 爬虫源分派表（sources.mjs 中 type: 'scraper' 的源按 scraper 键查找）
const SCRAPERS = {
  qbitai: scrapeQbitai,
  jiqizhixin: scrapeJiqizhixin,
  anthropic: scrapeAnthropic,
  zhidx: scrapeZhidx,
  xindongxi: scrapeXindongxi,
  xinzhiyuan: scrapeXinzhiyuan,
  cac: scrapeCac,
  miit: scrapeMiit,
  gov: scrapeGov,
  tc260: scrapeTc260,
  nda: scrapeNda,
  thehill: scrapeTheHill,
  soumu: scrapeSoumu,
  meti: scrapeMeti,
  msit: scrapeMsit,
  sdaia: scrapeSdaia,
  ndrc: scrapeNdrc,
  beijing: scrapeBeijing,
  shanghai: scrapeShanghai,
  zhejiang: scrapeZhejiang,
  guangdong: scrapeGuangdong,
  jiangsu: scrapeJiangsu,
  deepseek: scrapeDeepseek,
};

/**
 * 判断是否为官方博客类信源（低频发布，无日期条目放行）
 */
function isOfficialSource(source) {
  return source.official === true || source.source_type === 'official';
}

/**
 * 把原始日期串规范化为ISO格式入库。
 *
 * 2026-09-29 事故修复：过去对"无日期"一律用当前时间兜底 → 旧闻冒充今日稿、
 * date_key 落到采集日、参与精选评分。现改为三级兜底：
 *   1. 原始 pubDate 可解析 → 直接用；
 *   2. 从 URL 中提取发布日期（政务站 `t20251013_xxx.html`、通用 `/2026/09/29/slug` 等）；
 *   3. 都提不到 → 返回空串 ''，调用方在源头标 `_date_unknown=true` 走"未知日期"通道。
 *      绝不再用 Date.now() 兜底。
 */
export function normalizePublishedAt(raw, sourceName, title, sourceUrl) {
  if (raw) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const urlIso = extractPublishedFromUrl(sourceUrl);
  if (urlIso) {
    console.warn(`  [DATE-RESQ] ${sourceName} 原始日期缺失，从 URL 恢复: ${urlIso} | ${title || ''}`);
    return urlIso;
  }
  console.warn(`  [DATE-UNKNOWN] ${sourceName} 无发布日期且 URL 无日期段，标 date_unknown: "${raw || '(无日期)'}" | ${title || ''}`);
  return '';
}

/**
 * 时效性过滤（作用于已含 published_at 字段的文章数组）
 * - 无日期/日期解析失败：官方源放行，其他源丢弃
 * - 未来日期（超过当前时间+1天）：一律剔除
 * - 超出窗口丢弃：官方源7天，其他源72小时
 */
export function filterByFreshness(articles, source) {  const now = Date.now();
  const official = isOfficialSource(source);
  const cutoff = now - (official ? OFFICIAL_WINDOW_DAYS * 24 : HOURS_WINDOW) * 60 * 60 * 1000;

  return articles.filter(a => {
    // date_unknown：走"未知日期"专用通道，直接放行给下游归入 date_key='unknown'，
    // 不参与"今日"主列表、不评精选、仅 scope=all 可见（2026-09-29 事故修复）
    if (a._date_unknown) return true;
    const ts = a.published_at ? new Date(a.published_at).getTime() : NaN;
    if (isNaN(ts)) {
      // 采集器直接返回 null/空 published_at 时，走 URL/HTML 兜底再判一次；
      // 仍失败 → 标 _date_unknown 放行（不再冒充今日稿，见 normalizePublishedAt 注释）
      const rescued = resolvePublishedAt(a);
      if (rescued) {
        // 救援出来的日期必须重新过一遍时效窗口（2026-10-01 修复，"小程序当天0条"排查）。
        // 旧写法 `a.published_at = rescued; return true;` 只看"有没有救出日期"，不看救出来的是哪天：
        // 政务站列表页不带时间、URL 里写着 t20211227 / t20240522，于是 2021—2025 年的老文件
        // 每轮都成批进池（实测 09-29/09-30 两轮入库的 date_key 有 2024-05-22、2025-10-13 等）。
        // 后果不只是列表脏：候选池的"发布日个数"被撑到 160 个，而 pickRefineCandidates 给每个
        // 未满日保底 3 个精评名额、总预算只有 30 —— 名额被历史日桶分光，当日 97 条候选只抢到 3 席，
        // 当天页面于是几乎为空。这与 2026-08-27 把窗口从 72h 收紧到 36h 的意图（治陈旧稿占配额）
        // 是同一个洞的另一条支路，此处按同一口径补齐：超窗一律不进池。
        a.published_at = rescued;
        const rts = new Date(rescued).getTime();
        if (Number.isFinite(rts)) return rts >= cutoff && rts <= now + MAX_FUTURE_MS;
        return true;
      }
      a._date_unknown = true;
      a.published_at = '';
      return true;
    }
    if (ts > now + MAX_FUTURE_MS) return false; // 未来日期一律剔除
    return ts >= cutoff;
  });
}

/**
 * 采集单个RSS源（用fetch+parseString代替parseURL，避免兼容性问题）
 * 失败自动重试一次：瞬时网络抖动不应计入当日0产出，污染健康记录
 * @returns {{articles: Array, raw: number, error: string|null}} raw为feed原始条数（供健康记录区分"源死了"和"源活着但无新内容"）
 */
async function fetchSource(source, attempt = 1) {
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': source.userAgent || 'Mozilla/5.0 (compatible; AINewsBot/1.0)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await readResponseText(res); // 按 RSS/HTTP 声明的字符集解码（日文/政务 feed 常为 Shift-JIS/EUC-JP）
    if (mojibakeRatio(xml) > 0.05) throw new Error(`feed 解码异常: U+FFFD 占比过高（疑似字符集识别失败）`);
    const feed = await parser.parseString(xml);
    const rawCount = (feed.items || []).length;
    const now = Date.now();
    const official = isOfficialSource(source);
    const cutoff = now - (official ? OFFICIAL_WINDOW_DAYS * 24 : HOURS_WINDOW) * 60 * 60 * 1000;

    const articles = (feed.items || [])
      .filter(item => {
        // 过滤时间窗口外的文章
        const parsed = item.pubDate ? new Date(item.pubDate) : null;
        const ts = parsed && !isNaN(parsed.getTime()) ? parsed.getTime() : null;
        if (ts === null) return official; // 无日期/解析失败：官方源放行，其他丢弃
        if (ts > now + MAX_FUTURE_MS) return false; // 未来日期一律剔除
        return ts >= cutoff;
      })
      .map(item => {
        const pub = normalizePublishedAt(item.pubDate, source.name, item.title, item.link);
        const art = {
          title: (item.title || '').trim(),
          source_name: source.name,
          source_url: item.link || '',
          category: source.category,
          language: source.language,
          source_type: source.source_type,
          content_snippet: (item.contentSnippet || item.content || item.summary || '').slice(0, 2000),
          published_at: pub,
        };
        // normalizePublishedAt 已经尝试过 URL 救援；仍为空 → 再试一次从 snippet/HTML 提日期
        if (!art.published_at) {
          const htmlIso = extractPublishedFromHtml(art.content_snippet);
          if (htmlIso) art.published_at = htmlIso;
        }
        if (!art.published_at) art._date_unknown = true;
        return art;
      })
      .filter(a => a.title && a.source_url); // 过滤无效条目

    console.log(`  [OK] ${source.name}: ${articles.length} 条`);
    return { articles, raw: rawCount, error: null };

  } catch (err) {
    if (attempt < 2) {
      console.warn(`  [RETRY] ${source.name}: ${err.message}，3秒后重试`);
      await new Promise(r => setTimeout(r, 3000));
      return fetchSource(source, attempt + 1);
    }
    console.error(`  [FAIL] ${source.name}: ${err.message}`);
    return { articles: [], raw: 0, error: err.message };
  }
}

/**
 * 采集单个爬虫源（如量子位），失败降级为空数组
 */
async function fetchScraperSource(source) {
  const scrapeFn = SCRAPERS[source.scraper];
  if (!scrapeFn) {
    console.error(`  [FAIL] ${source.name}: 未注册的爬虫 "${source.scraper}"`);
    return { articles: [], raw: 0, error: `未注册的爬虫 "${source.scraper}"` };
  }
  const articles = await scrapeFn(source); // 爬虫内部已try/catch
  // 与RSS源相同的时效过滤（爬虫返回的 published_at 为ISO串或null）
  const fresh = filterByFreshness(articles, source);
  console.log(`  [OK] ${source.name}: ${fresh.length} 条（爬虫原始 ${articles.length} 条）`);
  // 爬虫内部失败时返回空数组：raw=0 即可反映异常，无需额外error
  return { articles: fresh, raw: articles.length, error: null };
}

/**
 * 连续0产出告警计算：从最近一条健康记录往前数连续 fetched=0 的天数，
 * 达到该源阈值（官方7天/媒体3天）即告警；记录不足阈值天数时不告警（避免新源误报）
 * @param {Array} history - getSourceHealthHistory 返回的记录（日期降序）
 * @param {Array} sources - 信源配置列表
 */
export function computeHealthAlerts(history, sources) {
  const bySource = new Map();
  for (const r of history) {
    if (!bySource.has(r.source_name)) bySource.set(r.source_name, []);
    bySource.get(r.source_name).push(r);
  }
  const alerts = [];
  for (const source of sources) {
    if (source.enabled === false) continue; // 临时下线的源不再计入告警（历史 0 产出行不再刷告警）
    const recs = bySource.get(source.name) || [];
    const threshold = alertThreshold(source);
    let zeroDays = 0;
    for (const r of recs) {
      if (r.fetched === 0) zeroDays++;
      else break;
    }
    if (recs.length >= threshold && zeroDays >= threshold) {
      const lastError = recs.find(r => r.error)?.error || null;
      alerts.push({ name: source.name, zeroDays, threshold, lastError });
    }
  }
  return alerts;
}

/**
 * 加工服务探活（2026-09-29 欠费事故修复）
 * 背景：09-28 起 DashScope 欠费，AI 加工全线失败，但要看完整跑完约 30 分钟、
 * 数隔离表爆量才被动发现（本轮事故就是人工撞出来的）。这里在开跑前用一次极小调用
 * （max_tokens=1）先验账号可用性，账号级不可用就立刻中止，省下整轮抓取与 LLM 花费，
 * 也让告警提前约半小时。
 * 判定口径：
 *   - 账号级（401/402/403、Arrearage/欠费/InvalidApiKey/Access denied）→ 立即中止，不重试
 *     （重试不会让欠费变可用，只会浪费时间）；
 *   - 非账号级（网络超时、5xx、DNS）→ 重试一次，仍失败才中止（避免一次网络抖动误杀整轮采集）。
 * 中止沿用既有 fail-fast 路径：打印 [ALERT] + process.exitCode=1 让 Actions 步骤标红触发通知，
 * 不另造第二套告警通道。SKIP_LLM_PROBE=1 可人工绕过（仅限明知账号正常、要先收原始新闻的补跑）。
 */
const PROBE_ACCOUNT_FATAL_RE = /Arrearage|overdue|欠费|InvalidApiKey|AccessDenied|Access denied|Incorrect API key|Unauthorized/i;

export function probeIsAccountFatal(r) {
  return r.status === 401 || r.status === 402 || r.status === 403 || PROBE_ACCOUNT_FATAL_RE.test(r.body || '');
}

export async function probeLLMService() {
  if (process.env.SKIP_LLM_PROBE === '1') {
    console.log('[WARN] SKIP_LLM_PROBE=1：已跳过加工服务探活（仅人工补跑使用）');
    return true;
  }
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) {
    console.error('!!! [ALERT] 加工服务探活失败：DASHSCOPE_API_KEY 未设置（密钥缺失，非欠费） !!!');
    console.error('!!! [ALERT] 本轮采集已中止（未抓取任何源）。请检查 workflow secrets 配置。 !!!');
    process.exitCode = 1;
    return false;
  }
  const probeModel = process.env.LLM_PROBE_MODEL || 'qwen-turbo';
  const timeoutMs = Number(process.env.LLM_PROBE_TIMEOUT_MS) || 20000;
  // 默认端点与各 ai-*.mjs 模块用的完全一致；LLM_PROBE_URL 仅供单测指向本地桩服务
  const probeUrl = process.env.LLM_PROBE_URL
    || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

  const once = async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetch(probeUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        // max_tokens=1 的固定短 prompt：只为验证"能不能调用"，不产生任何业务内容
        body: JSON.stringify({ model: probeModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: ac.signal,
      });
      let text = '';
      try { text = await resp.text(); } catch { /* 正文读不出时按状态码判定 */ }
      return { ok: resp.ok, status: resp.status, body: text.slice(0, 300) };
    } catch (e) {
      const timedOut = e?.name === 'AbortError';
      return { ok: false, status: 0, body: timedOut ? `timeout>${timeoutMs}ms` : String(e?.message || e) };
    } finally {
      clearTimeout(timer);
    }
  };

  let r = await once();
  if (!r.ok && !probeIsAccountFatal(r)) {
    console.log(`[PROBE] 首次探活未通过（${r.status || 'NET'} ${r.body.slice(0, 80)}），重试一次…`);
    r = await once();
  }
  if (r.ok) {
    console.log(`[PROBE] DashScope 探活通过（${probeModel}），开始采集`);
    return true;
  }

  const fatal = probeIsAccountFatal(r);
  const why = fatal ? '账号级不可用（欠费/鉴权失败）' : '服务不可达（超时/5xx/网络）';
  console.error('');
  console.error(`!!! [ALERT] 加工服务探活失败：${why} — 立即中止本轮采集（未抓取任何源） !!!`);
  console.error(`!!! [ALERT] HTTP ${r.status || 'N/A'}｜${r.body.slice(0, 200) || '(无响应体)'} !!!`);
  console.error('!!! [ALERT] 处置：检查 DashScope 账户余额/API Key 后重跑本轮；'
    + '确需先收原始新闻可临时 SKIP_LLM_PROBE=1，但产物会进隔离表不会上首页。 !!!');
  process.exitCode = 1; // 沿用既有标红路径 → Actions 步骤失败触发通知
  return false;
}

/**
 * 主采集流程
 */
async function main() {
  const args = process.argv.slice(2);

  // 初始化模式
  if (args.includes('--init')) {
    await initDB();
    return;
  }

  // 凌晨轻量轮（2026-08-27 新增）：workflow dispatch inputs.mode==='light'
  // （经 COLLECT_MODE 环境变量传入；client_payload 实测被 GitHub API 422 拒绝，
  // 保留解析仅作兼容）或命令行 --light 时只抓海外源，覆盖"美国白天=北京凌晨"窗口，
  // 把美西重磅稿的入库延迟从最多12h+压到4h内（02:35/05:35 两轮）。
  let lightMode = args.includes('--light') || process.env.COLLECT_MODE === 'light';
  try {
    const evPath = process.env.GITHUB_EVENT_PATH;
    if (!lightMode && evPath && fs.existsSync(evPath)) {
      const ev = JSON.parse(fs.readFileSync(evPath, 'utf8'));
      lightMode = ev?.client_payload?.mode === 'light';
    }
  } catch { /* 事件文件解析失败按普通轮处理 */ }
  // 临时下线的源（enabled:false，如 VentureBeat 429/TLS指纹封锁止损）不参与采集：
  // 全量轮与凌晨轻量轮都先剔除，挂回只需把 sources.mjs 里的 enabled 改回 true。
  const enabledSources = SOURCES.filter(s => s.enabled !== false);
  const activeSources = lightMode ? enabledSources.filter(isGlobalSource) : enabledSources;

  console.log('=== AI资讯采集管线启动 ===');
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`源数量: ${activeSources.length}${lightMode ? '（凌晨轻量轮：仅海外源）' : ` / 全量 ${SOURCES.length}`}`);
  console.log('');

  // Step 0: 加工服务探活（2026-09-29 欠费事故修复）——放在任何抓取之前，
  // 账号欠费/鉴权失败时立即中止，不要等整轮 30 分钟跑完才被动发现。
  if (!await probeLLMService()) return;

  // Step 1: 确保数据库表存在
  await initDB();

  // Step 2: 采集所有源（RSS + 爬虫，按 type 分派），同步记录各源产出供健康监控
  console.log('--- Step 1: 采集 ---');
  const allArticles = [];
  const healthStats = [];
  for (const source of activeSources) {
    // 按源抓取间隔（429限流保护，2026-09-06）：配置了 fetchIntervalHours 的源，若距上次真实抓取
    // 不足 N 小时则本轮跳过。跳过=不请求该源、且不写入 healthStats——因此其 source_health 行不被触碰
    // （checked_at/fetched/raw 保持上次真实抓取值），既不会把该源误记成 0 产出污染连续0告警，
    // 也不会推进间隔计时。以后任何被限流的源都可通过配置该字段复用此机制。
    if (source.fetchIntervalHours) {
      const hoursSince = await getHoursSinceLastFetch(source.name);
      if (hoursSince != null && hoursSince < source.fetchIntervalHours) {
        console.log(`  [SKIP] ${source.name}: 距上次抓取不足 ${source.fetchIntervalHours}h（429 限流保护，实测距上次 ${hoursSince.toFixed(1)}h），本轮跳过`);
        continue;
      }
    }
    const { articles, raw, error } = source.type === 'scraper'
      ? await fetchScraperSource(source)
      : await fetchSource(source);
    healthStats.push({ source_name: source.name, fetched: articles.length, raw, error });
    allArticles.push(...articles);
  }
  console.log(`采集完成: 共 ${allArticles.length} 条原始文章\n`);

  // Step 2.1: 信源健康——先记录后告警（必须在"无文章提前退出"之前执行：
  // 全部源挂掉正是最需要记录和告警的时刻）
  const todayKey = new Date().toISOString().split('T')[0];
  await recordSourceHealth(todayKey, healthStats);
  const healthHistory = await getSourceHealthHistory(14);
  const alerts = computeHealthAlerts(healthHistory, SOURCES);
  if (alerts.length) {
    console.log('!!! 信源健康告警 !!!');
    for (const a of alerts) {
      console.log(`  [ALERT] ${a.name}: 连续 ${a.zeroDays} 天 0 产出（阈值 ${a.threshold} 天）${a.lastError ? `，最近错误: ${a.lastError}` : ''}`);
    }
    console.log('');
  }

  // 仅健康检查模式：打印各源明细后退出，不跑AI、不入库文章
  if (args.includes('--health')) {
    console.log('--- 信源健康明细 ---');
    for (const s of healthStats) {
      const flag = s.fetched > 0 ? 'OK  ' : (s.error ? 'FAIL' : 'ZERO');
      console.log(`  [${flag}] ${s.source_name}: 新鲜 ${s.fetched} / 原始 ${s.raw}${s.error ? ` | ${s.error}` : ''}`);
    }
    console.log(`\n告警数: ${alerts.length}`);
    return;
  }

  if (allArticles.length === 0) {
    console.log('没有采集到任何文章，退出');
    return;
  }

  // Step 3: 去重（批内按 URL；2026-09-29 事故修复：改用归一化 URL，堵住 utm_/spm/尾斜杠
  // 差异导致的同一条稿被不同来源/不同参数入库两次）
  const seen = new Set();
  const batchUnique = allArticles.filter(a => {
    const k = normalizeUrl(a.source_url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Step 3.4: 批内标题归一化去重（2026-09-29 事故修复：同一天两条《互联网平台价格行为规则》
  // 因 source_url 不同被双双入库）。仅完全等价（去装饰性标点后字符串相等）才合并，
  // 保留 published_at 非空/最早那条为主条，同 URL 走合并、异 URL 视为同事件的两家转载，
  // 保留最早那条、其余只累加 merged_count 不再走 AI 评分。
  const byTitle = new Map();
  const titleMerged = [];
  let titleDupDropped = 0;
  for (const a of batchUnique) {
    const tn = normalizeTitle(a.title);
    if (!isDedupableTitle(tn)) { titleMerged.push(a); continue; }
    const prevIdx = byTitle.get(tn);
    if (prevIdx == null) {
      byTitle.set(tn, titleMerged.length);
      titleMerged.push(a);
      continue;
    }
    const prev = titleMerged[prevIdx];
    // 择主：非空 published_at 优先；两者都有则取更早者；都无日期则保留先入者。
    const prevTs = prev.published_at ? Date.parse(prev.published_at) : Infinity;
    const curTs = a.published_at ? Date.parse(a.published_at) : Infinity;
    const keep = curTs < prevTs ? a : prev;
    const drop = keep === a ? prev : a;
    if (keep !== prev) titleMerged[prevIdx] = keep;
    keep.merged_same_source = (keep.merged_same_source || 0) + 1 + (drop.merged_same_source || 0);
    titleDupDropped++;
  }
  if (titleDupDropped) console.log(`批内标题归一化合并: 剔除 ${titleDupDropped} 条同标题重复产物`);

  // Step 3.5: 入库前硬过滤——剔除已在库中的文章（制度性保障：
  // 旧文章不进入AI筛选，不占用当日20条入选名额，避免写库时才被跳过）
  // 2026-09-29 修复：getExistingUrls 已扩展为按 source_url ∪ url_norm 双路命中。
  const existingUrls = await getExistingUrls(titleMerged.map(a => a.source_url));
  const notUrlDup = titleMerged.filter(a => !existingUrls.has(a.source_url));
  const oldDropped = titleMerged.length - notUrlDup.length;
  console.log(`去重后: ${notUrlDup.length} 条${oldDropped ? `（剔除已入库旧文章 ${oldDropped} 条）` : ''}`);

  // Step 3.5a: 跨库标题 / 事件名合并（2026-09-29 事故修复：
  // 《互联网平台价格行为规则》同一天两条、《跨省跨区电力应急调度管理办法》两条，
  // 因 source_url 与 URL 归一化都不同、批内标题合并也没抓住（分别落在两轮采集里），
  // AI 跨期事件去重又被同主体不同事件误伤门槛放行 → 双双入库。
  // 现在写库前按 title_norm / event_norm 精确对照近 10 天已入库：命中即保留更早/有日期的那条为主，
  // 新条不入正式主列表、只 bumpMergedCount 记一笔合并数。
  const normTitles = notUrlDup.map(a => normalizeTitle(a.title)).filter(isDedupableTitle);
  const hitByTitle = normTitles.length ? await findExistingByTitleNorm(normTitles, 10) : new Map();
  const keptAfterTitleDup = [];
  let crossTitleMerged = 0;
  for (const a of notUrlDup) {
    const tn = normalizeTitle(a.title);
    const hits = tn ? hitByTitle.get(tn) : null;
    if (hits && hits.length) {
      const curTs = a.published_at ? Date.parse(a.published_at) : Infinity;
      const earliest = hits.reduce((m, h) => {
        const ts = h.published_at ? Date.parse(h.published_at) : Infinity;
        return ts < m.ts ? { id: h.id, ts } : m;
      }, { id: hits[0].id, ts: hits[0].published_at ? Date.parse(hits[0].published_at) : Infinity });
      if (curTs < earliest.ts) {
        // 新条发布时间更早：保留新条为主，把老早条降级为合并目标（后续一次性脚本清理）。
        await bumpMergedCount(earliest.id, 1);
        a.merged_same_source = (a.merged_same_source || 0) + 1;
      } else {
        await bumpMergedCount(earliest.id, 1);
      }
      crossTitleMerged++;
      continue;
    }
    keptAfterTitleDup.push(a);
  }
  if (crossTitleMerged) console.log(`跨库标题归一化合并: ${crossTitleMerged} 条命中已入库同标题稿件，走 merged_count 累加、不重复入库`);

  // Step 3.52: 日期未识出稿件分流（2026-09-29 事故修复）
  // 无发布日期（RSS/pubDate、URL、正文/meta 三级都提不到）的稿件不再冒充"今日新稿"：
  //   - 不进 AI 筛选、不占当日 20 条入选名额、不评 is_featured；
  //   - 单独以 date_key='unknown'、date_unknown=1 落库，仅 scope=all 可见；
  //   - 前端在条目上标"日期未知"字段（date_unknown: true）。
  // 缺失率 >20% 打红告警（沿用 fail-fast 路径：process.exitCode=1 让 Actions 步骤标红），
  // 提示"信源大面积丢日期"或"采集器解析回归"，避免静默污染。
  const knownArticles = [];
  const unknownArticles = [];
  for (const a of keptAfterTitleDup) {
    if (a._date_unknown || !a.published_at) {
      a._date_unknown = true;
      a.published_at = '';
      a.date_key = 'unknown';
      unknownArticles.push(a);
    } else {
      knownArticles.push(a);
    }
  }
  const totalIngested = knownArticles.length + unknownArticles.length;
  const unknownRate = totalIngested ? unknownArticles.length / totalIngested : 0;
  console.log(`日期解析: 已知 ${knownArticles.length} 条 / 未知 ${unknownArticles.length} 条（缺失率 ${(unknownRate * 100).toFixed(1)}%）`);
  if (unknownArticles.length) {
    console.log(`  [SAMPLE-UNKNOWN] 前 5 条 date_unknown 稿件:`);
    for (const u of unknownArticles.slice(0, 5)) {
      console.log(`    · ${u.source_name} | ${u.title.slice(0, 40)} | ${u.source_url.slice(0, 60)}`);
    }
  }
  if (unknownRate > 0.2 && totalIngested >= 5) {
    // 达到告警阈值：既打印醒目 ALERT 又置 exitCode，让 Actions 步骤标红（沿用现有告警路径）
    console.error('');
    console.error(`!!! [ALERT] published_at 缺失率 ${(unknownRate * 100).toFixed(1)}%（${unknownArticles.length}/${totalIngested}）> 20% !!!`);
    console.error('    疑似信源大面积丢日期 / 采集器解析回归；本轮这些稿件已改走 date_unknown 通道，不进今日主列表、不评精选。');
    console.error('    请核对相关爬虫（发改委/网信办/工信部/DeepSeek 官方等）的 list 页 DOM 是否变更。');
    console.error('');
    process.exitCode = 1;
  }
  const uniqueArticlesKnown = knownArticles;

  // Step 3.55: 拼盘拆条——"早知道/早报"类合集若被整体评分/去重误杀，藏在其中的
  // 大新闻会被连坐（2026-08-15事故：极客早知道因头条事件昨日已精选被整篇杀掉，
  // 苹果中国自研模型/SpaceX收购Cursor两条80+分新闻漏报）。拆成独立子事件各走评分。
  // 拆条失败/拆不出时保留原篇，行为与之前一致。
  const splitResult = await splitRoundups(uniqueArticlesKnown);
  let candidateArticles = splitResult.list;
  if (splitResult.stats.split > 0) {
    // 子事件的 #ev-N URL 可能已在库（前轮已拆过同一拼盘），再过一遍URL去重
    const existSub = await getExistingUrls(candidateArticles.filter(a => a.from_roundup).map(a => a.source_url));
    if (existSub.size) candidateArticles = candidateArticles.filter(a => !existSub.has(a.source_url));
    console.log(`拼盘拆条: 检出 ${splitResult.stats.roundups} 篇拼盘，拆出 ${splitResult.stats.split} 个子事件，候选池 ${candidateArticles.length} 条`);
  }

  // 候选池按发布日分布（2026-08-14 排查"当日稿少"时补上的观测点：
  // 只看总数分不清"当天没新闻"还是"当天稿被筛选挤掉"）
  const dayDist = new Map();
  for (const a of candidateArticles) {
    const dk = beijingDayKey(a.published_at);
    dayDist.set(dk, (dayDist.get(dk) || 0) + 1);
  }
  console.log(`候选池按发布日: ${[...dayDist.entries()].sort().map(([dk, n]) => `${dk}:${n}`).join(' ')}\n`);

  // 仅采集诊断模式：只看候选池分布不跑AI（本地排查用，不产生费用不入库）
  if (args.includes('--collect-only')) {
    console.log('--- collect-only 诊断模式：跳过AI筛选 ---');
    const titles = candidateArticles
      .filter(a => beijingDayKey(a.published_at) === beijingDayKey(new Date().toISOString()))
      .map(a => `[${a.source_name}] ${a.title}`);
    console.log(`当日候选标题(${titles.length}):`);
    for (const t of titles) console.log('  ' + t);
    return;
  }

  if (candidateArticles.length === 0) {
    console.log('无新文章可筛选，退出');
    return;
  }

  // Step 4: AI筛选评分（传入近期已入库标题，用于旧闻对照与事件去重）
  // 归日按“发布北京日”：本轮文章可能跨多个发布日（采集窗口72小时），
  // 逐日载入该日已入库数/精选数/精选最低分，供各日独立结算“每日10-20条/精选5条”。
  console.log('--- Step 2: AI筛选 ---');
  const affectedDays = [...new Set(candidateArticles.map(a => beijingDayKey(a.published_at)))];
  const todayBJ = beijingDayKey(new Date().toISOString());
  if (!affectedDays.includes(todayBJ)) affectedDays.push(todayBJ); // 无日期兜底稿归今天，确保有其上下文
  const dayContexts = {};
  for (const d of affectedDays) {
    const c = await getDayCounts(d);
    let featuredMinScore = 0;
    if (c.featured > 0) {
      const arts = await getArticlesByDate(d);
      const fs = arts.filter(a => a.is_featured).map(a => a.ai_score).filter(s => typeof s === 'number');
      featuredMinScore = fs.length ? Math.min(...fs) : 0;
    }
    dayContexts[d] = { existingCount: c.count, existingFeatured: c.featured, featuredMinScore, dayArticles: await getDayArticlesForQuota(d) };
    if (c.count > 0) console.log(`  发布日 ${d}: 已入库 ${c.count} 条（精选 ${c.featured} 条），本轮作增量处理`);
  }
  const recentTitles = await getRecentTitles(RECENT_TITLE_DAYS);
  if (recentTitles.length) console.log(`旧闻对照: 载入近${RECENT_TITLE_DAYS}天已入库标题 ${recentTitles.length} 条`);
  const selected = await filterArticles(candidateArticles, recentTitles, dayContexts);
  if (selected.length === 0) {
    console.log('AI筛选后无达标文章（或各日配额已满），退出');
    // 零入选正是最该对账的时刻：全部被杀掉时，重大新闻可能混在其中（2026-08-15事故）
    await auditMisses({ pool: candidateArticles, admitted: [], dayArticles: await getArticlesByDate(todayBJ) });
    return;
  }
  console.log('');

  // Step 4.5: 全文抓取（仅对入选文章，约20条）——摘要基于全文而非RSS片段，
  // 从根源上减少"看标题脑补"型幻觉；原文同时入库存档供后续事实二审/重生成。
  // 拼盘子事件（from_roundup）跳过全文抓取：父篇全文是整篇合集，抓回来会让摘要
  // 把别的串台事件也写进去；子事件已自带逐字摘录的事件段落作素材。
  console.log('--- Step 2.5: 全文抓取 ---');
  const roundupSubs = selected.filter(a => a.from_roundup);
  if (roundupSubs.length) console.log(`  ${roundupSubs.length} 条拼盘子事件跳过全文抓取（使用拆条摘录素材）`);
  await fetchFullContents(selected.filter(a => !a.from_roundup));
  console.log('');
  console.log('--- Step 3: AI总结生成 ---');
  const summarized = await generateSummaries(selected);
  console.log('');

  // Step 5.5: AI二审（事实核对）——把每篇摘要与已抓取的原文素材逐项对照，
  // 数字/公司归属/缩写展开/语义反转等确凿错误直接打回修正（幻觉的最后一道防线）
  console.log('--- Step 3.5: AI二审事实核对 ---');
  const reviewed = await reviewSummaries(summarized);
  console.log('');

  // Step 3.6: AI时效校验（旧闻拦截）——评分阶段看不到全文里的时间线索
  // （2026-08-12 事故：新智元把7/31的Seedance 2.5和8/2的Anthropic水印当新稿上报），
  // 摘要生成后全文已在手，提取"新闻由头"日期，明确早于3天前的旧闻剔除不入库
  console.log('--- Step 3.6: AI时效校验 ---');
  const { kept: freshArticles, dropped: oldNews } = await checkFreshness(reviewed, recentTitles);
  if (oldNews.length) {
    console.log(`旧闻剔除: ${oldNews.length} 条（新闻由头早于3天前）`);
    for (const o of oldNews) {
      console.log(`  [OLD] ${o.title.slice(0, 45)}（由头 ${o.__event_date || '?'}）: ${o.__reason || ''}`);
    }
    console.log('');
  }

  // Step 6: 写入数据库（noise分类为噪音，不入库）
  console.log('--- Step 4: 写入数据库 ---');
  const noiseCount = freshArticles.filter(a => a.category === 'noise').length;
  if (noiseCount > 0) console.log(`噪音过滤: 剔除与AI无实质关联的文章 ${noiseCount} 条`);
  const nonNoise = freshArticles.filter(a => a.category !== 'noise');

  // Step 3.75: AI跨期事件去重（内容级比对）——同一事件的跨天二次报道：
  // 纯复述剔除不入库；实质新进展（官方确认/新细节/新数字）保留但降级
  // （is_followup=1、强制不精选、分数压到原文章之下、记 related_to 供相关阅读）
  // 2026-08-11 案例：量子位"黄仁勋华尔街5000亿"(739) 与 次日NVIDIA官网"金融机构AI基建"(749) 同一事件漏网
  console.log('--- Step 3.75: AI跨期事件去重 ---');
  const recentEvents = await getRecentEvents(10);
  const { kept: deduped, dropped } = await dedupAgainstRecent(nonNoise, recentEvents);
  if (dropped.length) {
    console.log(`同事件复述剔除: ${dropped.length} 条（不单独入库）`);
    for (const d of dropped) {
      console.log(`  [DROP] ${d.title.slice(0, 45)}（关联 #${d.__related_id || '?'}）: ${d.__reason || ''}`);
    }
  }
  const followupCount = deduped.filter(a => a.is_followup).length;
  if (followupCount > 0) {
    console.log(`同事件跟进降级: ${followupCount} 条（保留但不精选）`);
    for (const f of deduped.filter(a => a.is_followup)) {
      console.log(`  [FOLLOW] ${f.title.slice(0, 45)} -> 关联 ${f.related_to || '?'} | ${f.__reason || ''}`);
    }
  }
  console.log('');

  // date_key 已在 filterArticles 里按发布北京日打好；此处兜底一次（降级路径/缺失时同口径补上）
  const finalArticles = deduped
    .map(a => ({
      ...a,
      date_key: a.date_key || beijingDayKey(a.published_at),
    }));

  // ---- fail-fast 写库闸门（2026-09-28 事故核心修复）----
  // 半成品判定：加工失败(_proc_failed) / 评分降级(_score_fallback) / takeaway 空 /
  // 标题或摘要含高比例 U+FFFD。命中者**一律不进主列表**，转隔离队列待 LLM 恢复后重跑。
  const isHalfProduct = (a) =>
    a._proc_failed === true ||
    a._score_fallback === true ||
    !(a.takeaway && String(a.takeaway).trim()) ||
    mojibakeRatio(a.title || '') > 0.05 ||
    mojibakeRatio(a.summary || '') > 0.05;
  const cleanArticles = finalArticles.filter(a => !isHalfProduct(a));
  const quarantined = finalArticles.filter(isHalfProduct);

  // 日配额汰换（2026-08-28 Top-20竞争制）：仅在"将真正入库的干净条目"里处理 __replaces——
  // 绝不能为了顶替旧条而删掉在库好文、结果新条又被隔离（净丢数据）。
  const replacements = cleanArticles.filter(a => a.__replaces);
  if (replacements.length) {
    console.log(`--- 汰换写库: ${replacements.length} 条新稿顶替在库低分条目 ---`);
    for (const a of replacements) {
      const r = a.__replaces;
      console.log(`  汰换: [${a.ai_score}分新条] ${a.title.slice(0, 50)} 顶替 [${r.ai_score}分旧条] ${r.title || '(无标题)'} (#${r.id})`);
      await deleteArticleById(r.id);
    }
  }

  await insertArticles(cleanArticles);

  // Step 4.5: 日期未知稿写库（2026-09-29 事故修复）
  // 这些条目已在 Step 3.52 里定死 date_key='unknown'、_date_unknown=true；
  // insertArticles 会拒给 is_featured、把 date_unknown 落列；仅 scope=all 检索可见，
  // 不进"今日"主列表、不占日配额、不评精选。
  if (unknownArticles.length) {
    console.log(`--- Step 4.5: 日期未知稿写入 date_key='unknown' 归档 ---`);
    const r = await insertArticles(unknownArticles);
    console.log(`date_unknown 通道: 新增 ${r.inserted} 条 / 已存在跳过 ${r.skipped} 条`);
  }

  // 隔离 + 告警（失败必须可见：exit 非0 让 Actions 步骤标红、触发通知）
  if (quarantined.length) {
    const n = await insertQuarantine(quarantined);
    const fatalArrears = quarantined.some(a =>
      /Arrearage|invalid_api_key|overdue|欠费|Incorrect API key|Unauthorized|401|402/i.test(String(a._proc_reason || '')));
    console.error(`\n!!! [ALERT] 加工质量闸门：本轮 ${quarantined.length} 条未通过（写入隔离表 ${n} 条），已阻止进入首页主列表，待重跑 !!!`);
    console.error(`    隔离样本: ${quarantined.slice(0, 5).map(a => `${(a.title || a.source_url || '').slice(0, 30)}<${a._score_fallback ? '评分降级' : (a._proc_reason || '加工失败')}>`).join(' , ')}`);
    if (fatalArrears) {
      console.error('    根因指向：DashScope 账号欠费/鉴权失败（Arrearage）——非代码问题，需充值/换密钥后由 reprocess-quarantine.mjs 回补。');
    }
    process.exitCode = 1; // 让工作流步骤标红告警（DB 已推干净主列表，隔离表留存待重跑）
  }

  // Step 7: 导语——逐日基于该日全量已入库文章重生；仅在本轮有干净新条目入库的日期重生成
  console.log('--- Step 5: 每日导语 ---');
  const daysWithNew = [...new Set(cleanArticles.map(a => a.date_key))];
  for (const d of daysWithNew) {
    const src = await getArticlesByDate(d); // 已包含本轮新写入的
    const intro = await generateDailyIntro(src);
    if (intro) {
      console.log(`导语[${d}](${intro.length}字): ${intro}`);
      await saveDailyIntro(d, intro);
    }
  }

  console.log('\n=== 采集完成 ===');
  console.log(`本轮新增入库: ${cleanArticles.length} 条${quarantined.length ? `，隔离待重跑: ${quarantined.length} 条` : ''}，涉及发布日 ${daysWithNew.sort().join(', ') || '(无)'}`);
  for (const d of daysWithNew.sort()) {
    const dc = await getDayCounts(d);
    console.log(`  ${d} 累计: ${dc.count} 条（精选 ${dc.featured} 条）`);
  }

  // Step 8: 漏报对账——系统只记录"入选了什么"，不记录"杀掉了什么"，漏报就无法被
  // 看见（2026-08-15事故：两条80+分新闻被杀一整天无人知晓）。每轮末把未入选的
  // 新鲜候选与当日已入选清单做一次主编级对账，疑似重大漏报打印进日志供人工复查。
  console.log('--- Step 6: 漏报对账 ---');
  await auditMisses({ pool: candidateArticles, admitted: cleanArticles, dayArticles: await getArticlesByDate(todayBJ) });
}

// 仅当作为脚本直接运行时才执行主流程（便于被测试脚本import）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(err => {
    console.error('采集管线异常:', err);
    process.exit(1);
  });
}
