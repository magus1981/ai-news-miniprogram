/**
 * AI筛选评分 - 调用通义千问(DashScope)对文章进行重要性评分
 * 标准：权威性、准确性、及时性
 */

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
// 评分是产品灵魂且每天仅3次调用，用旗舰模型qwen-max换判断力（成本增量可忽略）；
// 查重环节保持qwen-plus——判据刚用真实案例校准过（test:llm 13/13），换模型等于校准作废
const SCORING_MODEL = process.env.SCORING_MODEL || 'qwen-max';
// 单次评分批量上限：一次给上百篇打分会让输出过长而超时（2026-07-30事故根因），
// 且长清单会让模型放弃逐篇判断、改按来源档次批发分数
const SCORING_BATCH_SIZE = Number(process.env.SCORING_BATCH_SIZE) || 40;
// 旧闻对照窗口：产品是否"新"要看更长的历史。3天太短——GPT-5.6在9天前就已被报道过，
// 却因超出窗口被当成今日新发布（2026-07-30事故），故拉长到10天
export const RECENT_TITLE_DAYS = 10;
// 精评候选数：比日配额(20)宽一档，给阶段1粗排的误差留缓冲——
// 粗排偶尔把好文章排到20名外，留30条候选让阶段2有机会把它捞回来
const REFINE_CANDIDATES = Number(process.env.REFINE_CANDIDATES) || 30;

/**
 * 分数档位语义。没有语义定义时模型只能猜，写再多档位描述都没用：
 * 2026-07-30 的两种失败都源于此——旧的单一总分制把官方博客一律推到90+（通胀且与真实重要性错配，
 * 「某厂商适配Kimi K3」97分 > 「Kimi K3发布」89分），新的子分求和制则让三个维度各取中值、
 * 总分收敛到60-75的窄带（12篇只有4种分数）。多维求和在数学上必然抹平方差，故总分改由模型在锚点约束下直接给。
 */
export const SCORE_BANDS = `- 90-100 改变行业格局，全行业从业者都必须知道。一天0-1条，多数天为0条
- 80-89  重要进展，影响某个细分赛道的走向。一天0-3条
- 70-79  值得知道：有硬事实，但影响面限于特定人群
- 60-69  可看：正常的行业消息、研究成果、榜单
- 40-59  边缘：软文、厂商客户案例、行业评论、小功能更新
- 0-39   不值得收录`;

/**
 * 评分锚点（人工标定，2026-07-30 与用户逐条确认）。
 * LLM绝对打分对锚点极其敏感，而对文字档位描述几乎不敏感——这是同时治"通胀"和"紧缩"的唯一可靠手段。
 * 锚点分数一律重标，不沿用库里的历史分数：历史分数本身就是错的（同事件两篇并列95档、软文92分）。
 * 维护提示：锚点是这套评分的标尺，改动等于改变全站分数口径，务必与用户确认后再动。
 */
export const SCORE_ANCHORS = [
  { score: 92, title: 'Moonshot AI发布Kimi K3开放权重及基础设施', why: '全球首个开源3万亿参数级模型发布，改写开源格局' },
  { score: 88, title: '沉寂两年后，Ilya创办的SSI获英伟达50亿美元投资', why: '顶级人物+超大额资本，但尚未改变行业格局' },
  { score: 85, title: 'AMD豪掷50亿美元锁定Anthropic，2GW MI450 GPU支撑Claude算力', why: '双巨头算力协议，金额与规模都是硬事实' },
  { score: 83, title: 'Anthropic Claude将黎曼ζ函数满足猜想的零点比例下界从41.6%提升至67.2%', why: 'AI在世界级数学难题上取得实质性突破，附Lean形式化证明与外部数论专家审查——重大科研里程碑，硬事实+全行业关注度，不与普通学术成果同归"可看"档（2026-08-11 曾因此被误压在70分线外漏收）' },
  { score: 82, title: '特朗普政府禁止进口外国制造的人形机器人', why: '国家级政策落地，直接冲击产业链' },
  { score: 82, title: '月之暗面完成35亿美元融资，估值达350亿美元', why: '头部模型公司超大额融资，改变细分赛道格局' },
  { score: 76, title: '谷歌AI搜索占比一年内从15%升至43%', why: '硬数据反映用户行为的根本变化，但不是单一事件' },
  { score: 72, title: '萝卜快跑在伦敦启动右舵全无人公开道路测试', why: '中国无人车首进英国，具体里程碑' },
  { score: 64, title: '清华团队提出AI「失控行为预测框架」', why: '学术成果，跟进热点，影响面限于研究者' },
  { score: 63, title: 'OpenAI公布GPT-5.6系列多项工程优化（推理降本20%、提速15%），预告新硬件并称用户破10亿', why: '把已发布模型的后续工程优化/周边动态打包成综合稿、并挂旧模型名做抓眼标题——按其中最强的真实新事件定档，无重大新事件则属"可看"（反向锚点，此条历史误判为77分）' },
  { score: 62, title: '阿里云真武超节点Day0适配Kimi K3大模型', why: '厂商适配/性能宣传稿——数据再详实也不是大新闻（反向锚点，此条历史误判为97分）' },
  { score: 60, title: '搜索智能体也需要「操作系统」：SearchOS 开源多智能体协作框架', why: '开源工具，受众小众' },
  { score: 52, title: '微软正前所未有地公开与OpenAI、Anthropic竞争（据其季度财报900亿美元收入与持股关系解读）', why: '以财报数字/持股关系为由头的竞争格局解读稿——结论全是记者推演，无具体新事件、无AI技术增量，属边缘（反向锚点，此条历史误判为70分）' },
  { score: 50, title: 'Visa利用Claude检测支付网络漏洞并开源安全工具', why: '厂商客户案例，有规模数据但属于背书' },
  { score: 48, title: '小米发布智能可变大空间SUV（增程N90/N70 Max，顶配29.99万）', why: '车企/消费硬件发布会，只有"智能/AI"营销点、无实质AI技术增量——属边缘不入日报（反向锚点，此条历史误判为60分入列）' },
  { score: 45, title: 'OpenAI博客《新闻机构正借力AI强化核心使命》', why: '行业观察软文，无硬事实、无新闻增量' },
];

/**
 * 精评档位表（档位优先+档内拉开）。
 * 2026-07-30 复盘：即使有锚点，模型仍把30条候选里的15条批发成同一个82分——
 * 让模型直接给0-100分数就治不了扎堆。故改为模型只输出「档位（绝对判断）+全局严格排名（相对判断）」，
 * 分数由代码合成：高档位有硬配额（与 SCORE_BANDS 的"一天0-1条/0-3条"同口径），超配的按排名末位降档；
 * 档内按名次在区间里拉开，机制上杜绝同分批发。
 * 重磅上限取94而非100：留白防通胀，锚点最高也只有92（Kimi K3 改写开源格局）。
 * 档位名与 scoreBandLabel / 前台 fmt.wxs 同口径。
 */
export const REFINE_TIERS = [
  { key: '重磅', min: 90, max: 94, quota: 1 },
  { key: '重要', min: 80, max: 89, quota: 3 },
  { key: '值得看', min: 70, max: 79, quota: Infinity },
  { key: '可看', min: 60, max: 69, quota: Infinity },
  { key: '边缘', min: 40, max: 59, quota: Infinity },
];

/**
 * 衍生报道分数上限。
 * 「他人已发布的产品/事件」的跟随性报道（第三方适配、榜单转述、评论表态、媒体复述），
 * 其重要性天花板本就低于当事方的首发新闻。用一个硬上限同时解决同批与跨天两种情况——
 * 跨天场景无法靠"和同簇主稿比分数"解决（主稿在昨天的库里，不在本轮名单内），
 * 而 2026-07-29 的「阿里云适配Kimi K3」97分正是跨天衍生稿压过前一天主稿的实例。
 * 定在72（"值得知道"档顶）意味着衍生稿永远进不了精选。
 */
export const DERIVATIVE_SCORE_CEILING = 72;

/**
 * 精选分数门槛。按档位口径，80分是"重要"档底——只有影响细分赛道走向的进展才配称"今日必读"。
 * 2026-07-30 用户质疑"65分就能进精选"，根因是首轮硬凑3条（原 featuredCap 用 Math.max(3, ...)），
 * 分数不够也要凑满，精选于是退化为"当日Top3"而与质量脱钩。改为够门槛才给，宁缺毋滥。
 * 后改为80（原75）：改成档位制后分数不再可能虚高，但“值得看”档顶的79分依旧能过线——
 * 当日复跑里一篇79分的融资稿就进了精选，而它根本不是全行业必读。
 * 门槛与档位对齐后的含义：精选必为“重要”档以上，安静的日子就只有1-2条甚至0条。
 * 与 DERIVATIVE_SCORE_CEILING(72) 配合，衍生稿在制度上永远进不了精选。
 */
export const FEATURED_MIN_SCORE = 80;

/**
 * 标题近重复合并阈值（二元组Dice，规范化标题）。
 * 全库823组「同日两两标题」实测：>=0.55 的只有3对，且3对全是真重复、全都发出去了——
 * 百度Agent登顶两稿0.708、Trump机器人禁令两稿0.683、Jack Dorsey发布Buzz两稿0.590，零误伤。
 * 而事件名层的0.72一对都抓不到：它比的是AI给的事件名，不是标题。
 * 调阈值前请用 tmp-sim.mjs 复跑这份实测，别凭感觉动。
 */
export const TITLE_DUP_THRESHOLD = 0.55;

/**
 * 把一个时间戳（ISO串/可解析日期）归为“北京时间的自然日” YYYY-MM-DD。
 * 归日一律按发布日而非采集日（2026-07-30 用户反馈：昨天中午的新闻不该出现在今天页），
 * 而 published_at 存的是 UTC，直接 slice 会在北京凌晨 0-8 点的文章上差一天，故先 +8h 再取日。
 * 无日期/解析失败时用当前时间兜底（与 collect.mjs normalizePublishedAt 的兜底一致）。
 */
export function beijingDayKey(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  const base = Number.isFinite(t) ? t : Date.now();
  return new Date(base + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 参与标题近重复比对的最短长度（规范化后字符数）。
 * 短标题上纯字面相似度会误判：「苹果发布新款Mac」vs「苹果发布新款iPad」规范化后Dice=0.59，
 * 明明是两次不同发布却会被并掉。三对真漏例规范化后都在30字以上，
 * 故短标题一律不由代码硬并，留给AI查重层判断。
 */
const TITLE_DUP_MIN_LEN = 16;

if (!DASHSCOPE_API_KEY) {
  console.warn('警告: DASHSCOPE_API_KEY 未设置，AI筛选将使用降级策略（按来源权重排序）');
}

/**
 * 调用通义千问API
 */
async function callQwen(messages, temperature = 0.3, model = 'qwen-plus') {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
    }),
    signal: AbortSignal.timeout(120000), // 120秒超时：需对全部采集文章评分+事件标注，输出长，30秒不够用
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DashScope API错误 ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

/**
 * 对一批文章进行AI评分筛选（含事件聚类去重）
 * 制度性保障：
 * 1. AI为每篇文章标注事件簇(event_id)，代码强制同一事件只保留一篇（主稿优先，见 pickKept）——
 *    即使AI打分再高，重复事件也进不了列表，从机制上杜绝"3篇精选都是同一事件"
 * 2. 传入近RECENT_TITLE_DAYS天已入库标题作为对照：一是让旧闻重报/跟进报道被判为 follow|retro 并在精评中降分，二是喂给第四层跨期查重强制剔除旧闻重报
 * 3. 归日按“发布北京日”（非采集日）：一轮采集的文章可能跨多个发布日，“每日10-20条/精选5条”日配额按发布日分别结算（见 selectByQuota/markFeatured）
 * @param {Array} articles - 采集到的原始文章列表
 * @param {Array<string>} recentTitles - 近RECENT_TITLE_DAYS天已入库文章标题（判定新闻性以压低旧闻分 + 第四层跨期查重）
 * @param {Object<string,{existingCount:number, existingFeatured:number, featuredMinScore?:number}>} dayContexts - 按发布日(YYYY-MM-DD)的已入库数/精选数/精选最低分；缺失的日按首轮(0)处理
 * @param {number} [now] - 可注入时钟（供测试/突发新鲜度判定）
 * @returns {Array} - 带评分与 date_key(发布北京日) 的文章，按分数降序
 */
export async function filterArticles(articles, recentTitles = [], dayContexts = {}, now = Date.now()) {
  if (articles.length === 0) return [];

  // 无API Key时直接使用降级策略
  if (!DASHSCOPE_API_KEY) {
    return fallbackFilter(articles, dayContexts);
  }

  const recentBlock = recentTitles.length
    ? `\n近${RECENT_TITLE_DAYS}天已推送过的文章标题（判定novelty与旧闻的唯一依据，务必逐条比对产品名/事件主体）：\n${recentTitles.slice(0, 120).map(t => `- ${t}`).join('\n')}\n`
    : '';

  // 分批评分：每批独立调用+独立重试，单批失败只损失该批，不再整轮跌入降级
  const batches = [];
  for (let i = 0; i < articles.length; i += SCORING_BATCH_SIZE) {
    batches.push({ offset: i, items: articles.slice(i, i + SCORING_BATCH_SIZE) });
  }
  if (batches.length > 1) {
    console.log(`  分批评分: ${articles.length}条 -> ${batches.length}批（每批最多${SCORING_BATCH_SIZE}条）`);
  }

  const rawScores = [];
  let failedBatches = 0;
  for (const [bi, batch] of batches.entries()) {
    const part = await scoreBatch(batch.items, recentBlock, bi + 1, batches.length);
    if (!part) {
      failedBatches++;
      continue;
    }
    // 批内index是1-based局部编号，换算成全局下标
    for (const s of part) {
      const gi = batch.offset + (Number(s.index) - 1);
      if (gi >= 0 && gi < articles.length) rawScores.push({ ...s, _gi: gi });
    }
  }
  // 只有全部批次都失败才整轮降级：降级无AI评分、无事件去重、无旧闻识别，是最后手段
  if (!rawScores.length) {
    console.error('[ALERT] AI评分全部批次失败，落入降级策略：分数仅来自来源权重，无事件去重与旧闻识别，本轮质量不可信，务必人工复核');
    return fallbackFilter(articles, dayContexts);
  }
  if (failedBatches > 0) {
    console.warn(`  [WARN] ${failedBatches}/${batches.length} 批评分失败，该批文章本轮不参与入选`);
  }

  try {
    // 调试模式：打印子分明细与事件聚类结果，便于排查误聚类/误低分
    if (process.env.DEBUG_FILTER) {
      for (const s of rawScores) {
        const t = articles[s._gi]?.title || '(无效索引)';
        console.log(`  [DEBUG] 粗排${s.impact + s.facts + s.novelty}分 | ${s.newsness || '?'} | ${s.role || '?'} | event=${s.event} | ${t.slice(0, 50)}`);
      }
    }
    const scoredArticles = rawScores
      .map(s => {
        const detail = normalizeSubScores(s);
        return {
          ...articles[s._gi],
          ai_score: detail.score, // 粗排分，会被阶段2精评覆盖
          score_detail: JSON.stringify(detail),
          event_key: (typeof s.event === 'string' && s.event.trim()) || `__solo_${s._gi + 1}`,
          newsness: ['fresh', 'follow', 'retro'].includes(s.newsness) ? s.newsness : 'fresh',
          // role 后续无法重算，缺失时归为 primary（宁可不压也不误压主稿）
          role: s.role === 'derivative' ? 'derivative' : 'primary',
        };
      })
      .filter(a => a.ai_score && a.title) // 移除无效索引
      .sort((a, b) => b.ai_score - a.ai_score);

    // 事件级去重（代码强制）：同一事件簇只保留一篇，且主稿优先于衍生稿（见 pickKept）；
    // 被剔除报道的标题保留在 related_titles 上，供后续摘要生成做多源事实校对（如公司归属）
    // 模糊归并：AI对同一事件偶尔给出略有差异的事件名（如"全球首个大规模X发布"vs"全球首个X发布"），
    // 精确字符串匹配会漏并簇导致同事件重复入选甚至双双进精选，
    // 故规范化后按包含关系/二元组相似度(Dice>=0.72)归并到先出现（分数更高）的事件簇
    const byEvent = new Map();
    const canonicalKeys = []; // [{norm, key}]
    let dupDropped = 0;
    for (const a of scoredArticles) {
      let key = a.event_key;
      // 归一化事件名要落库（event_norm），供详情页"此前相关报道"识别同一事件的前情。
      // __solo_N 是按批内下标生成的占位键，跨轮次会撞车，一律不落库。
      let norm = '';
      if (!key.startsWith('__solo_')) {
        norm = normalizeEventName(key);
        const hit = canonicalKeys.find(c =>
          c.norm === norm || c.norm.includes(norm) || norm.includes(c.norm) || diceSimilarity(c.norm, norm) >= 0.72
        );
        if (hit) {
          key = hit.key;
          norm = hit.norm; // 用簇内首现者的归一化名做标准名，保证同簇跨轮落库值一致
        } else {
          canonicalKeys.push({ norm, key });
        }
      }
      a.event_norm = norm;
      const kept = byEvent.get(key);
      if (kept) {
        // 主稿优先：若新来的是主稿而已保留的是衍生稿，则换人——否则衍生稿粗排分更高时
        // 会把主新闻吐掉，只剩下「某厂商适配了它」这种配角稿代表整个事件
        const [winner, loser] = pickKept(kept, a);
        if (winner !== kept) byEvent.set(key, winner);
        mergeIntoKept(winner, loser);
        dupDropped++;
        continue;
      }
      a.related_titles = [];
      byEvent.set(key, a);
    }
    const deduped = [...byEvent.values()].sort((a, b) => b.ai_score - a.ai_score);
    if (dupDropped > 0) {
      console.log(`事件去重: 剔除同事件重复报道 ${dupDropped} 条（标题与素材保留供合并成一条）`);
    }

    // 第二层·标题近重复（代码强制）：上一层比的是AI给的事件名，AI一旦对同一件事给出两个不同事件名就漏并；
    // 这里直接比标题字面，把「同一件事被两家媒体用几乎相同措辞报道」兜住（见 mergeNearDupTitles）。
    // 放在精评之前：否则重复篇会白占精评名额，把真正的候选挤出 REFINE_CANDIDATES 之外。
    const nearDup = mergeNearDupTitles(deduped);
    if (nearDup.dropped > 0) {
      console.log(`标题近重复: 剔除字面高度重合的同事件报道 ${nearDup.dropped} 条`);
    }
    
    // 阶段2 精评：对去重后的前REFINE_CANDIDATES条做一次统一调用重定名次。
    // 分批粗排的致命伤是批间不可比（每批各一把尺，却跨批取Top几条进精选），
    // 一次全局精评把标尺统一；模型只出档位+排名，分数由代码按 REFINE_TIERS 合成（防同分批发）。
    const candidates = nearDup.list.slice(0, REFINE_CANDIDATES);
    const refined = await refineScores(candidates, recentBlock);
    if (!refined) {
      console.warn('  [WARN] 全局精评失败，本轮回退用分批粗排分：批间尺度不一致且分数偏紧缩，精选可信度下降');
    }
    applyRoleCeiling(candidates);
    candidates.sort((a, b) => b.ai_score - a.ai_score);
    
    // 候选分数全量打印：入选名单只是「候选取前20、再被查重砍掉几条」之后的幸存者，
    // 用幸存者的分布去判断模型有没有用满量程是量错了对象（2026-07-30 复盘教训：
    // 当日可见的15条全在70-82，但底部候选的分数根本没落盘，无法区分「模型保守」和「当天本就没大新闻」）。
    // 要判断锚点该不该动，必须先看得见低分档到底有没有被使用。
    if (candidates.length) {
      const bands = new Map();
      for (const a of candidates) {
        const b = scoreBandLabel(a.ai_score);
        bands.set(b, (bands.get(b) || 0) + 1);
      }
      console.log(`候选分布(${candidates.length}条${refined ? '，精评' : '，粗排降级'}): ${candidates.map(a => a.ai_score).join(',')}`);
      console.log(`  档位: ${[...bands].map(([b, n]) => `${b}=${n}`).join(' ')}`);
    }
    
    // 取文章：制度性数量保障——AI只负责排序，数量与日配额由代码控制（见 selectByQuota）。
    // 归日按“发布北京日”：一轮候选可能跨多天，各天用各自的已入库数独立取配额——
    // 否则昨天补采的旧闻会挤占今天的名额，或今天的新闻被昨天的余额误放行。
    // date_key 就地打在候选上，后续入库沿用，无需再从 published_at 重算。
    const byDayCand = new Map();
    for (const a of candidates) {
      a.date_key = beijingDayKey(a.published_at);
      if (!byDayCand.has(a.date_key)) byDayCand.set(a.date_key, []);
      byDayCand.get(a.date_key).push(a); // candidates 已按分降序，分桶后各日仍保持降序
    }
    let selected = [];
    for (const [dk, list] of byDayCand) {
      const ctx = dayContexts[dk] || {};
      selected.push(...selectByQuota(list, ctx.existingCount || 0));
    }
    selected.sort((a, b) => b.ai_score - a.ai_score);

    // 政策保底配额（2026-08-12 修复）：政策类文章在AI评分中系统性低分，正常配额下几乎永远进不了
    // 每日10-20条——12个新政策源（发改委/省市/日韩/中东）实测全部被科技融资新闻挤出。
    // 给政策维度每日保底 POLICY_QUOTA_PER_DAY 条：当天政策稿入选不足时，按分数从高到低补入，
    // 仅在当日总数未达日上限时补（不挤占科技新闻名额）；进精选仍走 markFeatured 统一标尺。
    // 2026-08-12 晚抽查发现保底未生效：原实现只扫精评Top-30候选池（byDayCand），而政策稿
    // AI评分系统性低分（当日12个政策源全抓到原始稿、候选池最低40分仍无一政策稿），保底循环
    // 永远找不到政策文章。改为从"当日全量去重稿件"（byDayFull，含候选池外的低分政策稿）补入：
    // 池内Top-30稿已被精评定分、其余用分批粗评分——政策维度只取当日最高分的几条，粗分序足够可靠；
    // 补入稿仍走后续跨期查重、AI总结与AI时效校验，旧闻安全网不变。
    const byDaySelected = new Map();
    for (const a of selected) {
      const dk = a.date_key || beijingDayKey(a.published_at);
      if (!byDaySelected.has(dk)) byDaySelected.set(dk, []);
      byDaySelected.get(dk).push(a);
    }
    const byDayFull = new Map();
    for (const a of nearDup.list) {
      const dk = beijingDayKey(a.published_at);
      if (!byDayFull.has(dk)) byDayFull.set(dk, []);
      byDayFull.get(dk).push(a);
    }
    const policyPicks = policyQuotaPicks(byDayFull, byDaySelected, dayContexts);
    if (policyPicks.length) {
      for (const a of policyPicks) a.date_key = beijingDayKey(a.published_at); // 候选池外的稿补打日期键
      selected.push(...policyPicks);
      selected.sort((a, b) => b.ai_score - a.ai_score);
    }
    
    // 终审查重安全网（制度性保障第三层）：首轮聚类靠"全量文章一次性打分+事件命名"，
    // 文章多时AI偶尔对同一事件给出无法模糊归并的两个事件名
    // （如一篇带型号"MAI-Cyber-1-Flash"一篇只说"网络安全模型"），
    // 入选名单仅10-20条，用一次专门的查重调用兜底，代价小、可靠性高。跨天名单一起查，同事件跨天重报也能兜住
    selected = await finalDedupePass(selected);

    // 跨期查重（制度性保障第四层）：入选文章写库前，与"近期已发布文章（当日+近RECENT_TITLE_DAYS天）"做同事件比对。
    // 同轮查重(finalDedupePass)只看本轮名单，看不到已入库文章；而"已推送标题→压低旧闻分"是软约束，
    // AI偶尔漏判（如昨天"发布开放权重"vs今天"开源2.8万亿"同事件不同标题，被重新打高分甚至进精选）。
    // recentTitles 已含当日及近期各发布日的标题，跨发布日通用，故直接用它做对照。
    const priorTitles = [...new Set(Array.isArray(recentTitles) ? recentTitles : [])].filter(Boolean);
    if (priorTitles.length) {
      selected = await crossRoundDedup(selected, priorTitles);
      if (selected.length === 0) {
        console.log('AI筛选完成: 入选文章均与近期已发布重复，本轮无新增');
        return [];
      }
    }

    // 塌缩检测放在最终名单上（全名单口径，仅告警）：档位制下分数由代码按档+名次合成，
    // 跨发布日同分属结构性巧合而非模型偷懒，这里的告警对降级/粗排路径仍有意义，误报无害。
    const collapse = detectScoreCollapse(selected);
    if (collapse) {
      console.warn(`  [ALERT] 评分塌缩: 入选名单 ${collapse.count}/${collapse.total} 篇同为 ${collapse.score} 分，模型可能未逐篇对比标尺，精选可信度下降`);
    }

    // 精选标记：日级预算最多5条，同样按发布日分别结算（各日用各自已精选数/最低分）。
    // 今天首轮(existingCount=0)按25%给；昨天多为增量(existingCount>0)，预算=5-已精选且需>=80，不会被补采稿灌满。
    const byDaySel = new Map();
    for (const a of selected) {
      const dk = a.date_key || beijingDayKey(a.published_at);
      if (!byDaySel.has(dk)) byDaySel.set(dk, []);
      byDaySel.get(dk).push(a);
    }
    let featuredMarked = 0;
    const dayNotes = [];
    for (const [dk, list] of byDaySel) {
      const ctx = dayContexts[dk] || {};
      featuredMarked += markFeatured(list, {
        existingCount: ctx.existingCount || 0,
        existingFeatured: ctx.existingFeatured || 0,
        featuredMinScore: ctx.featuredMinScore || 0,
        now,
      });
      dayNotes.push(`${dk}:${list.length}条${(ctx.existingCount || 0) > 0 ? `(增量,已有${ctx.existingCount})` : ''}`);
    }

    console.log(`AI筛选完成: ${articles.length}条 -> ${selected.length}条入选, ${featuredMarked}条精选 | 按发布日 ${dayNotes.join(' ')}`);
    return selected;

  } catch (err) {
    console.error('AI筛选结果处理失败，使用降级策略:', err.message);
    return fallbackFilter(articles, dayContexts);
  }
}

/**
 * 单批粗排：返回原始评分数组（含批内局部index），失败返回 null 由调用方决定降级范围。
 * 这一阶的分数只用于粗排取候选，不入库——最终分数一律由阶段2 refineScores 带锚点重给。
 * 因此本阶子分求和带来的“分数向中值收敛”不影响最终结果，只需保证相对高低大体正确；
 * 真正重要的输出是 event（事件聚类）、newsness（新闻性）、role（主稿/衍生稿）——这三项后续无法重算。
 * @param {Array} items - 本批文章
 * @param {string} recentBlock - 近期已推送标题对照块
 * @param {number} batchNo - 批次序号（日志用）
 * @param {number} batchTotal - 批次总数（日志用）
 */
async function scoreBatch(items, recentBlock, batchNo, batchTotal) {
  const articleList = items.map((a, i) =>
    `[${i + 1}] 来源:${a.source_name} | 标题:${a.title} | 摘要:${(a.content_snippet || '').slice(0, 400)}`
  ).join('\n');

  const prompt = `你是一位资深AI行业分析师。请对以下AI资讯逐篇评分，并做事件聚类。

评分方法：每篇必须分别给出三个子分（总分由程序求和，你不需要算总分）：
- impact 影响面(0-40)：改变行业格局/影响主要玩家=32-40；影响大量开发者或用户=22-31；影响单一产品的用户=12-21；小圈子玩具/边角功能=0-11
- facts 事实密度(0-30)：多个可验证硬事实（具体数字、基准成绩、价格、时间、规模）=22-30；有少量具体事实=12-21；基本只有定性表述=5-11；纯营销话术/标题党=0-4
- novelty 新闻增量(0-30)：全新事件且信息此前未知=22-30；已知事件的实质新进展（新数据/新决定）=12-21；已知事件的重复报道或换角度复述=3-11；旧事回顾/科普/盘点=0-2

评分约束：
- 必须逐篇独立判断。严禁按来源档次批发分数（如把所有官方博客统一给高分、把所有媒体稿统一给中等分）；
  官方博客同样可能是边角小功能（impact应很低），媒体稿同样可能是重大独家（impact应很高）
- 两篇价值确实相当时允许得出相同总分，但必须是逐篇算出来的，不得为省事而套用同一组子分
- 国内信息保障：国内头部公司（阿里/通义、字节/豆包、腾讯、华为、百度、DeepSeek、月之暗面/Kimi、智谱等）的实质性进展（发布/开源/重大合作/芯片算力），impact不得低于同级别海外事件，不得因"中文媒体转述而非官方一手"被系统性压分

旧闻硬判定（优先于其他判断，依据下方"近期已推送标题"）：
- 若文章讲的产品/模型/事件已出现在已推送标题中，说明它不是新东西：novelty 不得超过 11，newsness 必须是 follow 或 retro
- 发布/推出/亮相类文章，若其产品名此前已被推送过（哪怕只是他人的评测、对比、榜单报道），该产品就不是今天的新发布，而是官方回顾/营销稿：novelty 不得超过 5，newsness = retro

事件聚类规则：
- 报道同一核心事件的文章（如多家媒体报道同一模型发布），必须标注相同的event字符串（用事件的简短中文名，如"Claude Opus 5发布"）
- 同一主体同期围绕同一产品/事件连发的多篇文章，必须标注同一event：主发布公告、技术细节、API/参数说明、基准成绩、配套工具、高管站台演示——这些都是同一波官方宣发的不同篇目（如OpenAI同日发"GPT-X发布"+"两个API设置提升GPT-X基准成绩"，是同一event）
- event命名必须是"主体+核心动作"的短语，不超过15字，严禁附加角度/评论/从句（正确："微软发布MAI-Cyber-1-Flash"；错误："微软发布MAI-Cyber-1-Flash并披露其与OpenAI协同架构"），否则同一事件会因命名差异被误判为两个事件
- 聚类要保守：只有"同一主体的同一具体事件"才算同一event。主题相关但事件不同的必须分开，例如：A公司发生事故 与 B公司高管对此事发表评论，是两个不同事件

新闻性判定（newsness，每篇必填）：区分"文章发布时间"与"事件发生时间"，媒体今天发的文章完全可能写的是旧事：
- "fresh"：报道的是今天/近1-2天新发生的事件（发布、融资、政策、事故等）
- "follow"：近期事件的新进展、新回应、新数据
- "retro"：旧事件/旧研究的回顾、重读、解读、盘点、科普、编译（标题常含"重新审视/回顾/盘点/那些年"等特征，或内容主体是数月前乃至更早的工作）
深度观点/思想性内容（大师访谈、重要人物长文）虽属retro但有精读价值，impact与facts可正常给分

时间线索硬规则（2026-08-12 事故修复：新智元把7/31发布的Seedance 2.5和8/2启动的Anthropic水印当新稿上报入库）：
- 必须从摘要/内容中提取"核心新闻事件"（新闻由头）的发生时间再判newsness，不能只看标题和文章发布日期
- 内容明确给出事件日期（如"从8月2日起""X月X日宣布""自X日起"），且该日期早于文章发布日2天以上 → 该文是旧闻或跟进：newsness=retro或follow，novelty不得超过11（纯回顾/复述无新进展时不得超过5）
- "近日/日前/近期/最近"等模糊时间词：不得作为判fresh的依据；事件日期无法从内容确定时，若事件主体已出现在"近期已推送标题"中，一律follow/retro
- 文中更早的日期若是背景铺垫、历史回顾、引用旧数据，而非本次报道的由头，不算事件发生时间（如"欧盟2024年通过AI法案"是背景，不是由头）

主稿/衍生稿判定（role，每篇必填）：判据是"这条新闻如果没有另一条主新闻就不成立"：
- "primary"：当事方自己宣布/发布/被披露的原始事件，以及首次发布自己研究成果或数据的机构（如某安全研究所发布自做的模型评测报告、某数据公司发布自有统计）
- "derivative"：围绕他人已发布的产品/事件的跟随性报道——第三方对他家产品的适配/接入/上架、对他家已发布产品的榜单排名转述、对他人事件的评论/回应/表态、媒体对已知事件的复述与编译
判例（必读）："某公司发布X模型"=primary；"某云厂商完成对X模型的适配并公布性能数据"=derivative（就算带详实的时延/吞吐数字也是）；"X模型登顶某榜单"=derivative；"某CEO回应开放权重争议"=derivative
${recentBlock}
请严格按以下JSON格式返回，不要添加其他内容：
{"scores": [{"index": 1, "impact": 34, "facts": 26, "novelty": 25, "event": "Claude Opus 5发布", "newsness": "fresh", "role": "primary"}, {"index": 2, "impact": 20, "facts": 14, "novelty": 8, "event": "欧盟AI法案实施", "newsness": "follow", "role": "derivative"}]}

请为每一篇文章都返回评分（包括低分文章，不要省略任何index）。

待评文章（共${items.length}条）：
${articleList}`;

  const tag = batchTotal > 1 ? `第${batchNo}/${batchTotal}批` : '';
  // 超时/偶发失败重试1次
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await callQwen([
        { role: 'system', content: '你是AI行业资讯评估专家，只输出JSON格式结果。' },
        { role: 'user', content: prompt },
      ], 0.3, SCORING_MODEL);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error(`返回格式异常: ${response.slice(0, 120)}`);
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.scores)) throw new Error('scores字段缺失');
      return parsed.scores;
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? '超时（120秒）' : err.message;
      if (attempt < 2) {
        console.error(`  AI评分${tag}第${attempt}次失败，重试: ${reason}`);
      } else {
        console.error(`  AI评分${tag}重试后仍失败: ${reason}`);
      }
    }
  }
  return null;
}

/**
 * 阶段2 全局精评：对候选文章做一次统一调用，模型只输出档位+全局严格排名，
 * 分数由 applyTierRanks 按 REFINE_TIERS 合成，原地修改 ai_score / score_detail。
 * 为何必须单独一阶：
 * 1. 分批粗排每批各一把尺，跨批取Top几条进精选在统计上没有可比性；
 * 2. 为何不让模型直接给分：2026-07-30 实测即使有锚点，模型仍把30条里的15条批发成82分；
 *    严格排名强制逐对比较，档位则守住绝对口径（安静的日子不会被排名制造出重磅）；
 * 3. 候选只有几十条，一次调用输出短，不会重演 2026-07-30 的超时。
 * 失败返回 false，此时保留粗排分（有分总比无分好），由调用方告警。
 * @param {Array} candidates - 待精评文章（原地修改，入参顺序即粗排分降序）
 * @param {string} recentBlock - 近期已推送标题对照块
 * @returns {Promise<boolean>} 是否成功
 */
export async function refineScores(candidates, recentBlock = '') {
  if (!Array.isArray(candidates) || candidates.length === 0) return true;
  const anchorBlock = SCORE_ANCHORS.map(a => `- 【${scoreBandLabel(a.score)}】${a.title}（${a.why}）`).join('\n');
  const list = candidates.map((a, i) =>
    `[${i + 1}] 来源:${a.source_name} | 角色:${a.role === 'derivative' ? '衍生报道' : '当事方首发'} | 标题:${a.title} | 摘要:${(a.content_snippet || '').slice(0, 200)}`
  ).join('\n');

  const prompt = `你是一位资深AI行业主编，正在为今天的AI日报排定重要性次序。请对下列每篇文章给出两个判断：

1. tier（档位，绝对判断）：对照下方标尺样例判断这篇属于哪一档，与当天其他文章无关——安静的日子就该没有重磅：
- "重磅"：改变行业格局，全行业从业者都必须知道。一天0-1条，多数天为0条
- "重要"：重要进展，影响某个细分赛道的走向。一天0-3条
- "值得看"：有硬事实，但影响面限于特定人群
- "可看"：正常的行业消息、研究成果、榜单
- "边缘"：软文、厂商客户案例、行业评论、小功能更新
2. rank（全局排名，相对判断）：全部${candidates.length}篇按重要性排出1到${candidates.length}的严格名次，
   严禁并列、严禁跳号——必须逐对比较后排出唯一次序，且高档位文章的名次必须排在低档位文章之前

标尺样例（这是本站的档位口径，请严格对齐；判档前先想清楚"这篇比哪条样例更重要、比哪条更不重要"）：
${anchorBlock}

判档要求：
- 必须逐篇与标尺样例对比。不要把大多数文章都塞进同一档——那等于没有判断
- 不要因为来源权威就抬档（标尺里"边缘"档那两条正是权威来源发的软文与客户案例）
- 已标"衍生报道"的文章，档位天花板明显低于当事方首发（如"某厂商适配了他家模型"远不及"该模型发布本身"）
- 综合动态稿要看穿标题：厂商把多项小更新/已发布产品的后续工程优化打包、或用已发布的旧模型名做抓眼标题的，按其中"最强的那个真正新事件"定档，不因罗列项多或标题唬人而抬档；若无够格的新事件，属"可看"及以下
- 消费硬件/车企发布会（手机、汽车、家电等）若只有"智能/AI"营销标签、无实质AI技术增量（如自研AI芯片、自研大模型），属"边缘"不进日报；真含重大AI技术突破才按其技术分量定档
- 竞争格局/行业观察解读稿：若硬事实只有财报数字、持股关系、市值排名等非AI事件，而"竞争加剧/格局变化"是记者的推演与预期，属"边缘"；只有当事方拿出具体新举措（发模型、改路线、可验证的基准/成本数据）才按其实质内容定档
- 国内头部公司（阿里/通义、字节/豆包、腾讯、华为、百度、DeepSeek、月之暗面/Kimi、智谱等）的实质性进展，
  不得因"中文媒体转述而非官方一手"被系统性压档
- reason 用一句话说明你对标了哪条样例（不超过30字）
${recentBlock}
只输出JSON：
{"grades": [{"index": 1, "tier": "重要", "rank": 3, "reason": "量级接近SSI获50亿美元投资"}]}

请为每一篇都给出tier与rank，不要省略任何index。

待评文章（共${candidates.length}条）：
${list}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await callQwen([
        { role: 'system', content: '你是AI行业资讯主编，只输出JSON格式结果。' },
        { role: 'user', content: prompt },
      ], 0.3, SCORING_MODEL);
      const m = response.match(/\{[\s\S]*\}/);
      if (!m) throw new Error(`返回格式异常: ${response.slice(0, 120)}`);
      const parsed = JSON.parse(m[0]);
      if (!Array.isArray(parsed.grades)) throw new Error('grades字段缺失');
      const applied = applyTierRanks(candidates, parsed.grades);
      if (applied === 0) throw new Error('无一条档位可用');
      if (applied < candidates.length) {
        // 部分缺档的仍留粗排分，而两套尺子混在一起排序会失真，必须显式告知
        console.warn(`  [WARN] 全局精评只返回 ${applied}/${candidates.length} 篇，其余沿用粗排分（与精评分不同尺）`);
      }
      console.log(`  全局精评: ${applied}篇已按档位+排名定分`);
      return true;
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? '超时（120秒）' : err.message;
      if (attempt < 2) console.error(`  全局精评第${attempt}次失败，重试: ${reason}`);
      else console.error(`  全局精评重试后仍失败: ${reason}`);
    }
  }
  return false;
}

/**
 * 档内拉开：把 k 个名次均匀铺到 [min, max] 区间上，降序返回。
 * k=1 取区间中点（孤篇不该自动拿档顶：孤篇重要≠当天最强）；
 * k≤区间宽度+1 时相邻间距≥1，分数必不重复；k 超出区间宽度时允许少量相邻同分（无法避免）。
 */
function spreadScores(k, min, max) {
  if (k <= 0) return [];
  if (k === 1) return [Math.round((min + max) / 2)];
  const out = [];
  for (let i = 0; i < k; i++) out.push(max - Math.round(i * (max - min) / (k - 1)));
  return out;
}

/**
 * 把模型给的档位+排名合成为分数写回候选（纯函数，供测试）。
 * 档位优先：档位决定分数区间，排名只在档内定先后与配额取舍。具体三步：
 * 1. 按档分桶，档内按 rank 升序（rank 缺失/并列时退回入场顺序，即粗排分降序）；
 * 2. 配额压制：重磅≤1、重要≤3（与 SCORE_BANDS 同口径），超配的按排名末位降入下一档，可级联；
 *    降档只在代码层做，不回馈给模型——配额是本站口径，不是模型该揣摩的目标；
 * 3. 档内按名次用 spreadScores 拉开写回。
 * score_detail 保留粗排子分并标注 stage/tier/rank/demoted_from，供复盘溯源。
 * @param {Array} candidates - 候选文章（原地修改）
 * @param {Array} grades - 模型返回的 [{index, tier, rank, reason}]
 * @returns {number} 实际应用的篇数
 */
export function applyTierRanks(candidates, grades) {
  if (!Array.isArray(candidates) || !Array.isArray(grades)) return 0;
  const tierIndex = new Map(REFINE_TIERS.map((t, i) => [t.key, i]));
  // 采集有效条目：index合法且档位在册；同index重复时只认第一条
  const picked = new Map(); // candIdx -> {tier, rank, reason}
  for (const g of grades) {
    const i = Number(g?.index) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length || picked.has(i)) continue;
    const tier = tierIndex.get(typeof g.tier === 'string' ? g.tier.trim() : '');
    if (tier === undefined) continue;
    const rank = Number(g.rank);
    picked.set(i, {
      i, tier,
      rank: Number.isFinite(rank) && rank > 0 ? rank : Number.MAX_SAFE_INTEGER,
      reason: typeof g.reason === 'string' ? g.reason.slice(0, 60) : '',
    });
  }
  if (!picked.size) return 0;
  const byRank = (a, b) => a.rank - b.rank || a.i - b.i;
  const buckets = REFINE_TIERS.map(() => []);
  for (const e of [...picked.values()].sort(byRank)) buckets[e.tier].push(e);
  // 配额压制（自高档向下，降入的可能把下一档也顶超配，故逐档顺序处理即天然级联）
  for (let t = 0; t < buckets.length - 1; t++) {
    const { quota, key } = REFINE_TIERS[t];
    if (buckets[t].length <= quota) continue;
    const overflow = buckets[t].splice(quota);
    for (const e of overflow) e.demotedFrom = e.demotedFrom || key; // 级联时保留最初档位
    buckets[t + 1] = buckets[t + 1].concat(overflow).sort(byRank);
  }
  // 档内拉开写回
  let applied = 0;
  for (let t = 0; t < buckets.length; t++) {
    const scores = spreadScores(buckets[t].length, REFINE_TIERS[t].min, REFINE_TIERS[t].max);
    buckets[t].forEach((e, j) => {
      const a = candidates[e.i];
      let rough = null;
      try { rough = a.score_detail ? JSON.parse(a.score_detail) : null; } catch { rough = null; }
      a.ai_score = scores[j];
      a.score_detail = JSON.stringify({
        score: scores[j],
        stage: 'refined',
        tier: REFINE_TIERS[t].key,
        rank: e.rank === Number.MAX_SAFE_INTEGER ? null : e.rank,
        ...(e.demotedFrom ? { demoted_from: e.demotedFrom } : {}),
        reason: e.reason,
        role: a.role || 'primary',
        rough, // 阶段1粗排子分，仅供复盘对照
      });
      applied++;
    });
  }
  return applied;
}

/**
 * 衍生报道分数封顶（纯函数，供测试）。
 * 提示词里的"衍生稿天花板更低"是软约束，模型会因衍生稿带了详实数据而给高分
 * （「阿里云适配Kimi K3」带着时延-35%/吞吐1.8倍的硬数据，历史上就拿到了全库最高的97分），
 * 故由代码硬封顶。只降不升：本来就低于上限的不动。
 * @param {Array} list - 文章列表（原地修改）
 * @returns {number} 被封顶的篇数
 */
export function applyRoleCeiling(list) {
  if (!Array.isArray(list)) return 0;
  let capped = 0;
  for (const a of list) {
    if (a?.role !== 'derivative') continue;
    if (!(a.ai_score > DERIVATIVE_SCORE_CEILING)) continue;
    const before = a.ai_score;
    a.ai_score = DERIVATIVE_SCORE_CEILING;
    try {
      const d = a.score_detail ? JSON.parse(a.score_detail) : {};
      a.score_detail = JSON.stringify({ ...d, score: a.ai_score, capped_from: before });
    } catch { /* score_detail 不可解析时不阻断封顶 */ }
    capped++;
  }
  if (capped > 0) console.log(`  衍生稿封顶: ${capped} 条跟随性报道压到 ${DERIVATIVE_SCORE_CEILING} 分以内`);
  return capped;
}

/**
 * 同事件簇保留篇选择（纯函数，供测试）：主稿优先于衍生稿，同角色时看分数。
 * 单纯比分数会在衍生稿得分更高时把主新闻吐掉，只剩「某厂商适配了它」代表整个事件。
 * @returns {[object, object]} [保留篇, 被剔篇]
 */
export function pickKept(kept, incoming) {
  const keptDeriv = kept?.role === 'derivative';
  const inDeriv = incoming?.role === 'derivative';
  if (keptDeriv !== inDeriv) return keptDeriv ? [incoming, kept] : [kept, incoming];
  return (incoming?.ai_score || 0) > (kept?.ai_score || 0) ? [incoming, kept] : [kept, incoming];
}

/**
 * 提取标题中的数字串（版本号、型号、规模、金额）
 */
function numericTokens(norm) {
  return new Set(norm.match(/\d+/g) || []);
}

/**
 * 双方都带数字、且数字集合不同 → 判为不同事件，不予合并。
 * 「OpenAI发布GPT-6」vs「OpenAI发布GPT-5」规范化后Dice高达0.91，却是两次不同发布——
 * 这是纯字面相似度最危险的失效方式，必须挡住。
 * 只有一方带数字时不设限（同一事件常有一篇带截止天数/参数量而另一篇不带），交由阈值决定。
 */
function digitsConflict(a, b) {
  if (!a.size || !b.size) return false;
  if (a.size !== b.size) return true;
  for (const d of a) if (!b.has(d)) return true;
  return false;
}

/**
 * 标题近重复合并（纯函数，供测试）：事件名归并之后，再按标题字面相似度兜一层。
 *
 * 为什么这一层必须是代码、而不是再加一次AI调用：
 * finalDedupePass 已经就是「一次调用看全部入选名单、明确要求找出同事件重复组」，
 * 它在 2026-07-30 看到的正是两个都以 "Trump administration bans foreign-made" 开头的标题，
 * 仍然没有归并——提示词写着「宁漏勿错」，而一篇说 humanoid robots、一篇说 robots and power gear，
 * 保守的模型就当成两个禁令了，两篇双双进了精选。
 * AI强在「措辞完全不同但是同一件事」，代码强在「字面高度重合」，两者互补；
 * 拿第四次AI调用去补第三次AI调用漏掉的东西，只会重复同一种失败。
 *
 * @param {Array} articles - 事件去重后的文章（分数降序）
 * @returns {{list: Array, dropped: number}} 合并后的列表与剔除数
 */
export function mergeNearDupTitles(articles) {
  if (!Array.isArray(articles) || articles.length < 2) {
    return { list: Array.isArray(articles) ? articles : [], dropped: 0 };
  }
  const entries = []; // [{norm, digits, idx}] —— idx 指向 list 中的保留篇
  const list = [];
  let dropped = 0;
  for (const a of articles) {
    const norm = normalizeEventName(a.title || '');
    const digits = numericTokens(norm);
    const hit = norm.length >= TITLE_DUP_MIN_LEN
      ? entries.find(e =>
        e.norm.length >= TITLE_DUP_MIN_LEN
        && !digitsConflict(e.digits, digits)
        && diceSimilarity(e.norm, norm) >= TITLE_DUP_THRESHOLD)
      : null;
    if (hit) {
      // 主稿优先，与事件名层同一口径（见 pickKept）：字面几乎相同的两篇仍可能一主一衍生
      const [winner, loser] = pickKept(list[hit.idx], a);
      if (winner !== list[hit.idx]) {
        list[hit.idx] = winner;
        hit.norm = normalizeEventName(winner.title || '');
        hit.digits = numericTokens(hit.norm);
      }
      mergeIntoKept(winner, loser);
      dropped++;
      continue;
    }
    entries.push({ norm, digits, idx: list.length });
    list.push(a);
  }
  return { list, dropped };
}

/**
 * 分数→档位标签（供日志打印分布用）。
 * 口径必须与 SCORE_BANDS 以及前台 miniprogram/utils/fmt.wxs 的 scoreBand 三处一致，改一处要同步另两处。
 */
export function scoreBandLabel(score) {
  const s = Number(score) || 0;
  if (s >= 90) return '重磅';
  if (s >= 80) return '重要';
  if (s >= 70) return '值得看';
  if (s >= 60) return '可看';
  return '边缘';
}

/**
 * 子分归一与总分计算（纯函数，供测试）：总分一律由代码从三项子分求和，
 * 不采信模型自己算的总分（LLM算术偶尔出错，且"总分=子分之和"是评分可解释的前提）。
 * 子分越界截断到各自量程；三项子分全缺时回退到模型给的总分
 * （否则模型一旦不按子分格式输出，全批文章会被算0分而静默丢弃）。
 * @param {object} raw - AI返回的单篇评分对象
 * @returns {{impact:number, facts:number, novelty:number, score:number, degraded?:boolean}}
 */
export function normalizeSubScores(raw) {
  const pick = (v, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.round(n), max);
  };
  const hasSub = ['impact', 'facts', 'novelty'].some(k => Number.isFinite(Number(raw?.[k])));
  if (!hasSub) {
    const n = Number(raw?.score);
    const score = Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 100) : 0;
    return { impact: 0, facts: 0, novelty: 0, score, degraded: true };
  }
  const impact = pick(raw.impact, 40);
  const facts = pick(raw.facts, 30);
  const novelty = pick(raw.novelty, 30);
  return { impact, facts, novelty, score: impact + facts + novelty };
}

/**
 * 分数塌缩检测（纯函数，供测试）：同一分数占比过高说明模型没在逐篇判断
 * （典型表现是按来源档次批发分数），此时精选退化为"同分看采集顺序"，必须显式告警。
 * 样本不足6篇时同分很正常，不判塌缩（避免误报）。
 *
 * 阈值从"过半"降为"超三分之一且至5篇"：2026-07-30 入选的15条里有6条同为75分（占比40%），
 * 这已经是明摆着的批发分数，却达不到过半而全程没报警——它是用户亲自发现的。
 * count>=5 的下限用来挡住小名单误报（如 6 篇名单里 3 篇同分，本不算异常）。
 * @param {Array} scored - 已评分文章（应传最终入选名单，而非候选池：底部候选会把同分占比稀释掉）
 * @returns {{score:number,count:number,total:number,ratio:number}|null}
 */
export function detectScoreCollapse(scored) {
  if (!Array.isArray(scored) || scored.length < 6) return null;
  const tally = new Map();
  for (const a of scored) tally.set(a.ai_score, (tally.get(a.ai_score) || 0) + 1);
  const [score, count] = [...tally.entries()].sort((x, y) => y[1] - x[1])[0];
  const ratio = count / scored.length;
  return (count >= 5 && ratio >= 1 / 3) ? { score, count, total: scored.length, ratio } : null;
}

/**
 * 将被去重剔除的同事件文章合并进保留篇（纯函数，供测试）。
 * 重复报道不是垃圾：标题一律保留供多源事实校对；而同一来源（官方）同期连发的多篇
 * 还要把摘要片段一并带上，并记录连发篇数——下游摘要靠这些素材把多稿合并成一条新闻，
 * 而不是只留一篇、丢掉其余各篇的信息（2026-07-30 OpenAI三稿各占一条事故的修正）。
 * @param {object} kept - 保留篇（会被原地修改）
 * @param {object} dropped - 被剔除篇
 */
export function mergeIntoKept(kept, dropped) {
  if (!kept || !dropped) return kept;
  kept.related_titles = kept.related_titles || [];
  kept.related_titles.push(dropped.title);
  // 事件名继承：标题近重复层可能留下一篇 AI 未给事件名的（event_norm 为空）、
  // 而被剔的那篇有名——不继承就白丢了这条事件的跨日关联信号
  if (!kept.event_norm && dropped.event_norm) kept.event_norm = dropped.event_norm;
  if (dropped.source_name && dropped.source_name === kept.source_name) {
    kept.merged_same_source = (kept.merged_same_source || 0) + 1;
    kept.related_snippets = kept.related_snippets || [];
    kept.related_snippets.push({
      title: dropped.title,
      snippet: (dropped.content_snippet || '').slice(0, 300),
    });
  }
  return kept;
}

/**
 * 日配额选取（纯函数，供测试）：一日多轮采集共享“每日10-20条”配额
 * - 首轮（当日0条）：>=60分取最多20条，不足10条用5 6-59分补齐到10条
 * - 增量轮：配额=20-已有数；当日已达10条后门槛抬到70分——
 *   后续轮次只补“行业重要动态”级以上，不用凑数文章稀释日报
 * - 配额已满：只放行>=85分重大突发（最多2条），大新闻不因来得晚而漏掉
 * - 官方政策保护通道：官方政策源（网信办/工信部等）周更级频率，在增量配额里
 *   永远竞争不过当日新闻（2026-08-10事故：网信办08-07征求意见稿在08-09
 *   因当日只剩1个名额被挤掉）。>=70分的官方政策条目保送（每轮至多2条），
 *   不占日配额；量级每周仅几条，不会灌爆日报
 * @param {Array} deduped - 事件去重后的文章（分数降序）
 * @param {number} existingCount - 当日已入库文章数
 */
export function selectByQuota(deduped, existingCount = 0) {
  const isProtectedPolicy = a => a.source_type === 'official' && a.category === 'policy' && a.ai_score >= 70;
  const protectedPicks = deduped.filter(isProtectedPolicy).slice(0, 2);
  const pool = protectedPicks.length ? deduped.filter(a => !protectedPicks.includes(a)) : deduped;
  if (protectedPicks.length) console.log(`政策保护通道: 免配额放行 ${protectedPicks.length} 条官方政策(>=70分)`);

  const capRemaining = Math.max(0, 20 - existingCount);
  if (capRemaining === 0) {
    const breaking = pool.filter(a => a.ai_score >= 85).slice(0, 2);
    if (breaking.length) console.log(`突发通道: 当日配额已满，仍放行 ${breaking.length} 条(>=85分)`);
    return [...protectedPicks, ...breaking];
  }
  const minScore = existingCount >= 10 ? 70 : 60;
  const qualified = pool.filter(a => a.ai_score >= minScore);
  let selected = qualified.slice(0, capRemaining);
  // 数量保障只对“当日总数不足10条”生效
  // （补齐地板56分：按锚点口径56-59属“边缘”上沿，宁可用它凑满当日下限，也有跨期查重与精选门槛兜底）
  const dayShort = 10 - existingCount - selected.length;
  if (dayShort > 0) {
    const backfill = pool.filter(a => a.ai_score >= 56 && a.ai_score < minScore).slice(0, dayShort);
    if (backfill.length > 0) {
      console.log(`数量保障: 当日不足10条，用56-${minScore - 1}分段补入 ${backfill.length} 条`);
      selected = selected.concat(backfill);
    }
  }
  return [...protectedPicks, ...selected];
}

/**
 * 政策保底配额（纯函数，供测试）：政策类文章在AI评分中系统性低分，正常配额下几乎永远进不了
 * 每日10-20条——12个新政策源（发改委/省市/日韩/中东）实测全部被科技融资新闻挤出。
 * 给政策维度每日保底 POLICY_QUOTA_PER_DAY 条：当天政策稿入选不足时，按分数从高到低补入，
 * 仅在当日总数未达日上限时补（不挤占科技新闻名额）；进精选仍走 markFeatured 统一标尺。
 * 2026-08-12 修复：必须从"当日全量去重稿件"（byDayFull，含未进精评Top-30的低分政策稿）补入——
 * 原实现只扫精评候选池，政策稿系统性低分根本进不了候选池，导致保底永不触发
 * （当日12个政策源全抓到原始稿却0入选）。池内Top-30稿已被精评定分、其余用分批粗评分，
 * 本函数按 ai_score 降序取当日最高分的政策稿，与分数来源无关。
 * @param {Map<string, Array>} byDayFull - 当日全量去重稿件，按发布北京日分桶
 * @param {Map<string, Array>} byDaySelected - 已入选文章按日分桶
 * @param {Map<string, {existingCount?: number}>} dayContexts - 各日已入库数（配额口径）
 * @returns {Array} 待补入的政策稿（调用方负责 push 进 selected 并重排）
 */
export function policyQuotaPicks(byDayFull, byDaySelected, dayContexts = {}) {
  const POLICY_QUOTA_PER_DAY = 2;
  const DAY_CAP = 20;
  const picks = [];
  for (const [dk, list] of byDayFull) {
    const ctx = dayContexts[dk] || {};
    const already = byDaySelected.get(dk) || [];
    const policySelected = already.filter(a => a.category === 'policy').length;
    const need = POLICY_QUOTA_PER_DAY - policySelected;
    if (need <= 0) continue;
    const room = DAY_CAP - (ctx.existingCount || 0) - already.length;
    if (room <= 0) continue;
    const take = Math.min(need, room);
    // 已入选去重只认真实URL：无source_url的文章（如测试数据）不能因undefined落入"已入选"集合被误剔
    const selectedUrls = new Set(already.map(a => a.source_url).filter(Boolean));
    const promoted = [...list]
      .sort((a, b) => b.ai_score - a.ai_score)
      .filter(a => a.category === 'policy' && !(a.source_url && selectedUrls.has(a.source_url)))
      .slice(0, take);
    if (promoted.length) {
      console.log(`政策保底: ${dk} 补入 ${promoted.length} 条政策稿（原政策入选 ${policySelected} 条，从当日全量去重稿件补入）`);
      picks.push(...promoted);
    }
  }
  return picks;
}

/**
 * 精选标记（纯函数，供测试）：日级精选预算最多5条，多轮共享
 * - 门槛硬约束：一律需 >=FEATURED_MIN_SCORE（即“重要”档以上），不够就宁缺毋滥（当日精选可以为0条）
 * - 首轮：上限取入选数25%（至少1条、至多5条）
 * - 增量轮：仅 >=80分 且预算未满才可进精选——下午的普通动态不该挤进"今日必读"
 *   （门槛已升至80，此条现为冗余保护：将来门槛若回调，增量轮不至于跟着放水）
 * - retro（旧事回顾）任何情况不进精选（经事件去重，精选必然是不同事件）
 * 副作用：清理临时字段 event_key、role；返回本轮标记数
 */
export function markFeatured(selected, dayContext = {}) {
  const existingCount = dayContext.existingCount || 0;
  const existingFeatured = dayContext.existingFeatured || 0;
  const featuredMinScore = dayContext.featuredMinScore || 0; // 当日已精选中的最低分
  const now = dayContext.now || Date.now(); // 可注入时钟，供测试
  const budget = Math.max(0, 5 - existingFeatured);
  const isIncremental = existingCount > 0;
  const featuredCap = isIncremental
    ? budget
    : Math.min(selected.length, budget, Math.max(1, Math.floor(selected.length * 0.25)));
  // 突发新鲜度门槛：发布时间距今<=12小时才配"突发"（覆盖两轮采集间隔+夜间空窗）。
  // 高分但发布已久的属于补录好文，走普通列表即可；发布时间缺失按不新鲜处理，宁缺勿滥。
  const BREAKING_FRESH_MS = 12 * 3600 * 1000;
  const isFresh = (a) => {
    const ts = a.published_at ? new Date(a.published_at).getTime() : NaN;
    return Number.isFinite(ts) && now - ts <= BREAKING_FRESH_MS;
  };
  let marked = 0;
  selected.forEach(a => {
    a.is_featured = a.newsness !== 'retro'
      && marked < featuredCap
      && a.ai_score >= FEATURED_MIN_SCORE
      && (!isIncremental || a.ai_score >= 80);
    if (a.is_featured) marked++;
    // 突发标亮：增量轮里没进精选（预算已满）、但分数够"今日必读"水准
    // （>=85 且 >=当日精选最低分）、且刚发布不久的全新事件——不挤占已展示的精选，
    // 改在普通列表高亮，避免重磅被埋没。经跨期查重+新鲜度门槛后触发很少，是安全阀而非常态。
    a.is_breaking = !a.is_featured
      && isIncremental
      && a.newsness !== 'retro'
      && a.ai_score >= 85
      && a.ai_score >= featuredMinScore
      && isFresh(a);
    delete a.event_key; // 临时字段不入库
    delete a.role;      // 同上：已写进 score_detail，无需单独建列
  });
  return marked;
}

/**
 * 终审查重：对入选名单做一次专门的同事件检查，代码强制同组只保留最高分一篇。
 * 提示词保守校准：只认"同主体+同具体事件"，防止把主题相关的不同事件误并（双向防误伤）。
 * 任何异常都静默跳过，不阻断主流程。
 */
export async function finalDedupePass(selected) {
  if (selected.length < 2) return selected;
  const list = selected.map((a, i) => `[${i + 1}] 来源:${a.source_name} | ${a.title}`).join('\n');
  const prompt = `下面是今日入选的AI资讯标题列表。请找出其中"报道同一核心事件"的重复组。

判定标准：
- 同一主体的同一具体事件才算重复（即使标题差异很大，如一篇带产品型号一篇不带，只要是同一次发布/同一笔交易，也算）
- 同一主体围绕同一产品的同一波官方宣发也算重复（如：公司发布某产品 与 该公司创始人/高管同期站台介绍、演示、内部使用该产品，本质是同一发布事件的不同报道角度）
- 同一次人事/组织变动的不同报道角度也算重复（如：一篇报"某高管离职/上任"，另一篇报"该公司管理层调整/组织架构重组"，或报道该人事变动的股价/市场影响——它们都源自同一次人事变动官宣；2026-08-06 漏网判例：谷歌Jeff Dean离职 与 谷歌AI领导层调整 双双进精选）
- 仅主题相关但事件不同的不算（如：A公司发布模型 与 B公司发布同类模型；某事件发生 与 他人对该事件的评论）
- 第三方围绕同一产品的独立动作是不同事件，不算重复（如：某模型发布 / 该模型登顶榜单 / 其他公司完成对该模型的适配，是三个不同事件）
- 拿不准的不要列入，宁漏勿错

${list}

只输出JSON，无重复时duplicates为空数组：
{"duplicates": [[1,5],[3,9,12]]}`;
  try {
    const response = await callQwen([
      { role: 'system', content: '你是资讯查重助手，只输出JSON。' },
      { role: 'user', content: prompt },
    ], 0.1); // 低温度：查重要稳定保守，不要发散
    const m = response.match(/\{[\s\S]*\}/);
    if (!m) return selected;
    const groups = parseDupGroups(m[0]);
    if (!groups.length) return selected;
    const drop = new Set();
    for (const g of groups) {
      if (!Array.isArray(g) || g.length < 2) continue;
      const idxs = g.map(n => n - 1).filter(i => Number.isInteger(i) && i >= 0 && i < selected.length && !drop.has(i));
      if (idxs.length < 2) continue;
      // 保留分数最高的一篇，其余剔除；被剔篇的标题（同来源时还有摘要素材）挂到保留篇，供摘要合并与事实校对
      idxs.sort((x, y) => selected[y].ai_score - selected[x].ai_score);
      const keep = selected[idxs[0]];
      for (const i of idxs.slice(1)) {
        mergeIntoKept(keep, selected[i]);
        drop.add(i);
      }
    }
    if (drop.size > 0) {
      console.log(`终审查重: 剔除同事件重复 ${drop.size} 条`);
      return selected.filter((_, i) => !drop.has(i));
    }
    return selected;
  } catch (err) {
    console.warn('终审查重失败，跳过（不影响主流程）:', err.message);
    return selected;
  }
}

/**
 * 跨期查重：把本轮入选文章与"近期已发布文章（当日+近期）"做一次专门的同事件比对。
 * 命中已发布事件的候选一律丢弃（已发布篇有摘要、可能已进精选，优先保留）。
 * 提示词保守校准：只认"同主体+同具体事件"，跨语言/跨标题措辞也能识别；任何异常静默跳过。
 * @param {Array} candidates - 本轮入选文章（分数降序）
 * @param {Array<string>} publishedTitles - 近期（当日+近RECENT_TITLE_DAYS天）已入库文章标题
 */
export async function crossRoundDedup(candidates, publishedTitles = []) {
  if (!candidates.length || !publishedTitles.length) return candidates;
  // 截断120条：覆盖"当日已发布+近10天"（每日10-20条），标题按时间倒序，截断只丢最旧的
  const pubList = publishedTitles.slice(0, 120).map((t, i) => `[A${i + 1}] ${t}`).join('\n');
  const candList = candidates.map((a, i) => `[B${i + 1}] ${a.title}`).join('\n');
  const prompt = `A组是近期已发布的文章，B组是"待发布候选"。请找出B组中与A组报道同一核心事件的条目（这些候选属于旧闻重报，应剔除）。

判定标准（先按1-2判是否重复，再看3-4例外，例外优先）：
1. 同一主体的同一具体事件算重复（即使标题差异很大、报道角度不同或中英文不同，如一篇"发布开放权重"一篇"开源XX参数"，只要是同一次发布，也算）
2. 同一次发布/官宣的后续报道角度都算重复：官方宣发造势（创始人站台/演示/内部使用）、跟进分析、跑分解读、成本测算、战略点评——即使补充了新数据（基准分数、价格、依赖关系），核心事件仍是那一次发布；同一次人事/组织变动的后续角度（股价影响、内部反应、接任者背景）同样算重复
3. 例外A（独立新事件，保留）：做事的主体换成了另一家公司。如已发布"A公司开源某模型"，候选是"B公司宣布完成该模型适配/接入自家平台"，这是B公司自己的新动作，不算重复
4. 例外B（事件出现新状态，保留）：事件本身发生了后续变化。如：融资传闻→正式官宣、发布→被曝重大缺陷/客户暂停使用/产品下架、事故→官方调查结论、当事方对争议作出正式回应
5. 拿不准的不要列入，宁漏勿错。B组完全可能一条重复都没有（这是常态而非例外），没有就返回空数组，严禁为了输出结果而凑数

已发布(A组)：
${pubList}

待发布候选(B组)：
${candList}

请先对B组每条候选各用一行简述判定结论与依据的条款号（这一步是判准的关键，不可省略），
最后一行输出JSON，dup数组元素必须是纯数字（B组编号的数字部分，严禁带"B"前缀），无重复时dup为空数组：
{"dup": [1, 3]}`;
  try {
    const response = await callQwen([
      { role: 'system', content: '你是资讯查重助手，先逐条给出判定理由，最后一行输出JSON。' },
      { role: 'user', content: prompt },
    ], 0.1); // 低温度：查重要稳定保守
    const m = response.match(/\{[\s\S]*\}/);
    if (!m) return candidates;
    const dup = parseDupIndexes(m[0]);
    if (!dup.length) return candidates;
    const drop = new Set(dup.map(n => n - 1).filter(i => Number.isInteger(i) && i >= 0 && i < candidates.length));
    if (!drop.size) return candidates;
    console.log(`跨期查重: 剔除与近期已发布同事件的旧闻重报 ${drop.size} 条`);
    return candidates.filter((_, i) => !drop.has(i));
  } catch (err) {
    console.warn('跨轮查重失败，跳过（不影响主流程）:', err.message);
    return candidates;
  }
}

/**
 * 解析查重响应中的dup编号数组（纯函数，供测试）。
 * 解析容错：AI偶尔无视格式要求输出带B前缀/未加引号的编号（如 {"dup": [B1, B3]}），
 * 直接JSON.parse会抛异常导致整层查重被静默跳过（实测漏放跨天重报），故双路兜底：
 * 1) JSON解析失败时，正则截取dup数组原文再提取数字；2) 解析成功但元素是"B1"这类字符串时同样提数字
 * @param {string} jsonText - 响应中匹配到的JSON文本
 * @returns {number[]} - 纯数字编号数组（1-based），无法解析时为空数组
 */
export function parseDupIndexes(jsonText) {
  let raw;
  try {
    raw = JSON.parse(jsonText).dup;
  } catch {
    const arr = jsonText.match(/"?dup"?\s*:\s*\[([^\]]*)\]/);
    if (!arr) return [];
    raw = arr[1].match(/\d+/g) || [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map(v => {
      if (typeof v === 'number') return v;
      const digits = String(v).match(/\d+/);
      return digits ? Number(digits[0]) : NaN;
    })
    .filter(Number.isFinite);
}

/**
 * 解析终审查重响应中的duplicates分组数组（纯函数，供测试）。
 * 与 parseDupIndexes 同类容错（同一问题族：LLM编号输出偶带前缀/未加引号，
 * 裸JSON.parse抛异常会让终审查重整层静默失效）：
 * 1) JSON解析失败时，正则截取duplicates数组原文，逐个内层[]提取数字成组；
 * 2) 解析成功但组元素是"1"/"B1"这类字符串时同样提数字。
 * @param {string} jsonText - 响应中匹配到的JSON文本
 * @returns {number[][]} - 编号分组数组（1-based），无法解析时为空数组
 */
export function parseDupGroups(jsonText) {
  const toNums = (arr) => arr
    .map(v => {
      if (typeof v === 'number') return v;
      const digits = String(v).match(/\d+/);
      return digits ? Number(digits[0]) : NaN;
    })
    .filter(Number.isFinite);

  try {
    const raw = JSON.parse(jsonText).duplicates;
    if (!Array.isArray(raw)) return [];
    return raw.filter(Array.isArray).map(toNums);
  } catch {
    const outer = jsonText.match(/"?duplicates"?\s*:\s*\[([\s\S]*)\]/);
    if (!outer) return [];
    const groups = [];
    for (const g of outer[1].matchAll(/\[([^\][]*)\]/g)) {
      groups.push(toNums(g[1].match(/\d+/g) || []));
    }
    return groups;
  }
}

/**
 * 事件名规范化：小写、去空白与标点，只保留有效字符供相似度比较
 */
function normalizeEventName(s) {
  return s.toLowerCase().replace(/[\s\u3000\p{P}]/gu, '');
}

/**
 * 二元组Dice相似度（零依赖的字符串相似度，对中文事件名效果稳定）
 */
function diceSimilarity(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = s => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * 降级筛选策略：AI不可用时按来源权重+时间排序（同样受日配额约束）
 */
function fallbackFilter(articles, dayContexts = {}) {
  // 降级路径同样按“发布北京日”归日并各日独立取配额（与正常路径一致）。
  // 降级轮无可信分数，一律不标精选；排序只用来源权重，仅保证不崩、且 date_key 正确。
  const sourceWeights = {
    'official': 65,
    'media': 58,
  };
  const byDay = new Map();
  for (const a of articles) {
    const dk = beijingDayKey(a.published_at);
    if (!byDay.has(dk)) byDay.set(dk, []);
    byDay.get(dk).push({
      ...a,
      date_key: dk,
      ai_score: sourceWeights[a.source_type] || 55,
      is_featured: false,
    });
  }
  const out = [];
  for (const [dk, list] of byDay) {
    const existingCount = (dayContexts[dk] || {}).existingCount || 0;
    const capRemaining = Math.max(0, 20 - existingCount);
    if (capRemaining === 0) continue;
    list.sort((a, b) => b.ai_score - a.ai_score);
    out.push(...list.slice(0, Math.min(15, capRemaining)));
  }
  // 降级模式一律不标精选：此时分数只是来源权重，没做事件去重也没识别旧闻，
  // 按分取Top3等于"按采集顺序抽签"——它在 2026-07-30 把同一事件的三篇官方博客送上精选。
  // 故降级轮精选宁缺毋滥：宁可当日无精选，也不推不可信的"今日必读"。
  console.log(`降级筛选: 选取 ${out.length} 条（按发布日分桶，本轮不标精选）`);
  return out;
}
