const { getFavorites, removeFavorite } = require('../../utils/storage');
const { getSourceHealth } = require('../../utils/api');

Page({
  data: {
    favorites: [],
    health: null,       // 信源健康总览（null=加载中或失败，失败时整个区块不展示）
    healthExpanded: false, // 默认折叠，只显示总览行
  },

  onShow() {
    // 每次显示时刷新收藏列表
    this.setData({ favorites: getFavorites() });
    this.loadHealth();
  },

  // 信源健康：制度性保障的可见化——某源连续0产出超阈值时在这里亮红提醒
  async loadHealth() {
    try {
      const res = await getSourceHealth();
      const sources = (res.sources || []).map(s => ({
        ...s,
        statusText: s.status === 'alert'
          ? `连续 ${s.zero_days} 天无产出`
          : s.status === 'no_data'
            ? '暂无记录'
            : (s.latest_fetched > 0 ? `最近 ${s.latest_fetched} 条` : `${s.zero_days} 天无产出`),
      }));
      this.setData({ health: { alertCount: res.alert_count || 0, sources } });
    } catch (err) {
      // 健康接口失败不影响收藏功能，静默隐藏该区块
      this.setData({ health: null });
    }
  },

  onToggleHealth() {
    this.setData({ healthExpanded: !this.data.healthExpanded });
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
