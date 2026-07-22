const { getFavorites, removeFavorite } = require('../../utils/storage');

Page({
  data: {
    favorites: [],
  },

  onShow() {
    // 每次显示时刷新收藏列表
    this.setData({ favorites: getFavorites() });
  },

  // 点击收藏项 -> 进入详情
  onTapArticle(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}`,
    });
  },

  // 取消收藏
  onRemoveFavorite(e) {
    const { id } = e.currentTarget.dataset;
    removeFavorite(id);
    this.setData({ favorites: getFavorites() });
    wx.showToast({ title: '已取消收藏', icon: 'none' });
  },
});
