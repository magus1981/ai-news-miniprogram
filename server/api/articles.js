/**
 * GET /api/articles?category=&date=&page=&limit=&tag=
 * 分页分类文章列表；tag参数匹配tags JSON任一数组包含该值；date=all 表示不限日期
 */
const { getDB } = require('../lib/db');
const { parseTags, tagLikePattern } = require('../lib/tags');

// related_to 存的是 JSON 字符串，解析失败返回 null（不影响列表）
function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

const PAGE_SIZE = 20;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const db = getDB();
    const { category, date, page = '1', limit, tag } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const pageSize = Math.min(50, parseInt(limit) || PAGE_SIZE);
    const offset = (pageNum - 1) * pageSize;
    const dateKey = date === 'all' ? null : (date || new Date().toISOString().split('T')[0]);

    // 动态拼接WHERE条件
    const where = [`category != 'noise'`]; // 噪音文章不在任何列表展示
    const args = [];
    if (dateKey) { where.push('date_key = ?'); args.push(dateKey); }
    if (category && category !== 'all') { where.push('category = ?'); args.push(category); }
    if (tag) { where.push('tags LIKE ?'); args.push(tagLikePattern(tag)); }
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await db.execute({
      sql: `SELECT id, title, source_name, source_url, category, ai_score, is_featured, is_breaking, is_followup, related_to, published_at, tags
            FROM articles ${whereSQL}
            ORDER BY date_key DESC, ai_score DESC
            LIMIT ? OFFSET ?`,
      args: [...args, pageSize, offset],
    });

    const countResult = await db.execute({
      sql: `SELECT COUNT(*) as total FROM articles ${whereSQL}`,
      args,
    });
    const total = countResult.rows[0]?.total || 0;

    const articles = result.rows.map(row => ({
      id: row.id,
      title: row.title,
      source_name: row.source_name,
      source_url: row.source_url,
      category: row.category,
      ai_score: row.ai_score,
      is_featured: !!row.is_featured,
      is_breaking: !!row.is_breaking,
      is_followup: !!row.is_followup,
      related_to: row.related_to ? safeParseJson(row.related_to) : null,
      published_at: row.published_at,
      tags: parseTags(row.tags),
    }));

    res.status(200).json({
      date: dateKey || 'all',
      category: category || 'all',
      tag: tag || null,
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
