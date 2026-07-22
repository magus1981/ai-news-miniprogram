/**
 * 本地开发API服务器 - 零依赖，直接读取本地SQLite
 * 用法: node local-server.mjs
 * 默认端口: 3000
 */
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3000;
const dbPath = join(__dirname, 'data', 'articles.db');

let db;
try {
  db = new Database(dbPath, { readonly: true });
  console.log(`数据库已连接: ${dbPath}`);
} catch (err) {
  console.error(`无法打开数据库: ${dbPath}`);
  console.error('请先运行: cd pipeline && node collect.mjs --init');
  process.exit(1);
}

// CORS + JSON 响应
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

// 解析URL参数
function parseQuery(url) {
  const params = new URL(url, 'http://localhost').searchParams;
  return Object.fromEntries(params.entries());
}

// 解析tags列为对象（历史数据为JSON对象字符串，解析失败返回null）
function parseTags(raw) {
  if (!raw || raw === '[]') return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return null;
  } catch {
    return null;
  }
}

// 解析key_points列为数组（解析失败返回[]）
function parseKeyPoints(raw) {
  if (!raw || raw === '[]') return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 给列表行附加解析后的tags对象
function withParsedTags(row) {
  return { ...row, tags: parseTags(row.tags), is_featured: !!row.is_featured };
}

// 构造tag的LIKE匹配值：匹配tags JSON里任一数组包含该值，剥离引号/LIKE通配符防注入
function tagLikePattern(tag) {
  const clean = String(tag).replace(/["%_\\]/g, '');
  return `%"${clean}"%`;
}

// 路由处理
function handleRequest(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const query = parseQuery(req.url);

  // OPTIONS预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }

  try {
    // GET /api/featured
    if (pathname === '/api/featured') {
      const date = query.date || new Date().toISOString().split('T')[0];
      const rows = db.prepare(`
        SELECT id, title, original_title, source_name, source_url, category, summary, ai_score, published_at, tags
        FROM articles WHERE date_key = ? AND is_featured = 1
        ORDER BY ai_score DESC
      `).all(date);

      return sendJSON(res, 200, { date, count: rows.length, articles: rows.map(withParsedTags) });
    }

    // GET /api/articles（tag参数与category/date/page可叠加；date=all 表示不限日期）
    if (pathname === '/api/articles') {
      const date = query.date === 'all' ? null : (query.date || new Date().toISOString().split('T')[0]);
      const category = query.category;
      const tag = query.tag;
      const page = Math.max(1, parseInt(query.page) || 1);
      const limit = Math.min(50, parseInt(query.limit) || 20);
      const offset = (page - 1) * limit;

      // 动态拼接WHERE条件
      const where = [];
      const args = [];
      if (date) { where.push('date_key = ?'); args.push(date); }
      if (category && category !== 'all') { where.push('category = ?'); args.push(category); }
      if (tag) { where.push('tags LIKE ?'); args.push(tagLikePattern(tag)); }
      const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const total = db.prepare(`SELECT COUNT(*) as t FROM articles ${whereSQL}`).get(...args).t;
      const rows = db.prepare(`
        SELECT id, title, source_name, source_url, category, ai_score, is_featured, published_at, tags
        FROM articles ${whereSQL}
        ORDER BY date_key DESC, ai_score DESC LIMIT ? OFFSET ?
      `).all(...args, limit, offset);

      const articles = rows.map(withParsedTags);
      return sendJSON(res, 200, {
        date: date || 'all', category: category || 'all', tag: tag || null,
        page, page_size: limit,
        total, has_more: offset + articles.length < total, articles,
      });
    }

    // GET /api/tags（聚合全库tags，按出现次数降序，各取Top 30）
    if (pathname === '/api/tags') {
      const rows = db.prepare(`SELECT tags FROM articles WHERE tags LIKE '{%'`).all();
      const counters = { companies: {}, people: {}, keywords: {}, regions: {} };

      for (const row of rows) {
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

      return sendJSON(res, 200, {
        companies: top(counters.companies),
        people: top(counters.people),
        keywords: top(counters.keywords),
        regions: top(counters.regions),
      });
    }

    // GET /api/article/:id
    const articleMatch = pathname.match(/^\/api\/article\/(\d+)$/);
    if (articleMatch) {
      const id = articleMatch[1];
      const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
      if (!row) return sendJSON(res, 404, { error: '文章不存在' });
      return sendJSON(res, 200, {
        ...row,
        tags: parseTags(row.tags),
        key_points: parseKeyPoints(row.key_points),
        is_featured: !!row.is_featured,
      });
    }

    // 404
    sendJSON(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error('API错误:', err);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
}

const server = createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`\n本地API服务器已启动: http://localhost:${PORT}`);
  console.log(`接口列表:`);
  console.log(`  GET /api/featured?date=YYYY-MM-DD`);
  console.log(`  GET /api/articles?category=&date=&page=&tag=`);
  console.log(`  GET /api/tags`);
  console.log(`  GET /api/article/:id`);
  console.log(`\n小程序开发时请确保此服务器运行中`);
});
