/**
 * 常驻回归测试（LLM规则层）——真实调用AI，验证提示词规则没有相互误伤。
 * 每次运行约10次模型调用（几分钱、1-3分钟），按需执行，不进CI。
 *
 * 制度：任何修改 classify-rules.mjs 分类规则 或 TAGS_SPEC 打标规则 后必须跑本文件；
 * 新暴露的分类/打标问题修复后，把对应用例补充进来（两向：正例防漏、反例防误伤）。
 * 用例全部来自真实踩过的坑（见各用例注释）。
 *
 * 用法：node --import ../load-env.mjs tests/test-llm-rules.mjs   （在 pipeline 目录下）
 *       npm run test:llm                                        （在项目根目录）
 * 注意：DASHSCOPE_API_KEY 未设置时 generateSummary 会降级直通，测试结果无意义，
 *       故本文件在 key 缺失时直接报错退出。
 */
import { generateSummary } from '../ai-summary.mjs';
import { crossRoundDedup } from '../ai-filter.mjs';

if (!process.env.DASHSCOPE_API_KEY) {
  console.error('FATAL: DASHSCOPE_API_KEY 未设置（需 --import ../load-env.mjs 运行），退出');
  process.exit(1);
}

// 用例正文较短（<200字）时 generateSummary 会取 content_snippet，故两处都填
const A = (over) => ({ language: 'zh', source_name: '测试源', category: 'company', content_snippet: over.content, ...over });
const tagsOf = (r) => JSON.parse(r.tags);

const CASES = [
  {
    id: 'C1', desc: '平台事件不是观点（曾误入opinion的HF深度伪造类）→ company',
    article: A({
      title: '开源模型平台被曝遭滥用批量生成名人深度伪造图像',
      content: '有调查发现，某大型开源模型托管平台上的多个图像生成模型被滥用，批量生成名人深度伪造图像并在社交网络传播。平台方回应称已下架相关模型并加强内容审核策略，研究者呼吁建立更严格的模型上架审查机制。',
    }),
    check: (r) => r.category === 'company',
  },
  {
    id: 'C2', desc: '机构趋势报告是观点不是技术（曾误入technology的斯坦福HAI类）→ opinion',
    article: A({
      title: '斯坦福HAI发布年度AI指数报告：推理成本一年下降90%',
      content: '斯坦福大学以人为本AI研究院（HAI）发布年度AI指数报告，指出过去一年大模型推理成本下降约90%，开放权重模型与闭源模型的性能差距缩小到个位数百分点，企业AI采用率显著上升，报告还就AI治理与人才流动给出多项趋势判断。',
      category: 'technology',
    }),
    check: (r) => r.category === 'opinion',
  },
  {
    id: 'C3', desc: '模型发布事件归company不归technology',
    article: A({
      title: '智谱发布GLM-5：多项基准超越上一代',
      content: '智谱AI今日正式发布新一代基座模型GLM-5，官方称其在数学、代码、长文本等多项基准测试中大幅超越上一代产品，并同步开放API。定价与上一代持平，企业客户可申请专属部署。',
      category: 'technology',
    }),
    check: (r) => r.category === 'company',
  },
  {
    id: 'T1', desc: '被接入的第三方厂商不打标（曾把科大讯飞新闻挂到阿里）→ 只留发布方',
    article: A({
      title: '科大讯飞发布星火智能路由平台，支持接入通义千问、智谱GLM等第三方模型',
      content: '科大讯飞今日发布星火智能路由平台，面向企业提供多模型统一接入与治理能力，除星火大模型外还支持接入阿里巴巴通义千问、智谱GLM、DeepSeek等第三方模型，实现按任务自动路由与成本优化。',
    }),
    check: (r) => {
      const c = tagsOf(r).companies;
      return c.includes('科大讯飞') && !c.includes('阿里巴巴');
    },
  },
  {
    id: 'T2', desc: '子品牌归并母公司（淘天→阿里巴巴）',
    article: A({
      title: '阿里巴巴旗下淘天集团上线AI导购助手',
      content: '阿里巴巴旗下淘天集团宣布在淘宝App全量上线AI导购助手，基于通义大模型提供商品比价、搭配推荐与售后问答服务，首月覆盖用户预计过亿。',
    }),
    check: (r) => {
      const c = tagsOf(r).companies;
      return c.includes('阿里巴巴') && !c.some(x => x.includes('淘天'));
    },
  },
  {
    id: 'T3', desc: '对比提及的竞品不打标（基准超越谷歌只留发布方）',
    article: A({
      title: '微软发布Phi-5小模型，基准测试超越谷歌Gemma与Meta Llama同级产品',
      content: '微软今日发布Phi-5系列小参数模型，官方基准显示其在同参数量级上超越谷歌Gemma和Meta Llama的对应版本，主打端侧部署与低成本推理，即日起在Azure上提供。',
    }),
    check: (r) => {
      const c = tagsOf(r).companies;
      return c.includes('微软') && !c.includes('谷歌') && !c.includes('Meta');
    },
  },
  {
    id: 'T4', desc: '标题即对比宣称时被超越方也不打标（#501 OpenAI宣称超越Opus 5误挂Anthropic真实案例）',
    article: A({
      title: 'OpenAI声称GPT-5.6 Sol在ARC-AGI-3上超越Opus 5',
      content: 'OpenAI宣布其最新的GPT-5.6 Sol模型在ARC-AGI-3逻辑基准测试中，通过自定义的Responses API达到了38.3%的得分，超过了Anthropic的Claude Opus 5的30.2%。然而在官方测试环境中，GPT-5.6 Sol的得分仅为9.8%，因为该环境不支持保留推理和压缩功能，这一结果引发了关于测试公平性的讨论。',
    }),
    check: (r) => {
      const c = tagsOf(r).companies;
      return c.includes('OpenAI') && !c.includes('Anthropic');
    },
  },
  {
    id: 'R1', desc: '针对性政策只填主体国（美国禁令不带中国）',
    article: A({
      title: '美国计划对中国AI模型实施选择性禁令',
      content: '美国政府正在起草一项针对中国AI模型的选择性禁令方案，拟禁止联邦机构及关键基础设施部门采购和部署来自中国的大语言模型。美国商务部拒绝置评，多家美国科技公司警告过度限制可能损害开放生态。',
      category: 'policy',
    }),
    check: (r) => {
      const g = tagsOf(r).regions;
      return r.category === 'policy' && g.includes('美国') && !g.includes('中国');
    },
  },
  {
    id: 'R2', desc: '非政策文章不留国别（代码不变量兜底，城市/国别一律清空）',
    article: A({
      title: '萝卜快跑在伦敦启动右舵全无人公开道路测试',
      content: '百度旗下萝卜快跑宣布在伦敦启动右舵车型的全无人公开道路测试，这是其进入欧洲市场的第一步，首批投放30辆车，与当地监管机构合作推进安全审查。',
    }),
    check: (r) => r.category !== 'policy' ? tagsOf(r).regions.length === 0 : true,
  },
  {
    id: 'R3', desc: '多国联合发布两边都是主体',
    article: A({
      title: '美英联合签署前沿AI安全评估互认协议',
      content: '美国和英国两国政府今日联合签署前沿AI安全评估互认协议，双方的AI安全研究所将互认对方的模型安全评估结果，共享红队测试方法与风险数据库，协议自签署之日起生效。',
      category: 'policy',
    }),
    check: (r) => {
      const g = tagsOf(r).regions;
      return g.includes('美国') && g.includes('英国');
    },
  },
  {
    id: 'O1', desc: '开源特权：开放权重发布优先归opensource',
    article: A({
      title: '月之暗面开源Kimi新版基座模型权重',
      content: '月之暗面宣布开源新版Kimi基座模型的完整权重，采用宽松开源协议允许商用，同步发布训练细节技术报告，社区可在Hugging Face直接下载。',
    }),
    check: (r) => r.category === 'opensource',
  },
];

let pass = 0;
const failed = [];
for (const c of CASES) {
  try {
    const r = await generateSummary(c.article);
    const ok = c.check(r);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.id} ${c.desc} | category=${r.category} tags=${r.tags}`);
    if (ok) pass++; else failed.push(c.id);
  } catch (e) {
    console.log(`FAIL ${c.id} 异常: ${e.message}`);
    failed.push(c.id);
  }
}

// ---- 跨期查重用例（crossRoundDedup，双向：D1防漏、D2/D3防误伤）----
// 背景：2026-07-29 真实漏网——7-28已发TechCrunch"微软发布首个网络安全模型及新AI安全平台"，
// 7-29 The Decoder带CyberGym跑分的跟进报道仍被放行（旧判据"发布→首批实测数据出炉"豁免口子过松），
// 收紧为"跟进报道/跑分解读一律算重复"后，用本组用例双向锁定。
const PUBLISHED = [
  '微软发布首个网络安全模型及新AI安全平台',
  'Moonshot AI发布Kimi K3开放权重及基础设施',
];
const DEDUP_CASES = [
  {
    id: 'D1', desc: '同一发布的跟进跑分报道算重复（377vs418真实案例）→ 剔除',
    candidate: { title: '微软发布自家网络安全模型MAI-Cyber-1-Flash，仍依赖OpenAI处理复杂任务' },
    expectKept: false,
  },
  {
    id: 'D2', desc: '事件状态变化是真进展（发布→翻车下架）→ 保留',
    candidate: { title: '微软网络安全模型被曝误报率过高，部分企业客户暂停部署' },
    expectKept: true,
  },
  {
    id: 'D3', desc: '第三方适配是独立事件不算重复 → 保留',
    candidate: { title: '九章云极完成Kimi K3适配，入驻其Token工厂平台' },
    expectKept: true,
  },
];
for (const c of DEDUP_CASES) {
  try {
    const out = await crossRoundDedup([c.candidate], PUBLISHED);
    const kept = out.some(a => a.title === c.candidate.title);
    const ok = kept === c.expectKept;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.id} ${c.desc} | 实际${kept ? '保留' : '剔除'}`);
    if (ok) pass++; else failed.push(c.id);
  } catch (e) {
    console.log(`FAIL ${c.id} 异常: ${e.message}`);
    failed.push(c.id);
  }
}

const total = CASES.length + DEDUP_CASES.length;
console.log(`\n${pass}/${total} PASS${failed.length ? `，失败: ${failed.join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
