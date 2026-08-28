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
import { generateSummaries } from './ai-summary.mjs';
import { reviewSummaries } from './ai-review.mjs';
import { generateDailyIntro } from './ai-intro.mjs';
import { initDB, insertArticles, getRecentTitles, getExistingUrls, saveDailyIntro, recordSourceHealth, getSourceHealthHistory, getDayCounts, getDayArticlesForQuota, deleteArticleById, getArticlesByDate, getRecentEvents } from './db.mjs';
import { dedupAgainstRecent } from './ai-dedup.mjs';
import { checkFreshness } from './ai-freshness.mjs';
import { splitRoundups } from './roundup-split.mjs';
import { auditMisses } from './miss-audit.mjs';
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
 * 把原始日期串规范化为ISO格式入库
 * 解析失败时用当前时间兜底并打印警告
 */
export function normalizePublishedAt(raw, sourceName, title) {
  if (raw) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  console.warn(`  [WARN] ${sourceName} 条目日期缺失或解析失败，使用当前时间兜底: "${raw || '(无日期)'}" | ${title || ''}`);
  return new Date().toISOString();
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
    const ts = a.published_at ? new Date(a.published_at).getTime() : NaN;
    if (isNaN(ts)) return official; // 官方源无日期放行
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
    const xml = await res.text();
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
      .map(item => ({
        title: (item.title || '').trim(),
        source_name: source.name,
        source_url: item.link || '',
        category: source.category,
        language: source.language,
        source_type: source.source_type,
        content_snippet: (item.contentSnippet || item.content || item.summary || '').slice(0, 2000),
        published_at: normalizePublishedAt(item.pubDate, source.name, item.title),
      }))
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
  const activeSources = lightMode ? SOURCES.filter(isGlobalSource) : SOURCES;

  console.log('=== AI资讯采集管线启动 ===');
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`源数量: ${activeSources.length}${lightMode ? '（凌晨轻量轮：仅海外源）' : ` / 全量 ${SOURCES.length}`}`);
  console.log('');

  // Step 1: 确保数据库表存在
  await initDB();

  // Step 2: 采集所有源（RSS + 爬虫，按 type 分派），同步记录各源产出供健康监控
  console.log('--- Step 1: 采集 ---');
  const allArticles = [];
  const healthStats = [];
  for (const source of activeSources) {
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

  // Step 3: 去重（批内按URL）
  const seen = new Set();
  const batchUnique = allArticles.filter(a => {
    if (seen.has(a.source_url)) return false;
    seen.add(a.source_url);
    return true;
  });

  // Step 3.5: 入库前硬过滤——剔除已在库中的文章（制度性保障：
  // 旧文章不进入AI筛选，不占用当日20条入选名额，避免写库时才被跳过）
  const existingUrls = await getExistingUrls(batchUnique.map(a => a.source_url));
  const uniqueArticles = batchUnique.filter(a => !existingUrls.has(a.source_url));
  const oldDropped = batchUnique.length - uniqueArticles.length;
  console.log(`去重后: ${uniqueArticles.length} 条${oldDropped ? `（剔除已入库旧文章 ${oldDropped} 条）` : ''}`);

  // Step 3.55: 拼盘拆条——"早知道/早报"类合集若被整体评分/去重误杀，藏在其中的
  // 大新闻会被连坐（2026-08-15事故：极客早知道因头条事件昨日已精选被整篇杀掉，
  // 苹果中国自研模型/SpaceX收购Cursor两条80+分新闻漏报）。拆成独立子事件各走评分。
  // 拆条失败/拆不出时保留原篇，行为与之前一致。
  const splitResult = await splitRoundups(uniqueArticles);
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

  // 日配额汰换（2026-08-28 Top-20竞争制）：配额已满时新条目顶替在库最低分条目。
  // selectByQuota 只打 __replaces 标记（纯函数不碰库），删除动作统一在写库前执行——
  // 被汰条目若在后续环节（时效校验/跨期去重/噪音过滤）随新条目一起被剔除，则不删。
  // 精选条目（is_featured=1）与官方政策条目在 selectByQuota 内豁免汰换，markFeatured
  // 为增量标记（按 5-已精选 预算只增不减），精选永不被删，故精选数无需重算。
  const replacements = finalArticles.filter(a => a.__replaces);
  if (replacements.length) {
    console.log(`--- 汰换写库: ${replacements.length} 条新稿顶替在库低分条目 ---`);
    for (const a of replacements) {
      const r = a.__replaces;
      console.log(`  汰换: [${a.ai_score}分新条] ${a.title.slice(0, 50)} 顶替 [${r.ai_score}分旧条] ${r.title || '(无标题)'} (#${r.id})`);
      await deleteArticleById(r.id);
    }
  }

  await insertArticles(finalArticles);

  // Step 7: 导语——本轮可能写入多个发布日，逐日基于该日全量已入库文章重生（而非仅本轮），
  // 保证导语反映该日全天主线；失败不阻塞（前端无导语时不展示）
  console.log('--- Step 5: 每日导语 ---');
  const daysWithNew = [...new Set(finalArticles.map(a => a.date_key))];
  for (const d of daysWithNew) {
    const src = await getArticlesByDate(d); // 已包含本轮新写入的
    const intro = await generateDailyIntro(src);
    if (intro) {
      console.log(`导语[${d}](${intro.length}字): ${intro}`);
      await saveDailyIntro(d, intro);
    }
  }

  console.log('\n=== 采集完成 ===');
  console.log(`本轮新增入库: ${finalArticles.length} 条，涉及发布日 ${daysWithNew.sort().join(', ')}`);
  for (const d of daysWithNew.sort()) {
    const dc = await getDayCounts(d);
    console.log(`  ${d} 累计: ${dc.count} 条（精选 ${dc.featured} 条）`);
  }

  // Step 8: 漏报对账——系统只记录"入选了什么"，不记录"杀掉了什么"，漏报就无法被
  // 看见（2026-08-15事故：两条80+分新闻被杀一整天无人知晓）。每轮末把未入选的
  // 新鲜候选与当日已入选清单做一次主编级对账，疑似重大漏报打印进日志供人工复查。
  console.log('--- Step 6: 漏报对账 ---');
  await auditMisses({ pool: candidateArticles, admitted: finalArticles, dayArticles: await getArticlesByDate(todayBJ) });
}

// 仅当作为脚本直接运行时才执行主流程（便于被测试脚本import）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(err => {
    console.error('采集管线异常:', err);
    process.exit(1);
  });
}
