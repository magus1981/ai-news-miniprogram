const { getArticles } = require('../../utils/api');

Page({
  data: {
    tag: '',
    type: 'company', // company / people / keywords
    articles: [],
    total: 0,
    page: 1,
    hasMore: true,
    loading: true,
    loadingMore: false,
    error: '',
  },

  onLoad(options) {
    const tag = options.tag ? decodeURIComponent(options.tag) : '';
    const type = options.type || 'company';
    if (!tag) {
      this.setData({ error: '缺少标签参数', loading: false });
      return;
    }
    this.setData({ tag, type });
    wx.setNavigationBarTitle({ title: `#${tag}` });
    this.loadArticles(1);
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore && !this.data.loading) {
      this.loadArticles(this.data.page + 1);
    }
  },

  async loadArticles(page) {
    const isFirst = page === 1;
    this.setData(isFirst ? { loading: true, error: '' } : { loadingMore: true });

    try {
      // 标签搜索不限日期（跨全部历史）
      const res = await getArticles({ tag: this.data.tag, date: 'all', page });
      const newArticles = res.articles || [];
      this.setData({
        articles: isFirst ? newArticles : [...this.data.articles, ...newArticles],
        total: res.total || 0,
        page,
        hasMore: res.has_more || false,
        loading: false,
        loadingMore: false,
      });
    } catch (err) {
      this.setData({
        loading: false,
        loadingMore: false,
        error: `加载失败: ${(err && err.message) || err}`,
      });
      console.error('标签页加载失败:', err);
    }
  },
});
