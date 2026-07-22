const { getFeatured, getArticles } = require('../../utils/api');

const CATEGORIES = [
  { key: 'all', label: '全部' },
  { key: 'company', label: '公司动态' },
  { key: 'technology', label: '技术突破' },
  { key: 'opensource', label: '开源项目' },
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
        error: '加载失败，请下拉刷新重试',
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
