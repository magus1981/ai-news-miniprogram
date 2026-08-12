/**
 * GET /api/article/:id
 * 单篇文章详情（含AI总结）
 */
const { getDB } = require('../../lib/db');
const { parseTags, parseKeyPoints } = require('../../lib/tags');

// related_to 存的是 JSON 字符串，解析失败返回 null
function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const db = getDB();
    const { id } = req.query;

    if (!id) {
      return res.status(400).json({ error: '缺少文章ID' });
    }

    const result = await db.execute({
      sql: `SELECT id, title, original_title, source_name, source_url, category, 
                   summary, ai_score, is_featured, is_followup, related_to, published_at, collected_at, date_key, tags, key_points
            FROM articles WHERE id = ?`,
      args: [id],
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '文章不存在' });
    }

    const row = result.rows[0];
    res.status(200).json({
      id: row.id,
      title: row.title,
      original_title: row.original_title,
      source_name: row.source_name,
      source_url: row.source_url,
      category: row.category,
      summary: row.summary,
      ai_score: row.ai_score,
      is_featured: !!row.is_featured,
      is_followup: !!row.is_followup,
      related_to: row.related_to ? safeParseJson(row.related_to) : null,
      published_at: row.published_at,
      collected_at: row.collected_at,
      date_key: row.date_key,
      tags: parseTags(row.tags),
      key_points: parseKeyPoints(row.key_points),
    });

  } catch (err) {
    console.error('article detail API error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
