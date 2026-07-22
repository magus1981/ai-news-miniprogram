/**
 * GET /api/articles?category=&date=&page=&limit=
 * 分页分类文章列表
 */
const { getDB } = require('../lib/db');

const PAGE_SIZE = 20;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const db = getDB();
    const { category, date, page = '1', limit } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const pageSize = Math.min(50, parseInt(limit) || PAGE_SIZE);
    const offset = (pageNum - 1) * pageSize;
    const dateKey = date || new Date().toISOString().split('T')[0];

    let sql, args;

    if (category && category !== 'all') {
      sql = `SELECT id, title, source_name, source_url, category, ai_score, is_featured, published_at
             FROM articles 
             WHERE date_key = ? AND category = ?
             ORDER BY ai_score DESC
             LIMIT ? OFFSET ?`;
      args = [dateKey, category, pageSize, offset];
    } else {
      sql = `SELECT id, title, source_name, source_url, category, ai_score, is_featured, published_at
             FROM articles 
             WHERE date_key = ?
             ORDER BY ai_score DESC
             LIMIT ? OFFSET ?`;
      args = [dateKey, pageSize, offset];
    }

    const result = await db.execute({ sql, args });

    // 获取总数
    let countSql, countArgs;
    if (category && category !== 'all') {
      countSql = `SELECT COUNT(*) as total FROM articles WHERE date_key = ? AND category = ?`;
      countArgs = [dateKey, category];
    } else {
      countSql = `SELECT COUNT(*) as total FROM articles WHERE date_key = ?`;
      countArgs = [dateKey];
    }
    const countResult = await db.execute({ sql: countSql, args: countArgs });
    const total = countResult.rows[0]?.total || 0;

    const articles = result.rows.map(row => ({
      id: row.id,
      title: row.title,
      source_name: row.source_name,
      source_url: row.source_url,
      category: row.category,
      ai_score: row.ai_score,
      is_featured: !!row.is_featured,
      published_at: row.published_at,
    }));

    res.status(200).json({
      date: dateKey,
      category: category || 'all',
      page: pageNum,
      page_size: pageSize,
      total,
      has_more: offset + articles.length < total,
      articles,
    });

  } catch (err) {
    console.error('articles API error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
