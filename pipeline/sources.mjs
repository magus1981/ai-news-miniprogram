/**
 * MVP RSS源配置
 * 海外 3-5 个稳定源 + 国内 1-2 个直接RSS源（不依赖RSSHub）
 */

export const SOURCES = [
  // === 海外源 ===
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
    name: 'OpenAI Blog',
    url: 'https://openai.com/blog/rss.xml',
    category: 'company',
    language: 'en',
    source_type: 'official',
    official: true, // 低频官方源：无日期或日期解析失败的条目放行
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

  // === 国内源（直接RSS，不依赖RSSHub） ===
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
];

// 6个分类定义
export const CATEGORIES = [
  { key: 'company', label: '公司动态' },
  { key: 'technology', label: '技术突破' },
  { key: 'opensource', label: '开源项目' },
  { key: 'funding', label: '融资' },
  { key: 'opinion', label: '观点' },
  { key: 'policy', label: '政策' },
];
