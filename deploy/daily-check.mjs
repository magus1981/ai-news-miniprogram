#!/usr/bin/env node
/**
 * daily-check.mjs — 采集管线每日体检快照（服务器本地，crontab 每日 09:10）
 * 输出 /opt/ai-news/health-snapshot.json，供 QwenWork 三日体检任务开机后读取转报。
 * 全部计算在云端完成，不依赖用户本机开机。
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import Database from 'better-sqlite3';

const DB = '/opt/ai-news/data/articles.db';
const OUT = '/opt/ai-news/health-snapshot.json';
const GH_TOKEN = fs.existsSync('/opt/ai-news/.gh-token') ? fs.readFileSync('/opt/ai-news/.gh-token', 'utf8').trim() : '';
const now = new Date();
const dayKey = d => d.toISOString().slice(0, 10);

const db = new Database(DB, { readonly: true });
const snap = { generated_at: now.toISOString(), days: [], sources_alert: [], sources_offline: [], archive_mb: 0, ping_hits_3d: [], actions_recent: [], trigger_anomaly: [] };

// ---- 数据面：最近4天 ----
for (let i = 1; i <= 4; i++) {
  const d = new Date(now - i * 86400e3);
  const date = dayKey(d);
  const rows = db.prepare("SELECT title, source_name, ai_score, is_featured, published_at, collected_at FROM articles WHERE date_key=?").all(date);
  const lags = [];
  for (const r of rows) {
    try { lags.push((new Date(r.collected_at.replace(' ', 'T') + 'Z') - new Date(r.published_at)) / 3600e3); } catch {}
  }
  lags.sort((a, b) => a - b);
  const day = {
    date, count: rows.length, featured: rows.filter(r => r.is_featured).length,
    med_lag: lags.length ? +lags[Math.floor(lags.length / 2)].toFixed(1) : null,
    max_lag: lags.length ? +lags[lags.length - 1].toFixed(1) : null,
    low_score: rows.filter(r => r.ai_score < 65).map(r => ({ s: r.ai_score, t: r.title.slice(0, 40), src: r.source_name })),
    heavy_late: rows.filter(r => { try { return r.ai_score >= 75 && (new Date(r.collected_at.replace(' ', 'T') + 'Z') - new Date(r.published_at)) / 3600e3 > 12; } catch { return false; } })
      .map(r => ({ s: r.ai_score, t: r.title.slice(0, 40) })),
  };
  snap.days.push(day);
}

// ---- 信源健康：连续0产出（从最新往前数连续fetched=0） ----
const alerts = [];
const offline = [];
// 临时下线的源（与 pipeline/sources.mjs 的 enabled:false 保持同步，挂回时两处一并改回）：
// 其历史 0/429 产出行不再刷进 sources_alert，改记入 sources_offline 显式呈现"已下线"状态。
const OFFLINE = new Set(['VentureBeat']); // 9/18 用户拍板临时下线：429/TLS指纹级封锁，待新出口IP后挂回
const rows = db.prepare("SELECT source_name, date_key, fetched FROM source_health ORDER BY source_name, date_key DESC").all();
const bySrc = new Map();
for (const r of rows) { if (!bySrc.has(r.source_name)) bySrc.set(r.source_name, []); bySrc.get(r.source_name).push(r); }
const officialSet = new Set(['网信办','工信部','国务院','TC260','国家数据局','国家发改委','北京市政府','上海市政府','浙江省政府','广东省政府','江苏省政府','総務省 MIC','経済産業省 METI','デジタル庁','MSIT 과기정통부','SDAIA 沙特数据AI局','UAE AI News','The Hill Tech','Politico Tech','EU Digital Strategy','OpenAI Blog','Google DeepMind','Google AI','Microsoft AI','NVIDIA Blog','Anthropic','DeepSeek 官方']);
for (const [name, recs] of bySrc) {
  if (OFFLINE.has(name)) { offline.push(name); continue; } // 已下线：不进告警，只记入 sources_offline
  let z = 0;
  for (const r of recs) { if (r.fetched === 0) z++; else break; }
  // 与 sources.mjs 各源 alertDays 保持同步(8/28修复调整:网信办14/SDAIA30/广东14/SemiAnalysis周更7)
  const OVERRIDE = { '网信办': 14, 'SDAIA 沙特数据AI局': 30, '广东省政府': 14, 'SemiAnalysis': 7, 'VentureBeat': 9 }; // VentureBeat 9/4起429封禁冷却(24h/次触碰,commit 1e654d1),解封后回调
  const threshold = OVERRIDE[name] || (officialSet.has(name) ? 7 : 3);
  if (z >= threshold && recs.length >= threshold) alerts.push({ name, days: z, threshold });
}
snap.sources_alert = alerts;
snap.sources_offline = offline;

// ---- 存储 ----
// 2026-09-09 口径修正:存档改全量永久保留+回填补档,体积只增不减属预期,250M旧线废弃;唯一硬报警=磁盘水位>75%(disk_alert)
try { snap.archive_mb = +(execFileSync('du', ['-sm', '/opt/ai-news/data/archive']).toString().split('\t')[0]); } catch {}

// ---- 磁盘水位（2026-09-04 存档改全量永久保留后新增：>75% 时快照报警） ----
try {
  const dfOut = execFileSync('df', ['-P', '/opt']).toString().trim().split('\n').pop();
  const pct = parseInt(dfOut.trim().split(/\s+/)[4], 10);
  if (!Number.isNaN(pct)) {
    snap.disk_usage_pct = pct;
    if (pct > 75) snap.disk_alert = { usage_pct: pct, message: `磁盘使用率 ${pct}% 超过 75% 水位，注意扩容或清理` };
  }
} catch {}

// ---- 存档缺口（2026-09-04：DB各条source_url的sha1[:16]哈希 与 存档目录名逐条比对。
// 不能用"DB条数 vs 目录数"口径——存档里约有百余个历史遗产目录(DB被替换期遗留)会掩盖真实缺口。
// 缺口来源=推送失败轮次(Actions全新工作区永不重采)+死链, 兜底回填见 pipeline/archive-backfill.mjs。
// 缺口>30 时快照加 archive_gap） ----
try {
  const { createHash } = await import('crypto');
  const dirSet = new Set(fs.readdirSync('/opt/ai-news/data/archive', { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name));
  const urls = db.prepare("SELECT source_url u FROM articles WHERE source_url LIKE 'http%'").all();
  let gap = 0;
  for (const { u } of urls) {
    if (!dirSet.has(createHash('sha1').update(u).digest('hex').slice(0, 16))) gap++;
  }
  if (gap > 30) snap.archive_gap = { db_articles: urls.length, archive_dirs: dirSet.size, gap };
} catch {}

// ---- 探针命中（近3天） ----
try {
  const log = fs.readFileSync('/opt/ai-news/breaking-ping.log', 'utf8');
  const cutoff = new Date(now - 3 * 86400e3).toISOString().slice(0, 10);
  snap.ping_hits_3d = log.split('\n').filter(l => l.includes('快讯命中') && l.slice(0, 10) >= cutoff).slice(-5);
} catch {}

// ---- 采集轮次异常（近3天非204） ----
try {
  const log = fs.readFileSync('/opt/ai-news/trigger-collect.log', 'utf8');
  const cutoff = dayKey(new Date(now - 3 * 86400e3));
  snap.trigger_anomaly = log.split('\n').filter(l => l.slice(0, 10) >= cutoff && !l.includes('http=204')).slice(-5);
} catch {}

// ---- Actions 最近10轮 ----
if (GH_TOKEN) {
  try {
    const out = execFileSync('curl', ['-s', '-m', '20', '-H', `Authorization: token ${GH_TOKEN}`, 'https://api.github.com/repos/magus1981/ai-news-miniprogram/actions/runs?per_page=10'], { encoding: 'utf8', maxBuffer: 1e7 });
    snap.actions_recent = JSON.parse(out).workflow_runs.map(r => ({ at: r.created_at.slice(0, 16), status: r.status, conclusion: r.conclusion }));
  } catch {}
}

// ---- 备份健康（2026-09-14 新增）----
// 备份链路自己必须被监控：8/5 生产库真损坏过一次（data/ 里还留着 corrupt/recovered 文件），
// 而"脚本在跑"与"备份真的能恢复"是两件事。这里只读日志和目录，不碰生产库。
try {
  const BDIR = '/opt/ai-news/backups';
  const bLog = fs.existsSync('/opt/ai-news/db-backup.log')
    ? fs.readFileSync('/opt/ai-news/db-backup.log', 'utf8') : '';
  const okLines = bLog.split('\n').filter(l => l.startsWith('backup ok:'));
  const alertLines = bLog.split('\n').filter(l => l.includes('BACKUP-ALERT'));
  let kept = 0;
  let newest = null;
  try {
    const files = fs.readdirSync(BDIR).filter(f => /^articles-(\d{8})-\d{4}\.db\.gz$/.test(f)).sort();
    kept = files.length;
    newest = files.length ? files.at(-1).slice(9, 17) : null;   // YYYYMMDD
  } catch {}
  // 以备份文件本身为硬证据（目录里有最新 .gz 就说明真的落盘了）；目录空时才回落日志
  const logDm = (okLines.at(-1) || '').match(/articles-(\d{8})/);
  const src = newest ? 'dir' : (logDm ? 'log' : 'none');
  const lastOkD8 = newest || (logDm ? logDm[1] : null);
  const lastOk = lastOkD8 ? `${lastOkD8.slice(0, 4)}-${lastOkD8.slice(4, 6)}-${lastOkD8.slice(6, 8)}` : null;
  snap.backup = {
    last_ok: lastOk,
    last_ok_from: src,
    kept,
    recent_alerts: alertLines.slice(-3),
    log_present: !!bLog,
  };
  const ageDays = lastOk ? Math.floor((now - Date.parse(lastOk + 'T00:00:00+08:00')) / 86400e3) : 999;
  // 注意：不复用 alerts（那是 snap.sources_alert，元素是 {name,days,threshold} 对象，
  // 供信源健康播报消费）。备份告警单独成数组，避免被误分类成信源故障、也避免污染其结构。
  const bAlerts = [];
  if (ageDays > 2) {
    bAlerts.push(`备份超期：最近一次成功备份 ${lastOk || '从未'}（${ageDays > 900 ? '无记录' : ageDays + '天前'}），cron 30 3 * * * 可能没跑或一直失败`);
  }
  if (kept === 0) bAlerts.push('备份目录里没有任何 .db.gz，恢复路径不可用');
  if (alertLines.length) bAlerts.push(`备份日志有 ${alertLines.length} 条 BACKUP-ALERT，最近一条：${alertLines.at(-1).trim()}`);
  snap.backup.alerts = bAlerts;
} catch (e) {
  snap.backup = { error: String((e && e.message) || e) };
}

fs.writeFileSync(OUT, JSON.stringify(snap, null, 1));
console.log(dayKey(now), 'snapshot OK | days:', snap.days.length, '| alerts:', alerts.length, '| offline:', offline.length, '| archive:', snap.archive_mb + 'MB', '| disk:', (snap.disk_usage_pct ?? '?') + '%', snap.disk_alert ? 'DISK_ALERT' : '',
  '| backup:', snap.backup?.last_ok || 'NONE', `${snap.backup?.kept ?? 0}份`,
  (snap.backup?.alerts?.length ? `BACKUP_ALERT(${snap.backup.alerts.length})` : 'backup-ok'));
