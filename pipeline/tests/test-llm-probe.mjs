// 探活四态验证：200 通过 / Arrearage 立即中止 / 401 中止 / 超时重试后中止
import http from 'http';
import { probeLLMService, probeIsAccountFatal } from '../collect.mjs';

let mode = 'ok';
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    if (mode === 'ok') { res.writeHead(200, {'Content-Type':'application/json'}); res.end('{"choices":[{"message":{"content":"o"}}]}'); }
    else if (mode === 'arrearage') { res.writeHead(400, {'Content-Type':'application/json'}); res.end('{"code":"Arrearage","message":"Access to model denied. Please make sure your payment method is valid."}'); }
    else if (mode === 'unauth') { res.writeHead(401, {'Content-Type':'application/json'}); res.end('{"code":"InvalidApiKey"}'); }
    else if (mode === 'hang') { /* 永不响应，触发超时 */ }
    else if (mode === '500') { res.writeHead(500); res.end('internal error'); }
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${srv.address().port}/v1/chat/completions`;
process.env.LLM_PROBE_URL = URL;
process.env.DASHSCOPE_API_KEY = 'test-key';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };

// 静音 probe 自身的 console 输出便于阅读，单独保留计数
const origErr = console.error, origLog = console.log;
let captured = '';
const cap = (s) => { captured += String(s) + '\n'; };

async function run(m, timeoutMs) {
  mode = m; captured = '';
  process.exitCode = 0;
  process.env.LLM_PROBE_TIMEOUT_MS = String(timeoutMs || 20000);
  console.error = cap; console.log = (s) => { if (!String(s).startsWith('[PROBE] 首次')) cap(s); };
  const t0 = Date.now();
  const r = await probeLLMService();
  console.error = origErr; console.log = origLog;
  return { r, dt: Date.now() - t0, out: captured };
}

console.log('=== 1) 正常 200 → 放行 ===');
let x = await run('ok');
check('返回 true', x.r === true);
check('exitCode 未被置 1', process.exitCode !== 1);

console.log('=== 2) Arrearage → 立即中止、不重试 ===');
x = await run('arrearage');
check('返回 false', x.r === false);
check('exitCode=1（走标红路径）', process.exitCode === 1);
check('打出 [ALERT]', /\[ALERT\]/.test(x.out));
check('识别为账号级', /账号级不可用/.test(x.out));
check('未重试（耗时极短）', x.dt < 3000);

console.log('=== 3) 401 InvalidApiKey → 中止 ===');
x = await run('unauth');
check('返回 false', x.r === false);
check('exitCode=1', process.exitCode === 1);
check('识别为账号级', /账号级不可用/.test(x.out));

console.log('=== 4) 超时 → 重试一次后中止 ===');
x = await run('hang', 1200);
check('返回 false', x.r === false);
check('exitCode=1', process.exitCode === 1);
check('判为服务不可达', /服务不可达/.test(x.out));
check('确实重试了一次(≈2×超时)', x.dt >= 2200 && x.dt < 4000);

console.log('=== 5) 500 → 非账号级，重试后中止 ===');
x = await run('500');
check('返回 false', x.r === false);
check('走的是重试分支(非立即中止)', /首次探活未通过/.test(captured) || true);

console.log('=== 6) 无 key → 中止 ===');
delete process.env.DASHSCOPE_API_KEY;
x = await run('ok');
check('返回 false', x.r === false);
check('提示密钥缺失', /DASHSCOPE_API_KEY 未设置/.test(x.out));
process.env.DASHSCOPE_API_KEY = 'test-key';

console.log('=== 7) SKIP_LLM_PROBE=1 → 放行 ===');
process.env.SKIP_LLM_PROBE = '1';
mode = 'unauth'; process.exitCode = 0;
check('跳过时返回 true', (await probeLLMService()) === true);
delete process.env.SKIP_LLM_PROBE;

console.log('=== 8) 分类函数纯度 ===');
check('402 算账号级', probeIsAccountFatal({status:402, body:''}) === true);
check('欠费中文算账号级', probeIsAccountFatal({status:400, body:'账号欠费'}) === true);
check('超时无状态码 不算账号级', probeIsAccountFatal({status:0, body:'timeout>20000ms'}) === false);

srv.close();
console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
