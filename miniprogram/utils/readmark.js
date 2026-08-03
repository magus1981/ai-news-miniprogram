/**
 * 阅读水位线（补读区的基准）
 *
 * 记的是「用户已经看到哪个入库时刻为止」，不是「上次打开小程序的时间」。
 * 两者的差别在跨轮采集时会咬人：用户 13:55 进来，页面渲染的是那一刻的数据，
 * 14:00 那批新入库的条目他其实没看见；若按退出时刻(14:05)记水位，这批就被
 * 当成已读、明天的补读区也捞不到——正好复现了我们要修的那个漏读。
 * 所以水位线只推进到「页面拉数据的那一刻」。
 */
const KEY = 'lastReadAt';

// 候选水位：首页每次拉数据时登记，退到后台时才真正提交。
// 页内跳详情页再返回不算离开，否则补读区会在用户点开一条后整块消失。
let pending = '';

function getLastReadAt() {
  try {
    return wx.getStorageSync(KEY) || '';
  } catch (err) {
    return '';
  }
}

// 首次启动没有水位线。此时不能把库里的历史存量当成"未读"整批推给用户，
// 直接以当下为起点——从下一轮采集开始才会有补读内容。
function ensureLastReadAt() {
  const existing = getLastReadAt();
  if (existing) return existing;
  const now = new Date().toISOString();
  try {
    wx.setStorageSync(KEY, now);
  } catch (err) {
    console.error('写入阅读水位线失败:', err);
  }
  return now;
}

// 只许前进，不许后退（会话里多次拉数据时取最靠后的那次）
function stageFrontier(iso) {
  if (iso && iso > pending) pending = iso;
}

function commitFrontier() {
  if (!pending) return;
  try {
    wx.setStorageSync(KEY, pending);
  } catch (err) {
    console.error('提交阅读水位线失败:', err);
  }
  pending = '';
}

module.exports = { getLastReadAt, ensureLastReadAt, stageFrontier, commitFrontier };
