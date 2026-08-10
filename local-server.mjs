/**
 * 本地开发API服务器 - 零依赖，直接读取本地SQLite
 * 用法: node local-server.mjs
 * 默认端口: 3000
 */
import { createServer } from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { SOURCES, alertThreshold } from './pipeline/sources.mjs';

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3000;
const dbPath = join(__dirname, 'data', 'articles.db');
// 资料库存档目录（data/archive/{url哈希}/，与仓库 data/ 同根，供静态回显与同步打包）
const archiveDir = join(__dirname, 'data', 'archive');
// 存档上传体上限（单轮正常几MB~几十MB，防异常膨胀）
const MAX_ARCHIVE_UPLOAD = 200 * 1024 * 1024;
// 生产数据同步开关：设置 SYNC_TOKEN 环境变量后启用 POST /api/sync-upload（本地开发不设即关闭）
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';

// 相关报道检索窗口（openDb 预编译语句依赖，须前置声明）
const RELATED_WINDOW_DAYS = 30;

let db = null;
let relatedCandidateStmt = null;

// 打开/重开数据库（sync 换库后调用）
function openDb() {
  db = new Database(dbPath, { readonly: true });
  relatedCandidateStmt = db.prepare(`
    SELECT id, title, date_key, source_name, ai_score, tags, event_norm FROM articles
    WHERE id != ? AND category != 'noise'
      AND date_key < ? AND date_key >= date(?, '-${RELATED_WINDOW_DAYS} days')
    ORDER BY date_key DESC
  `);
}

try {
  openDb();
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-sync-token',
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

// 递归统计目录下文件数（含子目录；供存档同步防误清校验）
function countFiles(dir) {
  let n = 0;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) n += countFiles(join(dir, ent.name));
      else n++;
    }
  } catch {}
  return n;
}

// 当前采集轮的起点时刻（UTC 字符串）：四轮在北京时间 8/11/14/20 点触发，对应 UTC 0/3/6/12 点。
// 本轮起点之后入库的文章带 is_new 标，下一轮开始后自动失效——前端无需任何配置
function roundStartUTC(now = new Date()) {
  const HOURS = [0, 3, 6, 12];
  const start = HOURS.filter(x => x <= now.getUTCHours()).pop();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), start, 0, 0))
    .toISOString().slice(0, 19).replace('T', ' ');
}

// 给列表行附加解析后的tags对象
function withParsedTags(row) {
  const isNew = !!row.collected_at && row.collected_at >= roundStartUTC();
  return { ...row, tags: parseTags(row.tags), is_featured: !!row.is_featured, is_breaking: !!row.is_breaking, is_new: isNew };
}

// 构造tag的LIKE匹配值：匹配tags JSON里任一数组包含该值，剥离引号/LIKE通配符防注入
function tagLikePattern(tag) {
  const clean = String(tag).replace(/["%_\\]/g, '');
  return `%"${clean}"%`;
}

// 相关报道检索（纯SQL+内存打分，无LLM）
//
// 旧实现是「逐个标签值查、命中一个就算相关、按日期倒序取3条」，等价于
// 「同公司最近三条」——OpenAI 一家在库里就占 26 条，第一个公司标签直接把
// 3 个坑填满，拿到的是「OpenAI 最近发生的三件事」而不是「这条新闻的前情」。
// 现在改成分层判定：只有下面四层之一命中才算相关，够不上就返回空、模块整块不显示。
//
//   A event   : event_norm 相同（采集时的事件聚类名，同一件事的后续进展）
//   B topic   : 主体交集>=1 且 话题交集>=1（同一家公司在同一条线上的动作）
//   C thread  : 话题交集>=2（同一条技术线的不同玩家）
//
// 刻意没有“仅主体交集”这一层（2026-07-31 实测结论，别再加回来）：
// 只看公司重合时 18 条命中里大半是噪声；改成要求重合度(Jaccard>=0.6)只滤掉4条，
// 因为 [OpenAI, Anthropic] 是全库最常见的公司对，两篇都挂它 Jaccard 能到 1.0，
// 但它只说明“这两篇都是行业大稿”；再改成“共享主体至少一个稀有”，小窗口下
// “稀有”又失真（语料早期候选只二十条，Anthropic 也能算稀有）。三次补丁都在加
// 新的例外，说明“同一组当事方”本身就不是相关信号。真正有价值的那类（如“SSI 获
// 英伟达投资”↔“SSI 与 Nvidia 合作”）本质上就是同一事件，由 A 层接管。
//
// 层级决定排序优先级，层内再按 IDF 加权分（稀有标签比大路标签更能说明相关）、
// 最后按日期。窗口限当前发布日「之前」30天内——含当日的话最先被填进来的
// 往往是用户刚在首页看过的同日新闻，「此前」两个字就没兑现。
const RELATED_LIMIT = 3;
// 层级权重（决定排序，不参与门槛判定）
const RELATION_RANK = { event: 3, topic: 2, thread: 1 };
const RELATION_LABEL = { event: '事件进展', topic: '同一话题', thread: '相关话题' };

// 补读区配额（见 /api/catchup）：只回捞最近三天，再往前的漏读就让它过去——
// 断更一周回来时糊 50 条上去，等于把日报变成收件箱，比漏读更糟。
// 配额按天递减而不是一个扁平的总数：主场景是「隔一天回来」，昨天漏的十来条
// 应该基本都给他；而更早的那几天只需给个精华尾巴。扁平总数会造成昨天吃完配额、
// 前天只剩一条的残组（展示上就是一个“前天 · 1 条”的尴尬分组）。
const CATCHUP_WINDOW_DAYS = 3;
const CATCHUP_TOP_DAY_LIMIT = 10;   // 最近那一天（通常就是昨天）
const CATCHUP_OLDER_DAY_LIMIT = 3;  // 更早的每天

// 往期重要（见 /api/archive）的回捞窗口。
// 30 天不是为了限量，是为了防变陈：排序纯按重要度，没有窗口的话一年后最顶上还是
// 今天这几篇——那就不是「往期重要新闻」而是名人堂了。窗口让旧条目自然过期。
const ARCHIVE_WINDOW_DAYS = 30;

// 排序用的时间衰减：每过一天有效分减 0.5（只影响排序，展示仍用原分）。
// 用户定的方向：日期要是权重之一。力度用实测定的——全库分数集中在 60-97，
// 0.5/天意味着旧文章每老一周需多 3.5 分才能压住新文章，30 天前的要多 15 分；
// 0.3 几乎不改变排序（白加），1.0 则让 89 分新闻压过 9 天前的 95 分（喧宾夺主）。
const ARCHIVE_DECAY_PER_DAY = 0.5;

// 在一个AI资讯应用里这些词命中了也不说明相关。注意不能靠词频(IDF)压掉它们——
// 库里带"AI"标签的只有7条，频次很低但语义为零，IDF 反而会给它高权重。
const GENERIC_TAG_VALUES = new Set([
  'ai', 'a.i.', '人工智能', 'ai技术', 'ai模型', 'ai应用', 'ai产业', 'ai公司',
  '大模型', '大语言模型', 'llm', 'llms', 'agi', '生成式ai', 'genai',
  '机器学习', 'machine learning', '深度学习', 'deep learning', '神经网络',
  'artificial intelligence', 'ai model', 'ai industry',
]);

// 取某几类标签的有效值（小写去重、剔除通用无意义词）
function tagValues(tags, fields) {
  if (!tags) return [];
  const out = new Set();
  for (const f of fields) {
    for (const v of Array.isArray(tags[f]) ? tags[f] : []) {
      const n = String(v).trim().toLowerCase();
      if (n && !GENERIC_TAG_VALUES.has(n)) out.add(n);
    }
  }
  return [...out];
}

function findRelated(row, tags) {
  const selfSubj = tagValues(tags, ['companies', 'people']);
  const selfTopic = tagValues(tags, ['keywords']);
  const selfEvent = String(row.event_norm || '').trim();
  if (!selfSubj.length && !selfTopic.length && !selfEvent) return [];

  const rows = relatedCandidateStmt.all(row.id, row.date_key, row.date_key);
  if (!rows.length) return [];

  // IDF 在候选窗口内现算：一个标签的区分力取决于「最近一个月它出现得多不多」，
  // 用全库口径会被历史数据稀释
  const df = new Map();
  const cands = rows.map(r => {
    const t = parseTags(r.tags);
    const subj = tagValues(t, ['companies', 'people']);
    const topic = tagValues(t, ['keywords']);
    for (const v of new Set([...subj, ...topic])) df.set(v, (df.get(v) || 0) + 1);
    return { row: r, subj, topic };
  });
  const total = cands.length + 1;
  const idf = v => Math.log(total / ((df.get(v) || 0) + 1)) + 0.3;

  const picked = [];
  for (const c of cands) {
    const subjHit = c.subj.filter(v => selfSubj.includes(v));
    const topicHit = c.topic.filter(v => selfTopic.includes(v));
    const sameEvent = !!selfEvent && String(c.row.event_norm || '').trim() === selfEvent;

    let relation = '';
    if (sameEvent) relation = 'event';
    else if (subjHit.length && topicHit.length) relation = 'topic';
    else if (topicHit.length >= 2) relation = 'thread';
    else continue; // 单个标签重合、或只是同一批公司，一律不算相关，宁可不显示

    const weight = [...topicHit].reduce((s, v) => s + 2 * idf(v), 0)
      + [...subjHit].reduce((s, v) => s + idf(v), 0);
    picked.push({ row: c.row, relation, weight });
  }

  picked.sort((a, b) =>
    (RELATION_RANK[b.relation] - RELATION_RANK[a.relation])
    || (b.weight - a.weight)
    || (a.row.date_key < b.row.date_key ? 1 : -1)
  );

  return picked.slice(0, RELATED_LIMIT).map(p => ({
    id: p.row.id,
    title: p.row.title,
    date_key: p.row.date_key,
    source_name: p.row.source_name,
    relation: p.relation,
    relationLabel: RELATION_LABEL[p.relation],
  }));
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

  // GET /api/sync-download（供 GitHub Actions 采集前拉取当前库，保持历史连续）
  if (req.method === 'GET' && pathname === '/api/sync-download') {
    if (!SYNC_TOKEN) return sendJSON(res, 403, { error: 'sync disabled' });
    if ((req.headers['x-sync-token'] || '') !== SYNC_TOKEN) return sendJSON(res, 401, { error: 'unauthorized' });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="articles.db"',
    });
    fs.createReadStream(dbPath).pipe(res);
    return;
  }

  // GET /api/sync-archive-download（供 GitHub Actions 采集前拉回服务器存量存档：
  // Actions 每次全新工作区，不先拉回再增量，整包回传会把服务器存档抹掉）
  // 实现：预打包到 data/archive.tar.gz 缓存再流式发文件（Windows bsdtar 的
  // "-czf -" 管道输出会挂起，写文件正常；mtime 比目录旧时自动重建）
  if (req.method === 'GET' && pathname === '/api/sync-archive-download') {
    if (!SYNC_TOKEN) return sendJSON(res, 403, { error: 'sync disabled' });
    if ((req.headers['x-sync-token'] || '') !== SYNC_TOKEN) return sendJSON(res, 401, { error: 'unauthorized' });
    if (!fs.existsSync(archiveDir)) return sendJSON(res, 404, { error: 'no archive yet' });
    (async () => {
      try {
        const bundlePath = join(__dirname, 'data', 'archive.tar.gz');
        const needBuild = !fs.existsSync(bundlePath)
          || fs.statSync(archiveDir).mtimeMs > fs.statSync(bundlePath).mtimeMs;
        if (needBuild) {
          await execFileP('tar', ['-czf', bundlePath, '-C', join(__dirname, 'data'), 'archive'], { timeout: 120000 });
        }
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Disposition': 'attachment; filename="archive.tar.gz"',
        });
        fs.createReadStream(bundlePath).pipe(res);
      } catch (e) {
        console.error('[sync] 存档打包失败:', e.message);
        if (!res.headersSent) return sendJSON(res, 500, { error: e.message });
        res.destroy();
      }
    })();
    return;
  }

  // POST /api/proxy（供 GitHub Actions 采集时借国内IP代拉被海外封锁的站点，
  // 2026-08-07：机器之心 WAF 开始拦海外IP，Actions 上 curl 被重定向到推广页）
  // 请求体：{url, method?, headers?, body?}；返回 {status, contentType, body}，body 上限 2MB
  if (req.method === 'POST' && pathname === '/api/proxy') {
    if (!SYNC_TOKEN) return sendJSON(res, 403, { error: 'proxy disabled' });
    if ((req.headers['x-sync-token'] || '') !== SYNC_TOKEN) return sendJSON(res, 401, { error: 'unauthorized' });
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const spec = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!/^https:\/\//.test(spec.url || '')) return sendJSON(res, 400, { error: 'https only' });
        const resp = await fetch(spec.url, {
          method: spec.method === 'POST' ? 'POST' : 'GET',
          headers: spec.headers || {},
          body: spec.body != null ? spec.body : undefined,
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        });
        let body = await resp.text();
        if (body.length > 2 * 1024 * 1024) body = body.slice(0, 2 * 1024 * 1024);
        return sendJSON(res, 200, {
          status: resp.status,
          contentType: resp.headers.get('content-type') || '',
          setCookies: typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [],
          body,
        });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message });
      }
    });
    return;
  }

  // POST /api/sync-archive（资料库存档同步：接收 tar.gz 整包，解到临时目录后原子替换）
  // 与 sync-upload 同构：防误清对应物——老存档有图而新包空图时拒收
  // （客户端拉取失败的空工作区回传会把服务器存档抹掉）
  if (req.method === 'POST' && pathname === '/api/sync-archive') {
    if (!SYNC_TOKEN) return sendJSON(res, 403, { error: 'sync disabled' });
    if ((req.headers['x-sync-token'] || '') !== SYNC_TOKEN) return sendJSON(res, 401, { error: 'unauthorized' });
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const tmpTar = join(__dirname, 'data', 'archive.upload.tgz');
      const tmpDir = join(__dirname, 'data', 'archive.new');
      const oldBackup = join(__dirname, 'data', 'archive.old');
      try {
        const abuf = Buffer.concat(chunks);
        if (abuf.length < 100) return sendJSON(res, 400, { error: 'payload too small' });
        if (abuf.length > MAX_ARCHIVE_UPLOAD) return sendJSON(res, 413, { error: 'archive too large' });
        fs.writeFileSync(tmpTar, abuf);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.mkdirSync(tmpDir, { recursive: true });
        await execFileP('tar', ['-xzf', tmpTar, '-C', tmpDir], { timeout: 120000 });
        // 客户端以 `-C data archive` 打包，包内带 archive/ 前缀；
        // 解到将变成 archive 的临时目录后需剥掉一层，避免 archive/archive 嵌套
        const inner = join(tmpDir, 'archive');
        if (fs.existsSync(inner) && fs.statSync(inner).isDirectory()) {
          const flat = join(__dirname, 'data', 'archive.new.flat');
          fs.rmSync(flat, { recursive: true, force: true });
          fs.renameSync(inner, flat);
          fs.rmSync(tmpDir, { recursive: true, force: true });
          fs.renameSync(flat, tmpDir);
        }
        const newCount = countFiles(tmpDir);
        const oldCount = fs.existsSync(archiveDir) ? countFiles(archiveDir) : 0;
        // 防误清（2026-08-10 与 sync-upload 同口径）：客户端每轮先拉再推，
        // 正常回传的新包文件数 ≥ 老包；拉取失败的空工作区只含本轮新增，
        // 文件数会明显少于老包——此时拒收，避免把服务器存量存档整个换掉
        if (oldCount > 20 && newCount < Math.ceil(oldCount / 2)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return sendJSON(res, 409, { error: `refused: incoming ${newCount} < half of current ${oldCount} files` });
        }
        // 原子替换：当前目录改名备份 -> 新目录就位 -> 删备份（Windows rename 无法覆盖已存在目录）
        fs.rmSync(oldBackup, { recursive: true, force: true });
        if (fs.existsSync(archiveDir)) fs.renameSync(archiveDir, oldBackup);
        fs.renameSync(tmpDir, archiveDir);
        fs.rmSync(oldBackup, { recursive: true, force: true });
        fs.rmSync(tmpTar, { force: true });
        console.log(`[sync] 存档已更新: ${newCount} 个文件`);
        return sendJSON(res, 200, { ok: true, files: newCount });
      } catch (e) {
        try { fs.rmSync(tmpTar, { force: true }); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        console.error('[sync] 存档更新失败:', e.message);
        return sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }

  // POST /api/sync-upload（生产数据同步：整库上传+校验+原子替换）
  // 仅当设置了 SYNC_TOKEN 环境变量时启用。上传方携带 x-sync-token 头。
  if (req.method === 'POST' && pathname === '/api/sync-upload') {
    if (!SYNC_TOKEN) return sendJSON(res, 403, { error: 'sync disabled' });
    if ((req.headers['x-sync-token'] || '') !== SYNC_TOKEN) return sendJSON(res, 401, { error: 'unauthorized' });
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const tmpPath = dbPath + '.upload';
      try {
        const buf = Buffer.concat(chunks);
        if (buf.length < 4096) return sendJSON(res, 400, { error: 'payload too small' });
        fs.writeFileSync(tmpPath, buf);
        // 校验：能打开且含articles表
        const test = new Database(tmpPath);
        const cnt = test.prepare('SELECT COUNT(*) AS t FROM articles').get().t;
        // 墓碑保护（2026-08-07 教训：手工删除的文章会被下一轮 Actions 整库上传复活，
        // 谷歌重复新闻 628 删完次日又回来了）：上传库里若含墓碑名单中的 id，
        // 直接在上传副本中删掉再替换。
        let tombIds = [];
        try {
          tombIds = db.prepare('SELECT article_id FROM deleted_tombstones').all().map(r => r.article_id);
          if (tombIds.length) {
            const stmt = test.prepare('DELETE FROM articles WHERE id = ?');
            for (const id of tombIds) stmt.run(id);
          }
        } catch {}
        test.close();
        // 防误清库：新库条数不足现有库一半时拒绝替换（Actions/本地采集异常时
        // 避免拿一个接近空的库把服务器历史数据整个抹掉）
        let cur = 0;
        try { cur = db.prepare('SELECT COUNT(*) AS t FROM articles').get().t; } catch {}
        if (cur > 0 && cnt < Math.ceil(cur / 2)) {
          fs.unlinkSync(tmpPath);
          return sendJSON(res, 409, { error: `refused: incoming ${cnt} < half of current ${cur}` });
        }
        // 覆盖目标文件：先关旧句柄，再整文件复制（不用 rename——Windows 上
        // rename 无法覆盖被 SQLite 打开过的文件会报 EPERM，Linux 无此问题）
        const old = db; db = null;
        try { old.close(); } catch {}
        fs.copyFileSync(tmpPath, dbPath);
        // 2026-08-05 事故教训：覆盖主文件后必须清掉残留的 -wal/-shm，
        // 否则 openDb 会拿旧 WAL 去套新主文件，整库必坏（当时小程序全量 500）
        for (const suffix of ['-wal', '-shm']) {
          try { fs.unlinkSync(dbPath + suffix); } catch {}
          try { fs.unlinkSync(tmpPath + suffix); } catch {}
        }
        fs.unlinkSync(tmpPath);
        openDb();
        // 上传库不含墓碑表，替换后需回写，否则墓碑只生效一轮
        if (tombIds.length) {
          try {
            const w = new Database(dbPath);
            w.exec('CREATE TABLE IF NOT EXISTS deleted_tombstones (article_id INTEGER PRIMARY KEY, deleted_at TEXT DEFAULT (datetime(\'now\')))');
            const ins = w.prepare('INSERT OR IGNORE INTO deleted_tombstones (article_id) VALUES (?)');
            for (const id of tombIds) ins.run(id);
            w.close();
          } catch {}
        }
        console.log(`[sync] 数据库已更新: ${cnt} 篇文章`);
        return sendJSON(res, 200, { ok: true, articles: cnt });
      } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch {}
        if (!db) { try { openDb(); } catch {} }
        console.error('[sync] 失败:', e.message);
        return sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }

  try {
    // GET /api/featured
    if (pathname === '/api/featured') {
      const date = query.date || new Date().toISOString().split('T')[0];
      const rows = db.prepare(`
        SELECT id, title, original_title, source_name, source_url, category, summary, takeaway, ai_score, is_featured, published_at, collected_at, tags
        FROM articles WHERE date_key = ? AND is_featured = 1 AND category != 'noise'
        ORDER BY ai_score DESC
      `).all(date);

      // 今日导语（daily_meta表可能尚未创建，缺失时返回null，前端不展示）
      let intro = null;
      try {
        intro = db.prepare('SELECT intro FROM daily_meta WHERE date_key = ?').get(date)?.intro || null;
      } catch { /* 表不存在时忽略 */ }

      return sendJSON(res, 200, { date, count: rows.length, intro, articles: rows.map(withParsedTags) });
    }

    // GET /api/articles（tag参数与category/date/page可叠加；date=all 表示不限日期；
    // tag_type 限定只在 tags 的指定字段内精确匹配，避免跨字段撞字符串；
    // min_scores 为逗号分隔的下限列表（如 90,80），命中任一下限即保留，支持重要性多选筛选）
    if (pathname === '/api/articles') {
      const date = query.date === 'all' ? null : (query.date || new Date().toISOString().split('T')[0]);
      const category = query.category;
      const tag = query.tag;
      const tagType = ['companies', 'people', 'keywords', 'regions'].includes(query.tag_type) ? query.tag_type : null;
      const page = Math.max(1, parseInt(query.page) || 1);
      const limit = Math.min(50, parseInt(query.limit) || 20);
      const offset = (page - 1) * limit;
      // 重要性筛选：只认 0-100 的数字档位下限，非法值直接忽略；
      // 每个下限是严格档位区间（如 80 = 80-89），不是“≥80”
      const minScores = String(query.min_scores || '')
        .split(',').map(s => parseInt(s, 10)).filter(n => n > 0 && n <= 100);

      // 动态拼接WHERE条件
      const where = [`category != 'noise'`]; // 噪音文章不在任何列表展示
      const args = [];
      if (date) { where.push('date_key = ?'); args.push(date); }
      if (category && category !== 'all') { where.push('category = ?'); args.push(category); }
      if (tag) {
        if (tagType) {
          // 精确匹配：只在指定字段数组内找该标签（json_each展开数组逐项比对）
          where.push('json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags, ?) WHERE json_each.value = ?)');
          args.push(`$.${tagType}`, String(tag));
        } else {
          // 无tag_type时降级为全JSON模糊匹配（兼容旧版前端）
          where.push('tags LIKE ?'); args.push(tagLikePattern(tag));
        }
      }
      if (minScores.length) {
        // 多选并集：每个档位一个 [min, min+10) 区间；90 档封顶不设上限
        const conds = minScores.map(() => '(ai_score >= ? AND ai_score < ?)').join(' OR ');
        where.push(`(${conds})`);
        for (const m of minScores) { args.push(m, m >= 90 ? 999 : m + 10); }
      }
      const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const total = db.prepare(`SELECT COUNT(*) as t FROM articles ${whereSQL}`).get(...args).t;
      const rows = db.prepare(`
        SELECT id, title, source_name, source_url, category, takeaway, ai_score, is_featured, is_breaking, published_at, collected_at, tags
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

    // GET /api/tags（聚合tags计数；计数口径与标签落地页一致——
    // noise不展示故不计入；regions标签页只显示政策类文章，故只统计policy类，
    // 避免出现"标签条显示中国8条、点进去0条政策"的口径错位）
    if (pathname === '/api/tags') {
      const rows = db.prepare(`SELECT category, tags FROM articles WHERE tags LIKE '{%' AND category != 'noise'`).all();
      const counters = { companies: {}, people: {}, keywords: {}, regions: {} };

      for (const row of rows) {
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

      // companies/people 为白名单制、regions 枚举有限，总量有界，全量返回（前端负责收纳）；
      // keywords 无白名单约束、长尾无界，仍取 Top 30
      const top = (counter, limit = Infinity) => Object.entries(counter)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, limit);

      return sendJSON(res, 200, {
        companies: top(counters.companies),
        people: top(counters.people),
        keywords: top(counters.keywords, 30),
        regions: top(counters.regions),
      });
    }

    // GET /api/source-health（信源健康总览：各源连续0产出天数/最近活跃日/告警状态）
    if (pathname === '/api/source-health') {
      let rows = [];
      try {
        rows = db.prepare(`
          SELECT source_name, date_key, fetched, raw, error FROM source_health
          WHERE date_key >= date('now', '-14 days') ORDER BY date_key DESC
        `).all();
      } catch { /* 表未创建（尚未跑过新版采集），所有源返回 no_data */ }

      const bySource = new Map();
      for (const r of rows) {
        if (!bySource.has(r.source_name)) bySource.set(r.source_name, []);
        bySource.get(r.source_name).push(r);
      }

      const sources = SOURCES.map(s => {
        const recs = bySource.get(s.name) || [];
        const threshold = alertThreshold(s);
        let zeroDays = 0;
        for (const r of recs) {
          if (r.fetched === 0) zeroDays++;
          else break;
        }
        const latest = recs[0] || null;
        const status = !recs.length
          ? 'no_data'
          : (recs.length >= threshold && zeroDays >= threshold ? 'alert' : 'ok');
        return {
          name: s.name,
          official: s.source_type === 'official',
          threshold,
          zero_days: zeroDays,
          last_active: recs.find(r => r.fetched > 0)?.date_key || null,
          latest_date: latest?.date_key || null,
          latest_fetched: latest ? latest.fetched : null,
          latest_error: latest?.error || null,
          status,
        };
      });
      // 告警源排前面，其余保持配置顺序
      sources.sort((a, b) => (b.status === 'alert') - (a.status === 'alert'));

      return sendJSON(res, 200, {
        alert_count: sources.filter(s => s.status === 'alert').length,
        sources,
      });
    }

    // GET /api/dates（往期日报索引：有内容的日期倒序+篇数/精选数，供首页日期面板）
    if (pathname === '/api/dates') {
      const rows = db.prepare(`
        SELECT date_key, COUNT(*) AS total, SUM(is_featured) AS featured
        FROM articles WHERE category != 'noise'
        GROUP BY date_key ORDER BY date_key DESC
      `).all();
      return sendJSON(res, 200, {
        dates: rows.map(r => ({ date: r.date_key, total: r.total, featured: r.featured || 0 })),
      });
    }

    // GET /api/catchup（补读：用户上次离开后才入库、但发布日已翻页的文章）
    //
    // 解决的是一个纯阅读侧问题：采集分 8/14/20 三轮，早上只出几条。用户 8 点看完就走，
    // 14 点和 20 点入库的那十来条就再没有露脸机会——第二天首页只显示「今天」的桶，
    // 昨天白天的新闻整批静默蒸发。这里按「入库时间」而不是「发布日」重新捞一遍。
    //
    // 判定用 collected_at：入库语句是 INSERT OR IGNORE，同一条 URL 只会写一次，
    // 所以它是可靠的「这条第一次出现在应用里的时刻」，不会被后续重跑刷新。
    // date_key < today 是为了不和首页「今日」列表重复——今天的桶已经整个铺在页面上了。
    // 顺带修好一个既有盲区：发布日在过去、但今天才被采到的文章（源站延迟收录），
    // 过去只会落进用户已经读完的旧桶里，等于永不可见，现在会出现在补读区。
    //
    // since 解析不出来时 datetime() 返回 NULL，比较结果为 NULL、一条不返回——
    // 宁可整块不显示，也不要因为参数异常把历史存量整批倒给用户。
    if (pathname === '/api/catchup') {
      const since = query.since;
      const before = query.before || new Date().toISOString().split('T')[0];
      if (!since) return sendJSON(res, 200, { total: 0, articles: [] });

      const filter = `
        FROM articles
        WHERE category != 'noise'
          AND date_key < ? AND date_key >= date(?, '-${CATCHUP_WINDOW_DAYS} days')
          AND collected_at > datetime(?)
      `;
      const args = [before, before, since];
      const total = db.prepare(`SELECT COUNT(*) AS t ${filter}`).get(...args).t;
      // 窗函数做“每天取前N”：rn 是天内排名，day_rn 是第几新的一天（每天一个名次，
      // 所以用 DENSE_RANK 而不是 ROW_NUMBER）。天内排序以精选优先，被截掉的一定是分低的。
      const rows = db.prepare(`
        SELECT id, title, source_name, source_url, category, takeaway, ai_score, is_featured, is_breaking, published_at, collected_at, tags, date_key
        FROM (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY date_key ORDER BY is_featured DESC, ai_score DESC) AS rn,
            DENSE_RANK() OVER (ORDER BY date_key DESC) AS day_rn
          ${filter}
        )
        WHERE rn <= CASE WHEN day_rn = 1 THEN ${CATCHUP_TOP_DAY_LIMIT} ELSE ${CATCHUP_OLDER_DAY_LIMIT} END
        ORDER BY day_rn, rn
      `).all(...args);

      return sendJSON(res, 200, { since, before, total, articles: rows.map(withParsedTags) });
    }

    // GET /api/archive（往期重要：比 before 更早的新闻，按重要度而不是时间排序）
    //
    // 为什么需要它：子分类的日产量是结构性偏低的，不是偶发。实测最近 7 天：
    // 基建 4 天为 0、观点 3 天为 0、政策从没超过 1 条。只展当日的话，这些栏目
    // 点进去就是一片空白，而它们恰恰不是不重要（基建均分 85.1，全库最高）。
    //
    // 排序是「重要度为主、新鲜度为辅」：有效分 = ai_score - 离现在天数 × ARCHIVE_DECAY_PER_DAY。
    // 展示的分数徽章仍是原分，所以会出现 94 分排在 96 分上面的情况（新 7 天可抵 3.5 分），
    // 这是有意的取舍：用户对"旧闻越陈越往后"的直觉比分数严格单调更重要。同有效分时新的在前。
    if (pathname === '/api/archive') {
      const before = query.before || new Date().toISOString().split('T')[0];
      const category = query.category;
      const limit = Math.min(30, parseInt(query.limit) || 10);

      const where = [`category != 'noise'`, `date_key < ?`, `date_key >= date(?, '-${ARCHIVE_WINDOW_DAYS} days')`];
      const args = [before, before];
      if (category && category !== 'all') { where.push('category = ?'); args.push(category); }
      const filter = `FROM articles WHERE ${where.join(' AND ')}`;

      const total = db.prepare(`SELECT COUNT(*) AS t ${filter}`).get(...args).t;
      const rows = db.prepare(`
        SELECT id, title, source_name, source_url, category, takeaway, ai_score, is_featured, is_breaking, published_at, collected_at, tags, date_key
        ${filter}
        ORDER BY ai_score - (julianday(?) - julianday(date_key)) * ${ARCHIVE_DECAY_PER_DAY} DESC, date_key DESC
        LIMIT ?
      `).all(...args, before, limit);

      return sendJSON(res, 200, {
        before, category: category || 'all', total, articles: rows.map(withParsedTags),
      });
    }

    // GET /api/article/:id
    const articleMatch = pathname.match(/^\/api\/article\/(\d+)$/);
    if (articleMatch) {
      const id = articleMatch[1];
      const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
      if (!row) return sendJSON(res, 404, { error: '文章不存在' });
      const tags = parseTags(row.tags);
      return sendJSON(res, 200, {
        ...row,
        tags,
        key_points: parseKeyPoints(row.key_points),
        is_featured: !!row.is_featured,
        related: findRelated(row, tags), // 此前相关报道（分层判定，见 findRelated；够不上相关则为空数组）
      });
    }

    // GET /archive/...（资料库静态文件：文章HTML快照与图片，图片引用为 archive/{hash}/images/xx）
    const archiveFileMatch = pathname.match(/^\/archive\/(.+)$/);
    if (archiveFileMatch) {
      const rel = decodeURIComponent(archiveFileMatch[1]);
      const file = join(archiveDir, rel);
      // 路径穿越防护：规范化后必须仍在 archiveDir 内
      if (!file.startsWith(archiveDir + path.sep)) return sendJSON(res, 403, { error: 'forbidden' });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJSON(res, 404, { error: 'not found' });
      const ext = path.extname(file).toLowerCase();
      const mime = {
        '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
      }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(file).pipe(res);
      return;
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
  console.log(`  GET /api/source-health`);
  console.log(`  GET /api/dates`);
  console.log(`  GET /api/catchup?since=<ISO时间>&before=YYYY-MM-DD`);
  console.log(`  GET /api/archive?category=&before=YYYY-MM-DD&limit=`);
  console.log(`  GET /api/article/:id`);
  console.log(`  GET /archive/<hash>/...（资料库静态文件）`);
  console.log(`\n小程序开发时请确保此服务器运行中`);
});
