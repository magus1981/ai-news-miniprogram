const { getArticles } = require('../../utils/api');

// 入口type归一化：标签语义决定检索范围——
// 公司/人物是"主体"，收录其全部动态；
// 国别是"治理维度"，只收该国别的政策类文章（否则该国任何公司的日常动态都会混入）
const TYPE_MAP = {
  company: { tagType: 'companies' },
  companies: { tagType: 'companies' },
  people: { tagType: 'people' },
  opinion: { tagType: 'people' },
  keywords: { tagType: 'keywords' },
  policy: { tagType: 'regions', category: 'policy' },
  regions: { tagType: 'regions', category: 'policy' },
};

Page({
  data: {
    tag: '',
    type: 'company', // company / people / keywords / regions
    isRegion: false, // 国别标签：列表仅含政策分类，页头文案不同
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
    this.setData({ tag, type, isRegion: (TYPE_MAP[type] || {}).tagType === 'regions' });
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
      // 标签搜索不限日期（跨全部历史）；按标签类型限定字段与分类
      const opts = TYPE_MAP[this.data.type] || {};
      const res = await getArticles({
        tag: this.data.tag,
        tagType: opts.tagType,
        category: opts.category,
        date: 'all',
        page,
      });
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
