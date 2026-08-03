/**
 * GET /api/tags
 * 聚合tags：companies/people 为白名单制、regions 枚举有限，全量返回；
 * keywords 长尾无界，取 Top 30（均按出现文章数降序）。
 * 计数口径与标签落地页一致：noise 不计入；regions 只统计政策类文章
 * （国别标签页只显示政策类，避免"显示8条、点进去0条"的口径错位）。
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
    const result = await db.execute(`SELECT category, tags FROM articles WHERE tags LIKE '{%' AND category != 'noise'`);

    const counters = { companies: {}, people: {}, keywords: {}, regions: {} };
    for (const row of result.rows) {
      const obj = parseTags(row.tags);
      if (!obj) continue;
      for (const key of Object.keys(counters)) {
        if (key === 'regions' && row.category !== 'policy') continue; // 国别只计政策类
        const arr = obj[key];
        if (!Array.isArray(arr)) continue;
        // 同一篇文章内同一标签只计一次
        for (const name of new Set(arr.filter(t => typeof t === 'string' && t.trim()))) {
          const n = name.trim();
          counters[key][n] = (counters[key][n] || 0) + 1;
        }
      }
    }

    // companies/people 白名单制总量有界，全量返回（前端负责收纳）；keywords 仍截断
    const top = (counter, limit = Infinity) => Object.entries(counter)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, limit);

    res.status(200).json({
      companies: top(counters.companies),
      people: top(counters.people),
      keywords: top(counters.keywords, 30),
      regions: top(counters.regions),
    });

  } catch (err) {
    console.error('tags API error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
