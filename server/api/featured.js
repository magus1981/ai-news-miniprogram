/**
 * GET /api/featured?date=YYYY-MM-DD
 * 返回指定日期的精选文章（今日必读）
 */
const { getDB } = require('../lib/db');

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const db = getDB();
    const date = req.query.date || new Date().toISOString().split('T')[0];

    const result = await db.execute({
      sql: `SELECT id, title, original_title, source_name, source_url, category, summary, ai_score, published_at
            FROM articles 
            WHERE date_key = ? AND is_featured = 1
            ORDER BY ai_score DESC`,
      args: [date],
    });

    const articles = result.rows.map(row => ({
      id: row.id,
      title: row.title,
      original_title: row.original_title,
      source_name: row.source_name,
      source_url: row.source_url,
      category: row.category,
      summary: row.summary,
      ai_score: row.ai_score,
      published_at: row.published_at,
    }));

    res.status(200).json({
      date,
      count: articles.length,
      articles,
    });

  } catch (err) {
    console.error('featured API error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
