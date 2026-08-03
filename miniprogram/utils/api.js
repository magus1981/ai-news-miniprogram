/**
 * API请求封装
 */
const { apiBase } = require('./config');

/**
 * 通用GET请求
 */
function get(path, params = {}) {
  const query = Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null)
    .map(k => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');

  const url = `${apiBase}${path}${query ? '?' + query : ''}`;

  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: 'GET',
      header: {
        'Content-Type': 'application/json',
        'bypass-tunnel-reminder': 'true',
      },
      success(res) {
        if (res.statusCode === 200) {
          resolve(res.data);
        } else {
          reject(new Error(`API错误: ${res.statusCode}`));
        }
      },
      fail(err) {
        reject(new Error(`网络请求失败: ${err.errMsg}`));
      },
    });
  });
}

/**
 * 获取今日精选
 */
function getFeatured(date) {
  return get('/api/featured', { date });
}

/**
 * 获取文章列表（tag参数可与category/date叠加；date传'all'表示不限日期；
 * tagType限定只在tags的指定字段内精确匹配：companies/people/keywords/regions）
 */
function getArticles({ category, date, page = 1, limit = 20, tag, tagType }) {
  return get('/api/articles', { category, date, page, limit, tag, tag_type: tagType });
}

/**
 * 获取文章详情
 */
function getArticleDetail(id) {
  return get(`/api/article/${id}`);
}

/**
 * 获取标签聚合（companies/people/keywords 各Top 30）
 */
function getTags() {
  return get('/api/tags');
}

/**
 * 获取信源健康总览（各源连续0产出天数/告警状态）
 */
function getSourceHealth() {
  return get('/api/source-health');
}

/**
 * 获取往期日报索引（有内容的日期倒序，含篇数/精选数）
 */
function getDates() {
  return get('/api/dates');
}

/**
 * 获取补读列表：上次离开(since)后才入库、且发布日在 before 之前的文章。
 * 条数由后端按天配额控制（见 local-server.mjs CATCHUP_*）；
 * since 为空时后端直接返回空，不会倒历史存量。
 */
function getCatchup({ since, before }) {
  return get('/api/catchup', { since, before });
}

/**
 * 获取往期重要：比 before 更早的文章，按 ai_score 降序（不是时间序）。
 * category 不传或传 'all' 时不限分类；服务端只往回看 30 天（见 ARCHIVE_WINDOW_DAYS）。
 */
function getArchive({ category, before, limit }) {
  return get('/api/archive', { category, before, limit });
}

module.exports = {
  getFeatured,
  getArticles,
  getArticleDetail,
  getTags,
  getSourceHealth,
  getDates,
  getCatchup,
  getArchive,
};
