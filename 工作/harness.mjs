import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';

// 把后端复制成 .mjs 以便 Node 以 ESM 载入（原文件是 ESM，但扩展名 .js 会被当作 CJS）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcharness-'));
const mjsPath = path.join(tmpDir, 'worker.mjs');
fs.copyFileSync('_worker.js', mjsPath);
const mod = await import(mjsPath);
const worker = mod.default;

const pubDir = path.resolve('public');   // v2.23：静态资源目录 = public/（与 wrangler.jsonc 的 assets.directory 一致）
// 模拟 Cloudflare ASSETS 绑定（按 .assetsignore 白名单放行）
const ALLOWED = new Set(['/index.html', '/admin.html']);
const ASSETS = {
  async fetch(req) {
    const u = new URL(req.url);
    if (!ALLOWED.has(u.pathname)) return new Response('Not Found', { status: 404 });
    const file = path.join(pubDir, decodeURIComponent(u.pathname));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not Found', { status: 404 });
    return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': 'text/html' } });
  }
};

const env = { ASSETS, ZC_KV: null, DB: null };
const ctx = { waitUntil() {}, passThroughOnException() {} };

// 带浏览器特征头，避免被安全网关（防爬虫）拦截
const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document'
};
const call = (p, init) => {
  const h = Object.assign({}, BROWSER_HEADERS, (init && init.headers) || {});
  return worker.fetch(new Request('https://signal.example' + p, Object.assign({}, init, { headers: h })), env, ctx);
};

const results = [];
async function check(name, fn) {
  try { const d = await fn(); results.push(['PASS', name, d || '']); }
  catch (e) { results.push(['FAIL', name, e && e.message ? e.message : String(e)]); }
}

await check('GET / 返回主页面', async () => {
  const r = await call('/');
  const t = await r.text();
  assert.strictEqual(r.status, 200, 'status=' + r.status);
  assert.ok(t.startsWith('<!DOCTYPE html>'), 'not html');
  assert.ok(t.trimEnd().endsWith('</html>'), 'not html tail');
  return 'len=' + t.length;
});

await check('GET /index.html 走静态资源', async () => {
  const r = await call('/index.html');
  const t = await r.text();
  assert.strictEqual(r.status, 200);
  assert.ok(t.startsWith('<!DOCTYPE html>'));
  return 'len=' + t.length;
});

await check('GET /__zc_admin__ 返回管理页', async () => {
  const r = await call('/__zc_admin__');
  const t = await r.text();
  assert.strictEqual(r.status, 200);
  assert.ok(t.includes('用户管理'), 'admin page title missing');
  return 'len=' + t.length;
});

await check('GET /__zc_health__ JSON', async () => {
  const r = await call('/__zc_health__', { headers: { 'accept': 'application/json' } });
  const j = await r.json();
  assert.ok(j.ok === true, 'ok!=true');
  assert.ok(j.version, 'no version');
  assert.strictEqual(j.pages, true);
  return 'version=' + j.version + ' store=' + j.store;
});

await check('GET /favicon.ico → 204', async () => {
  const r = await call('/favicon.ico');
  assert.strictEqual(r.status, 204);
  return '';
});

await check('未知静态路径 → 404', async () => {
  const r = await call('/no-such-file.png');
  assert.strictEqual(r.status, 404);
  return 'status=404';
});

await check('静态资源缺失时回退兜底页', async () => {
  const emptyEnv = { ASSETS: { async fetch() { return new Response('nf', { status: 404 }); } }, ZC_KV: null, DB: null };
  const r = await worker.fetch(new Request('https://signal.example/', { headers: BROWSER_HEADERS }), emptyEnv, ctx);
  const t = await r.text();
  assert.strictEqual(r.status, 200);
  assert.ok(t.includes('SIGNAL 已部署'), 'fallback page missing');
  return 'fallback ok';
});

await check('POST /__zc_relay__ 缺 header → 400', async () => {
  const r = await call('/__zc_relay__', { method: 'POST', body: '{}' });
  assert.ok(r.status === 400 || r.status === 403, 'status=' + r.status);
  return 'status=' + r.status;
});

await check('跨站调用 relay 被拒', async () => {
  const r = await worker.fetch(new Request('https://signal.example/__zc_relay__', {
    method: 'POST', headers: Object.assign({}, BROWSER_HEADERS, { 'sec-fetch-site': 'cross-site', 'origin': 'https://evil.example' }), body: '{}'
  }), env, ctx);
  assert.ok(r.status === 403, 'status=' + r.status);
  return 'blocked=' + r.status;
});

console.log('\n===== 冒烟测试结果 =====');
for (const [s, n, d] of results) console.log(s.padEnd(4) + ' | ' + n + (d ? '  → ' + d : ''));
const failed = results.filter((x) => x[0] === 'FAIL').length;
console.log('===== ' + (results.length - failed) + '/' + results.length + ' 通过 =====');
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(failed ? 1 : 0);