const { getFeatured, getArticles, getTags, getDates, getCatchup, getArchive } = require('../../utils/api');
const { ensureLastReadAt, stageFrontier } = require('../../utils/readmark');

const CATEGORIES = [
  { key: 'all', label: '全部' },
  { key: 'company', label: '公司' },
  { key: 'technology', label: '技术' },
  { key: 'opensource', label: '开源' },
  { key: 'funding', label: '融资' },
  { key: 'opinion', label: '观点' },
  { key: 'policy', label: '政策' },
  { key: 'infra', label: '基建' },
];

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// 重要性档位（与 fmt.wxs scoreBand / pipeline SCORE_BANDS 口径一致）。
// 筛选语义是多选并集：选「重磅+值得看」就只看这两个档，不选=全部。
const SCORE_BANDS = [
  { min: 90, label: '重磅' },
  { min: 80, label: '重要' },
  { min: 70, label: '值得看' },
];

// 往期重要区的首屏展示条数。不能多：它是补充阅读，一旦比当日日报还长，「今日」就不再是主角了。
// 想多看的人点「再看 N 条」展开，上限是本次已拉取的 ARCHIVE_SHOW*3 条——
// 主动要看和被动刷到是两回事，展开是用户自己的选择，不破坏「今日为主」的默认版面。
const ARCHIVE_SHOW = 8;

// 与管线口径一致：date_key 按北京日分桶（见 pipeline/ai-filter.mjs beijingDayKey）。
// 这里不能用 UTC 日期——北京时间 00:00-08:00 的 UTC 日期还停在前一天，
// 会把昨天的日报当成"今天"（日期标签、isToday、次日箭头全错）。
function todayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// '2026-07-29' -> '7月29日 · 星期三'
function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
  return `${m}月${d}日 · 星期${weekday}`;
}

// 补读区的日期文案：昨天/前天用相对说法（用户脑子里就是这么记的），更早的给具体日期
function relativeDayLabel(dateStr, today) {
  const diff = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dateStr}T00:00:00Z`)) / 86400000
  );
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}月${d}日`;
}

Page({
  data: {
    categories: CATEGORIES,
    activeCategory: 'all',
    featuredArticles: [],   // 全部精选（heroArticle + subFeatured 的来源）
    heroArticle: null,      // 头条（精选第1条）
    subFeatured: [],        // 精选第2-5条
    restArticles: [],       // 非精选文章（全量）
    filteredRest: [],       // 按当前分类筛选后的非精选文章
    intro: '',              // 今日主编导语（可能为空，空时不展示）
    loading: true,
    date: '',
    dateLabel: '',
    error: '',
    hotTags: [], // 热门子标签（仅公司/观点/政策分类显示，横滑条只放Top10）
    allTags: [], // 当前分类的全部子标签（展开面板用，带文章数）
    tagsExpanded: false, // 是否展开全部标签面板
    isToday: true,         // 当前查看的是否今日（决定标题文案与"次日"箭头）
    datePanelVisible: false, // 往期日报面板
    dateList: [],          // 往期日期索引（来自/api/dates，带展示标签）
    hasPrev: false,        // 是否存在更早一期（决定左箭头显隐）
    catchupGroups: [],     // 补读区：漏读文章按发布日分组
    catchupTotal: 0,       // 窗口内漏读总数（可能大于实际展示数）
    catchupShown: 0,       // 实际展示数
    archiveArticles: [],   // 往期重要：比当前日期更早、按重要度排序，随分类联动
    archiveTotal: 0,       // 30天窗口内该分类的往期总数（用于告知还有多少）
    archiveMore: 0,        // 「再看 N 条」的 N：本次已拉取但未展示的条数，0 则不显展开钮
    scoreBandChips: SCORE_BANDS.map(b => (Object.assign({ selected: false }, b))),
    activeBands: [],       // 选中的档位下限列表（空=不筛选）
  },

  onLoad() {
    // 水位线在本次会话内固定，保证补读区不会边看边缩
    this._lastReadAt = ensureLastReadAt();
    this.setDate(todayStr());
    this.loadData();
    this.loadDateIndex(); // 异步预取往期索引，不阻塞首屏
    // 往期区要剔掉补读区已展示的条目，所以等补读区落定后再拉
    this.loadCatchup().then(() => this.loadArchive());
  },

  // 小程序常驻后台，第二天从后台唤起时不会重跑 onLoad——
  // 不主动比对日期的话，用户看到的还是标着「今日必读」的昨天那份日报
  onShow() {
    const today = todayStr();
    if (!this.data.date || !this.data.isToday || this.data.date === today) return;
    this._lastReadAt = ensureLastReadAt();
    this.setDate(today);
    this._archiveCache = {};
    this.loadData();
    this.loadDateIndex();
    this.loadCatchup().then(() => this.loadArchive());
  },

  onPullDownRefresh() {
    this._archiveCache = {};
    Promise.all([
      this.loadData(),
      this.loadCatchup().then(() => this.loadArchive()),
    ]).then(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 每日仅10-20条，一次拉全，无需分页
  async loadData() {
    this.setData({ loading: true, error: '' });
    // 先取时间再发请求：水位线只能代表「渲染出来的这份数据」，
    // 若用请求返回后的时间，恰好在这期间入库的条目就会被白白标成已读
    const loadedAt = new Date().toISOString();

    try {
      const [featuredRes, articlesRes] = await Promise.all([
        getFeatured(this.data.date),
        getArticles({ category: 'all', date: this.data.date, page: 1, limit: 50 }),
      ]);

      const featured = featuredRes.articles || [];
      const featuredIds = new Set(featured.map(a => a.id));
      const rest = (articlesRes.articles || [])
        .filter(a => !featuredIds.has(a.id))
        .sort((a, b) => (b.ai_score || 0) - (a.ai_score || 0));

      const heroArticle = featured[0] || null;
      const subFeatured = featured.slice(1).map((a, i) => (Object.assign({
        rankStr: String(i + 2).padStart(2, '0'),
      }, a)));

      this.setData({
        featuredArticles: featured,
        heroArticle,
        subFeatured,
        restArticles: rest,
        filteredRest: this.filterByCategory(rest, this.data.activeCategory, featured),
        intro: featuredRes.intro || '',
        loading: false,
      });

      // 只有在看今日日报时才推水位：翻往期是在回溯历史，并不代表补读区那几条看过了
      if (this.data.date === todayStr()) stageFrontier(loadedAt);
    } catch (err) {
      this.setData({
        loading: false,
        error: `加载失败: ${(err && err.message) || err}`,
      });
      console.error('加载数据失败:', err);
    }
  },

  // 补读区：按入库时间捞回「上次离开后新增、但发布日已翻页」的文章。
  // 只在看今日日报时出现——翻往期时用户是在主动回溯，再叠一块"你漏了"纯属干扰。
  // 失败时静默保留原样：这是锦上添花的模块，不该把首页拖进错误态。
  async loadCatchup() {
    const today = todayStr();
    if (this.data.date !== today) {
      if (this.data.catchupShown) {
        this.setData({ catchupGroups: [], catchupTotal: 0, catchupShown: 0 });
      }
      return;
    }

    try {
      const res = await getCatchup({ since: this._lastReadAt, before: today });
      const list = res.articles || [];
      // 按发布日分组保住日报的"日感"：合成一锅"未读12条"就分不清哪天的事了。
      // 后端已按 date_key 倒序返回，顺序累加即可成组。
      const groups = [];
      for (const a of list) {
        const last = groups[groups.length - 1];
        if (last && last.date === a.date_key) {
          last.articles.push(a);
        } else {
          groups.push({ date: a.date_key, label: relativeDayLabel(a.date_key, today), articles: [a] });
        }
      }
      this.setData({
        catchupGroups: groups,
        catchupTotal: res.total || list.length,
        catchupShown: list.length,
      });
    } catch (err) {
      console.error('补读列表加载失败:', err);
    }
  },

  // 往期重要：把更早的新闻按重要度回捞到当前分类下面。
  // 动因是子分类的日产量结构性偏低（实测最近 7 天：基建 4 天为 0、观点 3 天为 0），
  // 点进这些栏目就是一片空白，而它们并不是不重要（基建均分 85.1，全库最高）。
  // 必须随分类联动：用户点了「基建」，下面补的也得是基建，否则这一块只是噪音。
  async loadArchive() {
    const { date, activeCategory } = this.data;
    const cacheKey = `${date}|${activeCategory}`;
    if (!this._archiveCache) this._archiveCache = {};

    try {
      if (!this._archiveCache[cacheKey]) {
        // 多取一些：下面要剔掉已在页面上出现过的，剔完还得够 ARCHIVE_SHOW 条
        this._archiveCache[cacheKey] = await getArchive({
          category: activeCategory,
          before: date,
          limit: ARCHIVE_SHOW * 3,
        });
      }
      const res = this._archiveCache[cacheKey];

      // 拉取期间用户可能已经切走了分类/日期，晚到的响应不能盖掉当前视图
      if (this.data.date !== date || this.data.activeCategory !== activeCategory) return;

      // 去重只在「全部」下做，因为补读区也只在「全部」下展示。
      // 无条件去重会把某个分类里最新的那几条一并误剔，而那个分类恰恰最缺内容。
      const shown = new Set();
      if (activeCategory === 'all') {
        for (const g of this.data.catchupGroups) {
          for (const a of g.articles) shown.add(a.id);
        }
      }
      const full = (res.articles || []).filter(a => !shown.has(a.id));
      this._archiveFull = full;
      this._archiveServerTotal = res.total || 0;
      this.renderArchive();
    } catch (err) {
      console.error('往期重要加载失败:', err);
    }
  },

  // 往期区渲染：档位筛选只作用于已拉取到的候选（不重新请求），
  // 未筛选时总数仍用服务端口径，筛选后用筛后长度避免误导
  renderArchive() {
    if (!this._archiveFull) return;
    const full = this.applyBands(this._archiveFull);
    const bandsActive = this.data.activeBands.length > 0;
    this.setData({
      archiveArticles: full.slice(0, ARCHIVE_SHOW),
      archiveTotal: bandsActive ? full.length : (this._archiveServerTotal || 0),
      archiveMore: Math.max(0, full.length - ARCHIVE_SHOW),
    });
  },

  // 往期重要「再看 N 条」：一次性展开本次已拉取的全部（不再请求，列表就在手里）。
  // 切分类/切日期后 loadArchive 会重置回 8 条：展开是对当前视图的一次性选择，不是全局开关。
  onArchiveExpand() {
    if (!this._archiveFull || !this._archiveFull.length) return;
    this.setData({ archiveArticles: this.applyBands(this._archiveFull), archiveMore: 0 });
  },

  // 分类筛选：选具体分类时把精选文章也纳入列表——
  // 头条/精选区不随分类变化，若不纳入，属于该分类的头条文章会在分类列表里"消失"
  // bands 参数必传当前生效的档位：setData 的参数是先求值后生效，
  // 若在求值时读 this.data.activeBands 会拿到点击前的旧值，筛选永远慢一拍
  filterByCategory(list, category, featured, bands) {
    if (category === 'all') return this.applyBands(list, bands);
    const all = (featured || this.data.featuredArticles || []).concat(list);
    return this.applyBands(all
      .filter(a => a.category === category)
      .sort((a, b) => (b.ai_score || 0) - (a.ai_score || 0)), bands);
  },

  // 档位筛选：严格档位区间（重磅=90+、重要=80-89、值得看=70-79），多选并集；
  // 未传 bands 时默认读当前状态，传了则用传入值（避免 setData 求值时序问题）
  applyBands(list, bands) {
    const active = bands || this.data.activeBands;
    if (!active.length) return list;
    return list.filter(a => {
      const s = a.ai_score || 0;
      return active.some(min => s >= min && (min >= 90 || s < min + 10));
    });
  },

  // 档位chip点击（多选切换）：重算当日列表与往期区
  onBandToggle(e) {
    const min = Number(e.currentTarget.dataset.min);
    const bands = this.data.activeBands.slice();
    const idx = bands.indexOf(min);
    if (idx >= 0) bands.splice(idx, 1); else bands.push(min);
    this.setData({
      activeBands: bands,
      scoreBandChips: SCORE_BANDS.map(b => (Object.assign({ selected: bands.indexOf(b.min) >= 0 }, b))),
      filteredRest: this.filterByCategory(this.data.restArticles, this.data.activeCategory, undefined, bands),
    });
    this.renderArchive();
  },

  // 清空档位筛选
  onClearBands() {
    if (!this.data.activeBands.length) return;
    this.setData({
      activeBands: [],
      scoreBandChips: SCORE_BANDS.map(b => (Object.assign({ selected: false }, b))),
      filteredRest: this.filterByCategory(this.data.restArticles, this.data.activeCategory, undefined, []),
    });
    this.renderArchive();
  },

  // 分类筛选（当日列表客户端过滤，往期区需重新请求）
  onCategoryChange(e) {
    const category = e.currentTarget.dataset.key;
    if (category === this.data.activeCategory) return;

    this.setData({
      activeCategory: category,
      filteredRest: this.filterByCategory(this.data.restArticles, category),
    });
    this.updateHotTags();
    this.loadArchive();
  },

  // 头条/精选卡片点击
  onArticleTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}`,
    });
  },

  // 公司/观点/政策分类时加载子标签：横滑条只放Top10保持清爽，
  // 完整名单（白名单制、总量有界）存入allTags供"全部"面板展开——
  // 兼顾"不杂乱"与"任何有新闻的公司都能找到入口"
  async updateHotTags() {
    const { activeCategory } = this.data;
    const key = activeCategory === 'company' ? 'companies'
      : activeCategory === 'opinion' ? 'people'
      : activeCategory === 'policy' ? 'regions'
      : null;

    if (!key) {
      if (this.data.hotTags.length) this.setData({ hotTags: [], allTags: [], tagsExpanded: false });
      return;
    }

    try {
      if (!this._tagsCache) {
        this._tagsCache = await getTags();
      }
      const full = (this._tagsCache[key] || [])
        .map(t => ({ name: t.name, count: t.count, type: activeCategory }));
      this.setData({
        hotTags: full.slice(0, 10),
        allTags: full,
        tagsExpanded: false,
      });
    } catch (err) {
      console.error('热门标签加载失败:', err);
      this.setData({ hotTags: [], allTags: [], tagsExpanded: false });
    }
  },

  // 展开/收起全部标签面板
  onToggleTagsPanel() {
    this.setData({ tagsExpanded: !this.data.tagsExpanded });
  },

  // ===== 往期日报（历史翻看） =====

  // 统一设置当前查看日期（含派生状态），不触发加载
  setDate(dateStr) {
    this.setData({
      date: dateStr,
      dateLabel: formatDateLabel(dateStr),
      isToday: dateStr === todayStr(),
      hasPrev: this.calcHasPrev(dateStr),
    });
  },

  // 是否存在比 dateStr 更早的有内容日期（索引未加载时先显示箭头，点击时再校验）
  calcHasPrev(dateStr) {
    const list = this.data.dateList;
    if (!list.length) return true;
    return list.some(d => d.date < dateStr);
  },

  // 拉取往期索引（倒序），今天无内容也补一项，保证从往期能切回今天
  async loadDateIndex() {
    try {
      const res = await getDates();
      let list = (res.dates || []).map(d => (Object.assign({
        label: formatDateLabel(d.date),
      }, d)));
      const today = todayStr();
      if (!list.some(d => d.date === today)) {
        list = [{ date: today, total: 0, featured: 0, label: formatDateLabel(today) }].concat(list);
      }
      this.setData({ dateList: list, hasPrev: this.calcHasPrev(this.data.date) });
    } catch (err) {
      console.error('往期索引加载失败:', err);
    }
  },

  // 点日期标签打开往期面板（顺手刷新索引，覆盖"跨天后索引过期"场景）
  onDateLabelTap() {
    this.setData({ datePanelVisible: true });
    this.loadDateIndex();
  },

  onCloseDatePanel() {
    this.setData({ datePanelVisible: false });
  },

  // 面板内容区点击拦截（阻止冒泡到遮罩关闭）
  noop() {},

  // 面板选择某天
  onDateSelect(e) {
    const { date } = e.currentTarget.dataset;
    this.setData({ datePanelVisible: false });
    if (!date || date === this.data.date) return;
    this.switchToDate(date);
  },

  // 前一期/后一期箭头（按有内容的日期跳，自动跨过空档日）
  onPrevDay() {
    this.stepDate(-1);
  },
  onNextDay() {
    this.stepDate(1);
  },

  stepDate(dir) {
    const { date, dateList } = this.data;
    if (!dateList.length) return; // 索引未就绪，忽略点击
    // dateList为倒序：前一期=更早=索引+1
    const idx = dateList.findIndex(d => d.date === date);
    let target = null;
    if (idx >= 0) {
      target = dateList[idx + (dir === -1 ? 1 : -1)];
    } else {
      // 当前日期不在索引里（罕见），找最近的一天
      target = dir === -1 ? dateList.find(d => d.date < date) : dateList.slice().reverse().find(d => d.date > date);
    }
    if (target) this.switchToDate(target.date);
  },

  // 切换日期并重载整页（分类筛选保留，标签缓存不受影响——标签页本就是全库口径）
  switchToDate(dateStr) {
    this.setDate(dateStr);
    this.loadData();
    this.loadCatchup().then(() => this.loadArchive()); // 切回今天要把补读区带回，切去往期则负责清空
  },

  // ===== 左右滑动翻页：左滑看昨天，右滑回今天 =====
  // 与箭头/日期面板共用 stepDate，同样跨越空档日、同样受“今天封顶”约束。
  // 阈值取横向位移大于纵向 1.5 倍，避免上下滚动列表时误触发翻页。
  // 横滑区（分类条/标签条/标签面板）起手的手势由 onZoneTouchStart 打标记豁免，
  // 不用 catch 拦截——catch 会把 scroll-view 自身的滚动和点击一并弄死。
  onZoneTouchStart() {
    this._noSwipe = true;
  },

  onTouchStart(e) {
    const t = e.touches[0];
    this._touchStart = { x: t.clientX, y: t.clientY };
  },

  onTouchEnd(e) {
    if (!this._touchStart) return;
    if (this._noSwipe) {
      this._noSwipe = false;
      this._touchStart = null;
      return;
    }
    if (this.data.datePanelVisible) return; // 往期面板打开时不抢手势
    const t = e.changedTouches[0];
    const dx = t.clientX - this._touchStart.x;
    const dy = t.clientY - this._touchStart.y;
    this._touchStart = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0) {
      // 左滑→更早一期
      this.stepDate(-1);
    } else {
      // 右滑→更晚一期；已是今天则提示封顶
      if (this.data.isToday) {
        wx.showToast({ title: '已经是最新一期', icon: 'none' });
        return;
      }
      this.stepDate(1);
    }
  },

  // 热门子标签点击，跳标签归类页
  onHotTagTap(e) {
    const { tag, type } = e.currentTarget.dataset;
    if (!tag) return;
    wx.navigateTo({
      url: `/pages/tag/tag?tag=${encodeURIComponent(tag)}&type=${type || 'company'}`,
    });
  },

  onShareAppMessage() {
    return {
      title: '未竟智能 - 今日精选',
      path: '/pages/home/home',
    };
  },
});
