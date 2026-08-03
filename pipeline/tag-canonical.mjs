/**
 * 实体别名归一表（制度性保障：采集时归一 + 存量回填，一次性根治标签碎片化）
 *
 * 设计原则：
 * 1. 中文优先——有通用中文名的实体统一用中文（微软/英伟达/谷歌…），
 *    无通用中文惯用名的保留英文（OpenAI/Anthropic/SSI…）。
 * 2. 精确别名匹配（大小写不敏感），绝不做子串/模糊匹配，
 *    避免把不同实体误并（如 蚂蚁集团 ≠ 阿里巴巴，Mistral AI ≠ Meta）。
 * 3. 词典以 “规范名 -> [别名...]” 声明，规范名本身也自动纳入别名（用于修正大小写）。
 * 4. 集团归并的主力在AI打标提示词（TAGS_SPEC：按内容理解把子品牌归到母公司），
 *    本词典是确定性兜底——只收录高频、无歧义的子品牌别名，枚举不求穷尽。
 * 5. 公司、人物、区域标签均为白名单制：词典即花名册，未命中不入库；
 *    新公司/新人物/新国别需先在这里加入名单，下一轮采集才会打标。
 *    区域维度只收国家/地区级条目，城市名走别名归并到所属国（伦敦→英国）。
 */

// 公司/机构：规范名 -> 别名列表
// 子品牌上卷策略：子品牌/产品线/事业部/研究院/云部门/全资子公司统一归到母公司名下
// （如 阿里云->阿里巴巴、AWS->亚马逊、Azure->微软、DeepMind->谷歌）；
// 仅投资/参股关系的独立公司不归并（蚂蚁集团、月之暗面等单列）
const COMPANY_ALIASES = {
  '微软': ['Microsoft', 'MSFT', 'Azure', 'Microsoft Azure', 'GitHub', 'LinkedIn', 'Microsoft Research'],
  '英伟达': ['NVIDIA', 'Nvidia', 'nVidia'],
  '谷歌': ['Google', 'Alphabet', 'Google Cloud', 'GCP', 'Google DeepMind', 'DeepMind', 'YouTube', 'Waymo'],
  '苹果': ['Apple'],
  '亚马逊': ['Amazon', 'AWS', 'Amazon Web Services'],
  '华为': ['Huawei', '昇腾', 'Ascend', '鸿蒙', 'HarmonyOS', '海思', 'HiSilicon', '华为云'],
  '百度': ['Baidu', '文心', '文心一言', 'ERNIE', '百度智能云', '萝卜快跑', 'Apollo Go'],
  '阿里巴巴': ['Alibaba', '阿里', 'Alibaba Group', '阿里云', 'Alibaba Cloud', 'Aliyun', 'Qoder', '阿里Qoder', '通义', '通义千问', 'Qwen', '达摩院', 'DAMO Academy', '平头哥', 'T-Head', '夸克', 'Quark', '钉钉', 'DingTalk', '菜鸟', 'Cainiao', '高德', '淘宝', '天猫', '淘天', '淘天集团'],
  '腾讯': ['Tencent', '微信', 'WeChat', '腾讯云', 'Tencent Cloud', '混元', 'Hunyuan', '腾讯元宝'],
  '字节跳动': ['ByteDance', 'Bytedance', '字节', '抖音', 'TikTok', 'Douyin', '豆包', 'Doubao', '火山引擎', 'Volcano Engine', '剪映', 'Coze', '扣子', '即梦'],
  '特斯拉': ['Tesla'],
  '小米': ['Xiaomi'],
  '英特尔': ['Intel'],
  '高通': ['Qualcomm'],
  '三星': ['Samsung'],
  '甲骨文': ['Oracle'],
  '商汤': ['SenseTime', '商汤科技'],
  '科大讯飞': ['iFlytek', 'iFLYTEK'],
  '深信服': ['Sangfor', 'Sangfor Technologies', '深信服科技'],
  '月之暗面': ['Moonshot AI', 'Moonshot', 'Kimi'],
  '智谱AI': ['Zhipu AI', 'Zhipu', 'Z.ai', '智谱', '智谱清言'],
  '蚂蚁集团': ['Ant Group', '蚂蚁', '蚂蚁金服', '蚂蚁百灵'],
  '360集团': ['360', '奇虎360', 'Qihoo 360'],
  '小红书': ['Xiaohongshu', 'RED', 'rednote'],
  '昆仑万维': ['Kunlun Wanwei', 'Kunlun Tech', 'Skywork'],
  '宇树科技': ['Unitree', 'Unitree Robotics', '宇树'],
  '智元机器人': ['Agibot', 'AgiBot', '智元'],
  '阶跃星辰': ['StepFun', 'Step Fun'],
  '零一万物': ['01.AI', '01AI'],
  '百川智能': ['Baichuan', 'Baichuan AI'],
  '面壁智能': ['ModelBest', 'MiniCPM'],
  '上海人工智能实验室': ['Shanghai AI Laboratory', 'Shanghai AI Lab', '上海AI实验室', 'InternLM', '书生'],
  '中科院': ['中国科学院', 'Chinese Academy of Sciences', 'CAS'],
  '博通': ['Broadcom'],
  '台积电': ['TSMC'],
  '阿斯麦': ['ASML'],
  '中芯国际': ['SMIC'],
  '寒武纪': ['Cambricon'],
  '摩尔线程': ['Moore Threads'],
  // 无通用中文惯用名，保留英文（仅修正大小写/写法）
  'OpenAI': ['Open AI', 'openai'],
  'Anthropic': [],
  'DeepSeek': ['Deepseek', 'deepseek'],
  'Meta': ['Meta AI', 'Facebook'],
  'Mistral AI': ['Mistral'],
  'Hugging Face': ['HuggingFace'],
  'xAI': ['X.ai', 'X AI'],
  'Stability AI': ['StabilityAI'],
  'SSI': ['Safe Superintelligence', 'Safe Superintelligence Inc'],
  'SK Hynix': ['SK hynix', 'SKHynix'],
  'AMD': [],
  'IBM': [],
  'MiniMax': ['稀宇科技'],
  'Perplexity': ['Perplexity AI'],
  'Midjourney': [],
  'Runway': ['RunwayML'],
  'Cursor': ['Anysphere'],
  'Cognition': ['Cognition AI', 'Cognition Labs', 'Devin'],
  'Databricks': [],
  'Snowflake': [],
  'Scale AI': [],
  'Salesforce': [],
  'Adobe': [],
  'Groq': [],
  'Cerebras': ['Cerebras Systems'],
  'Arm': ['ARM'],
  'OPPO': ['oppo'],
  'vivo': ['Vivo', 'VIVO'],
  'Figure AI': ['Figure'],
  'METR': [],
};

// 人物：规范名 -> 别名列表（中文惯用名用中文，英文惯用名保留英文）
const PERSON_ALIASES = {
  '黄仁勋': ['Jensen Huang', 'Huang Renxun'],
  '马斯克': ['Elon Musk', 'Musk', '埃隆·马斯克', '埃隆马斯克'],
  '李彦宏': ['Robin Li'],
  '雷军': ['Lei Jun'],
  '扎克伯格': ['Mark Zuckerberg', 'Zuckerberg'],
  '梁文锋': ['Liang Wenfeng', '梁文峰'],
  'Sam Altman': ['Sam altman', 'Altman'],
  'Demis Hassabis': ['Hassabis'],
  'Dario Amodei': ['Amodei'],
  'Ilya Sutskever': ['Ilya'],
  'Clément Delangue': ['Clement Delangue', 'Clem Delangue', 'Delangue'],
  // 大厂掌门（中文优先）
  '库克': ['Tim Cook'],
  '纳德拉': ['Satya Nadella', 'Nadella'],
  '皮查伊': ['Sundar Pichai', 'Pichai'],
  // 学术界/安全派意见领袖
  '杨立昆': ['Yann LeCun', 'LeCun'],
  '辛顿': ['Geoffrey Hinton', 'Hinton'],
  '萨顿': ['Richard Sutton', 'Rich Sutton', 'Sutton'],
  '李飞飞': ['Fei-Fei Li', 'Feifei Li', 'Li Feifei'],
  '吴恩达': ['Andrew Ng'],
  '陶哲轩': ['Terence Tao', 'Terry Tao'],
  'Jeff Dean': ['Jeff dean', 'Dean'],
  // 国内新锐创始人
  '杨植麟': ['Yang Zhilin', 'Zhilin Yang'],
  '唐杰': ['Tang Jie'],
  '李开复': ['Kai-Fu Lee', 'Kaifu Lee'],
  '王小川': ['Wang Xiaochuan'],
  '周鸿祎': ['Zhou Hongyi'],
  '王兴兴': ['Wang Xingxing'],
  '任正非': ['Ren Zhengfei'],
};

// 区域：规范名 -> 别名列表（白名单制：词典即国别花名册，未命中不入库）
// 只收国家/地区级条目；城市名作为别名归并到所属国（如 伦敦→英国），
// 避免城市与国别混在同一维度里（曾出现 404 文章同时挂"英国""伦敦"两个标签）
const REGION_ALIASES = {
  '中国': ['China', 'PRC', '中国大陆', '北京', '上海', '深圳', '杭州'],
  '美国': ['US', 'USA', 'U.S.', 'United States', 'America', '硅谷', '华盛顿', '纽约', '加州', '旧金山', '西雅图'],
  '欧盟': ['EU', 'European Union', '布鲁塞尔'],
  '英国': ['UK', 'United Kingdom', 'Britain', '伦敦', 'London'],
  '日本': ['Japan', '东京'],
  '韩国': ['South Korea', 'Korea', '首尔'],
  '印度': ['India', '新德里', '德里'],
  '新加坡': ['Singapore'],
  '德国': ['Germany'],
  '法国': ['France', '巴黎'],
  '加拿大': ['Canada'],
  '俄罗斯': ['Russia'],
  '澳大利亚': ['Australia'],
  '以色列': ['Israel'],
  '沙特': ['Saudi Arabia', '沙特阿拉伯'],
  '阿联酋': ['UAE', 'United Arab Emirates', '迪拜'],
  '巴基斯坦': ['Pakistan'],
};

/**
 * 由 “规范名 -> [别名]” 词典构建 “小写别名 -> 规范名” 反查表，
 * 规范名自身也纳入（修正大小写）。
 */
function buildLookup(aliasDict) {
  const map = new Map();
  for (const [canonical, aliases] of Object.entries(aliasDict)) {
    map.set(canonical.toLowerCase(), canonical);
    for (const a of aliases) map.set(a.toLowerCase(), canonical);
  }
  return map;
}

const LOOKUPS = {
  company: buildLookup(COMPANY_ALIASES),
  person: buildLookup(PERSON_ALIASES),
  region: buildLookup(REGION_ALIASES),
};

/**
 * 归一单个标签名。
 * 公司、人物、区域标签均为白名单制（制度性保障）：
 * - people 以大咖库（PERSON_ALIASES）为准，未命中的路人高管/记者等不入库；
 * - companies 以公司库（COMPANY_ALIASES）为准，未命中的长尾杂牌公司不入库，
 *   避免一次性出场的小公司污染公司标签筛选；新公司需先加入名单再采集。
 * - regions 以国别库（REGION_ALIASES）为准，城市名经别名归并到所属国，
 *   未命中的地名不入库（曾因"未命中原样保留"混入城市标签"伦敦"）。
 * 未命中一律返回空串由调用方过滤。
 * @param {'company'|'person'|'region'|'keyword'} kind
 * @param {string} name
 * @returns {string} 归一后的规范名；company/person/region 未命中词典返回空串
 */
export function canonicalizeName(kind, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return trimmed;
  const lookup = LOOKUPS[kind];
  if (!lookup) return trimmed; // keyword 等不做归一
  const hit = lookup.get(trimmed.toLowerCase());
  if (hit) return hit;
  return (kind === 'person' || kind === 'company' || kind === 'region') ? '' : trimmed;
}

/**
 * 归一整个 tags 对象（companies/people/regions 归一，keywords 原样），
 * 归一后去重、每类最多3个。输入可为对象或已解析的 JSON。
 */
export function canonicalizeTagsObject(tags) {
  const norm = (arr, kind) => Array.isArray(arr)
    ? [...new Set(
        arr.filter(t => typeof t === 'string' && t.trim())
           .map(t => canonicalizeName(kind, t))
           .filter(Boolean) // company/person 白名单未命中返回空串，剔除
      )].slice(0, 3)
    : [];
  return {
    companies: norm(tags?.companies, 'company'),
    people: norm(tags?.people, 'person'),
    keywords: norm(tags?.keywords, 'keyword'),
    regions: norm(tags?.regions, 'region'),
  };
}
