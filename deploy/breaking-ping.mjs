#!/usr/bin/env node
/**
 * breaking-ping.mjs — 重磅快讯探针（服务器本地，每30分钟 crontab 跑）
 * 目的：把"重磅新闻最多3-6小时入库"再压到"30分钟发现+8分钟触发采集≈40分钟入库"。
 * 机制：只拉5个最快源的RSS首页层（每条几百KB），解析最新item的link+时间；
 *       90分钟内发布且未入库的新条目中，官方源一律触发，媒体源须命中大事关键词；
 *       命中则立即 dispatch 一轮 light 采集（走完整AI评分链路，探针不自己判分）。
 * 频控：两次触发至少间隔90分钟（防媒体刷屏式连发把Actions打满）。
 * 零成本前提：仓库public（Actions分钟无限），探针流量在服务器自身带宽内可忽略。
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
const DB = '/opt/ai-news/data/articles.db';
const STATE = '/opt/ai-news/.breaking-ping-state.json';
const COOLDOWN_MS = 90 * 60 * 1000;
const FRESH_MS = 90 * 60 * 1000;

const FEEDS = [
  { name: 'OpenAI Blog', url: 'https://openai.com/blog/rss.xml', official: true },
  { name: 'Google DeepMind', url: 'https://deepmind.google/blog/feed/basic/', official: true },
  { name: 'NVIDIA Blog', url: 'https://blogs.nvidia.com/feed/', official: true },
  { name: 'The Decoder', url: 'https://the-decoder.com/feed/', official: false },
  { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', official: false },
];
// 媒体源大事关键词（官方源新条目一律算大事，不过滤）
const BIG = /launch|reveal|announce|releas|introduc|unveil|acqui|merg|rais|fund|billion|trillion|GPT-|Gemini|Claude|Llama|DeepSeek|open.?source|AGI|发布|推出|开源|收购|融资|万亿|亿美/;

function fetchText(url) {
  try {
    return execFileSync('curl', ['-s', '-m', '15', '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', '-L', url], {
      maxBuffer: 10 * 1024 * 1024, encoding: 'utf8',
    });
  } catch { return ''; }
}
function items(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const b = m[0];
    const link = (b.match(/<link>(?:<!\[CDATA\[)?\s*(\S+?)\s*(?:\]\]>)?<\/link>/) || [])[1];
    const date = (b.match(/<pubDate>(.*?)<\/pubDate>/) || b.match(/<dc:date>(.*?)<\/dc:date>/) || [])[1];
    const title = ((b.match(/<title>(?:<!\[CDATA\[)?\s*([\s\S]*?)\s*(?:\]\]>)?<\/title>/) || [])[1] || '').slice(0, 60);
    if (link && date) out.push({ link, ts: Date.parse(date), title });
  }
  return out;
}
function inDb(link) {
  try {
    const r = execFileSync('sqlite3', [DB, `SELECT 1 FROM articles WHERE source_url='${link.replace(/'/g, "''")}' LIMIT 1`], { encoding: 'utf8' });
    return r.trim() === '1';
  } catch { return true; } // 查询失败按已入库处理，宁可不触发
}
let state = { lastTrigger: 0 };
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
const now = Date.now();
if (now - (state.lastTrigger || 0) < COOLDOWN_MS) process.exit(0);

const hits = [];
for (const f of FEEDS) {
  const fresh = items(fetchText(f.url))
    .filter(x => x.ts && now - x.ts < FRESH_MS && now - x.ts > -2 * 3600e3)
    .filter(x => !inDb(x.link))
    .filter(x => f.official || BIG.test(x.title));
  for (const x of fresh) hits.push(`${f.name}: ${x.title}`);
}
if (hits.length) {
  execFileSync('/opt/ai-news/trigger-collect.sh', ['light']);
  state.lastTrigger = now;
  fs.writeFileSync(STATE, JSON.stringify(state));
  console.log(new Date().toISOString(), `快讯命中${hits.length}条，已触发light轮:\n  ` + hits.join('\n  '));
}
