/**
 * 字符集解码离线回归测试（2026-09-28 MIC 乱码事故）。
 *
 * 用三个真实政务源的响应字节样本（存在 tests/fixtures/*.raw，抓取自 2026-09-28）：
 *   - 総務省 news.rdf：HTTP 头**无** charset，但 XML 声明 Shift_JIS —— 旧 resp.text()
 *     按 UTF-8 硬解 → 大面积 U+FFFD；本测试断言新解码器嗅探到 Shift_JIS、0 乱码。
 *   - METI /press/：UTF-8。
 *   - デジタル庁 news.xml：HTTP 头声明 charset=utf-8。
 * 全程不联网，仅读本地 fixture，可在 Actions/CI/本地随时 `node tests/test-charset.mjs`。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodeBody, mojibakeRatio, normalizeLabel } from '../charset.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = (f) => path.join(__dirname, 'fixtures', f);

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`PASS ${msg}`); }
  else { failed++; console.error(`FAIL ${msg}`); }
}
const oldUtf8 = (buf) => new TextDecoder('utf-8', { fatal: false }).decode(buf);

// —— 総務省 MIC：无 HTTP charset，靠 XML 声明 Shift_JIS ——
{
  const buf = fs.readFileSync(FIX('soumu-news.rdf.raw'));
  const d = decodeBody(buf, { contentType: 'text/xml' }); // 头里没有 charset
  ok(d.encoding === 'shift_jis', `MIC: 无HTTP charset 时从XML声明嗅探到 shift_jis (实际=${d.encoding})`);
  ok(mojibakeRatio(d.text) === 0, `MIC: 新解码 U+FFFD=0 (实际=${mojibakeRatio(d.text)})`);
  ok(/情報通信|ホームページ|審議会/.test(d.text), 'MIC: 解码后含正确日文关键词(情報通信/ホームページ/審議会)');
  const bad = mojibakeRatio(oldUtf8(buf));
  ok(bad > 0.05, `MIC: 对照——旧法(UTF-8硬解)确会乱码 U+FFFD=${bad.toFixed(4)} >0.05（证明修复必要）`);
}

// —— METI：UTF-8 ——
{
  const buf = fs.readFileSync(FIX('meti-press.html.raw'));
  const d = decodeBody(buf, { contentType: 'text/html' });
  ok(d.encoding === 'utf-8', `METI: 解码为 utf-8 (实际=${d.encoding})`);
  ok(mojibakeRatio(d.text) < 0.005, `METI: U+FFFD≈0 (实际=${mojibakeRatio(d.text)})`);
  ok(/経済産業省|プレス|リリース/.test(d.text), 'METI: 含正确日文关键词(経済産業省/プレス/リリース)');
}

// —— デジタル庁：HTTP 头声明 charset=utf-8 ——
{
  const buf = fs.readFileSync(FIX('digital-news.xml.raw'));
  const d = decodeBody(buf, { contentType: 'application/rss+xml; charset=utf-8' });
  ok(d.declared === 'utf-8', `デジタル庁: 采用 HTTP 声明的 utf-8 (declared=${d.declared})`);
  ok(mojibakeRatio(d.text) === 0, `デジタル庁: U+FFFD=0`);
  ok(/デジタル庁|新着/.test(d.text), 'デジタル庁: 含正确日文关键词(デジタル庁/新着)');
}

// —— 编码别名归一（覆盖 GBK/EUC-KR/Big5/Shift-JIS 变体）——
{
  ok(normalizeLabel('Shift-JIS') === 'shift_jis', '别名: Shift-JIS→shift_jis');
  ok(normalizeLabel('EUC-JP') === 'euc-jp', '别名: EUC-JP→euc-jp');
  ok(normalizeLabel('gb2312') === 'gbk', '别名: gb2312→gbk');
  ok(normalizeLabel('EUC-KR') === 'euc-kr', '别名: EUC-KR→euc-kr');
  const cn = decodeBody(Buffer.from([0xd6, 0xd0, 0xb9, 0xfa]), { contentType: 'text/html; charset=gbk' });
  ok(cn.text === '中国', `声明 GBK 解码 "中国" (实际=${JSON.stringify(cn.text)})`);
}

console.log(`\n=== test-charset: ${passed}/${passed + failed} PASS${failed ? ' (有失败!)' : ''} ===`);
if (failed) process.exit(1);
