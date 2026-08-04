const { getFavorites, removeFavorite, getFollowedTags, removeFollowedTag } = require('../../utils/storage');
const { getSourceHealth, getArticles } = require('../../utils/api');

// 标签检索口径与 tag 页 TYPE_MAP 保持一致：
// 公司/人物收全部动态，国别只收政策类（否则该国公司日常会混进"政策动态"）
const TYPE_MAP = {
  company: { tagType: 'companies' },
  companies: { tagType: 'companies' },
  people: { tagType: 'people' },
  opinion: { tagType: 'people' },
  keywords: { tagType: 'keywords' },
  policy: { tagType: 'regions', category: 'policy' },
  regions: { tagType: 'regions', category: 'policy' },
};

// 入口type -> chip上的中文类别
const TYPE_LABEL = {
  company: '公司', companies: '公司',
  people: '人物', opinion: '人物',
  policy: '国别', regions: '国别',
  keywords: '关键词',
};

// 关注动态一次最多拉多少个标签（一个标签一个请求，防请求数爆炸）
const FOLLOW_FETCH_LIMIT = 8;
const FEED_LIMIT = 30;

Page({
  data: {
    activeTab: 'follow', // follow=我的关注 / favorite=我的收藏
    favorites: [],
    followedTags: [],    // 关注的标签（{tag, type, followed_at}）
    followFeed: [],      // 关注动态：各标签最新文章聚合，按日期倒序
    followLoading: false,
    followOverflow: 0,   // 超出拉取上限的标签数（>0 时提示）
    health: null,       // 信源健康总览（null=加载中或失败，失败时整个区块不展示）
    healthExpanded: false, // 默认折叠，只显示总览行
  },

  onShow() {
    // 每次显示时刷新：收藏和关注都可能在别的页面被改动
    const followedTags = getFollowedTags()
      .map(f => (Object.assign({ typeLabel: TYPE_LABEL[f.type] || '标签' }, f)));
    this.setData({ favorites: getFavorites(), followedTags });
    this.loadFollowFeed();
    this.loadHealth();
  },

  onTabChange(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab !== this.data.activeTab) this.setData({ activeTab: tab });
  },

  // 关注动态：每个标签拉最新10条，聚合去重后按日期倒序。
  // 单标签失败静默跳过——动态是聚合视图，缺一角不该整块报错。
  async loadFollowFeed() {
    const tags = this.data.followedTags;
    if (!tags.length) {
      this.setData({ followFeed: [], followOverflow: 0 });
      return;
    }
    this.setData({ followLoading: true, followOverflow: Math.max(0, tags.length - FOLLOW_FETCH_LIMIT) });

    try {
      const requests = tags.slice(0, FOLLOW_FETCH_LIMIT).map(f => {
        const opts = TYPE_MAP[f.type] || {};
        return getArticles({
          tag: f.tag,
          tagType: opts.tagType,
          category: opts.category,
          date: 'all',
          page: 1,
          limit: 10,
        })
          .then(res => (res.articles || []).map(a => (Object.assign({ followTag: f.tag }, a))))
          .catch(() => []);
      });
      const results = await Promise.all(requests);

      // 拉取期间用户可能已切走/取关，晚到的响应不覆盖现状
      if (getFollowedTags().length !== this.data.followedTags.length) return;

      const seen = new Set();
      const feed = [];
      for (const list of results) {
        for (const a of list) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          feed.push(a);
        }
      }
      // 日期倒序为主，同日按重要度——动态流要"新"，不是"榜单"
      feed.sort((a, b) =>
        (b.date_key || '').localeCompare(a.date_key || '') ||
        (b.ai_score || 0) - (a.ai_score || 0)
      );
      this.setData({ followFeed: feed.slice(0, FEED_LIMIT), followLoading: false });
    } catch (err) {
      this.setData({ followLoading: false });
      console.error('关注动态加载失败:', err);
    }
  },

  // 标签chip上的✕：取关并刷新动态
  onUnfollowTag(e) {
    const { tag, type } = e.currentTarget.dataset;
    removeFollowedTag(tag, type);
    const followedTags = getFollowedTags()
      .map(f => (Object.assign({ typeLabel: TYPE_LABEL[f.type] || '标签' }, f)));
    this.setData({ followedTags });
    this.loadFollowFeed();
    wx.showToast({ title: '已取消关注', icon: 'none' });
  },

  // 点标签chip -> 标签归类页
  onTagChipTap(e) {
    const { tag, type } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/tag/tag?tag=${encodeURIComponent(tag)}&type=${type || 'company'}`,
    });
  },

  // 信源健康：制度性保障的可见化——某源连续0产出超阈值时在这里亮红提醒
  async loadHealth() {
    try {
      const res = await getSourceHealth();
      const sources = (res.sources || []).map(s => (Object.assign({
        statusText: s.status === 'alert'
          ? `连续 ${s.zero_days} 天无产出`
          : s.status === 'no_data'
            ? '暂无记录'
            : (s.latest_fetched > 0 ? `最近 ${s.latest_fetched} 条` : `${s.zero_days} 天无产出`),
      }, s)));
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
