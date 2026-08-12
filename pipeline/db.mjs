/**
 * 数据库连接与写入
 * 本地模式：TURSO_URL未设置时，使用本地SQLite文件（零注册）
 * 云端模式：设置TURSO_URL后，使用Turso云数据库
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TURSO_URL = process.env.TURSO_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const LOCAL_MODE = !TURSO_URL;

let db;

if (LOCAL_MODE) {
  // 本地模式：使用 better-sqlite3
  const Database = (await import('better-sqlite3')).default;
  const dbPath = join(__dirname, '..', 'data', 'articles.db');
  // 确保data目录存在
  const { mkdirSync } = await import('fs');
  mkdirSync(join(__dirname, '..', 'data'), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  console.log(`本地模式: 数据库文件 ${dbPath}`);
} else {
  // 云端模式：使用 Turso
  const { createClient } = await import('@libsql/client');
  db = createClient({ url: TURSO_URL, authToken: TURSO_AUTH_TOKEN });
  console.log('云端模式: Turso');
}

/**
 * 初始化数据表
 */
export async function initDB() {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      original_title TEXT,
      source_name TEXT NOT NULL,
      source_url TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      summary TEXT,
      ai_score REAL,
      is_featured INTEGER DEFAULT 0,
      is_breaking INTEGER DEFAULT 0,
      published_at TEXT NOT NULL,
      collected_at TEXT DEFAULT (datetime('now')),
      date_key TEXT NOT NULL
    )`;
  const idx1 = `CREATE INDEX IF NOT EXISTS idx_date_category ON articles(date_key, category)`;
  const idx2 = `CREATE INDEX IF NOT EXISTS idx_featured ON articles(date_key, is_featured)`;
  // 每日元信息（主编导语等），一天一行
  const createMetaSQL = `
    CREATE TABLE IF NOT EXISTS daily_meta (
      date_key TEXT PRIMARY KEY,
      intro TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`;
  // 信源健康记录：每次采集后写入各源产出数（制度性保障：
  // 某源挂掉不再靠肉眼发现，连续0产出超阈值自动告警）
  const createHealthSQL = `
    CREATE TABLE IF NOT EXISTS source_health (
      date_key TEXT NOT NULL,
      source_name TEXT NOT NULL,
      fetched INTEGER NOT NULL DEFAULT 0,
      raw INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      checked_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (date_key, source_name)
    )`;

  if (LOCAL_MODE) {
    db.exec(createTableSQL);
    db.exec(idx1);
    db.exec(idx2);
    db.exec(createMetaSQL);
    db.exec(createHealthSQL);
  } else {
    await db.execute(createTableSQL);
    await db.execute(idx1);
    await db.execute(idx2);
    await db.execute(createMetaSQL);
    await db.execute(createHealthSQL);
  }
  // 列迁移（制度性：表结构自愈）——旧库缺列时自动补建，已存在则忽略 duplicate column 错误
  const migrations = [
    `ALTER TABLE articles ADD COLUMN content TEXT DEFAULT ''`,
    `ALTER TABLE articles ADD COLUMN tags TEXT DEFAULT '[]'`,
    `ALTER TABLE articles ADD COLUMN key_points TEXT DEFAULT '[]'`,
    `ALTER TABLE articles ADD COLUMN is_breaking INTEGER DEFAULT 0`,
    `ALTER TABLE articles ADD COLUMN takeaway TEXT DEFAULT ''`,
    `ALTER TABLE articles ADD COLUMN quote TEXT DEFAULT ''`,
    // 子分明细（JSON: {impact,facts,novelty,score}）：评分可解释的存档。
    // 只看一个总分时，"为何这篇进精选那篇没进"无法事后复盘（用户 2026-07-30 质疑即此）
    `ALTER TABLE articles ADD COLUMN score_detail TEXT DEFAULT ''`,
    // 同来源同事件被合并的稿件数：前台可展示"官方连发N篇"，也供质检核对合并是否生效
    `ALTER TABLE articles ADD COLUMN merged_count INTEGER DEFAULT 0`,
    // 资料库存档：正文HTML快照（图片引用已改写为本地archive路径，随整库同步走）
    `ALTER TABLE articles ADD COLUMN content_html TEXT DEFAULT ''`,
    // 归一化事件名：详情页"此前相关报道"靠它认出同一事件的前情进展。
    // 旧行为空（采集时未落库），查询侧必须把空值当"无信号"而不是"同事件"
    `ALTER TABLE articles ADD COLUMN event_norm TEXT DEFAULT ''`,
    // 上一行建完列才能建索引，所以混在这个数组里按顺序执行
    `CREATE INDEX IF NOT EXISTS idx_event_norm ON articles(event_norm)`,
    // AI跨期事件去重（2026-08-12）：同一事件的跨天二次报道标记
    // is_followup=1：实质新进展跟进稿（保留但强制不精选、分压到原文章之下）
    // related_to：JSON {"id","title","date_key"}，指向同事件的先入库文章（相关阅读）
    `ALTER TABLE articles ADD COLUMN is_followup INTEGER DEFAULT 0`,
    `ALTER TABLE articles ADD COLUMN related_to TEXT DEFAULT ''`,
  ];
  for (const m of migrations) {
    try {
      if (LOCAL_MODE) db.exec(m); else await db.execute(m);
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) console.warn('表迁移跳过:', err.message);
    }
  }
  console.log('数据库表初始化完成');
}

/**
 * 获取近N天已入库文章标题（供AI筛选做旧闻/重复事件对照）
 * 优先返回原标题（英文源），否则用中文标题
 * LIMIT 200：对照窗口拉长到10天后（每日10-20条），原LIMIT 100 会把最旧几天静默截没，
 * 而"这个产品之前推过没有"正是旧闻判定的唯一依据
 */
export async function getRecentTitles(days = 3) {
  const sql = `SELECT title, original_title FROM articles
    WHERE date_key >= date('now', '-${days} days')
    ORDER BY date_key DESC LIMIT 200`;
  try {
    let rows;
    if (LOCAL_MODE) {
      rows = db.prepare(sql).all();
    } else {
      const result = await db.execute(sql);
      rows = result.rows;
    }
    return rows.map(r => r.original_title || r.title).filter(Boolean);
  } catch (err) {
    console.warn('读取近期标题失败（不影响采集，仅失去旧闻对照）:', err.message);
    return [];
  }
}

/**
 * 查询给定URL中哪些已在库中（供采集管线在AI筛选前硬过滤，
 * 制度性保障：已入库的旧文章不占用当日20条入选名额）
 * @param {Array<string>} urls
 * @returns {Set<string>} 已存在的URL集合
 */
export async function getExistingUrls(urls) {
  if (!urls.length) return new Set();
  const placeholders = urls.map(() => '?').join(',');
  const sql = `SELECT source_url FROM articles WHERE source_url IN (${placeholders})`;
  try {
    let rows;
    if (LOCAL_MODE) {
      rows = db.prepare(sql).all(...urls);
    } else {
      const result = await db.execute({ sql, args: urls });
      rows = result.rows;
    }
    return new Set(rows.map(r => r.source_url));
  } catch (err) {
    console.warn('查询已入库URL失败（不影响采集，仅失去入库前过滤）:', err.message);
    return new Set();
  }
}

/**
 * 批量插入文章
 */
export async function insertArticles(articles) {
  let inserted = 0;
  let skipped = 0;

  const insertSQL = `INSERT OR IGNORE INTO articles 
    (title, original_title, source_name, source_url, category, summary, ai_score, is_featured, is_breaking, published_at, date_key, tags, content, content_html, takeaway, key_points, quote, score_detail, merged_count, event_norm, is_followup, related_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  for (const article of articles) {
    const args = [
      article.title,
      article.original_title || null,
      article.source_name,
      article.source_url,
      article.category,
      article.summary || null,
      article.ai_score || null,
      article.is_featured ? 1 : 0,
      article.is_breaking ? 1 : 0,
      article.published_at,
      article.date_key,
      article.tags || '[]',
      article.content || '', // 抓取的原文全文（存档供事实二审/重生成摘要）
      article.content_html || '', // 正文HTML快照（资料库存档，2026-08-10 起）
      article.takeaway || '', // 一句话要点
      article.key_points || '[]', // 核心事实要点（JSON数组）
      article.quote || '', // 原文金句（已程序校验逐字来自原文）
      article.score_detail || '', // 子分明细JSON（影响面/事实密度/新闻增量）
      article.merged_same_source || 0, // 被合并的同来源同事件稿件数
      article.event_norm || '', // 归一化事件名（供详情页识别同一事件的前情）
      article.is_followup ? 1 : 0, // AI跨期去重标记：同事件实质新进展的跟进稿
      article.related_to || '', // 相关阅读：指向同事件的先入库文章 {id,title,date_key}
    ];

    try {
      if (LOCAL_MODE) {
        const result = db.prepare(insertSQL).run(...args);
        if (result.changes > 0) inserted++;
        else skipped++;
      } else {
        await db.execute({ sql: insertSQL, args });
        inserted++;
      }
    } catch (err) {
      if (err.message?.includes('UNIQUE constraint')) {
        skipped++;
      } else {
        console.error(`插入失败: ${article.title}`, err.message);
        skipped++;
      }
    }
  }

  console.log(`写入完成: 新增 ${inserted} 条, 跳过 ${skipped} 条(重复)`);
  return { inserted, skipped };
}

/**
 * 保存当日主编导语（已存在则覆盖，支持重跑回填）
 */
export async function saveDailyIntro(dateKey, intro) {
  const sql = `INSERT INTO daily_meta (date_key, intro) VALUES (?, ?)
    ON CONFLICT(date_key) DO UPDATE SET intro = excluded.intro, created_at = datetime('now')`;
  try {
    if (LOCAL_MODE) {
      db.prepare(sql).run(dateKey, intro);
    } else {
      await db.execute({ sql, args: [dateKey, intro] });
    }
    console.log(`今日导语已保存 (${dateKey})`);
  } catch (err) {
    console.warn('保存导语失败（不影响文章入库）:', err.message);
  }
}

/**
 * 记录本次采集各源产出（同日多轮采集取最大值：任一轮有产出即视为当日健康）
 * @param {string} dateKey - YYYY-MM-DD
 * @param {Array<{source_name, fetched, raw, error}>} stats
 */
export async function recordSourceHealth(dateKey, stats) {
  const sql = `INSERT INTO source_health (date_key, source_name, fetched, raw, error) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date_key, source_name) DO UPDATE SET
      fetched = CASE WHEN excluded.fetched > fetched THEN excluded.fetched ELSE fetched END,
      raw = CASE WHEN excluded.raw > raw THEN excluded.raw ELSE raw END,
      error = excluded.error,
      checked_at = datetime('now')`;
  try {
    for (const s of stats) {
      const args = [dateKey, s.source_name, s.fetched || 0, s.raw || 0, s.error || null];
      if (LOCAL_MODE) {
        db.prepare(sql).run(...args);
      } else {
        await db.execute({ sql, args });
      }
    }
    console.log(`信源健康记录已写入 (${dateKey}, ${stats.length} 个源)`);
  } catch (err) {
    console.warn('记录信源健康失败（不影响采集）:', err.message);
  }
}

/**
 * 读取近N天信源健康记录（日期降序，供连续0产出告警计算）
 */
export async function getSourceHealthHistory(days = 14) {
  const sql = `SELECT source_name, date_key, fetched, raw, error FROM source_health
    WHERE date_key >= date('now', '-${days} days') ORDER BY date_key DESC`;
  try {
    if (LOCAL_MODE) {
      return db.prepare(sql).all();
    }
    const result = await db.execute(sql);
    return result.rows;
  } catch (err) {
    console.warn('读取信源健康记录失败:', err.message);
    return [];
  }
}

/**
 * 统计指定日期已入库文章数与精选数（供一日多轮采集共享日配额）
 * 排除 noise（不占用展示名额）
 * @returns {{count: number, featured: number}}
 */
export async function getDayCounts(dateKey) {
  const sql = `SELECT
      COUNT(*) AS count,
      SUM(CASE WHEN is_featured = 1 THEN 1 ELSE 0 END) AS featured
    FROM articles WHERE date_key = ? AND category != 'noise'`;
  try {
    let row;
    if (LOCAL_MODE) {
      row = db.prepare(sql).get(dateKey);
    } else {
      const result = await db.execute({ sql, args: [dateKey] });
      row = result.rows[0];
    }
    return { count: Number(row?.count || 0), featured: Number(row?.featured || 0) };
  } catch (err) {
    console.warn('统计当日已入库数失败（按首轮处理）:', err.message);
    return { count: 0, featured: 0 };
  }
}

/**
 * 读取指定日期的已入库文章（供导语独立回填等场景）
 */
export async function getArticlesByDate(dateKey) {
  const sql = `SELECT title, category, summary, ai_score, is_featured FROM articles
    WHERE date_key = ? AND category != 'noise' ORDER BY ai_score DESC`;
  try {
    if (LOCAL_MODE) {
      return db.prepare(sql).all(dateKey);
    }
    const result = await db.execute({ sql, args: [dateKey] });
    return result.rows;
  } catch (err) {
    console.warn('读取当日文章失败:', err.message);
    return [];
  }
}

/**
 * 读取近N天已入库文章（含事件名/摘要，供AI跨期事件去重做内容级对照）
 * 排除noise；按日期+分数倒序取最近limit条（对照窗口拉长到10天，
 * 同一事件跨天二次报道正是漏网重灾区，窗口太短认不出前情）
 */
export async function getRecentEvents(days = 10, limit = 120) {
  const sql = `SELECT id, date_key, title, event_norm, summary, ai_score
    FROM articles
    WHERE category != 'noise' AND date_key >= date('now', '-${days} days')
    ORDER BY date_key DESC, ai_score DESC LIMIT ${limit}`;
  try {
    if (LOCAL_MODE) {
      return db.prepare(sql).all();
    }
    const result = await db.execute(sql);
    return result.rows;
  } catch (err) {
    console.warn('读取近期事件对照失败（去重跳过，不影响入库）:', err.message);
    return [];
  }
}
