/**
 * 跨期查重 v2 实验：把判重从"主题聚合"逼回"一对一指认同一次发布动作"。
 * （v1 实测失败：现行/例外C 两版都把 10-07 成批发布判成重复，理由是 A 组多条相关稿
 *   构成"同一核心事件集群"——聚合判重才是根因，例外条款在聚合面前不起作用。）
 *
 * v2 两处结构性改动：
 *   甲 判重必须一对一指认 A 组中的具体那一条，指认不出即保留；
 *   乙 明令禁止把 A 组多条稿聚合成"事件域/集群/持续进展"。
 * 输出格式也改成 pairs:[{b,a}]，这样"没有有效 a 配对的剔除"在代码层就不被采纳。
 *
 * 用法：node tests/exp-cross-dedup-v2.mjs
 */
import '../load-env.mjs';

const KEY = process.env.DASHSCOPE_API_KEY;
if (!KEY) { console.error('[ABORT] DASHSCOPE_API_KEY 未设置'); process.exit(1); }
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

const RULES_V2 = `判定标准（先做一对一指认，再判重复）：
甲. 一条B候选要判为重复，必须指名A组中**具体某一条**已发布文章与它报道的是**同一次发布动作**（同一次官宣/同一天的同一次放出/同一批产出），并在输出里给出 b 与 a 的配对。指认不出具体那一条，或只能说出"同一主体的同一研究方向/同一系列进展"，一律**不算重复，必须保留**。
乙. 严禁把A组多条报道聚合成"某个事件域/事件集群/持续冲击/同一主题的多次报道"来判重：A组里有十条相关稿，也不等于一次发布。重复只认一对一。
1. 同一主体的同一具体事件算重复（即使标题差异很大、报道角度不同或中英文不同）
2. 同一次发布动作的后续报道角度算重复：宣发造势、跟进分析、跑分解读、成本测算、战略点评。同一批产出的不同计数口径（如 722 篇手稿 / 372 个结果族、总数与子集数、中英文各报一次）属同一次发布，必须判重
3. 例外A（独立新事件，保留）：做事的主体换成另一家公司，是它自己的新动作
4. 例外B（事件出现新状态，保留）：融资传闻→正式官宣、发布→被曝重大缺陷/客户暂停/产品下架、事故→官方调查结论、当事方对争议作出正式回应
5. 例外C（新一批可数产出，保留）：你指认到的那条A稿只是**单项成果**的宣布，而候选报道的是同一主体在之后**一次性放出新一批可数产出**（论文/手稿/数据集/基准/模型/客户，给出数量级，或伴随新的机构声明）——这构成新一次发布动作，不算重复
6. 拿不准的不列入，宁漏勿错；B组完全可能一条重复都没有（这是常态而非例外），没有就返回空配对，严禁为凑结果而配对`;

const CASES = [
  {
    n: 1,
    name: 'C1 该保留（成批发布 vs 单点声明）',
    want: 'pairs 为空（指认不出同一次发布）',
    A: [
      'OpenAI宣布解决一个千禧年大奖难题',
      'OpenAI持续冲击数学界',
      'OpenAI组建独立数学家顾问小组以修复关系',
      'AI找出数学反例推翻论文，作者确认',
      'Clay Mathematics Institute says the Navier-Stokes Millennium Problem appears solved',
    ],
    B: ['OpenAI drops another batch of mathematical breakthroughs', '突发！OpenAI一次放出722篇数学成果，准黎曼猜想、4D挂谷都在列'],
  },
  {
    n: 2,
    name: 'C2 该判重（同一批的第二种计数口径）',
    want: 'pairs 含 b=1 与 b=2（均指向 a=1）',
    A: ['OpenAI drops another batch of mathematical breakthroughs'],
    B: ['OpenAI dumps 372 AI-generated math proofs on GitHub', '722篇！OpenAI一次发布大量数学成果（含372个结果族）'],
  },
  {
    n: 3,
    name: 'C3 该判重（原有能力回归）',
    want: 'pairs 含 b=1 → a=1',
    A: ['EmbeddingGemma 2：开放、轻量级的多模态嵌入模型'],
    B: ['Google claims EmbeddingGemma 2 outperforms rival embeddings in retrieval benchmarks'],
  },
];

function buildPrompt(A, B) {
  const pubList = A.map((t, i) => `[A${i + 1}] ${t}`).join('\n');
  const candList = B.map((t, i) => `[B${i + 1}] ${t}`).join('\n');
  return `A组是近期已发布的文章，B组是"待发布候选"。请找出B组中与A组某一条报道**同一次发布动作**的条目（这些候选属于旧闻重报，应剔除）。

${RULES_V2}

已发布(A组)：
${pubList}

待发布候选(B组)：
${candList}

请先对B组每条候选各用一行输出：要么"重复：与A_k同一次发布，依据条款…"，要么"保留：指认不出与A组任何一条是同一次发布（依据甲/例外…）"。
最后一行输出JSON，只列确属同一次发布的配对，元素必须是纯数字字段：{"pairs": [{"b": 1, "a": 3}]}；无重复时 pairs 为空数组。`;
}

async function ask(prompt) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'qwen-plus', temperature: 0.1,
      messages: [
        { role: 'system', content: '你是资讯查重助手。判重必须一对一指认，先逐条给结论，最后一行输出JSON。' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).choices[0].message.content;
}

function parsePairs(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const arr = Array.isArray(j.pairs) ? j.pairs : [];
    return arr.map(p => ({ b: Number(p.b), a: Number(p.a) })).filter(p => Number.isFinite(p.b) && Number.isFinite(p.a));
  } catch { return null; }
}

// ONLY=1,2,3 只跑指定用例；RUNS=N 同一用例重复跑 N 次（测温度 0.1 下的稳定性——
// 实测发现模型会"逐条结论说重复、pairs 却给空"，判据能不能上闸，要看重复跑稳不稳）
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean).map(Number);
const RUNS = Math.max(1, Number(process.env.RUNS || 1));
const picked = ONLY.length ? CASES.filter(c => ONLY.includes(c.n)) : CASES;

for (const c of picked) {
  for (let r = 1; r <= RUNS; r++) {
    console.log(`\n########## ${c.name}${RUNS > 1 ? ` [第${r}/${RUNS}次]` : ''} ##########\n期望：${c.want}`);
    let out;
    try { out = await ask(buildPrompt(c.A, c.B)); } catch (e) { console.log('调用失败:', e.message); continue; }
    const pairs = parsePairs(out);
    console.log('pairs =', JSON.stringify(pairs));
    for (const line of out.split('\n').filter(l => /B\d/.test(l)).slice(0, 4)) console.log('   ', line.trim().slice(0, 170));
  }
}
