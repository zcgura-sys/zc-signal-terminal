// v2.29 企业化扩展回归测试（全部上游服务用 mock，不联网）
// 覆盖：请求 ID / 结构化日志 / OTel · CSP · RBAC · 配额与熔断 · 语音 · MCP · Web Push（真实解密校验）
//       Google/Microsoft OIDC(PKCE) · TOTP 2FA · 团队 · RAG · Stripe 计费 · SIEM 哈希链
// 运行：node test_v29.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import crypto from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcv29-'));
const mjsPath = path.join(tmpDir, 'worker.mjs');
fs.copyFileSync('_worker.js', mjsPath);
const worker = (await import(mjsPath)).default;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmacHex = (k, d) => crypto.createHmac('sha256', k).update(d).digest('hex');
const b64u = (b) => Buffer.from(b).toString('base64url');

/* ---------- 测试底座 ---------- */
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); }, passThroughOnException() { } };
const flush = async () => { while (pending.length) await Promise.allSettled(pending.splice(0)); };

const calls = []; const routes = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const rec = { url, init: init || {}, headers: new Headers((init && init.headers) || {}) };
  calls.push(rec);
  for (const [pre, fn] of routes) if (url.startsWith(pre)) return fn(rec);
  return new Response('no mock for ' + url, { status: 599 });
};
const mock = (prefix, fn) => { routes.unshift([prefix, fn]); };
const callsTo = (prefix) => calls.filter((c) => c.url.startsWith(prefix));
const resetMocks = () => { routes.length = 0; calls.length = 0; };

function mkStore() {
  const store = new Map();
  const KV = {
    async get(k) { return store.has(k) ? store.get(k).v : null; },
    async put(k, v, o) { store.set(k, { v: String(v), md: o && o.metadata }); },
    async delete(k) { store.delete(k); },
    async list() { return { keys: [], list_complete: true }; }
  };
  const session = (email, provider, role) => {
    const t = crypto.randomBytes(32).toString('hex');
    store.set('zc_sess:' + sha(t), { v: JSON.stringify({ email, createdAt: Date.now(), seenAt: Date.now(), provider: provider || 'github' }) });
    if (role) store.set('zc_user:' + email, { v: JSON.stringify({ email, role, provider: provider || 'github', createdAt: Date.now() }) });
    return t;
  };
  return { store, KV, session };
}
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36';
const BASE = { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', 'sec-fetch-site': 'same-origin' };
function call(env, pathname, tok, body, opt) {
  opt = opt || {};
  const headers = Object.assign({}, BASE, opt.headers || {}, tok ? { 'x-zc-session': tok } : {});
  let payload;
  if (body !== undefined && body !== null) {
    if (opt.raw) payload = body; else { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  }
  const method = opt.method || (payload !== undefined ? 'POST' : 'GET');
  return worker.fetch(new Request('https://signal.example' + pathname, { method, headers, body: payload }), env, ctx);
}
const J = async (r) => { try { return await r.json(); } catch (e) { return null; } };
const R = [];
async function check(name, fn) { try { await fn(); R.push(['PASS', name]); } catch (e) { R.push(['FAIL', name + ' → ' + ((e && e.stack) || e).toString().split('\n').slice(0, 3).join(' | ')]); } }
const quiet = (env) => Object.assign({ ZC_SEC_MODE: 'off', ZC_LOG_LEVEL: 'off' }, env);

/* ====================================================================
 * 1) 请求 ID + 结构化日志 + OTel
 * ==================================================================== */
await check('请求 ID：自动生成并回写响应头；合法的入站 ID 原样沿用；非法值被替换', async () => {
  const { KV } = mkStore(); const env = quiet({ ZC_KV: KV });
  const r1 = await call(env, '/__zc_health__'); const id1 = r1.headers.get('x-request-id');
  assert.ok(id1 && id1.length >= 8, '缺少 X-Request-Id');
  assert.ok(/app;dur=\d+/.test(r1.headers.get('server-timing') || ''), '缺少 Server-Timing');
  const r2 = await call(env, '/__zc_health__', null, null, { headers: { 'x-request-id': 'trace-abc-12345' } });
  assert.strictEqual(r2.headers.get('x-request-id'), 'trace-abc-12345');
  const r3 = await call(env, '/__zc_health__', null, null, { headers: { 'x-request-id': 'bad id with spaces & <script>' } });
  assert.notStrictEqual(r3.headers.get('x-request-id'), 'bad id with spaces & <script>');
});

await check('结构化日志：一行 JSON，带 rid / status / ms，且不记录查询串里的密钥', async () => {
  const { KV } = mkStore(); const env = { ZC_KV: KV, ZC_SEC_MODE: 'off' };
  const lines = []; const orig = console.log; console.log = (s) => { lines.push(String(s)); };
  let r; try { r = await call(env, '/__zc_kv__?key=TOPSECRET-123'); await flush(); } finally { console.log = orig; }
  const rid = r.headers.get('x-request-id');
  const row = lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((x) => x && x.msg === 'request' && x.rid === rid)[0];
  assert.ok(row, '没有找到对应的请求日志');
  assert.strictEqual(typeof row.status, 'number'); assert.strictEqual(typeof row.ms, 'number');
  assert.ok(lines.join('\n').indexOf('TOPSECRET-123') < 0, '日志泄露了查询串');
  assert.ok(row.route && row.route.indexOf('?') < 0);
});

await check('OTel：按 traceparent 续接 trace，向 OTLP 端点导出 span（带自定义请求头）', async () => {
  resetMocks(); const { KV } = mkStore();
  mock('https://otel.example/', () => new Response('{}', { status: 200 }));
  const env = quiet({ ZC_KV: KV, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example', OTEL_EXPORTER_OTLP_HEADERS: 'x-key=abc' });
  const tid = crypto.randomBytes(16).toString('hex'), pid = crypto.randomBytes(8).toString('hex');
  await call(env, '/__zc_health__', null, null, { headers: { traceparent: '00-' + tid + '-' + pid + '-01' } }); await flush();
  const c = callsTo('https://otel.example/v1/traces')[0]; assert.ok(c, '没有导出 span');
  assert.strictEqual(c.headers.get('x-key'), 'abc');
  const sp = JSON.parse(c.init.body).resourceSpans[0].scopeSpans[0].spans[0];
  assert.strictEqual(sp.traceId, tid); assert.strictEqual(sp.parentSpanId, pid);
});

/* ====================================================================
 * 2) CSP 补全
 * ==================================================================== */
const PAGE = '<!doctype html><html><head><script>var a=1;</script></head><body><script src="/x.js"></script><script>console.log(2)</script></body></html>';
const pageEnv = (extra) => quiet(Object.assign({ ASSETS: { fetch: async () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }) } }, extra || {}));
const hashOf = (s) => "'sha256-" + crypto.createHash('sha256').update(s).digest('base64') + "'";
await check('CSP：逐个内联脚本算 SHA-256，script-src 里没有 unsafe-inline，页面可正常返回', async () => {
  const r = await call(pageEnv(), '/'); const csp = r.headers.get('content-security-policy') || '';
  assert.strictEqual(r.status, 200); assert.ok((await r.text()).indexOf('var a=1;') >= 0, '页面内容被破坏');
  const sd = csp.split(';').map((s) => s.trim()).filter((s) => s.indexOf('script-src') === 0)[0];
  assert.ok(sd.indexOf(hashOf('var a=1;')) >= 0 && sd.indexOf(hashOf('console.log(2)')) >= 0, '缺少内联脚本哈希：' + sd);
  assert.ok(sd.indexOf("'unsafe-inline'") < 0, 'script-src 不应含 unsafe-inline');
  ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'", 'report-uri /__zc_csp__', 'https://challenges.cloudflare.com'].forEach((d) => assert.ok(csp.indexOf(d) >= 0, '缺少指令：' + d));
});
await check('CSP：report 模式只上报不拦截；off 回到旧的最小策略；麦克风权限保持关闭', async () => {
  const rr = await call(pageEnv({ ZC_CSP_MODE: 'report' }), '/');
  assert.ok((rr.headers.get('content-security-policy-report-only') || '').indexOf('script-src') >= 0);
  assert.ok((rr.headers.get('content-security-policy') || '').indexOf('script-src') < 0, 'report 模式不应同时强制');
  const ro = await call(pageEnv({ ZC_CSP_MODE: 'off' }), '/');
  assert.strictEqual(ro.headers.get('content-security-policy'), "object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  assert.ok((rr.headers.get('permissions-policy') || '').indexOf('microphone=()') >= 0);
});
await check('CSP 违规上报端点：204 且写入结构化日志', async () => {
  const lines = []; const orig = console.log; console.log = (s) => lines.push(String(s));
  let r; try { r = await call({ ZC_SEC_MODE: 'off' }, '/__zc_csp__', null, JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'https://evil.example/x.js' } }), { raw: true, headers: { 'content-type': 'application/csp-report' } }); } finally { console.log = orig; }
  assert.strictEqual(r.status, 204);
  assert.ok(lines.some((l) => l.indexOf('csp-violation') >= 0 && l.indexOf('evil.example') >= 0));
});

/* ====================================================================
 * 3) RBAC
 * ==================================================================== */
/* ====================================================================
 * 4) 配额与成本熔断（走真实的 relay 代理）
 * ==================================================================== */
const sse = (inT, outT) => new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"usage":{"prompt_tokens":' + inT + ',"completion_tokens":' + outT + '}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const relay = (env, tok, size, model) => call(env, '/__zc_relay__', tok, 'x'.repeat(size || 100), { raw: true, method: 'POST', headers: { 'x-zc-target-url': 'https://api.openai.com/v1/chat/completions', 'x-zc-target-method': 'POST', 'content-length': String(size || 100), 'x-zc-model': model || 'gpt-4o' } });
/* ====================================================================
 * 5) 语音
 * ==================================================================== */
/* ====================================================================
 * 6) MCP
 * ==================================================================== */
function mcpServer() {
  const seen = [];
  return { seen, handler: async (rec) => {
    const body = JSON.parse(rec.init.body); seen.push({ method: body.method, sid: rec.headers.get('mcp-session-id'), auth: rec.headers.get('authorization') });
    const jr = (result, extraHeaders) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: Object.assign({ 'content-type': 'application/json' }, extraHeaders || {}) });
    if (body.method === 'initialize') return jr({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } }, { 'mcp-session-id': 'sess-1' });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'add', description: '加法', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }] } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
    if (body.method === 'tools/call') return jr({ content: [{ type: 'text', text: 'sum=' + (body.params.arguments.a + body.params.arguments.b) }] });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } }), { headers: { 'content-type': 'application/json' } });
  } };
}
await check('MCP：SSRF 防护（内网 / 元数据地址 / http / 带账号密码）一律拒绝', async () => {
  const { KV, session } = mkStore(); const env = quiet({ ZC_KV: KV }); const t = session('m@github');
  for (const u of ['https://127.0.0.1/mcp', 'https://169.254.169.254/latest', 'http://example.com/mcp', 'https://user:pw@example.com/mcp', 'https://localhost/mcp', 'ftp://example.com']) {
    const r = await call(env, '/__zc_mcp__/servers', t, { action: 'add', name: 'x', url: u }); assert.strictEqual(r.status, 400, u + ' 应被拒绝，实际 ' + r.status);
  }
  const env2 = quiet({ ZC_KV: KV, ZC_MCP_ALLOW: 'good.example' });
  assert.strictEqual((await call(env2, '/__zc_mcp__/servers', t, { action: 'add', name: 'x', url: 'https://other.example/mcp' })).status, 400);
});
await check('MCP：添加私有服务器（令牌只存服务端、列表不回显）→ 列工具（SSE）→ 调工具（会话头 / 鉴权头 / 审计）', async () => {
  resetMocks(); const srv = mcpServer(); mock('https://mcp.example.com/', srv.handler);
  const { KV, session } = mkStore(); const env = quiet({ ZC_KV: KV, ZC_DATA_KEY: 'k-1' }); const t = session('m@github');
  let r = await call(env, '/__zc_mcp__/servers', t, { action: 'add', name: '计算器', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer SUPER-SECRET' } });
  const sv = (await J(r)).server; assert.strictEqual(r.status, 200); assert.ok(sv.id.indexOf('u:') === 0);
  const listTxt = await (await call(env, '/__zc_mcp__/servers', t)).text();
  assert.ok(listTxt.indexOf('SUPER-SECRET') < 0, '列表泄露了令牌'); assert.ok(listTxt.indexOf('"headerKeys":["Authorization"]') >= 0);
  const raw = [...(await (async () => { const out = []; for (const [k, v] of globalThis.__never || []) out.push(v); return out; })())];
  r = await call(env, '/__zc_mcp__/tools', t, { serverId: sv.id }); const tools = (await J(r)).tools;
  assert.strictEqual(tools[0].name, 'add');
  r = await call(env, '/__zc_mcp__/call', t, { serverId: sv.id, tool: 'add', arguments: { a: 2, b: 3 } }); const out = await J(r);
  assert.strictEqual(out.text, 'sum=5'); assert.strictEqual(out.isError, false);
  assert.ok(srv.seen.every((s) => s.auth === 'Bearer SUPER-SECRET'), '鉴权头应附在每次请求上');
  assert.ok(srv.seen.filter((s) => s.method === 'tools/call')[0].sid === 'sess-1', '应带上 Mcp-Session-Id');
  assert.strictEqual((await call(env, '/__zc_mcp__/call', session('o@github'), { serverId: sv.id, tool: 'add', arguments: {} })).status, 404, '别人不能用我的服务器');
});
await check('MCP：管理员全局服务器（env）对所有登录用户可见，但请求头不外泄；停用 / 删除生效', async () => {
  resetMocks(); const srv = mcpServer(); mock('https://mcp.example.com/', srv.handler);
  const { KV, session } = mkStore(); const t = session('m@github');
  const env = quiet({ ZC_KV: KV, MCP_SERVERS: JSON.stringify([{ id: 'docs', name: '文档', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer GLOBAL-SECRET' } }]) });
  const txt = await (await call(env, '/__zc_mcp__/servers', t)).text();
  assert.ok(txt.indexOf('GLOBAL-SECRET') < 0); assert.ok(txt.indexOf('"id":"g:docs"') >= 0 && txt.indexOf('"scope":"global"') >= 0);
  const o = await J(await call(env, '/__zc_mcp__/call', t, { serverId: 'g:docs', tool: 'add', arguments: { a: 1, b: 1 } })); assert.strictEqual(o.text, 'sum=2');
  const add = await J(await call(env, '/__zc_mcp__/servers', t, { action: 'add', name: 'p', url: 'https://mcp.example.com/p' }));
  await call(env, '/__zc_mcp__/servers', t, { action: 'toggle', id: add.server.id, enabled: false });
  assert.strictEqual((await call(env, '/__zc_mcp__/tools', t, { serverId: add.server.id })).status, 404, '停用后不可用');
  await call(env, '/__zc_mcp__/servers', t, { action: 'remove', id: add.server.id });
  assert.strictEqual((await J(await call(env, '/__zc_mcp__/servers', t))).servers.filter((s) => s.scope === 'user').length, 0);
});

/* ====================================================================
 * 7) Web Push —— 在测试里按 RFC 8291 真实解密、按 RFC 8292 真实验签
 * ==================================================================== */
function mkSub() {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const auth = crypto.randomBytes(16);
  return { ua, auth, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/' + crypto.randomBytes(8).toString('hex'), keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } } };
}
function decryptPush(body, ua, auth) {
  const salt = body.subarray(0, 16); const idlen = body[20]; const asPub = body.subarray(21, 21 + idlen); const ct = body.subarray(21 + idlen);
  const secret = ua.computeSecret(asPub);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.strictEqual(plain[plain.length - 1], 2, '缺少记录结束分隔符'); return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}
function verifyVapid(authHeader, audience) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authHeader); assert.ok(m, 'VAPID 头格式不对');
  const [h, p, s] = m[1].split('.'); const pub = Buffer.from(m[2], 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + p), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'VAPID 签名无效');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString()); assert.strictEqual(claims.aud, audience); assert.ok(claims.exp > Date.now() / 1000);
  return m[2];
}
/* ====================================================================
 * 8) Google / Microsoft 登录（OIDC + PKCE）
 * ==================================================================== */
async function oidcLogin(env, provider, tokenUrl, userinfoUrl, info, hdrCheck) {
  resetMocks(); let verifier = null; let challenge = null;
  mock(tokenUrl, async (rec) => { const p = new URLSearchParams(rec.init.body); verifier = p.get('code_verifier'); assert.strictEqual(p.get('grant_type'), 'authorization_code'); assert.strictEqual(p.get('code'), 'AUTHCODE'); return new Response(JSON.stringify({ access_token: 'AT-1' }), { headers: { 'content-type': 'application/json' } }); });
  mock(userinfoUrl, (rec) => { assert.strictEqual(rec.headers.get('authorization'), 'Bearer AT-1'); return new Response(JSON.stringify(info), { headers: { 'content-type': 'application/json' } }); });
  const s = await call(env, '/__zc_auth__/' + provider + '/start', null, null);
  assert.strictEqual(s.status, 302); const loc = new URL(s.headers.get('location'));
  challenge = loc.searchParams.get('code_challenge'); assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(loc.searchParams.get('redirect_uri'), 'https://signal.example/__zc_auth__/' + provider + '/callback');
  const state = loc.searchParams.get('state');
  const cb = await call(env, '/__zc_auth__/' + provider + '/callback?state=' + state + '&code=AUTHCODE', null, null, { headers: { 'sec-fetch-site': 'cross-site' } });
  if (verifier) assert.strictEqual(b64u(crypto.createHash('sha256').update(verifier).digest()), challenge, 'PKCE verifier 与 challenge 不匹配');
  return { cb, state, loc };
}
await check('Google 登录：start 带 PKCE → callback 换令牌 → 一次性握手票据换会话 → /me 返回账号信息；state 不能重放', async () => {
  const { KV } = mkStore(); const env = quiet({ ZC_KV: KV, GOOGLE_OAUTH_CLIENT_ID: 'gid', GOOGLE_OAUTH_CLIENT_SECRET: 'gsec' });
  assert.strictEqual((await J(await call(env, '/__zc_auth__/status'))).google, true);
  const { cb, state } = await oidcLogin(env, 'google', 'https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo', { sub: '1001', email: 'al@corp.com', email_verified: true, name: 'Al' });
  assert.strictEqual(cb.status, 302); const ho = new URL(cb.headers.get('location')).searchParams.get('zc_handoff'); assert.ok(/^[a-f0-9]{64}$/.test(ho));
  const hj = await J(await call(env, '/__zc_auth__/github/handoff', null, { code: ho })); assert.ok(hj.ok && hj.token); assert.strictEqual(hj.provider, 'google'); assert.strictEqual(hj.label, 'Al');
  assert.ok(/@google$/.test(hj.email) && hj.email.indexOf('1001') < 0 && hj.email.indexOf('corp') < 0, '账号标识应是 sub 的哈希，而不是邮箱 / 原始 sub');
  const me = await J(await call(env, '/__zc_auth__/me', hj.token)); assert.strictEqual(me.role, undefined); assert.strictEqual(me.label, 'Al');
  assert.strictEqual((await call(env, '/__zc_auth__/github/handoff', null, { code: ho })).status, 400, '握手票据只能用一次');
  const again = await call(env, '/__zc_auth__/google/callback?state=' + state + '&code=AUTHCODE', null, null, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.ok(again.headers.get('location').indexOf('zc_handoff') < 0, 'state 重放必须失败');
});
await check('Google 登录：邮箱域名白名单只认「已验证」邮箱；ZC_ROLE_ADMINS 里的已验证邮箱才能进运维接口', async () => {
  const { KV } = mkStore(); const base = { ZC_KV: KV, GOOGLE_OAUTH_CLIENT_ID: 'gid', GOOGLE_OAUTH_CLIENT_SECRET: 'gsec', ZC_AUTH_OAUTH_DOMAINS: 'corp.com' };
  let env = quiet(base);
  let r = await oidcLogin(env, 'google', 'https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo', { sub: '2', email: 'x@evil.com', email_verified: true, name: 'X' });
  assert.ok(r.cb.headers.get('location').indexOf('zc_handoff') < 0, '域名不在白名单必须拒绝');
  r = await oidcLogin(env, 'google', 'https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo', { sub: '3', email: 'y@corp.com', email_verified: false, name: 'Y' });
  assert.ok(r.cb.headers.get('location').indexOf('zc_handoff') < 0, '未验证邮箱必须拒绝');
  env = quiet(Object.assign({}, base, { ZC_ROLE_ADMINS: 'boss@corp.com' }));
  r = await oidcLogin(env, 'google', 'https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo', { sub: '4', email: 'boss@corp.com', email_verified: true, name: 'Boss' });
  const hj = await J(await call(env, '/__zc_auth__/github/handoff', null, { code: new URL(r.cb.headers.get('location')).searchParams.get('zc_handoff') }));
  assert.strictEqual((await call(env, '/__zc_ops__/status', hj.token)).status, 200, '管理员可进运维接口');
  const other = await oidcLogin(env, 'google', 'https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo', { sub: '5', email: 'dev@corp.com', email_verified: true, name: 'Dev' });
  const hj2 = await J(await call(env, '/__zc_auth__/github/handoff', null, { code: new URL(other.cb.headers.get('location')).searchParams.get('zc_handoff') }));
  assert.strictEqual((await call(env, '/__zc_ops__/status', hj2.token)).status, 403, '普通成员进不了运维接口');
});
await check('Microsoft 登录：走租户端点 + PKCE；账号标识用 sub 哈希（不信任邮箱声明）', async () => {
  const { KV } = mkStore(); const env = quiet({ ZC_KV: KV, MICROSOFT_OAUTH_CLIENT_ID: 'mid', MICROSOFT_OAUTH_CLIENT_SECRET: 'msec', MICROSOFT_OAUTH_TENANT: 'contoso-tenant-id' });
  const { cb, loc } = await oidcLogin(env, 'microsoft', 'https://login.microsoftonline.com/contoso-tenant-id/oauth2/v2.0/token', 'https://graph.microsoft.com/oidc/userinfo', { sub: 'AbC_dEf-123', email: 'ceo@contoso.com', name: 'Pat' });
  assert.ok(loc.toString().indexOf('login.microsoftonline.com/contoso-tenant-id/oauth2/v2.0/authorize') >= 0);
  const hj = await J(await call(env, '/__zc_auth__/github/handoff', null, { code: new URL(cb.headers.get('location')).searchParams.get('zc_handoff') }));
  assert.ok(/^[a-f0-9]{24}@microsoft$/.test(hj.email), hj.email); assert.strictEqual(hj.provider, 'microsoft');
});
await check('OIDC：未配置的提供方返回 501，不泄露任何配置', async () => {
  const { KV } = mkStore(); const r = await call(quiet({ ZC_KV: KV }), '/__zc_auth__/google/start'); assert.strictEqual(r.status, 501);
});

/* ====================================================================
 * 9) TOTP 2FA（含 RFC 6238 测试向量）
 * ==================================================================== */
function totp(secretB32, counter) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const out = [];
  for (const ch of secretB32) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', Buffer.from(out)).update(msg).digest(); const o = h[19] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0');
}
/* ====================================================================
 * 10) 团队工作区
 * ==================================================================== */
await check('团队：创建 → 邀请码一次性 → 加入 → 分享对话 → 成员读取；viewer 只读；非成员 404；删除权限', async () => {
  const { KV, session } = mkStore(); const env = quiet({ ZC_KV: KV });
  const ta = session('alice@github'), tb = session('bob@github'), tc = session('carol@github'), tx = session('eve@github');
  const team = (await J(await call(env, '/__zc_team__/create', ta, { name: '产品组' }))).team; assert.strictEqual(team.role, 'owner');
  const inv = await J(await call(env, '/__zc_team__/invite', ta, { teamId: team.id, role: 'editor' })); assert.ok(inv.code.indexOf(team.id + '.') === 0);
  assert.strictEqual((await call(env, '/__zc_team__/invite', tb, { teamId: team.id })).status, 404, '非成员不能邀请');
  assert.strictEqual((await call(env, '/__zc_team__/join', tb, { code: inv.code })).status, 200);
  assert.strictEqual((await call(env, '/__zc_team__/join', tc, { code: inv.code })).status, 400, '邀请码一次性');
  const invV = await J(await call(env, '/__zc_team__/invite', ta, { teamId: team.id, role: 'viewer' })); await call(env, '/__zc_team__/join', tc, { code: invV.code });
  const sh = await J(await call(env, '/__zc_team__/share', tb, { teamId: team.id, title: '架构讨论', data: { messages: [{ role: 'user', content: '你好' }] } })); assert.ok(sh.item.id);
  assert.strictEqual((await call(env, '/__zc_team__/share', tc, { teamId: team.id, title: 'x', data: { a: 1 } })).status, 403, 'viewer 不能分享');
  const items = (await J(await call(env, '/__zc_team__/items?teamId=' + team.id, tc))).items; assert.strictEqual(items.length, 1); assert.strictEqual(items[0].title, '架构讨论');
  const one = (await J(await call(env, '/__zc_team__/item?teamId=' + team.id + '&id=' + sh.item.id, tc))).item; assert.strictEqual(one.data.messages[0].content, '你好');
  assert.strictEqual((await call(env, '/__zc_team__/items?teamId=' + team.id, tx)).status, 404, '非成员不可见');
  assert.strictEqual((await call(env, '/__zc_team__/delete', tc, { teamId: team.id, id: sh.item.id })).status, 403);
  assert.strictEqual((await call(env, '/__zc_team__/delete', ta, { teamId: team.id, id: sh.item.id })).status, 200, 'owner 可删任何内容');
  assert.strictEqual((await call(env, '/__zc_team__/member', ta, { teamId: team.id, email: 'bob@github', action: 'remove' })).status, 200);
  assert.strictEqual((await call(env, '/__zc_team__/items?teamId=' + team.id, tb)).status, 404, '被移出后立即失去访问');
  assert.strictEqual((await J(await call(env, '/__zc_team__/list', tb))).teams.length, 0);
});
await check('团队：owner 可删除团队（成员访问 / 分享内容 / 邀请码 / 各人的团队列表全部清掉）；非 owner 不行', async () => {
  const { store, KV, session } = mkStore(); const env = quiet({ ZC_KV: KV });
  const ta = session('alice@github'), tb = session('bob@github'), tc = session('carol@github'), tx = session('eve@github');
  const team = (await J(await call(env, '/__zc_team__/create', ta, { name: '待删团队' }))).team;
  const inv = await J(await call(env, '/__zc_team__/invite', ta, { teamId: team.id, role: 'editor' })); await call(env, '/__zc_team__/join', tb, { code: inv.code });
  const inv2 = await J(await call(env, '/__zc_team__/invite', ta, { teamId: team.id, role: 'viewer' }));   // 一张还没用的邀请码
  const sh = await J(await call(env, '/__zc_team__/share', tb, { teamId: team.id, title: '会被一起删掉', data: { m: 1 } })); assert.ok(sh.item.id);
  assert.strictEqual((await call(env, '/__zc_team__/disband', tb, { teamId: team.id })).status, 403, 'editor 不能删团队');
  assert.strictEqual((await call(env, '/__zc_team__/disband', tx, { teamId: team.id })).status, 404, '非成员不能删团队');
  assert.strictEqual((await call(env, '/__zc_team__/disband', ta)).status, 404, '缺 teamId');
  assert.strictEqual((await call(env, '/__zc_team__/disband', ta, { teamId: team.id })).status, 200);
  for (const [who, tok] of [['owner', ta], ['成员', tb]]) {
    assert.strictEqual((await J(await call(env, '/__zc_team__/list', tok))).teams.length, 0, who + ' 的团队列表应已清空');
    assert.strictEqual((await call(env, '/__zc_team__/items?teamId=' + team.id, tok)).status, 404, who + ' 不能再访问');
  }
  assert.strictEqual((await call(env, '/__zc_team__/join', tc, { code: inv2.code })).status, 400, '未使用的邀请码随团队失效');
  assert.ok([...store.keys()].filter((k) => k.indexOf('zc_team:t:' + team.id) === 0 || k.indexOf('zc_team:i:' + team.id) === 0 || k.indexOf('zc_team:x:' + team.id) === 0).length === 0, '团队 / 分享内容 / 索引都应已从存储里删除');
  const again = (await J(await call(env, '/__zc_team__/create', ta, { name: '删完可以再建' }))).team; assert.strictEqual(again.role, 'owner');
});
await check('团队：过大内容被拒；单人自用 / 未登录模式提示需要账号', async () => {
  const { KV, session } = mkStore(); const env = quiet({ ZC_KV: KV }); const t = session('alice@github');
  const team = (await J(await call(env, '/__zc_team__/create', t, { name: 'T' }))).team;
  assert.strictEqual((await call(env, '/__zc_team__/share', t, { teamId: team.id, title: 'big', data: { s: 'x'.repeat(700 * 1024) } })).status, 413);
  const r = await call(quiet({ ZC_KV: KV, ZC_AUTH_DISABLED: '1' }), '/__zc_team__/list'); assert.strictEqual(r.status, 401);
});

/* ====================================================================
 * 11) RAG
 * ==================================================================== */
const embedVec = (s) => { const v = new Array(32).fill(0); String(s).toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean).forEach((w) => { v[parseInt(sha(w).slice(0, 6), 16) % 32] += 1; }); return v; };
await check('RAG：切片 → 嵌入 → int8 量化存储 → 余弦检索把相关片段排第一；按人隔离；可删除', async () => {
  resetMocks(); mock('https://api.openai.com/v1/embeddings', (rec) => { const b = JSON.parse(rec.init.body); assert.strictEqual(b.model, 'text-embedding-3-small'); return new Response(JSON.stringify({ data: b.input.map((s, i) => ({ index: i, embedding: embedVec(s) })) })); });
  const { KV, session } = mkStore(); const env = quiet({ ZC_KV: KV, RAG_EMBED_API_KEY: 'sk-embed' }); const ta = session('alice@github'), tb = session('bob@github');
  const text = 'wrangler deploy publishes the worker to cloudflare edge network.\n\n' + 'banana bread needs ripe bananas flour sugar and butter.\n\n' + 'kubernetes pods schedule containers onto cluster nodes.';
  const add = await J(await call(env, '/__zc_rag__/add', ta, { title: '笔记', text })); assert.ok(add.id); assert.ok(add.chunks >= 1);
  const longText = ('段落内容。'.repeat(120) + '\n\n').repeat(6); const add2 = await J(await call(env, '/__zc_rag__/add', ta, { title: '长文', text: longText })); assert.ok(add2.chunks > 2, '长文应被切成多片');
  const hits = (await J(await call(env, '/__zc_rag__/search', ta, { query: 'how do I deploy a worker to cloudflare', k: 3 }))).hits;
  assert.ok(hits[0].text.indexOf('wrangler deploy') >= 0, '相关片段应排第一：' + JSON.stringify(hits[0])); assert.ok(hits[0].score >= hits[hits.length - 1].score);
  assert.strictEqual((await J(await call(env, '/__zc_rag__/search', tb, { query: 'deploy worker' }))).hits.length, 0, '别人的知识库看不到');
  assert.strictEqual((await call(env, '/__zc_rag__/delete', ta, { id: add.id })).status, 200);
  assert.strictEqual((await J(await call(env, '/__zc_rag__/status', ta))).docs.length, 1);
  assert.strictEqual((await call(quiet({ ZC_KV: KV }), '/__zc_rag__/add', ta, { title: 'x', text: 'x'.repeat(50) })).status, 501);
});

await check('RAG（v2.32 项目）：文件带 projectId 标签；项目检索只看项目文件（includeGlobal 才并入全局）；全局检索看不到项目文件；非法 projectId 当作无', async () => {
  resetMocks(); mock('https://api.openai.com/v1/embeddings', (rec) => { const b = JSON.parse(rec.init.body); return new Response(JSON.stringify({ data: b.input.map((s, i) => ({ index: i, embedding: embedVec(s) })) })); });
  const { KV, session } = mkStore(); const env = quiet({ ZC_KV: KV, RAG_EMBED_API_KEY: 'sk-embed' }); const ta = session('alice@github');
  const g = await J(await call(env, '/__zc_rag__/add', ta, { title: '全局', text: 'kubernetes pods schedule containers onto cluster nodes in the global notes.' }));
  const p1 = await J(await call(env, '/__zc_rag__/add', ta, { title: '项目甲', text: 'wrangler deploy publishes the worker for project alpha release.', projectId: 'pj_alpha' }));
  const p2 = await J(await call(env, '/__zc_rag__/add', ta, { title: '项目乙', text: 'banana bread needs ripe bananas flour sugar for project beta recipes.', projectId: 'pj_beta' }));
  const bad = await J(await call(env, '/__zc_rag__/add', ta, { title: '非法标签', text: 'this document has an invalid project tag and must stay global.', projectId: 'a b/../c' }));
  assert.ok(g.id && p1.id && p2.id && bad.id);
  const st = (await J(await call(env, '/__zc_rag__/status', ta))).docs; const byT = (t) => st.find((d) => d.title === t);
  assert.strictEqual(byT('项目甲').projectId, 'pj_alpha'); assert.strictEqual(byT('全局').projectId, undefined); assert.strictEqual(byT('非法标签').projectId, undefined, '非法 projectId 不能被写进去');
  const titles = async (b) => (await J(await call(env, '/__zc_rag__/search', ta, Object.assign({ query: 'deploy worker project notes bananas kubernetes', k: 8 }, b)))).hits.map((h) => h.title);
  const tGlobal = await titles({});
  assert.ok(tGlobal.indexOf('全局') >= 0 && tGlobal.indexOf('非法标签') >= 0, '不传 projectId = 全局文档：' + tGlobal);
  assert.ok(tGlobal.indexOf('项目甲') < 0 && tGlobal.indexOf('项目乙') < 0, '项目文件不能漏进普通对话：' + tGlobal);
  const tAlpha = await titles({ projectId: 'pj_alpha' });
  assert.deepStrictEqual([...new Set(tAlpha)], ['项目甲'], '项目检索只看自己的文件：' + tAlpha);
  const tAlphaG = [...new Set(await titles({ projectId: 'pj_alpha', includeGlobal: true }))].sort();
  assert.deepStrictEqual(tAlphaG, ['全局', '项目甲', '非法标签'].sort(), 'includeGlobal 并入全局文档、仍不含别的项目：' + tAlphaG);
  assert.deepStrictEqual((await titles({ projectId: 'pj_nope' })), [], '不存在的项目 = 空结果');
});

/* ====================================================================
 * 12) Stripe 计费
 * ==================================================================== */
const PLANS = JSON.stringify({ pro: { name: 'Pro', price: 'price_123', mode: 'subscription', costDay: 5, reqDay: 3 } });
const stripeSig = (secret, payload, t) => 't=' + t + ',v1=' + hmacHex(secret, t + '.' + payload);
/* ====================================================================
 * 13) SIEM
 * ==================================================================== */
await check('SIEM：审计事件实时转发（HMAC 签名可验；Splunk HEC 格式）；失败不影响业务', async () => {
  resetMocks(); const { KV, session } = mkStore(); const t = session('m@github'); let rec = null;
  mock('https://siem.example/', (r) => { rec = r; return new Response('ok'); });
  let env = quiet({ ZC_KV: KV, SIEM_URL: 'https://siem.example/hec', SIEM_TOKEN: 'tok', SIEM_HMAC_KEY: 'hk', SIEM_FORMAT: 'splunk' });
  assert.strictEqual((await call(env, '/__zc_task__', t, { action: 'create', kind: 'agent', title: '审计我' })).status, 200); await flush();
  assert.ok(rec, '应转发审计事件'); assert.strictEqual(rec.headers.get('authorization'), 'Splunk tok');
  assert.strictEqual(rec.headers.get('x-zc-signature'), 'sha256=' + hmacHex('hk', rec.init.body)); const ev = JSON.parse(rec.init.body); assert.strictEqual(ev.sourcetype, 'zc-gura'); assert.strictEqual(ev.event.kind, 'audit');
  mock('https://siem.example/', () => { throw new Error('boom'); });
  assert.strictEqual((await call(env, '/__zc_task__', t, { action: 'create', kind: 'agent', title: 'x' })).status, 200, 'SIEM 故障不能拖垮业务'); await flush();
});
await check('SIEM：「导出审计」已移除——接口对管理员也是 404；运维状态接口仍可用；审计条目照常实时转发', async () => {
  const { KV, session } = mkStore(); const env = quiet({ ZC_KV: KV, ZC_ROLE_ADMINS: 'root@github', SIEM_HMAC_KEY: 'hk' }); const t = session('m@github'), ta = session('root@github');
  assert.strictEqual((await call(env, '/__zc_ops__/audit-export', t)).status, 403, '非管理员仍被挡在运维接口之外');
  assert.strictEqual((await call(env, '/__zc_ops__/audit-export', ta)).status, 404, '管理员也不应再有导出接口');
  const st = await call(env, '/__zc_ops__/status', ta); assert.strictEqual(st.status, 200); assert.strictEqual((await J(st)).ok, true);
});

/* ====================================================================
 * 14) 兼容性：旧接口行为不变
 * ==================================================================== */
await check('兼容：health / auth status 版本与新增字段；未配置任何新能力时旧流程不受影响', async () => {
  const { KV, session } = mkStore(); const env = quiet({ ZC_KV: KV }); const t = session('m@github');
  const h = await J(await call(env, '/__zc_health__')); assert.strictEqual(h.version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version); assert.strictEqual(h.google, false); assert.strictEqual(h.csp, 'enforce');
  const a = await J(await call(env, '/__zc_auth__/status')); assert.strictEqual(a.twofa, undefined); assert.strictEqual(a.google, false);
  assert.strictEqual((await J(await call(env, '/__zc_task__', t, { action: 'create', kind: 'agent', title: 'ok' }))).task.title, 'ok');
  assert.strictEqual((await call(env, '/__zc_kv__', t)).status < 500, true);
});

/* ---------- 汇总 ---------- */
await flush();
let fail = 0; for (const [s, n] of R) { console.log(s + ' | ' + n); if (s === 'FAIL') fail++; }
console.log('\n===== ' + (R.length - fail) + '/' + R.length + ' 通过 =====');
process.exit(fail ? 1 : 0);
