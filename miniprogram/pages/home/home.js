const { getFeatured, getArticles, getTags } = require('../../utils/api');

const CATEGORIES = [
  { key: 'all', label: '全部' },
  { key: 'company', label: '公司' },
  { key: 'technology', label: '技术' },
  { key: 'opensource', label: '开源' },
  { key: 'funding', label: '融资' },
  { key: 'opinion', label: '观点' },
  { key: 'policy', label: '政策' },
];

Page({
  data: {
    categories: CATEGORIES,
    activeCategory: 'all',
    featuredArticles: [],
    articles: [],
    loading: true,
    loadingMore: false,
    hasMore: true,
    page: 1,
    date: '',
    error: '',
    hotTags: [], // 热门子标签（仅公司/观点分类显示）
  },

  onLoad() {
    const today = new Date().toISOString().split('T')[0];
    this.setData({ date: today });
    this.loadData();
  },

  onPullDownRefresh() {
    this.setData({ page: 1, articles: [], hasMore: true });
    this.loadData().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) {
      this.loadMore();
    }
  },

  async loadData() {
    this.setData({ loading: true, error: '' });

    try {
      // 并行加载精选和列表
      const [featuredRes, articlesRes] = await Promise.all([
        getFeatured(this.data.date),
        getArticles({ category: this.data.activeCategory, date: this.data.date, page: 1 }),
      ]);

      this.setData({
        featuredArticles: featuredRes.articles || [],
        articles: articlesRes.articles || [],
        hasMore: articlesRes.has_more || false,
        page: 1,
        loading: false,
      });
    } catch (err) {
      this.setData({
        loading: false,
        error: `加载失败: ${(err && err.message) || err}`,
      });
      console.error('加载数据失败:', err);
    }
  },

  async loadMore() {
    const nextPage = this.data.page + 1;
    this.setData({ loadingMore: true });

    try {
      const res = await getArticles({
        category: this.data.activeCategory,
        date: this.data.date,
        page: nextPage,
      });

      this.setData({
        articles: [...this.data.articles, ...(res.articles || [])],
        hasMore: res.has_more || false,
        page: nextPage,
        loadingMore: false,
      });
    } catch (err) {
      this.setData({ loadingMore: false });
      console.error('加载更多失败:', err);
    }
  },

  onCategoryChange(e) {
    const category = e.currentTarget.dataset.key;
    if (category === this.data.activeCategory) return;

    this.setData({
      activeCategory: category,
      articles: [],
      page: 1,
      hasMore: true,
    });
    this.loadArticlesByCategory();
    this.updateHotTags();
  },

  // 公司/观点/政策分类时加载热门子标签（Top 10）
  async updateHotTags() {
    const { activeCategory } = this.data;
    const key = activeCategory === 'company' ? 'companies'
      : activeCategory === 'opinion' ? 'people'
      : activeCategory === 'policy' ? 'regions'
      : null;

    if (!key) {
      if (this.data.hotTags.length) this.setData({ hotTags: [] });
      return;
    }

    try {
      if (!this._tagsCache) {
        this._tagsCache = await getTags();
      }
      const list = (this._tagsCache[key] || []).slice(0, 10)
        .map(t => ({ name: t.name, type: activeCategory }));
      this.setData({ hotTags: list });
    } catch (err) {
      console.error('热门标签加载失败:', err);
      this.setData({ hotTags: [] });
    }
  },

  // 热门子标签点击，跳标签归类页
  onHotTagTap(e) {
    const { tag, type } = e.currentTarget.dataset;
    if (!tag) return;
    wx.navigateTo({
      url: `/pages/tag/tag?tag=${encodeURIComponent(tag)}&type=${type || 'company'}`,
    });
  },

  async loadArticlesByCategory() {
    try {
      const res = await getArticles({
        category: this.data.activeCategory,
        date: this.data.date,
        page: 1,
      });

      this.setData({
        articles: res.articles || [],
        hasMore: res.has_more || false,
      });
    } catch (err) {
      console.error('分类加载失败:', err);
    }
  },

  onShareAppMessage() {
    return {
      title: 'AI前沿资讯 - 今日精选',
      path: '/pages/home/home',
    };
  },
});
