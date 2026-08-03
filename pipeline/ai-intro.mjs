/**
 * 今日导语 - 入库完成后综合当日全部文章生成一段"主编导语"
 * 定位：读者打开首页第一眼看到的今日主线（今天AI圈发生了什么、哪条最值得读），
 * 100-160字，只基于当日已入库文章的标题与摘要，不引入外部信息（防幻觉）
 *
 * 独立运行（回填当天导语）：node ai-intro.mjs [YYYY-MM-DD]
 */
import './load-env.mjs';
import { pathToFileURL } from 'url';

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
// 导语虽短但含事实陈述且是首页门面（每天仅1次调用），用旗舰模型防加戏；可用 INTRO_MODEL 覆盖
const INTRO_MODEL = process.env.INTRO_MODEL || 'qwen-max';

/**
 * 基于当日文章列表生成导语文本，失败返回null（导语缺失时前端不展示，不阻塞管线）
 * @param {Array} articles - 当日文章（含 title/category/summary/ai_score/is_featured）
 */
export async function generateDailyIntro(articles) {
  if (!DASHSCOPE_API_KEY || !articles.length) return null;

  // 素材：精选给标题+摘要首句，其余只给标题（控制token，导语只需主线不需细节）
  const lines = articles.map(a => {
    const featured = a.is_featured ? '【精选】' : '';
    const firstSentence = a.is_featured ? `：${(a.summary || '').split(/[。！]/)[0].slice(0, 60)}` : '';
    return `- ${featured}${a.title}${firstSentence}`;
  });

  const prompt = `你是AI资讯日报主编。请根据今日入选的${articles.length}条资讯，写一段100-160字的今日导语。

要求：
1. 先用1-2句概括今天AI圈的整体主线（今天的重头戏在哪几个方向，如发布/融资/开源/政策），方向词必须对应列表里真实存在的事件，列表里没有"模型发布"就不能说"模型发布"
2. 再点出最值得读的1条【精选】并用一句话说明为什么值得读。主推必须事实完整、主体明确：消息主体不明（如"未具名公司""神秘团队"）或核心只有单方无法核实宣称的，一律不得作为主推，宁可选分数稍低但扎实的
3. 只依据下面给出的标题和摘要，严禁引入列表之外的任何事实、数据、公司名
4. 严禁添加素材没有的修饰性断言：素材没说"首次/罕见/最大"就不能写，素材没提交易细节（如筹码、条款）就不能编；严禁宏大意义拔高（"展示了××实力""标志着××崛起""预示着未来××"这类结论，素材直接推不出就不能写）；判断可以有，但必须能从素材直接推出
5. 语气像资深主编写给读者的开场白：干练、有判断、不堆砌，不用"首先/其次"，不逐条罗列
6. 不要问候语（如"大家好"），不要落款，直接进入内容
7. 纯文本输出，不要markdown、不要引号包裹

今日资讯列表：
${lines.join('\n')}`;

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
      },
      body: JSON.stringify({
        model: INTRO_MODEL,
        messages: [
          { role: 'system', content: '你是AI行业资讯日报的资深主编，文字干练克制，只输出导语正文。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.6,
        max_tokens: 400,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`DashScope API错误 ${res.status}`);
    const data = await res.json();
    const intro = (data.choices[0].message.content || '').trim()
      .replace(/^["'「『]+|["'」』]+$/g, ''); // 去掉模型偶尔加的引号包裹
    // 长度合理性校验：过短说明生成失败；超长时按句号截断（不能拦腰斩句），防止首页被撑爆
    if (intro.length < 40) throw new Error(`导语过短(${intro.length}字): ${intro}`);
    if (intro.length > 180) {
      const cut = intro.slice(0, 180);
      const lastEnd = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
      return lastEnd >= 40 ? cut.slice(0, lastEnd + 1) : cut;
    }
    return intro;
  } catch (err) {
    console.warn(`今日导语生成失败（不影响文章入库）: ${err.message}`);
    return null;
  }
}

// 独立运行：回填指定日期（默认今天）的导语
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { getArticlesByDate, saveDailyIntro } = await import('./db.mjs');
  const dateKey = process.argv[2] || new Date().toISOString().split('T')[0];
  const articles = await getArticlesByDate(dateKey);
  if (!articles.length) {
    console.log(`${dateKey} 没有已入库文章，无法生成导语`);
    process.exit(0);
  }
  console.log(`为 ${dateKey} 的 ${articles.length} 条文章生成导语...`);
  const intro = await generateDailyIntro(articles);
  if (intro) {
    console.log(`导语(${intro.length}字): ${intro}`);
    await saveDailyIntro(dateKey, intro);
  }
}
