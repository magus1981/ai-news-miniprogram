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
      const { id } = this.data.article;
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
