/**
 * 本地收藏管理 (wx.Storage)
 */

const STORAGE_KEY = 'favorites';

/**
 * 获取所有收藏
 */
function getFavorites() {
  try {
    return wx.getStorageSync(STORAGE_KEY) || [];
  } catch (e) {
    return [];
  }
}

/**
 * 添加收藏
 */
function addFavorite(article) {
  const favorites = getFavorites();
  // 防止重复
  if (favorites.some(f => f.id === article.id)) {
    return false;
  }
  favorites.unshift({
    id: article.id,
    title: article.title,
    source_name: article.source_name,
    category: article.category,
    source_url: article.source_url,
    saved_at: new Date().toISOString(),
  });
  wx.setStorageSync(STORAGE_KEY, favorites);
  return true;
}

/**
 * 取消收藏
 */
function removeFavorite(id) {
  let favorites = getFavorites();
  favorites = favorites.filter(f => f.id !== id);
  wx.setStorageSync(STORAGE_KEY, favorites);
}

/**
 * 检查是否已收藏
 */
function isFavorite(id) {
  const favorites = getFavorites();
  return favorites.some(f => f.id === id);
}

// ===== 标签关注（与收藏同源不同道：收藏留文章，关注留"实体"） =====
// type 沿用标签页口径：company/people/keywords/regions，与 tag 页 TYPE_MAP 直接对接
const FOLLOW_KEY = 'followed_tags';

function getFollowedTags() {
  try {
    return wx.getStorageSync(FOLLOW_KEY) || [];
  } catch (e) {
    return [];
  }
}

function addFollowedTag(tag, type) {
  const list = getFollowedTags();
  if (list.some(f => f.tag === tag && f.type === type)) return false;
  list.unshift({ tag, type, followed_at: new Date().toISOString() });
  wx.setStorageSync(FOLLOW_KEY, list);
  return true;
}

function removeFollowedTag(tag, type) {
  const list = getFollowedTags().filter(f => !(f.tag === tag && f.type === type));
  wx.setStorageSync(FOLLOW_KEY, list);
}

function isFollowedTag(tag, type) {
  return getFollowedTags().some(f => f.tag === tag && f.type === type);
}

module.exports = {
  getFavorites,
  addFavorite,
  removeFavorite,
  isFavorite,
  getFollowedTags,
  addFollowedTag,
  removeFollowedTag,
  isFollowedTag,
};
