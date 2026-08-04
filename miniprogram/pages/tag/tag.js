const { getArticles } = require('../../utils/api');
const { addFollowedTag, removeFollowedTag, isFollowedTag } = require('../../utils/storage');

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

// 重要性档位（与首页/管线口径一致），多选并集，不选=全部。
// 标签页历史会越积越多，筛选走服务端（min_scores），不是客户端切已加载列表
const SCORE_BANDS = [
  { min: 90, label: '重磅' },
  { min: 80, label: '重要' },
  { min: 70, label: '值得看' },
];

Page({
  data: {
    tag: '',
    type: 'company', // company / people / keywords / regions
    isRegion: false, // 国别标签：列表仅含政策分类，页头文案不同
    isFollowed: false, // 当前标签是否已关注
    articles: [],
    total: 0,
    page: 1,
    hasMore: true,
    loading: true,
    loadingMore: false,
    error: '',
    scoreBandChips: SCORE_BANDS.map(b => (Object.assign({ selected: false }, b))),
    activeBands: [], // 选中的档位下限（空=不筛选）
  },

  onLoad(options) {
    const tag = options.tag ? decodeURIComponent(options.tag) : '';
    const type = options.type || 'company';
    if (!tag) {
      this.setData({ error: '缺少标签参数', loading: false });
      return;
    }
    this.setData({
      tag, type, isRegion: (TYPE_MAP[type] || {}).tagType === 'regions',
      isFollowed: isFollowedTag(tag, type),
    });
    wx.setNavigationBarTitle({ title: `#${tag}` });
    this.loadArticles(1);
  },

  onShow() {
    // 从关注入口跳过来可能已取关，回来同步按钮状态
    if (this.data.tag) {
      this.setData({ isFollowed: isFollowedTag(this.data.tag, this.data.type) });
    }
  },

  // 关注/取关当前标签
  onToggleFollow() {
    const { tag, type, isFollowed } = this.data;
    if (isFollowed) {
      removeFollowedTag(tag, type);
      this.setData({ isFollowed: false });
      wx.showToast({ title: '已取消关注', icon: 'none' });
    } else {
      addFollowedTag(tag, type);
      this.setData({ isFollowed: true });
      wx.showToast({ title: '已关注，可在“我的”查看动态', icon: 'none' });
    }
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore && !this.data.loading) {
      this.loadArticles(this.data.page + 1);
    }
  },

  // 档位chip点击（多选）：重新从服务端拉第1页
  onBandToggle(e) {
    const min = Number(e.currentTarget.dataset.min);
    const bands = this.data.activeBands.slice();
    const idx = bands.indexOf(min);
    if (idx >= 0) bands.splice(idx, 1); else bands.push(min);
    this.setData({
      activeBands: bands,
      scoreBandChips: SCORE_BANDS.map(b => (Object.assign({ selected: bands.indexOf(b.min) >= 0 }, b))),
    });
    this.loadArticles(1);
  },

  onClearBands() {
    if (!this.data.activeBands.length) return;
    this.setData({
      activeBands: [],
      scoreBandChips: SCORE_BANDS.map(b => (Object.assign({ selected: false }, b))),
    });
    this.loadArticles(1);
  },

  async loadArticles(page) {
    const isFirst = page === 1;
    this.setData(isFirst ? { loading: true, error: '' } : { loadingMore: true });

    try {
      // 标签搜索不限日期（跨全部历史）；按标签类型限定字段与分类；带上档位筛选
      const opts = TYPE_MAP[this.data.type] || {};
      const res = await getArticles({
        tag: this.data.tag,
        tagType: opts.tagType,
        category: opts.category,
        date: 'all',
        page,
        minScores: this.data.activeBands,
      });
      const newArticles = res.articles || [];
      this.setData({
        articles: isFirst ? newArticles : this.data.articles.concat(newArticles),
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
