// Turnstile 人机验证测试：未配置时行为不变；配置后登录 / 邀请码注册 / GitHub 入口都要先过验证
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcts-'));
const mjsPath = path.join(tmpDir, 'worker.mjs');
fs.copyFileSync('_worker.js', mjsPath);
const worker = (await import(mjsPath)).default;

const store = new Map();
const KV = {
  async get(k) { return store.has(k) ? store.get(k).v : null; },
  async put(k, v, o) { store.set(k, { v: String(v), md: o && o.metadata }); },
  async delete(k) { store.delete(k); },
  async list() { return { keys: [], list_complete: true }; }
};

// 假的 siteverify：令牌 "good-*" 通过一次，其余失败；"net-down" 模拟服务不可达
const used = new Set();
let verifyCalls = 0;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')) {
    verifyCalls++;
    const tok = init.body.get('response');
    assert.strictEqual(init.body.get('secret'), 'SECRET');
    if (tok === 'net-down') throw new Error('network');
    if (tok.startsWith('good-') && !used.has(tok)) { used.add(tok); return new Response(JSON.stringify({ success: true }), { status: 200 }); }
    return new Response(JSON.stringify({ success: false, 'error-codes': [used.has(tok) ? 'timeout-or-duplicate' : 'invalid-input-response'] }), { status: 200 });
  }
  return new Response('x', { status: 500 });
};

const ctx = { waitUntil() {}, passThroughOnException() {} };
const H = { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
const post = (env, sub, body) => worker.fetch(new Request('https://signal.example/__zc_auth__/' + sub, { method: 'POST', headers: H, body: JSON.stringify(body) }), env, ctx);
const get = (env, sub) => worker.fetch(new Request('https://signal.example/__zc_auth__/' + sub, { method: 'GET', headers: H, redirect: 'manual' }), env, ctx);

const R = [];
async function check(name, fn) { try { await fn(); R.push(['PASS', name]); } catch (e) { R.push(['FAIL', name + ' → ' + (e && e.message)]); } }

const base = { ZC_KV: KV, ZC_AUTH_INVITE_CODES: 'invite-abc' };
const on = Object.assign({}, base, { TURNSTILE_SITE_KEY: 'SITE', TURNSTILE_SECRET_KEY: 'SECRET' });

await check('未配置 Turnstile：/status 不暴露站点密钥，登录不要求令牌', async () => {
  const st = await (await get(base, 'status')).json();
  assert.strictEqual(st.turnstile, '');
  const r = await post(base, 'login', { email: 'nobody', password: 'whatever12' });
  assert.strictEqual(r.status, 401);   // 走到了密码校验，而不是被验证拦下
});
await check('只配了站点密钥没配私密密钥 → 视为未启用（不锁死站点）', async () => {
  const half = Object.assign({}, base, { TURNSTILE_SITE_KEY: 'SITE' });
  assert.strictEqual((await (await get(half, 'status')).json()).turnstile, '');
  assert.strictEqual((await post(half, 'login', { email: 'nobody', password: 'whatever12' })).status, 401);
});
await check('配置后 /status 返回站点密钥（公开），不含私密密钥', async () => {
  const text = await (await get(on, 'status')).text();
  assert.ok(text.includes('"turnstile":"SITE"'));
  assert.ok(!text.includes('SECRET'));
});
await check('登录：不带令牌 → 403 TURNSTILE_FAILED，且不进入密码校验', async () => {
  const r = await post(on, 'login', { email: 'nobody', password: 'whatever12' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await r.json()).code, 'TURNSTILE_FAILED');
});
await check('登录：无效令牌 → 403', async () => {
  assert.strictEqual((await post(on, 'login', { email: 'nobody', password: 'whatever12', cf_turnstile: 'bad' })).status, 403);
});
await check('登录：有效令牌 → 通过验证，进入密码校验（401 账号或密码错误）', async () => {
  assert.strictEqual((await post(on, 'login', { email: 'nobody', password: 'whatever12', cf_turnstile: 'good-1' })).status, 401);
});
await check('令牌只能用一次：重放 → 403 且提示已过期', async () => {
  const r = await post(on, 'login', { email: 'nobody', password: 'whatever12', cf_turnstile: 'good-1' });
  assert.strictEqual(r.status, 403);
  assert.ok((await r.json()).error.includes('过期'));
});
await check('验证服务不可达 → 503（fail closed，不放行）', async () => {
  assert.strictEqual((await post(on, 'login', { email: 'nobody', password: 'whatever12', cf_turnstile: 'net-down' })).status, 503);
});
await check('邀请码注册：无令牌 403；有令牌后才会校验邀请码', async () => {
  const body = { name: 'staff01', password: 'password123', invite: 'wrong' };
  assert.strictEqual((await post(on, 'register-invite', body)).status, 403);
  const r = await post(on, 'register-invite', Object.assign({}, body, { cf_turnstile: 'good-2' }));
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await r.json()).code, 'INVITE_WRONG');
});
await check('邀请码注册：令牌 + 正确邀请码 → 成功', async () => {
  const r = await post(on, 'register-invite', { name: 'staff01', password: 'password123', invite: 'invite-abc', cf_turnstile: 'good-3' });
  assert.strictEqual(r.status, 200);
});
await check('GitHub 入口：未配置 OAuth 时仍是 501，不被验证逻辑误伤', async () => {
  assert.strictEqual((await get(on, 'github/start?ts=good-4')).status, 501);
});
await check('GitHub 入口（已配置 OAuth）：无令牌 → 跳回首页并带错误；有令牌 → 跳 GitHub', async () => {
  const gh = Object.assign({}, on, { GITHUB_OAUTH_CLIENT_ID: 'cid', GITHUB_OAUTH_CLIENT_SECRET: 'csec' });
  const r1 = await get(gh, 'github/start');
  assert.strictEqual(r1.status, 302);
  assert.ok(r1.headers.get('location').includes('zc_auth_err='));
  const r2 = await get(gh, 'github/start?ts=good-5');
  assert.strictEqual(r2.status, 302);
  assert.ok(r2.headers.get('location').startsWith('https://github.com/login/oauth/authorize'));
});

let fail = 0;
for (const [s, m] of R) { console.log(s + '  ' + m); if (s === 'FAIL') fail++; }
console.log(`\n${R.length - fail}/${R.length} passed`);
process.exit(fail ? 1 : 0);
