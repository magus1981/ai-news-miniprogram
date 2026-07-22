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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const RESULTS_FILE = join(__dirname, 'reclassify-results.jsonl');

const VALID_CATEGORIES = ['company', 'technology', 'opensource', 'funding', 'opinion', 'policy', 'noise'];
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

## 一级分类（只选一个，按"文章最主要的价值点"判定）
- company（公司）：AI公司的商业动作——新模型/产品发布的商业维度、战略调整、高管变动、定价/API变更、签单营收、大厂AI布局
- technology（技术）：技术本身的能力推进——基准新纪录、新架构/算法/训练方法、安全对齐研究、Agent/RAG等工程范式实质进展、官方技术博客的深度技术解读
- opensource（开源）：开放权重模型发布与更新、开源框架/工具、HF/GitHub高热项目、开源协议争议。【开源特权规则：涉及开放权重/开源协议的内容优先归开源】
- funding（融资）：融资事件、并购、IPO、风投基金、算力巨额资本支出
- opinion（观点）：行业领袖言论访谈、趋势报告、技术路线争论、AI对社会影响的严肃讨论。【拿不准归观点】
- policy（政策）：各国AI立法监管、出口管制/芯片禁令、数据安全/隐私/版权法规判例、政府AI战略
- noise：与AI无实质关联的内容（噪音，不归类）

## 元规则
1. 一文一分类，按主要价值点；2. 事件主体优先；3. 开源特权；4. 拿不准归opinion；5. 明显与AI无关归noise

## 子标签提取
- companies：涉及的主要公司，通用英文名为主（如OpenAI、Google DeepMind、阿里巴巴），最多3个
- people：涉及的主要人物，业界惯用名（惯用中文用中文如黄仁勋，惯用英文用英文如Sam Altman），最多3个
- keywords：核心关键词，最多3个
- regions：仅涉及地缘/监管时填（如 中国、美国、欧盟、英国、日本），无则空数组，最多3个

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
      return { id: row.id, category: result.category, tags, confidence };
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
