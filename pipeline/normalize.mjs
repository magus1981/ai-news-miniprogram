/**
 * URL / 标题归一化（normalize）
 *
 * 背景（2026-09-29 事故修复）：同一条新闻因 URL 参数差异（utm_* / spm / 尾部斜杠 /
 * www 前缀 / hash）或标题标点/前后缀差异被视为两条，事件去重也拦不住，造成同一天
 * 出现两条《互联网平台价格行为规则》《跨省跨区电力应急调度管理办法》。
 * 归一化函数供采集期批内去重、写库前对照、事后一次性合并脚本共用，保证口径一致。
 *
 * 设计原则：宁可漏合（保留两条）不可误合（把 A 公司 X 事件与 A 公司 Y 事件并掉）。
 * 因此归一化只做**无损**的等价变换：
 *   - URL：小写 host、去 www.、去常见追踪参数、去 hash、去末尾斜杠（非根）。
 *   - 标题：去空白、去装饰性标点、去【】栏目前缀、小写；不做语义改写、不做截断。
 */

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'gclsrc', 'dclid', 'fbclid', 'msclkid', 'twclid', 'igshid',
  'mc_cid', 'mc_eid', 'oly_anon_id', 'oly_enc_id',
  'spm', 'scm', 'from', 'ref', 'ref_src', 'refer', 'referer', 'scene', 'chksm',
  'wxshare', 'share_token', 'share_from', 'shareurl', 'key', 'ascasing', 'ts',
  'via', 'sharer', 'clicktime', 'enterad',
]);

/**
 * URL 归一化。失败回退到"小写去空"以避免抛错。
 * @param {string} u
 * @returns {string}
 */
export function normalizeUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(String(u).trim());
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.protocol = url.protocol.toLowerCase();
    url.hash = '';
    const keep = [];
    for (const [k, v] of url.searchParams.entries()) {
      if (!TRACKING_PARAMS.has(k.toLowerCase())) keep.push([k, v]);
    }
    url.search = keep.length ? '?' + keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
    let s = url.toString();
    // 去掉非根路径末尾斜杠（保留 https://example.com/）
    if (s.endsWith('/') && !/^[a-z]+:\/\/[^/]+\/$/i.test(s)) s = s.slice(0, -1);
    return s;
  } catch {
    return String(u).trim().toLowerCase();
  }
}

/**
 * 标题归一化。用于近重复合并的比对键。
 * 规则：
 *   - 去空白（含全角空格）；
 *   - 去【…】/ […] 装饰性前缀（往往是"早报/独家/快讯"栏目名，不改变事件）；
 *   - 去常见中英文标点（,.:;!?、《》〈〉「」『』""''()（）[]{}—|·~ ～）；
 *   - 转小写。
 * 保留：数字、字母、CJK、"-"号内的语义部分（因为版本号如 V4.1-Flash 有意义）。
 * 但为简化去重键，也一起去掉"-"号；不同标点表述的同一标题合并优先于严格区分版本符号。
 * @param {string} t
 * @returns {string}
 */
export function normalizeTitle(t) {
  if (!t) return '';
  return String(t)
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, '')
    .replace(/[\u3000]/g, '')
    .replace(/[|｜·—～~-]/g, '')
    .replace(/[，。；：、！？""''《》〈〉「」『』()（）\[\]{}<>《》/]/g, '')
    .replace(/[.,;:!?"'()\[\]{}<>/]/g, '')
    .toLowerCase();
}

/**
 * 标题归一化后是否可用来做去重比对。
 * 太短的标题（<8 个归一化字符，如"转发""更新"）不唯一，不能硬合，交给 AI 语义层判断。
 * 与 ai-filter.mjs 里 TITLE_DUP_MIN_LEN=16 的口径不完全一致：
 *   那里是"字面 Dice 相似度阈值"防误合的最小长度，风险是"苹果发布新款Mac vs iPad"；
 *   这里是"完全同字符串直接合并"的最小长度，风险更小（完全同串才合）。
 */
export function isDedupableTitle(normTitle) {
  return typeof normTitle === 'string' && normTitle.length >= 8;
}
