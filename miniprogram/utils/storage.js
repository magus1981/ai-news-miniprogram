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

module.exports = {
  getFavorites,
  addFavorite,
  removeFavorite,
  isFavorite,
};
