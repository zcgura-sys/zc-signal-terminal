// 审计 / 后台任务 / 审批中心的「按登录账号隔离」回归测试
// 复现并防回归：一个用户的后台任务、审计日志、审批单不能被其他登录用户读到或改动。
// 运行：node test_owner_isolation.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import crypto from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcown-'));
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

const env = { ZC_KV: KV, ZC_SEC_MODE: 'off' };          // 本测试只关心业务授权，关掉安全网关
const envAnon = { ZC_KV: KV, ZC_SEC_MODE: 'off', ZC_AUTH_DISABLED: '1' };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const H = {
  'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
  'accept-language': 'zh-CN,zh;q=0.9',
  'sec-fetch-site': 'same-origin'
};
function call(pathname, tok, body, useEnv) {
  const headers = Object.assign({}, H, tok ? { 'x-zc-session': tok } : {}, body ? { 'content-type': 'application/json' } : {});
  return worker.fetch(new Request('https://signal.example' + pathname, {
    method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined
  }), useEnv || env, ctx);
}
const jget = async (r) => { try { return await r.json(); } catch (e) { return null; } };
const tick = () => new Promise((r) => setTimeout(r, 10));

const R = [];
async function check(name, fn) { try { await fn(); R.push(['PASS', name]); } catch (e) { R.push(['FAIL', name + ' → ' + (e && e.message)]); } }

const SECRET = 'ALICE-机密-任务-9f3a';
let taskA = null;

await check('A 创建后台任务（返回任务 id）', async () => {
  const r = await call('/__zc_task__', tokA, { action: 'create', kind: 'agent', title: SECRET });
  const j = await jget(r);
  assert.strictEqual(r.status, 200, 'HTTP ' + r.status);
  taskA = j && j.task;
  assert.ok(taskA && taskA.id, '未返回任务 id');
  await tick();
});

await check('B 拉取后台任务列表 → 看不到 A 的任务（隐私泄露点）', async () => {
  const j = await jget(await call('/__zc_task__', tokB));
  const hit = (j.items || []).filter((x) => x.id === taskA.id || String(x.title || '').indexOf('ALICE-机密') >= 0);
  assert.strictEqual(hit.length, 0, 'B 读到了 A 的任务：' + JSON.stringify(hit.slice(0, 2)));
});

await check('B 无法用 A 的任务 id 更新任务', async () => {
  const r = await call('/__zc_task__', tokB, { action: 'update', id: taskA.id, note: 'B改写', status: 'done' });
  assert.ok(r.status === 404 || r.status === 403, 'update 应被拒，实际 ' + r.status);
  await tick();
  const j = await jget(await call('/__zc_task__', tokA));
  const mine = (j.items || []).filter((x) => x.id === taskA.id)[0];
  assert.ok(mine, 'A 自己的任务应仍可见');
  assert.notStrictEqual(mine.note, 'B改写', 'A 的任务被 B 改写了');
  assert.notStrictEqual(mine.status, 'done', 'A 的任务状态被 B 改写了');
});

await check('B 无法取消 A 的任务', async () => {
  const r = await call('/__zc_task__', tokB, { action: 'cancel', id: taskA.id });
  assert.ok(r.status === 404 || r.status === 403, 'cancel 应被拒，实际 ' + r.status);
  await tick();
  const j = await jget(await call('/__zc_task__', tokA));
  const mine = (j.items || []).filter((x) => x.id === taskA.id)[0];
  assert.notStrictEqual(mine && mine.cancelRequested, true, 'A 的任务被 B 取消了');
});

await check('B 拉取审计日志 → 看不到 A 的任务审计条目', async () => {
  const j = await jget(await call('/__zc_audit__', tokB));
  const hit = (j.items || []).filter((x) => String(x.reason || '').indexOf('ALICE-机密') >= 0 || (x.taskId && x.taskId === taskA.id));
  assert.strictEqual(hit.length, 0, 'B 读到了 A 的审计：' + JSON.stringify(hit.slice(0, 2)));
});

await check('B 清空审计日志，不会清掉 A 的条目', async () => {
  const r = await call('/__zc_audit__', tokB, { action: 'clear', confirm: true });
  assert.strictEqual(r.status, 200, 'HTTP ' + r.status);
  await tick();
  const j = await jget(await call('/__zc_audit__?kw=' + encodeURIComponent('ALICE-机密'), tokA));
  assert.ok((j.items || []).length >= 1, 'A 的审计被 B 清空了');
});

let apA = null;
await check('A 申请一张审批单', async () => {
  const r = await call('/__zc_approval__', tokA, { action: 'create', kind: 'sandbox:exec', title: 'A 的审批单', detail: SECRET, risk: 'high' });
  const j = await jget(r);
  assert.strictEqual(r.status, 200, 'HTTP ' + r.status);
  apA = j && j.approval;
  assert.ok(apA && apA.id);
  await tick();
});

await check('B 拉取审批列表 → 看不到 A 的审批单', async () => {
  const j = await jget(await call('/__zc_approval__', tokB));
  const all = [].concat(j.pending || [], j.recent || []);
  assert.strictEqual(all.filter((x) => x.id === apA.id).length, 0, 'B 读到了 A 的审批单');
});

await check('B 无法批准 / 否决 A 的审批单', async () => {
  const r = await call('/__zc_approval__', tokB, { action: 'decide', id: apA.id, decision: 'approve' });
  assert.ok(r.status === 404 || r.status === 403, 'decide 应被拒，实际 ' + r.status);
  await tick();
  const j = await jget(await call('/__zc_approval__', tokA));
  const mine = (j.recent || []).filter((x) => x.id === apA.id)[0];
  assert.strictEqual(mine && mine.decision, 'pending', 'A 的审批单被 B 处理了');
});

await check('A 自己仍能正常处理自己的审批单（隔离不是一刀切屏蔽）', async () => {
  const r = await call('/__zc_approval__', tokA, { action: 'decide', id: apA.id, decision: 'approve', scope: 'once' });
  assert.strictEqual(r.status, 200, 'HTTP ' + r.status);
  await tick();
  const j = await jget(await call('/__zc_approval__', tokA));
  const mine = (j.recent || []).filter((x) => x.id === apA.id)[0];
  assert.strictEqual(mine && mine.decision, 'approve');
});

await check('A 自己的任务 / 审计仍可见', async () => {
  const jt = await jget(await call('/__zc_task__', tokA));
  assert.ok((jt.items || []).some((x) => x.id === taskA.id), 'A 看不到自己的任务');
  const ja = await jget(await call('/__zc_audit__', tokA));
  assert.ok((ja.items || []).length >= 1, 'A 看不到自己的审计');
  assert.strictEqual(ja.ownerLeak, undefined);
});

await check('模拟 isolate 重启（内存态清空）后，仍然按账号隔离', async () => {
  delete globalThis.__zcState;   // 丢弃内存态，强制走 KV 持久化路径
  const jt = await jget(await call('/__zc_task__', tokB));
  assert.ok(!(jt.items || []).some((x) => x.id === taskA.id), '重启后 B 从持久层读到了 A 的任务');
  const jtA = await jget(await call('/__zc_task__', tokA));
  assert.ok((jtA.items || []).some((x) => x.id === taskA.id), '重启后 A 读不到自己的任务（持久层丢失归属）');
  const jaA = await jget(await call('/__zc_audit__?kw=' + encodeURIComponent('ALICE-机密'), tokA));
  assert.ok((jaA.items || []).length >= 1, '重启后 A 看不到自己的审计');
  const jaB = await jget(await call('/__zc_audit__?kw=' + encodeURIComponent('ALICE-机密'), tokB));
  assert.strictEqual((jaB.items || []).length, 0, '重启后 B 读到了 A 的审计');
});

await check('未登录访问三个接口 → 401（原有鉴权不变）', async () => {
  for (const p of ['/__zc_task__', '/__zc_audit__', '/__zc_approval__']) {
    const r = await call(p, '');
    assert.strictEqual(r.status, 401, p + ' → ' + r.status);
  }
});

await check('关闭登录（单人自用）时匿名接口照旧可用', async () => {
  const r = await call('/__zc_task__', '', { action: 'create', kind: 'agent', title: 'anon 任务' }, envAnon);
  assert.strictEqual(r.status, 200, 'HTTP ' + r.status);
  await tick();
  const j = await jget(await call('/__zc_task__', '', null, envAnon));
  assert.ok((j.items || []).some((x) => String(x.title || '') === 'anon 任务'), '匿名模式看不到自己的任务');
});

for (const [s, n] of R) console.log(s, n);
const bad = R.filter((r) => r[0] === 'FAIL').length;
console.log(bad ? ('\n' + bad + ' 项失败') : '\n全部通过');
process.exit(bad ? 1 : 0);
