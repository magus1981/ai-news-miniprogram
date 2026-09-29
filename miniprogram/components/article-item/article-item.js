Component({
  // 默认 styleIsolation:isolated 会挡住 app.wxss 的全局 .score-badge 档位色，
  // 导致列表里的“值得看/可看”退回系统默认白底黑字、与灰字正文混淆（2026-07-31 定位）。
  // 开 addGlobalClass 让 app.wxss 全局样式进入本组件。
  options: {
    addGlobalClass: true,
  },
  properties: {
    article: {
      type: Object,
      value: {},
    },
  },

  methods: {
    onTap() {
      const { id, degraded, source_url } = this.data.article;
      // 兜底稿没有详情页（未经 AI 加工入库），点了不跳错误页：
      // 复制原文链接让用户能去看原文，并如实告知为什么没有详情页。
      if (degraded) {
        if (source_url) {
          wx.setClipboardData({
            data: source_url,
            success: () => wx.showToast({ title: '未加工原文，链接已复制', icon: 'none' }),
          });
        } else {
          wx.showToast({ title: '未加工原文，暂无详情页', icon: 'none' });
        }
        return;
      }
      wx.navigateTo({
        url: `/pages/detail/detail?id=${id}`,
      });
    },

    // 子标签chip点击（catchtap，不触发卡片跳转）
    onSubtagTap(e) {
      const { tag, type } = e.currentTarget.dataset;
      if (!tag) return;
      wx.navigateTo({
        url: `/pages/tag/tag?tag=${encodeURIComponent(tag)}&type=${type || 'company'}`,
      });
    },
  },
});
