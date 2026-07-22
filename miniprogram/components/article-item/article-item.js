Component({
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
