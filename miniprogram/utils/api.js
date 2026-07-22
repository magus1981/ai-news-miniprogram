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
 * 获取文章列表（tag参数可与category/date叠加；date传'all'表示不限日期）
 */
function getArticles({ category, date, page = 1, limit = 20, tag }) {
  return get('/api/articles', { category, date, page, limit, tag });
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

module.exports = {
  getFeatured,
  getArticles,
  getArticleDetail,
  getTags,
};
