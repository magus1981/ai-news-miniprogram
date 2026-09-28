/**
 * 隔离队列 / 半成品回补重跑（2026-09-28 事故修复配套）
 *
 * 用途：当 DashScope 恢复（欠费缴清/换密钥）后，把此前被 fail-fast 闸门拦下的
 * 半成品（翻译/summary 失败、乱码、评分降级）重新加工成合格条目：
 *   - 从 articles_quarantine 读待重跑条目；
 *   - 可选 --include-bad-articles：同时就地修复主列表里残留的半成品（如 09-28 那 10 条 MIC 乱码）；
 *   - 重抓全文（charset 已修复）→ 重新生成翻译/takeaway/summary → AI 二审；
 *   - 合格则写回主列表并从隔离表删除；仍失败则 attempts+1 留在表里。
 *
 * 用法：
 *   node pipeline/reprocess-quarantine.mjs                 # 只重跑隔离队列
 *   node pipeline/reprocess-quarantine.mjs --date 2026-09-28
 *   node pipeline/reprocess-quarantine.mjs --include-bad-articles
 *   node pipeline/reprocess-quarantine.mjs --limit 50 --dry-run
 *
 * 前置：DASHSCOPE_API_KEY 必须可用（脚本开头会探活；欠费未解会直接退出，不空跑）。
 */
import './load-env.mjs';
import {
  initDB, insertArticles, insertQuarantine, getQuarantineBatch, deleteQuarantineByUrl,
  getBadMainArticles, updateArticleFromReprocess, deleteArticleByUrl, getArticlesByDate,
  saveDailyIntro, countQuarantine,
} from './db.mjs';
import { fetchFullContents } from './fetch-content.mjs';
import { generateSummaries } from './ai-summary.mjs';
import { reviewSummaries } from './ai-review.mjs';
import { generateDailyIntro } from './ai-intro.mjs';
import { mojibakeRatio } from './charset.mjs';

const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dateKey = argVal('--date');
const limit = Number(argVal('--limit')) || 50;
const DRY = args.includes('--dry-run');
const INCLUDE_BAD = args.includes('--include-bad-articles');

/** 加工是否合格（口径与 collect 写库闸门一致） */
function isClean(a) {
  return a
    && !a._proc_failed
    && a.takeaway && String(a.takeaway).trim()
    && mojibakeRatio(a.title || '') <= 0.05
    && mojibakeRatio(a.summary || '') <= 0.05;
}

async function probeLLM() {
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) { console.error('[ABORT] DASHSCOPE_API_KEY 未设置，无法回补。'); return false; }
  try {
    const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: process.env.SUMMARY_MODEL || 'qwen-max', messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }),
      signal: AbortSignal.timeout(30000),
    });
    if (r.ok) return true;
    const t = await r.text();
    let code = ''; try { code = JSON.parse(t).error?.code || ''; } catch {}
    console.error(`[ABORT] DashScope 探活失败 HTTP ${r.status} code=${code}：${t.slice(0, 200)}`);
    console.error('  请先解决账号欠费(Arrearage)/配额/密钥问题，再跑本脚本回补。');
    return false;
  } catch (e) { console.error('[ABORT] DashScope 探活异常:', e.message); return false; }
}

async function reprocessOne(raw) {
  // raw 可能来自隔离表或主列表半成品；补齐 fetch/summary 所需字段
  const art = {
    title: raw.title,
    original_title: raw.original_title || (raw.language !== 'zh' ? raw.title : null),
    source_name: raw.source_name,
    source_url: raw.source_url,
    category: raw.category,
    language: raw.language || '',
    source_type: raw.source_type || '',
    published_at: raw.published_at,
    date_key: raw.date_key,
    ai_score: raw.ai_score,
    content_snippet: raw.content_snippet || '',
    content: raw.content || '',
    // 隔离/坏行的评分不可信（多来自降级），重跑后维持来源分但强制不精选
    is_featured: false,
    newsness: raw.newsness || 'fresh',
  };
  // 重新抓全文（charset 修复后不会再乱码）
  await fetchFullContents([art]);
  const [summarized] = await generateSummaries([art]);
  const [reviewed] = await reviewSummaries([summarized]);
  return { art: reviewed, ok: isClean(reviewed) };
}

async function main() {
  console.log('=== 隔离/半成品 回补重跑 ===');
  console.log(`参数: date=${dateKey || '隔离全部'} limit=${limit} include-bad-articles=${INCLUDE_BAD} dry-run=${DRY}`);
  await initDB();

  const ok = await probeLLM();
  if (!ok) process.exit(1);

  const queue = await getQuarantineBatch(limit, dateKey);
  const bad = INCLUDE_BAD ? await getBadMainArticles(dateKey) : [];
  console.log(`待重跑: 隔离队列 ${queue.length} 条，主列表半成品 ${bad.length} 条\n`);

  if (!queue.length && !bad.length) { console.log('无待回补条目。当前隔离队列总数：', await countQuarantine()); return; }

  const affectedDays = new Set();
  let fixed = 0, refail = 0;

  // 1) 隔离队列 → 合格后写入主列表并删除隔离行
  for (const raw of queue) {
    const { art, ok: clean } = await reprocessOne(raw);
    if (clean) {
      if (DRY) { console.log(`[DRY] 合格: ${(art.title || '').slice(0, 40)}`); fixed++; affectedDays.add(art.date_key); continue; }
      await deleteArticleByUrl(art.source_url);            // 清掉可能的旧半成品（若有）
      await insertArticles([art]);
      await deleteQuarantineByUrl(art.source_url);
      fixed++; affectedDays.add(art.date_key);
      console.log(`  [OK] 重跑入库: ${(art.title || '').slice(0, 46)}（takeaway ${String(art.takeaway).length}字）`);
    } else {
      refail++;
      console.warn(`  [STILL-FAIL] ${(art.title || raw.source_url || '').slice(0, 40)} → 继续留在隔离表`);
    }
  }

  // 2) 主列表半成品 → 就地 UPDATE（保留 id 与排序位）
  for (const row of bad) {
    const { art, ok: clean } = await reprocessOne(row);
    if (clean) {
      if (DRY) { console.log(`[DRY] 主列表可修复 #${row.id}: ${(art.title || '').slice(0, 40)}`); fixed++; affectedDays.add(row.date_key); continue; }
      await updateArticleFromReprocess(row.id, art);
      fixed++; affectedDays.add(row.date_key);
      console.log(`  [FIXED-IN-PLACE] #${row.id} ${(art.title || '').slice(0, 46)}`);
    } else {
      refail++;
      console.warn(`  [STILL-BAD] #${row.id} ${(row.title || '').slice(0, 40)}：主列表半成品重跑后仍不合格，建议人工介入/删除`);
    }
  }

  // 3) 受影响发布日重生导语
  if (!DRY) {
    for (const d of affectedDays) {
      const src = await getArticlesByDate(d);
      const intro = await generateDailyIntro(src);
      if (intro) { await saveDailyIntro(d, intro); console.log(`  导语[${d}] 已重生成`); }
    }
  }

  console.log('\n=== 回补完成 ===');
  console.log(`合格入库/修复: ${fixed} 条；仍失败: ${refail} 条；隔离表剩余: ${await countQuarantine()} 条${DRY ? '（DRY-RUN 未落库）' : ''}`);
}

main().catch(err => { console.error('回补脚本异常:', err); process.exit(1); });
