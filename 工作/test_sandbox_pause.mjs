// v2.34 沙箱「到期暂停 / 自动唤醒 / 定时暂停→恢复」回归测试（模拟 E2B 平台，按官方 OpenAPI 的状态码）：node test_sandbox_pause.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcsbxp-'));
fs.copyFileSync('_worker.js', path.join(tmpDir, 'worker.mjs'));
const worker = (await import(path.join(tmpDir, 'worker.mjs'))).default;

/* ---------- 假 E2B 平台 ---------- */
const boxes = new Map();           // id -> { state: running|paused|killed, md, startedAt }
let log = [];                      // 平台 API 调用记录
const cfg = { rejectPauseFields: false, pausedGet404: false, pauseStatus: 204, connect409: 0, getStatus: 0 };
let seq = 0;
const J = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: { 'content-type': 'application/json' } });
const frame = (o, flag) => { const b = new TextEncoder().encode(JSON.stringify(o)); const out = new Uint8Array(5 + b.length); out[0] = flag || 0; out[1] = (b.length >>> 24) & 255; out[2] = (b.length >>> 16) & 255; out[3] = (b.length >>> 8) & 255; out[4] = b.length & 255; out.set(b, 5); return out; };
const cat = (...a) => { const n = a.reduce((x, y) => x + y.length, 0); const o = new Uint8Array(n); let i = 0; a.forEach((y) => { o.set(y, i); i += y.length; }); return o; };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url && url.url ? url.url : url)); const m = (init && init.method) || 'GET';
  let body = null; try { body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch (e) { body = null; }
  if (u.host === 'api.e2b.app') {
    log.push({ m, p: u.pathname, q: u.search, body });
    let mt;
    if (m === 'POST' && (u.pathname === '/v2/sandboxes' || u.pathname === '/sandboxes')) {
      if (cfg.rejectPauseFields && body && body.autoPause) return J({ message: 'unknown field autoPause' }, 400);
      const id = 'sbx' + (++seq) + 'abcdefgh';
      boxes.set(id, { state: 'running', md: body.metadata, startedAt: new Date().toISOString() });
      return J({ sandboxID: id, envdAccessToken: 'tok' + id, templateID: 'base' }, 201);
    }
    if (m === 'GET' && u.pathname === '/v2/sandboxes') {
      const want = u.searchParams.get('state'); const md = u.searchParams.get('metadata') || '';
      const ws = (md.match(/ws=([^&]*)/) || [])[1];
      return J(Array.from(boxes.entries()).filter(([, b]) => b.state === want && b.md && String(b.md.ws) === ws).map(([id, b]) => ({ sandboxID: id, state: b.state, metadata: b.md, startedAt: b.startedAt })));
    }
    if (m === 'GET' && u.pathname === '/sandboxes') {
      const md = u.searchParams.get('metadata') || ''; const ws = (md.match(/ws=([^&]*)/) || [])[1];
      return J(Array.from(boxes.entries()).filter(([, b]) => b.state === 'running' && b.md && String(b.md.ws) === ws).map(([id, b]) => ({ sandboxID: id, state: b.state, metadata: b.md, startedAt: b.startedAt })));
    }
    if ((mt = u.pathname.match(/^\/sandboxes\/([^/]+)$/)) && m === 'GET') {
      if (cfg.getStatus) return J({ message: 'boom' }, cfg.getStatus);
      const b = boxes.get(mt[1]);
      if (!b || b.state === 'killed') return J({ message: 'not found' }, 404);
      if (b.state === 'paused' && cfg.pausedGet404) return J({ message: 'not found' }, 404);
      return J({ sandboxID: mt[1], state: b.state, metadata: b.md, startedAt: b.startedAt, endAt: new Date(Date.now() + 1800000).toISOString(), envdAccessToken: 'tok' + mt[1] });
    }
    if ((mt = u.pathname.match(/^\/(?:v2\/)?sandboxes\/([^/]+)\/(connect|resume)$/)) && m === 'POST') {
      const b = boxes.get(mt[1]);
      if (!b || b.state === 'killed') return J({ message: 'No accessible sandbox or saved snapshot was found' }, 404);
      if (cfg.connect409 > 0) { cfg.connect409--; return J({ message: 'The sandbox is changing state' }, 409); }
      if (b.state === 'paused') { b.state = 'running'; return J({ sandboxID: mt[1], envdAccessToken: 'tok' + mt[1] }, 201); }
      return J({ sandboxID: mt[1], envdAccessToken: 'tok' + mt[1] }, 200);
    }
    if ((mt = u.pathname.match(/^\/sandboxes\/([^/]+)\/pause$/)) && m === 'POST') {
      const b = boxes.get(mt[1]);
      if (!b || b.state === 'killed') return J({ message: 'not found' }, 404);
      if (cfg.pauseStatus !== 204) return J({ message: 'node is busy' }, cfg.pauseStatus);
      if (b.state === 'paused') return J({ message: 'already paused' }, 409);
      b.state = 'paused'; return new Response(null, { status: 204 });
    }
    if ((mt = u.pathname.match(/^\/sandboxes\/([^/]+)\/(timeout|refreshes)$/)) && m === 'POST') return new Response(null, { status: 204 });
    if ((mt = u.pathname.match(/^\/sandboxes\/([^/]+)$/)) && m === 'DELETE') { const b = boxes.get(mt[1]); if (b) b.state = 'killed'; return new Response(null, { status: 204 }); }
    return J({ message: 'unhandled ' + m + ' ' + u.pathname }, 500);
  }
  if (u.host === 'sandbox.e2b.app') {   // envd：沙箱在跑才能执行，暂停 / 被杀 → 502（和真实代理一样）
    const id = (init.headers && (init.headers['E2b-Sandbox-Id'] || init.headers['e2b-sandbox-id'])) || '';
    const b = boxes.get(id);
    log.push({ m: 'ENVD', p: id, st: b && b.state });
    if (!b || b.state !== 'running') return new Response(JSON.stringify({ sandboxId: id, message: 'The sandbox was not found', code: 502 }), { status: 502 });
    return new Response(cat(frame({ event: { start: { pid: 1 } } }), frame({ event: { data: { stdout: Buffer.from('ok\n').toString('base64') } } }), frame({ event: { end: { exitCode: 0 } } }), frame({}, 2)), { status: 200, headers: { 'content-type': 'application/connect+json' } });
  }
  return new Response('fail', { status: 500 });
};
let shift = 0; const realNow = Date.now; Date.now = () => realNow() + shift;

const ctx = { waitUntil() { }, passThroughOnException() { } };
const H = { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
const mkEnv = (x) => Object.assign({ E2B_API_KEY: 'e2b_testkey_123456789', ZC_SBX_ALLOW_ANON: '1' }, x || {});
const _log = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; _log(...a); };
const call = async (sub, ws, env, bodyObj, extra) => {
  const r = await worker.fetch(new Request('https://signal.example/__zc_sandbox__/' + sub, { method: 'POST', headers: Object.assign({}, H, { 'x-zc-workspace': ws }, extra || {}), body: JSON.stringify(bodyObj || { command: 'echo hi' }) }), env || mkEnv(), ctx);
  let j = null; try { j = await r.json(); } catch (e) { /* ignore */ }
  return { status: r.status, j };
};
const R = [];
async function check(name, fn) { const t0 = realNow(); try { await fn(); R.push(['PASS', name]); } catch (e) { R.push(['FAIL', name + ' → ' + (e && e.message)]); } if (process.env.ZC_DEBUG) console.error(R[R.length - 1][0] + ' ' + name.slice(0, 60) + ' ' + (realNow() - t0) + 'ms'); }
const creates = () => log.filter((x) => x.m === 'POST' && (x.p === '/v2/sandboxes' || x.p === '/sandboxes'));
const idOf = (ws) => { const c = Array.from(boxes.entries()).filter(([, b]) => b.md && b.md.ws === ws); return c.length ? c[c.length - 1][0] : ''; };

await check('创建：带 autoPause:true + autoResume.enabled（到期暂停而不是销毁），且标明 mode=pause', async () => {
  const r = await call('exec', 'w1');
  assert.strictEqual(r.status, 200, JSON.stringify(r.j)); assert.strictEqual(r.j.ok, true);
  const c = creates()[0].body;
  assert.strictEqual(c.autoPause, true); assert.deepStrictEqual(c.autoResume, { enabled: true }); assert.strictEqual(c.metadata.ws, 'w1');
  assert.strictEqual(r.j.sbxMode, 'pause'); assert.strictEqual(r.j.fresh, true, '本次请求新建了沙箱 → fresh');
  const r2 = await call('exec', 'w1'); assert.strictEqual(r2.j.sandboxId, r.j.sandboxId); assert.ok(!r2.j.fresh, '第二次不该再 fresh');
});
await check('创建：账号 / 接口不认暂停字段（400）→ 依次退一档，最后退回「到期即 kill」并如实标明 mode=kill', async () => {
  cfg.rejectPauseFields = true; log = [];
  const r = await call('exec', 'w2'); cfg.rejectPauseFields = false;
  assert.strictEqual(r.status, 200, JSON.stringify(r.j));
  const cs = creates().map((x) => x.body);
  assert.ok(cs.length >= 3 && cs[0].autoResume && cs[1].autoPause && !cs[1].autoResume && !cs[2].autoPause, JSON.stringify(cs.map((x) => Object.keys(x))));
  assert.strictEqual(r.j.sbxMode, 'kill');
});
await check('E2B_AUTO_PAUSE=0：创建时不带暂停字段', async () => {
  log = []; const r = await call('exec', 'w3', mkEnv({ E2B_AUTO_PAUSE: '0' }));
  assert.strictEqual(r.status, 200); const c = creates()[0].body; assert.ok(!('autoPause' in c) && !('autoResume' in c), JSON.stringify(c));
});
await check('沙箱睡着了（暂停态）：下一次执行自动唤醒原沙箱 —— 不新建、文件系统还在，响应带 resumed:true', async () => {
  const a = await call('exec', 'w4'); const id = a.j.sandboxId; boxes.get(id).state = 'paused'; log = [];
  const r = await call('exec', 'w4');
  assert.strictEqual(r.status, 200, JSON.stringify(r.j)); assert.strictEqual(r.j.sandboxId, id, '必须还是原来的沙箱');
  assert.strictEqual(creates().length, 0, '不许新建'); assert.strictEqual(r.j.resumed, true);
  assert.ok(log.some((x) => x.p.endsWith('/connect')), '应调用 connect 唤醒'); assert.strictEqual(boxes.get(id).state, 'running');
});
await check('暂停态时 GET 返回 404（部分接口版本）：用 connect 再确认，唤醒而不是误判「已丢失」', async () => {
  const a = await call('exec', 'w5'); const id = a.j.sandboxId; boxes.get(id).state = 'paused'; cfg.pausedGet404 = true; log = [];
  const r = await call('exec', 'w5'); cfg.pausedGet404 = false;
  assert.strictEqual(r.status, 200, JSON.stringify(r.j)); assert.strictEqual(r.j.sandboxId, id); assert.strictEqual(creates().length, 0);
});
await check('正在暂停 / 恢复中（connect 返回 409）：等一等再试，不误判、不新建', async () => {
  const a = await call('exec', 'w6'); const id = a.j.sandboxId; boxes.get(id).state = 'paused'; cfg.connect409 = 2; log = [];
  const r = await call('exec', 'w6');
  assert.strictEqual(r.status, 200, JSON.stringify(r.j)); assert.strictEqual(r.j.sandboxId, id); assert.strictEqual(creates().length, 0);
});
await check('沙箱真的被销毁（GET / connect / resume 全是 404）：才重建，响应 fresh:true 让前端知道工作区是空的', async () => {
  const a = await call('exec', 'w7'); const id = a.j.sandboxId; boxes.get(id).state = 'killed'; log = [];
  const r = await call('exec', 'w7');
  assert.strictEqual(r.status, 200, JSON.stringify(r.j)); assert.notStrictEqual(r.j.sandboxId, id); assert.strictEqual(r.j.fresh, true); assert.strictEqual(creates().length, 1);
});
await check('冷启动（内存里没有会话）：按 metadata 找回「暂停中」的沙箱并唤醒，而不是新建空沙箱', async () => {
  boxes.set('pausedmeta0001', { state: 'paused', md: { app: 'zc-signal', ws: 'w8' }, startedAt: new Date(realNow() - 3600000).toISOString() }); log = [];
  const r = await call('exec', 'w8');
  assert.strictEqual(r.status, 200, JSON.stringify(r.j)); assert.strictEqual(r.j.sandboxId, 'pausedmeta0001'); assert.strictEqual(creates().length, 0); assert.strictEqual(r.j.resumed, true);
});
await check('浏览器带着旧沙箱 ID 回来（沙箱已暂停）：接管并唤醒；别人的 / 没有 ws 元数据的沙箱仍然不接管', async () => {
  boxes.set('pausedhint0001', { state: 'paused', md: { app: 'zc-signal', ws: 'w9' }, startedAt: new Date().toISOString() });
  boxes.set('someoneelse001', { state: 'paused', md: { app: 'zc-signal', ws: 'other' }, startedAt: new Date().toISOString() }); log = [];
  const r = await call('exec', 'w9', null, null, { 'x-zc-sbx-id': 'pausedhint0001' });
  assert.strictEqual(r.j.sandboxId, 'pausedhint0001'); assert.strictEqual(creates().length, 0);
  log = []; const r2 = await call('exec', 'w9b', null, null, { 'x-zc-sbx-id': 'someoneelse001' });
  assert.notStrictEqual(r2.j.sandboxId, 'someoneelse001', '不能凭沙箱 ID 越权接管别的工作区');
});
await check('接口抖动（GET 一直 500）：绝不新建空沙箱，报「暂时无法确认」让调用方重试', async () => {
  const a = await call('exec', 'w10'); const id = a.j.sandboxId; boxes.get(id).state = 'paused'; cfg.getStatus = 500; log = [];
  const r = await call('exec', 'w10'); cfg.getStatus = 0;
  assert.notStrictEqual(r.status, 200); assert.strictEqual(creates().length, 0, '状态不明时不许新建');
});
await check('定时「暂停→恢复」：连续运行超过上限（E2B_MAX_RUN_SECONDS）后，下一次执行前先暂停再恢复，沙箱 ID 不变、命令照常执行', async () => {
  const env = mkEnv({ E2B_MAX_RUN_SECONDS: '300' });
  const a = await call('exec', 'c1', env); const id = a.j.sandboxId;
  log = []; const r0 = await call('exec', 'c1', env); assert.ok(!log.some((x) => x.p.endsWith('/pause')), '没到上限不该暂停');
  shift += 400000; log = [];
  const r = await call('exec', 'c1', env);
  assert.strictEqual(r.status, 200, JSON.stringify(r.j)); assert.strictEqual(r.j.sandboxId, id); assert.strictEqual(r.j.ok, true);
  const i1 = log.findIndex((x) => x.p === '/sandboxes/' + id + '/pause'), i2 = log.findIndex((x, i) => i > i1 && x.p.endsWith('/connect')), i3 = log.findIndex((x, i) => i > i2 && x.m === 'ENVD');
  assert.ok(i1 >= 0 && i2 > i1 && i3 > i2, '顺序应为 暂停 → 恢复 → 执行：' + JSON.stringify(log.map((x) => x.m + ' ' + x.p)));
  assert.strictEqual(r.j.resumed, true); assert.ok(!log.some((x) => x.m === 'DELETE'), '绝不 kill');
  log = []; await call('exec', 'c1', env); assert.ok(!log.some((x) => x.p.endsWith('/pause')), '计时清零后不该再暂停');
});
await check('定时暂停失败（平台 503 节点忙）：不影响本次执行、不 kill、不新建', async () => {
  const env = mkEnv({ E2B_MAX_RUN_SECONDS: '300' });
  const a = await call('exec', 'c2', env); const id = a.j.sandboxId; shift += 400000; cfg.pauseStatus = 503; log = [];
  const r = await call('exec', 'c2', env); cfg.pauseStatus = 204;
  assert.strictEqual(r.status, 200, JSON.stringify(r.j)); assert.strictEqual(r.j.sandboxId, id); assert.strictEqual(creates().length, 0); assert.ok(!log.some((x) => x.m === 'DELETE'));
  assert.strictEqual(boxes.get(id).state, 'running');
});
await check('「到期即 kill」模式的沙箱不做定时暂停（暂停后可能回不来，不冒险）；E2B_MAX_RUN_SECONDS=0 也关闭', async () => {
  const env = mkEnv({ E2B_MAX_RUN_SECONDS: '300' });
  cfg.rejectPauseFields = true; const a = await call('exec', 'c3', env); cfg.rejectPauseFields = false; shift += 400000; log = [];
  await call('exec', 'c3', env); assert.ok(!log.some((x) => x.p.endsWith('/pause')), 'kill 模式不暂停');
  const env0 = mkEnv({ E2B_MAX_RUN_SECONDS: '0' }); await call('exec', 'c4', env0); shift += 99999999; log = [];
  await call('exec', 'c4', env0); assert.ok(!log.some((x) => x.p.endsWith('/pause')), '0 = 关闭');
});
await check('心跳 ping：暂停态 → 唤醒（resumed）；沙箱没了 → gone:true；接口抖动 → ok + unknown（不误报「已过期」）；keepalive 在命令之间触发定时暂停', async () => {
  const a = await call('exec', 'k1'); const id = a.j.sandboxId; boxes.get(id).state = 'paused';
  const p1 = await call('ping', 'k1', null, { keepalive: true });
  assert.strictEqual(p1.j.ok, true); assert.strictEqual(p1.j.resumed, true); assert.strictEqual(boxes.get(id).state, 'running'); assert.strictEqual(p1.j.autoPause, true);
  cfg.getStatus = 500; const p2 = await call('ping', 'k1'); cfg.getStatus = 0; assert.strictEqual(p2.j.ok, true); assert.strictEqual(p2.j.unknown, true); assert.ok(!p2.j.gone);
  const env = mkEnv({ E2B_MAX_RUN_SECONDS: '300' }); await call('exec', 'k2', env); const id2 = idOf('k2'); shift += 400000; log = [];
  const p3 = await call('ping', 'k2', env, { keepalive: true }); assert.strictEqual(p3.j.ok, true);
  assert.ok(log.some((x) => x.p === '/sandboxes/' + id2 + '/pause') && log.some((x) => x.p.endsWith('/connect')), '心跳应触发暂停→恢复');
  boxes.get(id2).state = 'killed'; const p4 = await call('ping', 'k2', env); assert.strictEqual(p4.j.gone, true); assert.strictEqual(p4.j.ok, false);
});
await check('状态接口如实暴露配置：autoPause / maxRunSec', async () => {
  const r = await worker.fetch(new Request('https://signal.example/__zc_sandbox__/status', { method: 'POST', headers: Object.assign({}, H, { 'x-zc-workspace': 'w1' }), body: '{}' }), mkEnv({ E2B_MAX_RUN_SECONDS: '1200' }), ctx);
  const j = await r.json(); assert.strictEqual(j.available, true); assert.strictEqual(j.backend, 'e2b'); assert.strictEqual(j.autoPause, true); assert.strictEqual(j.maxRunSec, 1200);
});

Date.now = realNow; globalThis.fetch = realFetch;
R.forEach((r) => console.log(r[0] + ' | ' + r[1]));
const fail = R.filter((r) => r[0] === 'FAIL').length;
console.log('===== ' + (R.length - fail) + '/' + R.length + ' 通过 =====');
process.exit(fail ? 1 : 0);
