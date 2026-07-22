/**
 * 采集主流程：RSS/爬虫采集 -> AI筛选 -> AI总结 -> 写入数据库
 * 
 * 用法：
 *   node collect.mjs          # 正常采集
 *   node collect.mjs --init   # 仅初始化数据库表
 */
import './load-env.mjs'; // 必须最先加载：后续模块在求值时读取 process.env
import Parser from 'rss-parser';
import { pathToFileURL } from 'url';
import { SOURCES } from './sources.mjs';
import { filterArticles } from './ai-filter.mjs';
import { generateSummaries } from './ai-summary.mjs';
import { initDB, insertArticles } from './db.mjs';
import { scrapeQbitai } from './scraper-qbitai.mjs';
import { scrapeJiqizhixin } from './scraper-jiqizhixin.mjs';

const parser = new Parser();

// 仅采集最近72小时内的文章（放宽以覆盖低频官方博客）
const HOURS_WINDOW = 72;
// 未来日期容忍上限：超过当前时间+1天的一律剔除
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

// 爬虫源分派表（sources.mjs 中 type: 'scraper' 的源按 scraper 键查找）
const SCRAPERS = {
  qbitai: scrapeQbitai,
  jiqizhixin: scrapeJiqizhixin,
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
 * - 超出72小时窗口：丢弃
 */
export function filterByFreshness(articles, source) {  const now = Date.now();
  const cutoff = now - HOURS_WINDOW * 60 * 60 * 1000;
  const official = isOfficialSource(source);

  return articles.filter(a => {
    const ts = a.published_at ? new Date(a.published_at).getTime() : NaN;
    if (isNaN(ts)) return official; // 官方源无日期放行
    if (ts > now + MAX_FUTURE_MS) return false; // 未来日期一律剔除
    return ts >= cutoff;
  });
}

/**
 * 采集单个RSS源（用fetch+parseString代替parseURL，避免兼容性问题）
 */
async function fetchSource(source) {
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': source.userAgent || 'Mozilla/5.0 (compatible; AINewsBot/1.0)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const feed = await parser.parseString(xml);
    const now = Date.now();
    const cutoff = now - HOURS_WINDOW * 60 * 60 * 1000;
    const official = isOfficialSource(source);

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
    return articles;

  } catch (err) {
    console.error(`  [FAIL] ${source.name}: ${err.message}`);
    return [];
  }
}

/**
 * 采集单个爬虫源（如量子位），失败降级为空数组
 */
async function fetchScraperSource(source) {
  const scrapeFn = SCRAPERS[source.scraper];
  if (!scrapeFn) {
    console.error(`  [FAIL] ${source.name}: 未注册的爬虫 "${source.scraper}"`);
    return [];
  }
  const articles = await scrapeFn(source); // 爬虫内部已try/catch
  // 与RSS源相同的时效过滤（爬虫返回的 published_at 为ISO串或null）
  const fresh = filterByFreshness(articles, source);
  console.log(`  [OK] ${source.name}: ${fresh.length} 条（爬虫原始 ${articles.length} 条）`);
  return fresh;
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

  console.log('=== AI资讯采集管线启动 ===');
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`源数量: ${SOURCES.length}`);
  console.log('');

  // Step 1: 确保数据库表存在
  await initDB();

  // Step 2: 采集所有源（RSS + 爬虫，按 type 分派）
  console.log('--- Step 1: 采集 ---');
  const allArticles = [];
  for (const source of SOURCES) {
    const articles = source.type === 'scraper'
      ? await fetchScraperSource(source)
      : await fetchSource(source);
    allArticles.push(...articles);
  }
  console.log(`采集完成: 共 ${allArticles.length} 条原始文章\n`);

  if (allArticles.length === 0) {
    console.log('没有采集到任何文章，退出');
    return;
  }

  // Step 3: 去重（按URL）
  const seen = new Set();
  const uniqueArticles = allArticles.filter(a => {
    if (seen.has(a.source_url)) return false;
    seen.add(a.source_url);
    return true;
  });
  console.log(`去重后: ${uniqueArticles.length} 条\n`);

  // Step 4: AI筛选评分
  console.log('--- Step 2: AI筛选 ---');
  const selected = await filterArticles(uniqueArticles);
  if (selected.length === 0) {
    console.log('AI筛选后无达标文章，退出');
    return;
  }
  console.log('');

  // Step 5: AI生成总结
  console.log('--- Step 3: AI总结生成 ---');
  const summarized = await generateSummaries(selected);
  console.log('');

  // Step 6: 写入数据库
  console.log('--- Step 4: 写入数据库 ---');
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const finalArticles = summarized.map(a => ({
    ...a,
    date_key: today,
  }));

  await insertArticles(finalArticles);

  console.log('\n=== 采集完成 ===');
  console.log(`今日精选: ${finalArticles.filter(a => a.is_featured).length} 条`);
  console.log(`总计入库: ${finalArticles.length} 条`);
}

// 仅当作为脚本直接运行时才执行主流程（便于被测试脚本import）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(err => {
    console.error('采集管线异常:', err);
    process.exit(1);
  });
}
