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

  // 加工隔离/待重跑队列（2026-09-28 事故修复）：翻译+takeaway 失败、评分降级、乱码自检不过的条目
  // 一律先进这张表，**绝不以半成品进 articles 主列表**；LLM 恢复后由 reprocess-quarantine.mjs 重跑，
  // 成功后写主列表并从本表删除。按 source_url 唯一，重复采集只更新不堆积。
  const createQuarantineSQL = `
    CREATE TABLE IF NOT EXISTS articles_quarantine (
      source_url TEXT PRIMARY KEY,
      title TEXT,
      original_title TEXT,
      source_name TEXT,
      category TEXT,
      language TEXT,
      source_type TEXT,
      published_at TEXT,
      date_key TEXT,
      ai_score REAL,
      content TEXT DEFAULT '',
      content_snippet TEXT DEFAULT '',
      content_html TEXT DEFAULT '',
      reason TEXT,
      failed_stage TEXT,
      attempts INTEGER DEFAULT 0,
      quarantined_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`;
  const idxQ = `CREATE INDEX IF NOT EXISTS idx_quarantine_date ON articles_quarantine(date_key)`;

  if (LOCAL_MODE) {
    db.exec(createTableSQL);
    db.exec(idx1);
    db.exec(idx2);
    db.exec(createMetaSQL);
    db.exec(createHealthSQL);
    db.exec(createQuarantineSQL);
    db.exec(idxQ);
  } else {
    await db.execute(createTableSQL);
    await db.execute(idx1);
    await db.execute(idx2);
    await db.execute(createMetaSQL);
    await db.execute(createHealthSQL);
    await db.execute(createQuarantineSQL);
    await db.execute(idxQ);
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
 * 把加工失败/降级的条目写入隔离队列（待重跑）。按 source_url upsert：
 * 同一条 URL 反复失败只更新原因与时间，不堆积。返回写入条数。
 * @param {Array} articles - 带 _proc_failed / _score_fallback / __mojibake 标记的条目
 * @param {string} [defaultStage] - 失败环节（scoring|summary|charset）
 */
export async function insertQuarantine(articles, defaultStage = 'summary') {
  if (!Array.isArray(articles) || !articles.length) return 0;
  const sql = `INSERT INTO articles_quarantine
    (source_url, title, original_title, source_name, category, language, source_type,
     published_at, date_key, ai_score, content, content_snippet, content_html,
     reason, failed_stage, attempts, quarantined_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
    ON CONFLICT(source_url) DO UPDATE SET
      title=excluded.title, original_title=excluded.original_title,
      source_name=excluded.source_name, category=excluded.category,
      language=excluded.language, source_type=excluded.source_type,
      published_at=excluded.published_at, date_key=excluded.date_key,
      ai_score=excluded.ai_score, content=excluded.content,
      content_snippet=excluded.content_snippet, content_html=excluded.content_html,
      reason=excluded.reason, failed_stage=excluded.failed_stage,
      updated_at=datetime('now')`;
  let n = 0;
  for (const a of articles) {
    const reason = a._proc_reason || a.__reason || (a._score_fallback ? '评分降级（AI不可用）' : defaultStage);
    const stage = a._score_fallback ? 'scoring' : (a.__mojibake ? 'charset' : defaultStage);
    const args = [
      a.source_url, a.title || '', a.original_title || null, a.source_name || '',
      a.category || '', a.language || '', a.source_type || '',
      a.published_at || '', a.date_key || '', a.ai_score ?? null,
      a.content || '', a.content_snippet || '', a.content_html || '',
      String(reason).slice(0, 300), stage,
    ];
    try {
      if (LOCAL_MODE) db.prepare(sql).run(...args);
      else await db.execute({ sql, args });
      n++;
    } catch (err) {
      console.error(`隔离写入失败: ${(a.title || a.source_url || '').slice(0, 40)}`, err.message);
    }
  }
  return n;
}

/** 读取一批待重跑条目（可按发布日过滤），供 reprocess-quarantine.mjs 使用。 */
export async function getQuarantineBatch(limit = 50, dateKey = null) {
  const where = dateKey ? `WHERE date_key = ?` : '';
  const paramList = dateKey ? [dateKey] : [];
  const sql = `SELECT * FROM articles_quarantine ${where} ORDER BY updated_at ASC LIMIT ?`;
  const args = [...paramList, limit];
  try {
    if (LOCAL_MODE) return db.prepare(sql).all(...args);
    const r = await db.execute({ sql, args });
    return r.rows;
  } catch (err) {
    console.warn('读取隔离队列失败:', err.message);
    return [];
  }
}

/** 重跑成功后从隔离表删除（按 source_url）。 */
export async function deleteQuarantineByUrl(sourceUrl) {
  const sql = `DELETE FROM articles_quarantine WHERE source_url = ?`;
  try {
    if (LOCAL_MODE) db.prepare(sql).run(sourceUrl);
    else await db.execute({ sql, args: [sourceUrl] });
    return true;
  } catch (err) {
    console.warn('删除隔离条目失败:', err.message);
    return false;
  }
}

/** 隔离队列总数（供告警/巡检：积压说明加工持续失败）。 */
export async function countQuarantine() {
  try {
    if (LOCAL_MODE) return db.prepare('SELECT COUNT(*) AS c FROM articles_quarantine').get().c;
    const r = await db.execute('SELECT COUNT(*) AS c FROM articles_quarantine');
    return Number(r.rows[0]?.c || 0);
  } catch { return 0; }
}

/**
 * 找出主列表里残留的半成品（历史事故遗留：空 takeaway / 乱码 / 未翻译），
 * 供 reprocess-quarantine.mjs 就地修复重跑。命中口径与 collect 写库闸门一致。
 * @param {string} [dateKey] 指定发布日（YYYY-MM-DD），不传则近 3 天
 */
export async function getBadMainArticles(dateKey = null) {
  const dateClause = dateKey
    ? 'date_key = ?'
    : `date_key >= date('now', '-3 days')`;
  const params = dateKey ? [dateKey] : [];
  // 半成品：空/缺 takeaway，或 title/summary 含 U+FFFD，或 score_detail 显示降级
  // 注：articles 表无 content_snippet/language/source_type 列，重跑靠 content + 重新抓全文
  const sql = `SELECT id, title, original_title, source_name, source_url, category,
      summary, content, content_html, published_at, date_key, ai_score, score_detail
    FROM articles
    WHERE category != 'noise' AND (${dateClause})
      AND (
        takeaway IS NULL OR TRIM(takeaway) = ''
        OR instr(COALESCE(title,''), char(65533)) > 0
        OR instr(COALESCE(summary,''), char(65533)) > 0
        OR COALESCE(json_extract(NULLIF(score_detail,''), '$.stage'), '') = 'fallback'
      )`;
  try {
    if (LOCAL_MODE) return db.prepare(sql).all(...params);
    const r = await db.execute({ sql, args: params });
    return r.rows;
  } catch (err) {
    console.warn('查询主列表半成品失败:', err.message);
    return [];
  }
}

/** 就地按 id 重写一条已加工成功的文章字段（重跑回填用）。 */
export async function updateArticleFromReprocess(id, a) {
  const sql = `UPDATE articles SET
      title=?, original_title=?, summary=?, category=?, ai_score=?, is_featured=?,
      tags=?, takeaway=?, key_points=?, quote=?, score_detail=?, content=?, content_html=?,
      merged_count=?, event_norm=?
    WHERE id=?`;
  const args = [
    a.title, a.original_title || null, a.summary || '', a.category,
    a.ai_score ?? null, a.is_featured ? 1 : 0, a.tags || '[]',
    a.takeaway || '', a.key_points || '[]', a.quote || '',
    a.score_detail || '', a.content || '', a.content_html || '',
    a.merged_same_source || 0, a.event_norm || '', id,
  ];
  try {
    if (LOCAL_MODE) { db.prepare(sql).run(...args); return true; }
    await db.execute({ sql, args });
    return true;
  } catch (err) {
    console.error(`更新重跑条目失败 #${id}:`, err.message);
    return false;
  }
}

/** 按 source_url 删除主列表条目（重跑前清掉旧的半成品行，避免与隔离重跑冲突）。 */
export async function deleteArticleByUrl(sourceUrl) {
  const sql = `DELETE FROM articles WHERE source_url = ?`;
  try {
    if (LOCAL_MODE) return db.prepare(sql).run(sourceUrl).changes > 0;
    const r = await db.execute({ sql, args: [sourceUrl] });
    return true;
  } catch (err) { console.warn('删除主列表条目失败:', err.message); return false; }
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
 * 查询某信源距上次抓取(健康记录写入)的小时数，供"按源抓取间隔"限流保护用。
 * checked_at 由 SQLite datetime('now') 写入（UTC），故此处用 julianday 做差，
 * 避免 Node 端把 'YYYY-MM-DD HH:MM:SS'(无时区标记) 当本地时间解析造成的时区偏移误判。
 * 主键 (date_key, source_name) 保证一天一行，取 date_key 最新行的 checked_at 即上次真实抓取时刻。
 * @param {string} sourceName
 * @returns {Promise<number|null>} 距上次抓取小时数；该源从无健康记录时返回 null（视为可抓取）
 */
export async function getHoursSinceLastFetch(sourceName) {
  const sql = `SELECT (julianday('now') - julianday(checked_at)) * 24.0 AS hours_since
    FROM source_health WHERE source_name = ?
    ORDER BY date_key DESC, checked_at DESC LIMIT 1`;
  try {
    if (LOCAL_MODE) {
      const row = db.prepare(sql).get(sourceName);
      return row && row.hours_since != null ? Number(row.hours_since) : null;
    }
    const result = await db.execute({ sql, args: [sourceName] });
    const row = result.rows[0];
    return row && row.hours_since != null ? Number(row.hours_since) : null;
  } catch (err) {
    console.warn(`读取 ${sourceName} 上次抓取时间失败（按可抓处理）:`, err.message);
    return null;
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
 * 读取指定日期的已入库文章清单（供日配额汰换竞争制比较分数/判定豁免）
 * 与 getDayCounts 同口径排除 noise；按分数升序返回，便于 selectByQuota 从最低分找汰换对象。
 * 注意：articles 表无 source_type 列（采集时该字段只在内存对象上，从未落库），
 * 官方政策豁免在 selectByQuota 内按 category='policy' 从严近似。
 */
export async function getDayArticlesForQuota(dateKey) {
  const sql = `SELECT id, title, ai_score, is_featured, category FROM articles
    WHERE date_key = ? AND category != 'noise' ORDER BY ai_score ASC`;
  try {
    if (LOCAL_MODE) {
      return db.prepare(sql).all(dateKey);
    }
    const result = await db.execute({ sql, args: [dateKey] });
    return result.rows;
  } catch (err) {
    console.warn('读取当日配额清单失败（按无可汰对象处理）:', err.message);
    return [];
  }
}

/**
 * 按 id 删除文章（仅供日配额汰换：新条目顶替在库最低分条目时调用）
 * 调用方必须先打日志留痕（被汰条目 id/标题/分数），再执行删除
 * @returns {number} 实际删除行数
 */
export async function deleteArticleById(id) {
  const sql = `DELETE FROM articles WHERE id = ?`;
  try {
    if (LOCAL_MODE) {
      return db.prepare(sql).run(id).changes;
    }
    const result = await db.execute({ sql, args: [id] });
    return Number(result.rows_affected || 0);
  } catch (err) {
    console.error(`删除被汰条目失败 (#${id}):`, err.message);
    return 0;
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
  const sql = `SELECT id, date_key, title, event_norm, summary, ai_score, tags
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
