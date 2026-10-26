// 沙箱按账号隔离的回归测试：node test_sandbox_isolation.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import crypto from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcsbx-'));
const mjsPath = path.join(tmpDir, 'worker.mjs');
fs.copyFileSync('_worker.js', mjsPath);
const worker = (await import(mjsPath)).default;

// 内存版 KV（只实现 get/put/delete/list）
const store = new Map();
const KV = {
  async get(k) { return store.has(k) ? store.get(k).v : null; },
  async put(k, v, o) { store.set(k, { v: String(v), md: o && o.metadata }); },
  async delete(k) { store.delete(k); },
  async list() { return { keys: [], list_complete: true }; }
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function mkSession(email, provider) {
  const token = crypto.randomBytes(32).toString('hex');
  store.set('zc_sess:' + sha(token), { v: JSON.stringify({ email, createdAt: Date.now(), seenAt: Date.now(), provider }) });
  return token;
}
const tokA = mkSession('alice@github', 'github');
const tokB = mkSession('bob@github', 'github');
const tokInvite = mkSession('staff01@corp.example', 'invite');

// 拦截 E2B 平台调用：记录“创建沙箱”时的 metadata.ws
const created = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url && url.url ? url.url : url);
  if (u.startsWith('https://api.e2b.app/v2/sandboxes') && init && init.method === 'POST') {
    const body = JSON.parse(init.body);
    created.push(body.metadata && body.metadata.ws);
    return new Response(JSON.stringify({ sandboxID: 'sbx' + created.length + 'abcdefgh', envdAccessToken: 'tok' }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  if (u.startsWith('https://api.e2b.app')) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response('fail', { status: 500 });   // envd 执行通道：直接失败即可，本测试只关心创建时用的 ws
};

const env = { ZC_KV: KV, E2B_API_KEY: 'e2b_testkey_123456789' };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const H = { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
const call = (sub, tok, ws, extra) => worker.fetch(new Request('https://signal.example/__zc_sandbox__/' + sub, { method: 'POST', headers: Object.assign({}, H, tok ? { 'x-zc-session': tok } : {}, ws ? { 'x-zc-workspace': ws } : {}, extra || {}), body: JSON.stringify({ command: 'echo hi' }) }), env, ctx);

const R = [];
async function check(name, fn) { try { await fn(); R.push(['PASS', name]); } catch (e) { R.push(['FAIL', name + ' → ' + (e && e.message)]); } }

await check('未登录访问沙箱 → 401，且不创建沙箱', async () => {
  const n = created.length;
  const r = await call('exec', '', 'main');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(created.length, n);
});
await check('伪造/无效会话 → 401', async () => {
  const r = await call('exec', 'a'.repeat(64), 'main');
  assert.strictEqual(r.status, 401);
});
let wsA, wsB, wsI;
await check('A、B 都用 x-zc-workspace: main，却得到不同的沙箱工作区', async () => {
  created.length = 0;
  await call('exec', tokA, 'main');
  wsA = created[created.length - 1];
  await call('exec', tokB, 'main');
  wsB = created[created.length - 1];
  assert.ok(wsA && wsB, 'created=' + JSON.stringify(created));
  assert.notStrictEqual(wsA, wsB);
  assert.ok(wsA !== 'main' && wsB !== 'main', '不应再使用共享的 main');
});
await check('邀请码登录用户同样被隔离', async () => {
  await call('exec', tokInvite, 'main');
  wsI = created[created.length - 1];
  assert.ok(wsI && wsI !== wsA && wsI !== wsB && wsI !== 'main');
});
await check('同一用户同名工作区稳定（重启后仍回到自己的沙箱）', async () => {
  // 同一个 ws → 派生值固定：直接比对算法
  const expect = 'u' + sha('zc-sbx-v1|alice@github|main').slice(0, 24);
  assert.strictEqual(wsA, expect);
});
await check('同一用户不同项目名 → 不同工作区', async () => {
  await call('exec', tokA, 'projX');
  assert.notStrictEqual(created[created.length - 1], wsA);
});
await check('B 把请求头伪造成 A 的派生名，也只会落到 B 自己的新工作区', async () => {
  await call('exec', tokB, wsA);
  const got = created[created.length - 1];
  assert.notStrictEqual(got, wsA);
});
await check('B 用 x-zc-sbx-id 提示尝试接管 A 的沙箱 → 被拒绝（metadata.ws 不匹配）', async () => {
  // 让 E2B 的 GET /sandboxes/{id} 返回属于 A 的沙箱
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.e2b.app/sandboxes/sbxAAAAAAAA') && (!init || !init.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ sandboxID: 'sbxAAAAAAAA', envdAccessToken: 'tokA', state: 'running', metadata: { app: 'zc-signal', ws: wsA } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return prev(url, init);
  };
  created.length = 0;
  await call('exec', tokB, 'fresh1', { 'x-zc-sbx-id': 'sbxAAAAAAAA' });
  globalThis.fetch = prev;
  assert.strictEqual(created.length, 1, '应新建属于 B 的沙箱而不是接管 A 的；created=' + JSON.stringify(created));
  assert.notStrictEqual(created[0], wsA);
});
await check('ZC_SBX_ALLOW_ANON=1 时才允许匿名（显式开关）', async () => {
  const e2 = Object.assign({}, env, { ZC_SBX_ALLOW_ANON: '1', ZC_AUTH_DISABLED: '1' });
  created.length = 0;
  const r = await worker.fetch(new Request('https://signal.example/__zc_sandbox__/exec', { method: 'POST', headers: Object.assign({}, H, { 'x-zc-workspace': 'main' }), body: '{}' }), e2, ctx);
  assert.notStrictEqual(r.status, 401);
});

globalThis.fetch = realFetch;
for (const [s, n] of R) console.log(s, n);
const bad = R.filter((r) => r[0] === 'FAIL').length;
console.log(bad ? ('\n' + bad + ' 项失败') : '\n全部通过');
process.exit(bad ? 1 : 0);
