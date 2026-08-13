/**
 * DeepSeek 官方（deepseek.com）发布监控爬虫
 *
 * 背景（2026-08-13）：DeepSeek-V4-Pro-0813 深夜上线，媒体稿早上才发，
 * 09:05采集轮没抓到——重大模型发布只盯媒体稿必然滞后。官网首页为SSR，
 * 页面内嵌JS配置里直接有官方发布公告文本（"🎉 DeepSeek-V4-Pro 正式版发布..."），
 * 发布当轮即可采到，比媒体转载早几小时到几天。
 *
 * 策略：抓首页 → 正则提取"DeepSeek-X 发布"公告文本与版本号 →
 * 按版本构造唯一 source_url（URL去重保证每个版本只入一次；首页公告被新版本
 * 替换后旧版不再提取，不影响已入库）。
 * 无反爬（普通浏览器UA即可，2026-08-13实测）；无显式日期，官方源按采集日入库。
 */
import { pathToFileURL } from 'url';

const HOME = 'https://www.deepseek.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 匹配 "DeepSeek-V4-Pro 正式版发布..." 公告（截断到引号/换行转义处）
const RELEASE_RE = /DeepSeek-[A-Za-z0-9.\-]*\s*(?:正式版)?发布[^"\\]{0,150}/g;

/**
 * 采集 DeepSeek 官方发布公告
 * @param {Object} source - sources.mjs 中的源配置
 * @returns {Array} 文章数组（每版一条）
 */
export async function scrapeDeepseek(source) {
  try {
    const resp = await fetch(HOME, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      console.error(`  [FAIL] DeepSeek官方爬虫: HTTP ${resp.status}`);
      return [];
    }
    const html = await resp.text();

    const articles = [];
    const seen = new Set();
    const matches = [...html.matchAll(RELEASE_RE)]
      .map(m => m[0].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim())
      .filter((v, i, a) => a.indexOf(v) === i); // 页面内同一公告多次内嵌，去重

    for (const text of matches) {
      const ver = (text.match(/DeepSeek-([A-Za-z0-9.\-]+)/) || [])[1];
      if (!ver || text.length < 12 || seen.has(ver)) continue;
      seen.add(ver);
      articles.push({
        title: text.length > 60 ? text.slice(0, 60) + '…' : text,
        source_name: source.name,
        // 按版本构造唯一URL：URL去重保证每版只入一次；旧版公告被替换后不影响已入库
        source_url: `${HOME}release/${ver}`,
        category: source.category,
        language: source.language,
        source_type: source.source_type,
        content_snippet: text.slice(0, 300),
        published_at: null, // 官方源无日期放行；发布日=采集日
      });
    }
    if (!articles.length) {
      console.warn('  [WARN] DeepSeek官方爬虫: 首页未匹配到发布公告（页面结构可能变更）');
    }
    return articles;
  } catch (err) {
    console.error(`  [FAIL] DeepSeek官方爬虫: ${err.message}`);
    return [];
  }
}

// 独立运行调试：node scraper-deepseek.mjs
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const arts = await scrapeDeepseek({ name: 'DeepSeek 官方', category: 'technology', language: 'zh', source_type: 'official' });
  console.log(`\n抓到 ${arts.length} 条`);
  arts.forEach(a => console.log(' -', a.title, '|', a.source_url, '|', a.published_at));
}
