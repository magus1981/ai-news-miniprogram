/**
 * 跨期查重提示词 A/B 实验（会真调 DashScope，人工运行，不进常驻闸）
 *
 * 为什么需要它：crossRoundDedup 的判准在提示词里，纯函数闸测不到；
 * 而"成批新增可数产出算不算新事件"这种新约束，没做对照实验就写进合同＝没验证的规矩。
 *
 * 三组用例全部取自生产库真实标题：
 *   C1 该保留（正例）：A 组只有"宣布解决一个千禧年难题"这类单点声明，B 组是 10-07 成批放出
 *      722 篇手稿/372 结果族 —— 现行提示词把它判成旧闻重报（2026-10-08 实测误杀）。
 *   C2 该判重（反例·同批双口径）：A 组已是那次成批发布，B 组是同一批的另一计数口径
 *      （372 篇证明 / 722 篇手稿）—— 新提示词绝不能把它放开，否则同一次发布双进。
 *   C3 该判重（反例·原有能力回归）：EmbeddingGemma 2 已发精选，候选是同一发布的英文报道。
 *
 * 用法（在 pipeline 目录下，需 pipeline/.env 里的 DASHSCOPE_API_KEY）：
 *   node tests/exp-cross-dedup.mjs
 */
import '../load-env.mjs';

const KEY = process.env.DASHSCOPE_API_KEY;
if (!KEY) { console.error('[ABORT] DASHSCOPE_API_KEY 未设置'); process.exit(1); }
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

// —— 现行提示词的判定标准（逐字取自 main 的 crossRoundDedup）——
const RULES_NOW = `判定标准（先按1-2判是否重复，再看3-4例外，例外优先）：
1. 同一主体的同一具体事件算重复（即使标题差异很大、报道角度不同或中英文不同，如一篇"发布开放权重"一篇"开源XX参数"，只要是同一次发布，也算）
2. 同一次发布/官宣的后续报道角度都算重复：官方宣发造势（创始人站台/演示/内部使用）、跟进分析、跑分解读、成本测算、战略点评——即使补充了新数据（基准分数、价格、依赖关系），核心事件仍是那一次发布；同一次人事/组织变动的后续角度（股价影响、内部反应、接任者背景）同样算重复
3. 例外A（独立新事件，保留）：做事的主体换成了另一家公司。如已发布"A公司开源某模型"，候选是"B公司宣布完成该模型适配/接入自家平台"，这是B公司自己的新动作，不算重复
4. 例外B（事件出现新状态，保留）：事件本身发生了后续变化。如：融资传闻→正式官宣、发布→被曝重大缺陷/客户暂停使用/产品下架、事故→官方调查结论、当事方对争议作出正式回应
5. 拿不准的不要列入，宁漏勿错。B组完全可能一条重复都没有（这是常态而非例外），没有就返回空数组，严禁为了输出结果而凑数`;

// —— 待验的新提示词：新增例外C，并把"绑发布动作、不绑数字"写死，防同批双口径放开 ——
const RULES_NEW = `判定标准（先按1-2判是否重复，再看3-5例外，例外优先）：
1. 同一主体的同一具体事件算重复（即使标题差异很大、报道角度不同或中英文不同，如一篇"发布开放权重"一篇"开源XX参数"，只要是同一次发布，也算）
2. 同一次发布/官宣的后续报道角度都算重复：官方宣发造势（创始人站台/演示/内部使用）、跟进分析、跑分解读、成本测算、战略点评——即使补充了新数据（基准分数、价格、依赖关系），核心事件仍是那一次发布；同一次人事/组织变动的后续角度（股价影响、内部反应、接任者背景）同样算重复
3. 例外A（独立新事件，保留）：做事的主体换成了另一家公司。如已发布"A公司开源某模型"，候选是"B公司宣布完成该模型适配/接入自家平台"，这是B公司自己的新动作，不算重复
4. 例外B（事件出现新状态，保留）：事件本身发生了后续变化。如：融资传闻→正式官宣、发布→被曝重大缺陷/客户暂停使用/产品下架、事故→官方调查结论、当事方对争议作出正式回应
5. 例外C（新一批可数产出，保留）：已发布那篇只宣布过某一项成果或较小的一批，而候选报道的是同一主体在之后**一次性放出新一批可数产出**（论文/手稿/数据集/基准/模型/客户的规模化发布，标题或正文给出数量级、且伴随新的机构反应），这属于新一次发布动作，不算重复
   例外C 的判据绑"是否同一次发布动作"，不绑"数字是否不同"：同一批产出的不同计数口径（如 722 篇手稿 / 372 个结果族、总数与子集数、中英文各报一次）仍属同一次发布，必须判重，只保留一篇
6. 拿不准的不要列入，宁漏勿错。B组完全可能一条重复都没有（这是常态而非例外），没有就返回空数组，严禁为了输出结果而凑数`;

const CASES = [
  {
    name: 'C1 该保留（成批发布 vs 单点声明）',
    expect: 'dup 为空数组（两条候选都是新事件）',
    A: [
      'OpenAI宣布解决一个千禧年大奖难题',
      'OpenAI持续冲击数学界',
      'OpenAI组建独立数学家顾问小组以修复关系',
      'AI找出数学反例推翻论文，作者确认',
      'Clay Mathematics Institute says the Navier-Stokes Millennium Problem appears solved',
    ],
    B: [
      'OpenAI drops another batch of mathematical breakthroughs',
      '突发！OpenAI一次放出722篇数学成果，准黎曼猜想、4D挂谷都在列',
    ],
  },
  {
    name: 'C2 该判重（同一批的第二种计数口径）',
    expect: 'dup 含 1 和 2（都是同一次成批发布）',
    A: ['OpenAI drops another batch of mathematical breakthroughs'],
    B: [
      'OpenAI dumps 372 AI-generated math proofs on GitHub',
      '722篇！OpenAI一次发布大量数学成果（含372个结果族）',
    ],
  },
  {
    name: 'C3 该判重（原有能力回归）',
    expect: 'dup 含 1（同一发布的英文报道）',
    A: ['EmbeddingGemma 2：开放、轻量级的多模态嵌入模型'],
    B: ['Google claims EmbeddingGemma 2 outperforms rival embeddings in retrieval benchmarks'],
  },
];

function buildPrompt(rules, A, B) {
  const pubList = A.map((t, i) => `[A${i + 1}] ${t}`).join('\n');
  const candList = B.map((t, i) => `[B${i + 1}] ${t}`).join('\n');
  return `A组是近期已发布的文章，B组是"待发布候选"。请找出B组中与A组报道同一核心事件的条目（这些候选属于旧闻重报，应剔除）。

${rules}

已发布(A组)：
${pubList}

待发布候选(B组)：
${candList}

请先对B组每条候选各用一行简述判定结论与依据的条款号（这一步是判准的关键，不可省略），
最后一行输出JSON，dup数组元素必须是纯数字（B组编号的数字部分，严禁带"B"前缀），无重复时dup为空数组：
{"dup": [1, 3]}`;
}

async function ask(prompt) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'qwen-plus',
      temperature: 0.1,
      messages: [
        { role: 'system', content: '你是资讯查重助手，先逐条给出判定理由，最后一行输出JSON。' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

function parseDup(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return Array.isArray(j.dup) ? j.dup.map(Number).filter(Number.isFinite) : [];
  } catch { return null; }
}

const variants = [['现行', RULES_NOW], ['加例外C', RULES_NEW]];
const tally = {};
for (const c of CASES) {
  console.log(`\n########## ${c.name} ##########`);
  console.log(`期望：${c.expect}`);
  console.log(`A组: ${c.A.length} 条 | B组候选: ${c.B.map((x, i) => `B${i + 1}=${x.slice(0, 30)}`).join(' ; ')}`);
  for (const [label, rules] of variants) {
    let out;
    try { out = await ask(buildPrompt(rules, c.A, c.B)); }
    catch (e) { console.log(`  【${label}】调用失败: ${e.message}`); continue; }
    const dup = parseDup(out);
    const reasonLines = out.split('\n').filter(l => /B\d/.test(l)).slice(0, 4);
    const key = `${label}|${c.name.slice(0, 2)}`;
    tally[key] = dup;
    console.log(`  【${label}】dup = ${JSON.stringify(dup)}`);
    for (const r of reasonLines) console.log(`       ${r.trim().slice(0, 150)}`);
  }
}

console.log('\n=========== 结论对照 ===========');
console.log('C1 现行应为 [1,2]（复现误杀），加例外C 应为 []（放开新事件）');
console.log('C2 两版都应为 [1,2]（新提示词不得放开同批口径）');
console.log('C3 两版都应含 1（不得因新增例外C 退化）');
