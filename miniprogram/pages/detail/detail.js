const { getArticleDetail } = require('../../utils/api');
const { addFavorite, removeFavorite, isFavorite } = require('../../utils/storage');

Page({
  data: {
    article: null,
    loading: true,
    error: '',
    isFavorited: false,
  },

  onLoad(options) {
    const { id } = options;
    if (!id) {
      this.setData({ error: '参数错误', loading: false });
      return;
    }
    this.articleId = id;
    this.setData({ isFavorited: isFavorite(Number(id)) });
    this.loadDetail(id);
  },

  async loadDetail(id) {
    try {
      const article = await getArticleDetail(id);
      this.setData({ article, loading: false });
      wx.setNavigationBarTitle({ title: article.source_name || '文章详情' });
    } catch (err) {
      this.setData({ error: '加载失败', loading: false });
      console.error('加载详情失败:', err);
    }
  },

  // 子标签chip点击，跳标签归类页
  onTagTap(e) {
    const { tag, type } = e.currentTarget.dataset;
    if (!tag) return;
    wx.navigateTo({
      url: `/pages/tag/tag?tag=${encodeURIComponent(tag)}&type=${type || 'company'}`,
    });
  },

  // 此前相关报道点击，跳对应详情页
  onRelatedTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  // 收藏/取消收藏
  toggleFavorite() {    const { article, isFavorited } = this.data;
    if (!article) return;

    if (isFavorited) {
      removeFavorite(article.id);
      this.setData({ isFavorited: false });
      wx.showToast({ title: '已取消收藏', icon: 'none' });
    } else {
      addFavorite(article);
      this.setData({ isFavorited: true });
      wx.showToast({ title: '已收藏', icon: 'success' });
    }
  },

  // 阅读原文
  openOriginal() {
    const { article } = this.data;
    if (!article || !article.source_url) return;

    wx.setClipboardData({
      data: article.source_url,
      success() {
        wx.showToast({ title: '链接已复制，请在浏览器打开', icon: 'none', duration: 2000 });
      },
    });
  },

  // 分享
  onShareAppMessage() {
    const { article } = this.data;
    return {
      title: article ? article.title : 'AI前沿资讯',
      path: `/pages/detail/detail?id=${this.articleId}`,
    };
  },
});
