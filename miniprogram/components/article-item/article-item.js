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
  },
});
