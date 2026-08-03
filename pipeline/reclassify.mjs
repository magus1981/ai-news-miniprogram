/**
 * 全量重分类脚本：按《AI资讯小程序-栏目说明.md》重新判定全部文章的
 * 一级分类(category)和子标签(tags，新增 regions 区域键)
 *
 * 用法：
 *   node reclassify.mjs            # 处理全部待办并入库
 *   node reclassify.mjs --limit 60 # 只处理60条（断点续跑，分批执行用）
 *
 * 断点续跑：每条结果立即追加到 pipeline/reclassify-results.jsonl，
 * 重跑自动跳过已完成id；全部完成后才在事务中批量UPDATE进库
 */
import './load-env.mjs'; // 必须最先加载
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { CATEGORY_RULES, VALID_CATEGORIES, applyTagInvariants } from './classify-rules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const RESULTS_FILE = join(__dirname, 'reclassify-results.jsonl');

const TAG_KEYS = ['companies', 'people', 'keywords', 'regions'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 命令行参数 --limit N
const limitArg = process.argv.find(a => a.startsWith('--limit'));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1] || process.argv[process.argv.indexOf('--limit') + 1]) : Infinity;

if (!DASHSCOPE_API_KEY) {
  console.error('错误: DASHSCOPE_API_KEY 未设置');
  process.exit(1);
}

/**
 * 调用通义千问API（30秒超时）
 */
async function callQwen(messages, temperature = 0.2) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify({ model: 'qwen-plus', messages, temperature }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DashScope API错误 ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

const PROMPT = `你是AI行业资讯分类器。请对下面这篇文章做一级分类并提取子标签。

${CATEGORY_RULES}

## 子标签提取
- companies：只填该新闻的当事方/主角（发布方、交易/合作双方、被报道的主体），最多3个；排除仅作为对比、竞品、基准测试、行业背景顺带提及的公司，以及仅作为被接入/被兼容/被支持对象被列举的第三方厂商——当事方判断优先于集团归并，非当事方即使能归并到某大厂也不填（如"某平台宣布接入通义千问、智谱GLM等第三方模型"只填平台方，严禁因通义千问隶属阿里巴巴而填 阿里巴巴）；一律按内容理解归并到集团/母公司规范名——子品牌/产品线/事业部/云部门/全资子公司归母公司（如 阿里云/通义→阿里巴巴，Azure/GitHub→微软，抖音/火山引擎→字节跳动），仅投资/参股关系的独立公司不归并（如 蚂蚁集团不归阿里巴巴）
- people：涉及的主要人物，业界惯用名（惯用中文用中文如黄仁勋，惯用英文用英文如Sam Altman），最多3个
- keywords：核心关键词，最多3个
- regions：仅当category为policy时填写（非政策文章一律空数组），且只填政策/监管动作的主体方——谁立法/谁监管/谁发布政策就填谁，被制裁/被针对/被影响的国家不填（如"美国对中国AI模型实施禁令"只填 美国），仅多国联合发布时才填多个；只填国家/地区级名称（如 中国、美国、欧盟、英国、日本），严禁填城市名——事件发生在某城市时写所属国（如"在伦敦启动测试"填 英国不填伦敦），无则空数组

## 输出（严格JSON，不要输出其他内容）
{"category":"...", "tags":{"companies":[],"people":[],"keywords":[],"regions":[]}, "confidence":"high|medium|low"}`;

/**
 * 分类单篇文章（重试1次）
 */
async function classifyArticle(row) {
  const context = [row.title, row.original_title, row.summary, (row.content || '').slice(0, 800)]
    .filter(Boolean).join('\n');

  const messages = [
    { role: 'system', content: '你是AI行业资讯分类器，只输出JSON格式。' },
    { role: 'user', content: `${PROMPT}\n\n## 文章\n${context.slice(0, 3000)}` },
  ];

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await callQwen(messages);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error(`返回中未找到JSON: ${response.slice(0, 100)}`);
      const result = JSON.parse(jsonMatch[0]);

      // 校验category
      if (!VALID_CATEGORIES.includes(result.category)) {
        throw new Error(`非法category: ${result.category}`);
      }
      // 校验tags四个键必须存在（没有补[]）
      const tags = {};
      for (const k of TAG_KEYS) {
        const arr = result.tags?.[k];
        tags[k] = Array.isArray(arr)
          ? [...new Set(arr.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()))].slice(0, 3)
          : [];
      }
      const confidence = ['high', 'medium', 'low'].includes(result.confidence) ? result.confidence : 'medium';
      return { id: row.id, category: result.category, tags: applyTagInvariants(result.category, tags), confidence };
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await sleep(500);
    }
  }
  const reason = lastErr.name === 'TimeoutError' ? '超时(30s)' : lastErr.message;
  return { id: row.id, error: reason };
}

/**
 * 读取已完成的jsonl结果
 */
function loadDone() {
  const done = new Map();
  if (!existsSync(RESULTS_FILE)) return done;
  for (const line of readFileSync(RESULTS_FILE, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r.id && !r.error) done.set(r.id, r);
    } catch { /* 忽略坏行 */ }
  }
  return done;
}

async function main() {
  const Database = (await import('better-sqlite3')).default;
  const dbPath = join(__dirname, '..', 'data', 'articles.db');
  const db = new Database(dbPath);

  const rows = db.prepare(
    'SELECT id, title, original_title, summary, content, category AS old_category FROM articles ORDER BY id'
  ).all();
  console.log(`全量文章: ${rows.length} 篇`);

  // 分类前分布
  const beforeDist = {};
  for (const r of rows) beforeDist[r.old_category] = (beforeDist[r.old_category] || 0) + 1;

  // 断点续跑：跳过已完成
  const done = loadDone();
  const pending = rows.filter(r => !done.has(r.id));
  console.log(`已完成: ${done.size} 条, 待处理: ${pending.length} 条, 本次上限: ${LIMIT === Infinity ? '不限' : LIMIT}`);

  // 逐条处理（每条成功立即追加jsonl）
  let processed = 0;
  let failed = 0;
  for (const row of pending) {
    if (processed >= LIMIT) break;
    const result = await classifyArticle(row);
    if (result.error) {
      failed++;
      console.error(`[FAIL] id=${row.id} ${row.title.slice(0, 30)}: ${result.error}`);
    } else {
      appendFileSync(RESULTS_FILE, JSON.stringify(result) + '\n');
      done.set(row.id, result);
      processed++;
      if (processed % 10 === 0 || processed === pending.length) {
        console.log(`进度: 本次已处理 ${processed}, 累计完成 ${done.size}/${rows.length}`);
      }
    }
    if (processed < pending.length) await sleep(1000); // 限速1秒/篇
  }

  if (done.size < rows.length) {
    console.log(`\n本轮结束（断点已保存到 ${RESULTS_FILE}），还剩 ${rows.length - done.size} 条，重跑本脚本继续`);
    db.close();
    return;
  }

  // 全部完成：事务批量UPDATE
  console.log('\n全部处理完成，事务批量入库...');
  const updateStmt = db.prepare('UPDATE articles SET category = ?, tags = ? WHERE id = ?');
  const applyAll = db.transaction(() => {
    for (const r of rows) {
      const result = done.get(r.id);
      updateStmt.run(result.category, JSON.stringify(result.tags), r.id);
    }
  });
  applyAll();
  db.close();

  // === 统计报告 ===
  const afterDist = {};
  let changed = 0;
  const noiseList = [];
  const lowList = [];
  const regionsDist = {};
  for (const r of rows) {
    const result = done.get(r.id);
    afterDist[result.category] = (afterDist[result.category] || 0) + 1;
    if (result.category !== r.old_category) changed++;
    if (result.category === 'noise') noiseList.push(`id=${r.id} ${r.title}`);
    if (result.confidence === 'low') lowList.push(`id=${r.id} [${result.category}] ${r.title}`);
    for (const region of result.tags.regions) {
      regionsDist[region] = (regionsDist[region] || 0) + 1;
    }
  }

  console.log('\n========== 重分类统计报告 ==========');
  console.log('\n【分类分布对比】');
  const allCats = [...new Set([...Object.keys(beforeDist), ...Object.keys(afterDist)])];
  for (const c of allCats) {
    console.log(`  ${c.padEnd(12)} ${beforeDist[c] || 0} -> ${afterDist[c] || 0}`);
  }
  console.log(`\n【改判】 ${changed}/${rows.length} 篇分类发生变化`);
  console.log(`\n【noise】 ${noiseList.length} 篇`);
  noiseList.forEach(s => console.log(`  ${s}`));
  console.log(`\n【confidence=low】 ${lowList.length} 篇`);
  lowList.forEach(s => console.log(`  ${s}`));
  console.log('\n【regions 分布】');
  Object.entries(regionsDist).sort((a, b) => b[1] - a[1])
    .forEach(([name, c]) => console.log(`  ${name}: ${c} 篇`));
  if (failed > 0) console.log(`\n【失败重跑】 ${failed} 条处理失败（未入jsonl，重跑会重试）`);
}

main().catch(err => {
  console.error('重分类脚本异常:', err);
  process.exit(1);
});
