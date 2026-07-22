/**
 * GET /api/tags
 * 聚合全库tags，返回 companies/people/keywords 各Top 30（按出现文章数降序）
 */
const { getDB } = require('../lib/db');
const { parseTags } = require('../lib/tags');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const db = getDB();
    const result = await db.execute(`SELECT tags FROM articles WHERE tags LIKE '{%'`);

    const counters = { companies: {}, people: {}, keywords: {}, regions: {} };
    for (const row of result.rows) {
      const obj = parseTags(row.tags);
      if (!obj) continue;
      for (const key of Object.keys(counters)) {
        const arr = obj[key];
        if (!Array.isArray(arr)) continue;
        // 同一篇文章内同一标签只计一次
        for (const name of new Set(arr.filter(t => typeof t === 'string' && t.trim()))) {
          const n = name.trim();
          counters[key][n] = (counters[key][n] || 0) + 1;
        }
      }
    }

    const top = (counter) => Object.entries(counter)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 30);

    res.status(200).json({
      companies: top(counters.companies),
      people: top(counters.people),
      keywords: top(counters.keywords),
      regions: top(counters.regions),
    });

  } catch (err) {
    console.error('tags API error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
