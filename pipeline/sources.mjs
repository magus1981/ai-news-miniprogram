/**
 * RSS源配置
 * 海外官方博客 + 海外头部媒体 + 国内媒体（直接RSS或自建爬虫，不依赖RSSHub）
 * 接入前均经实测：2026-07-28 全部源拉取+解析验证通过
 */

export const SOURCES = [
  // === 海外官方源（第一手权威） ===
  {
    name: 'OpenAI Blog',
    url: 'https://openai.com/blog/rss.xml',
    category: 'company',
    language: 'en',
    source_type: 'official',
    official: true, // 低频官方源：无日期或日期解析失败的条目放行
  },
  {
    name: 'Google DeepMind',
    // 主地址 deepmind.google/blog/rss.xml 对非浏览器拒连，basic feed + Feedly UA 实测可用
    url: 'https://deepmind.google/blog/feed/basic/',
    userAgent: 'Feedly/1.0',
    category: 'technology',
    language: 'en',
    source_type: 'official',
    official: true,
  },
  {
    name: 'Google AI',
    url: 'https://blog.google/technology/ai/rss/',
    category: 'company',
    language: 'en',
    source_type: 'official',
    official: true,
  },
  {
    name: 'Microsoft AI',
    // blogs.microsoft.com/ai/feed 已410下线，改用 Microsoft Source AI 专题feed（需Feedly UA）
    url: 'https://news.microsoft.com/source/topics/ai/feed/',
    userAgent: 'Feedly/1.0',
    category: 'company',
    language: 'en',
    source_type: 'official',
    official: true,
  },
  {
    name: 'NVIDIA Blog',
    url: 'https://blogs.nvidia.com/feed/',
    category: 'infra',
    language: 'en',
    source_type: 'official',
    official: true,
  },
  {
    name: 'Anthropic',
    // 无RSS（/news/rss.xml 404），新闻列表页为SSR，直接爬取
    type: 'scraper',
    scraper: 'anthropic',
    url: 'https://www.anthropic.com/news', // 列表页URL（爬虫内部使用，此处仅作记录）
    category: 'company',
    language: 'en',
    source_type: 'official',
    official: true,
  },

  // === 海外媒体源 ===
  {
    name: 'Hacker News AI',
    url: 'https://hnrss.org/newest?q=AI+OR+LLM+OR+GPT&points=100',
    category: 'technology',
    language: 'en',
    source_type: 'media',
  },
  {
    name: 'TechCrunch AI',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/',
    category: 'technology',
    language: 'en',
    source_type: 'media',
  },
  {
    name: 'The Decoder',
    url: 'https://the-decoder.com/feed/',
    category: 'opinion',
    language: 'en',
    source_type: 'media',
  },
  {
    name: 'Crunchbase News',
    url: 'https://news.crunchbase.com/feed/',
    // 该站对浏览器UA返回403（Cloudflare反爬），对feed阅读器UA放行，实测 Feedly/1.0 可用
    userAgent: 'Feedly/1.0',
    category: 'funding',
    language: 'en',
    source_type: 'media',
  },
  {
    name: 'The Verge AI',
    url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    category: 'company',
    language: 'en',
    source_type: 'media',
  },
  {
    name: 'Ars Technica AI',
    url: 'https://arstechnica.com/ai/feed/',
    category: 'technology',
    language: 'en',
    source_type: 'media',
  },
  {
    name: 'VentureBeat',
    // AI分类feed(/category/ai/feed)已停更，主站feed内容基本全是AI
    url: 'https://venturebeat.com/feed/',
    category: 'company',
    language: 'en',
    source_type: 'media',
  },
  {
    name: 'MIT Tech Review',
    // 全站feed含非AI内容，靠AI筛选闸门过滤
    url: 'https://www.technologyreview.com/feed/',
    category: 'technology',
    language: 'en',
    source_type: 'media',
  },
  {
    name: 'SemiAnalysis',
    // 算力/芯片/数据中心深度分析第一权威，补infra维度海外信源短板；
    // 周更低频长文，2026-07-31 实测拉取+解析验证通过（10条带日期）
    url: 'https://semianalysis.com/feed/',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    category: 'infra',
    language: 'en',
    source_type: 'media',
    alertDays: 7, // 周更节奏，按官方源频率告警
  },

  // === 国内源（直接RSS或自建爬虫，不依赖RSSHub） ===
  {
    name: '机器之心',
    // RSS源(https://www.jiqizhixin.com/rss)已下线(302跳转)，列表页为React SPA，
    // 改为GraphQL接口爬虫
    type: 'scraper',
    scraper: 'jiqizhixin',
    url: 'https://www.jiqizhixin.com/articles', // 列表页URL（爬虫内部使用，此处仅作记录）
    category: 'technology',
    language: 'zh',
    source_type: 'media',
  },
  {
    name: '量子位',
    // RSS源(https://www.qbitai.com/feed)实测不可用，改为HTML爬虫抓取列表页
    type: 'scraper',
    scraper: 'qbitai',
    url: 'https://www.qbitai.com/category/资讯', // 列表页URL（爬虫内部使用，此处仅作记录）
    category: 'technology',
    language: 'zh',
    source_type: 'media',
  },
  {
    name: '雷峰网',
    // 大厂动态覆盖全，补国内头部公司信源短板；量大(20条/72h)，靠AI筛选闸门过滤
    url: 'https://www.leiphone.com/feed',
    category: 'company',
    language: 'zh',
    source_type: 'media',
  },
  {
    name: '智东西',
    // RSS(zhidx.com/feed)已坏(HTTP 500)，列表页SSR但无日期，两级爬取（列表+详情页取日期）
    type: 'scraper',
    scraper: 'zhidx',
    url: 'https://zhidx.com/p/category/人工智能', // 列表页URL（爬虫内部使用，此处仅作记录）
    category: 'company',
    language: 'zh',
    source_type: 'media',
  },
  {
    name: '芯东西',
    // 智东西子刊，芯片/算力专业内容，补infra维度国内信源
    type: 'scraper',
    scraper: 'xindongxi',
    url: 'https://zhidx.com/aichip001', // 列表页URL（爬虫内部使用，此处仅作记录）
    category: 'infra',
    language: 'zh',
    source_type: 'media',
  },
  {
    name: '新智元',
    // 头部AI媒体，突发快讯+大佬推特/访谈转述覆盖强（补X信源盲区，如黄仁勋推文类新闻）；
    // 官网RSS已坏(HTTP 500)，改HTML爬虫，2026-07-31 实测列表页+翻页验证通过（20条带ISO日期）
    type: 'scraper',
    scraper: 'xinzhiyuan',
    url: 'https://aiera.com.cn/', // 列表页URL（爬虫内部使用，此处仅作记录）
    category: 'company',
    language: 'zh',
    source_type: 'media',
  },
  {
    name: '极客公园',
    // 老牌科技媒体，AI内容浓度高（实测83%）；深度实测类文章（AI硬件/应用评测）补国内源短板；
    // 多新闻快讯聚合条目（极客早知道）与量子位/新智元重叠，靠事件簇去重+衍生稿封顶自然压制；
    // 2026-08-09 实测默认UA拉取+解析通过（30条带ISO日期）
    url: 'https://www.geekpark.net/rss',
    category: 'technology',
    language: 'zh',
    source_type: 'media',
  },

  // === 政策源（policy维度专职信源，2026-07-29 实测拉取+解析验证通过） ===
  {
    name: 'The Hill Tech',
    // 美国国会/立法/监管动态，非AI内容靠AI筛选闸门过滤
    // 2026-08-11 弃RSS改直连：RSS有5-9小时滞后致当日稿漏收，改走WP REST API（见scraper-thehill.mjs）
    type: 'scraper',
    scraper: 'thehill',
    url: 'https://thehill.com/policy/technology/',
    category: 'policy',
    language: 'en',
    source_type: 'media',
  },
  {
    name: 'Politico Tech',
    // 美国科技政策专业报道，AI监管浓度高；实测需浏览器UA
    url: 'https://rss.politico.com/technology.xml',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    category: 'policy',
    language: 'en',
    source_type: 'media',
  },
  {
    name: 'EU Digital Strategy',
    // 欧盟委员会数字战略官网官方feed（AI Act执法/罚单/指南一手信息）；
    // /en/news-redirect/rss.xml 返回500，/en/rss.xml 实测可用（需浏览器UA）
    url: 'https://digital-strategy.ec.europa.eu/en/rss.xml',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    category: 'policy',
    language: 'en',
    source_type: 'official',
    official: true, // 官方低频源：无日期条目放行
  },
  {
    name: '网信办',
    // 中国AI政策一手源（补中国政策信源空白，2026-08-07）：生成式AI/深度合成/算法备案公告、
    // AI治理办法征求意见稿、法规规章均在此发布。无RSS，自爬两个静态栏目页（网信发布+政策法规），
    // 非AI条目靠AI筛选闸门过滤。更新频率中低（周级），按官方源告警阈值放宽。
    type: 'scraper',
    scraper: 'cac',
    url: 'https://www.cac.gov.cn/wxzw/wxfb/A093702index_1.htm', // 列表页URL（爬虫内部使用，此处仅作记录）
    category: 'policy',
    language: 'zh',
    source_type: 'official',
    official: true,
    alertDays: 7,
  },
  {
    name: '工信部',
    // 中国工信领域政策一手源（2026-08-07）：AI/电信/数据类政策文件、行业标准征求意见。
    // 页面JS渲染，走search-front-server搜索接口（官方文件发布页的底层数据源）。
    // 非AI条目靠AI筛选闸门过滤。
    type: 'scraper',
    scraper: 'miit',
    url: 'https://www.miit.gov.cn/zwgk/zcwj/wjfb/index.html', // 仅作记录，爬虫内部调API
    category: 'policy',
    language: 'zh',
    source_type: 'official',
    official: true,
    alertDays: 7,
  },
  {
    name: '国务院',
    // 最高权威政策源（2026-08-10）：“人工智能+”行动意见等国发文件首发地，
    // 部门文件（发改委/科技部/市监总局等）也经政策文件库统一发布。
    // 走政策文件库底层搜索API，国发+部门文件各取最新15条；非AI条目靠AI筛选闸门过滤。
    type: 'scraper',
    scraper: 'gov',
    url: 'https://www.gov.cn/zhengce/zhengcewenjianku/', // 仅作记录，爬虫内部调API
    category: 'policy',
    language: 'zh',
    source_type: 'official',
    official: true,
    alertDays: 7,
  },
  {
    name: 'TC260',
    // 全国信息安全标准化技术委员会（2026-08-10）：AI安全标准事实基准，
    // 《生成式人工智能服务安全基本要求》等大模型合规依据均出自该委。
    // 首页SSR静态块，征求意见稿/标准发布公告AI浓度最高；非AI条目靠AI筛选闸门过滤。
    type: 'scraper',
    scraper: 'tc260',
    url: 'https://www.tc260.org.cn/', // 仅作记录，爬虫内部抓首页
    category: 'policy',
    language: 'zh',
    source_type: 'official',
    official: true,
    alertDays: 7,
  },
  {
    name: '国家数据局',
    // 数据要素×AI政策核心出口（2026-08-10）：行业高质量数据集建设、数据产权登记、
    // 公共数据开发利用等文件在此发布。通知公告栏目（tzgg）政策密度最高，
    // 列表页SSR静态HTML；课题征集/大赛公告等非AI条目靠AI筛选闸门过滤。
    type: 'scraper',
    scraper: 'nda',
    url: 'https://www.nda.gov.cn/sjj/zwgk/tzgg/list/index_pc_1.html', // 仅作记录，爬虫内部使用
    category: 'policy',
    language: 'zh',
    source_type: 'official',
    official: true,
    alertDays: 7,
  },
];

// 7个分类定义
export const CATEGORIES = [
  { key: 'company', label: '公司动态' },
  { key: 'technology', label: '技术突破' },
  { key: 'opensource', label: '开源项目' },
  { key: 'funding', label: '融资' },
  { key: 'opinion', label: '观点' },
  { key: 'policy', label: '政策' },
  { key: 'infra', label: '算力基建' },
];

/**
 * 信源健康告警阈值（连续0产出天数）：
 * 官方博客低频发布（OpenAI可能一周不发）放宽到7天，媒体源日更为常态取3天；
 * 个别源可在配置里用 alertDays 覆盖
 */
export function alertThreshold(source) {
  return source.alertDays || (source.source_type === 'official' ? 7 : 3);
}
