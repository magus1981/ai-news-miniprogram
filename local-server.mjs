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
        SELECT id, title, original_title, source_name, source_url, category, summary, ai_score, published_at
        FROM articles WHERE date_key = ? AND is_featured = 1
        ORDER BY ai_score DESC
      `).all(date);

      return sendJSON(res, 200, { date, count: rows.length, articles: rows });
    }

    // GET /api/articles
    if (pathname === '/api/articles') {
      const date = query.date || new Date().toISOString().split('T')[0];
      const category = query.category;
      const page = Math.max(1, parseInt(query.page) || 1);
      const limit = Math.min(50, parseInt(query.limit) || 20);
      const offset = (page - 1) * limit;

      let rows, total;
      if (category && category !== 'all') {
        total = db.prepare('SELECT COUNT(*) as t FROM articles WHERE date_key = ? AND category = ?').get(date, category).t;
        rows = db.prepare(`
          SELECT id, title, source_name, source_url, category, ai_score, is_featured, published_at
          FROM articles WHERE date_key = ? AND category = ?
          ORDER BY ai_score DESC LIMIT ? OFFSET ?
        `).all(date, category, limit, offset);
      } else {
        total = db.prepare('SELECT COUNT(*) as t FROM articles WHERE date_key = ?').get(date).t;
        rows = db.prepare(`
          SELECT id, title, source_name, source_url, category, ai_score, is_featured, published_at
          FROM articles WHERE date_key = ?
          ORDER BY ai_score DESC LIMIT ? OFFSET ?
        `).all(date, limit, offset);
      }

      const articles = rows.map(r => ({ ...r, is_featured: !!r.is_featured }));
      return sendJSON(res, 200, {
        date, category: category || 'all', page, page_size: limit,
        total, has_more: offset + articles.length < total, articles,
      });
    }

    // GET /api/article/:id
    const articleMatch = pathname.match(/^\/api\/article\/(\d+)$/);
    if (articleMatch) {
      const id = articleMatch[1];
      const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
      if (!row) return sendJSON(res, 404, { error: '文章不存在' });
      return sendJSON(res, 200, { ...row, is_featured: !!row.is_featured });
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
  console.log(`  GET /api/articles?category=&date=&page=`);
  console.log(`  GET /api/article/:id`);
  console.log(`\n小程序开发时请确保此服务器运行中`);
});
