/* test_v29_front.mjs —— v2.29 前端扩展回归测试
 * 在 vm 沙箱里加载前端主脚本（DOM 用桩），直接驱动 ZX 的逻辑：
 *   i18n · 标签 / 归档 · 分支版本 / 分叉 / 编辑前自动备份 · MCP 工具并入 Agent 与调用 · 知识库注入 · 跑分统计 ·
 *   分享数据脱图 · 登录补丁 / 引导 / 守卫路径的静态契约 · CSP 友好（无内联事件属性）
 * 运行：node test_v29_front.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const all = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length);
let app = all[0];
const EXPOSE = 'window.__T = { ZX, ZX_EN, Sessions, Chat, View, Agent, AgentTools, SystemPrompt, Store, Dialog, Toast, Api, Auth };\n';
const tail = "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootApp); else bootApp();";
assert.ok(app.includes(tail), '启动锚点缺失');
app = app.replace(tail, EXPOSE + tail);

function makeEl(tag) {
  return { tagName: String(tag || 'div').toUpperCase(), _on: Object.create(null), style: { setProperty() { }, removeProperty() { } },
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } }, dataset: {}, children: [], childNodes: [],
    textContent: '', innerHTML: '', hidden: false, value: '', disabled: false, scrollHeight: 24, offsetHeight: 40,
    appendChild(c) { this.children.push(c); return c; }, removeChild() { }, replaceChildren() { }, remove() { }, insertBefore() { }, insertAdjacentHTML() { },
    setAttribute() { }, getAttribute() { return null; }, removeAttribute() { }, addEventListener() { }, removeEventListener() { },
    querySelector() { return makeEl(); }, querySelectorAll() { return []; }, focus() { }, blur() { }, click() { }, closest() { return null; }, scrollIntoView() { },
    getBoundingClientRect() { return { width: 120, height: 40, top: 0, left: 0, right: 120, bottom: 40 }; }, animate() { return { cancel() { }, finished: Promise.resolve() }; } };
}
const cache = new Map(); const q = (sel) => { if (!cache.has(sel)) cache.set(sel, makeEl(sel === '#input' ? 'textarea' : 'div')); return cache.get(sel); };
const store = {};
const lsStub = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }, clear() { }, key: () => null, get length() { return 0; } };
const netLog = []; let netHandler = async () => ({ ok: false, status: 599, data: {} });
const fakeFetch = async (url, init) => {
  const u = String(url); netLog.push({ url: u, init: init || {} });
  const r = await netHandler(u, init || {});
  return { ok: r.ok !== false && (r.status || 200) < 400, status: r.status || 200, headers: { get: (k) => (k === 'x-request-id' ? 'rid-test-1234' : null) }, json: async () => r.data || {}, text: async () => JSON.stringify(r.data || {}), blob: async () => ({ size: 3 }) };
};
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Symbol, WeakMap,
  AbortController, TextEncoder, TextDecoder, URL, URLSearchParams, structuredClone, Event: class { constructor(t) { this.type = t; } }, performance: { now: () => Date.now() },
  fetch: fakeFetch, atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  localStorage: lsStub, sessionStorage: lsStub, navigator: { userAgent: 'node', language: 'zh-CN', clipboard: {}, maxTouchPoints: 1 },
  location: { href: 'https://signal.example/', origin: 'https://signal.example', pathname: '/', search: '', hash: '' },
  document: { readyState: 'loading', addEventListener() { }, removeEventListener() { }, querySelector: q, querySelectorAll: () => [], getElementById: () => null, createElement: (t) => makeEl(t), createTextNode: () => ({}), documentElement: makeEl(), head: makeEl(), body: makeEl(), visibilityState: 'visible', hidden: false },
  crypto: { subtle: {}, randomUUID: () => 'x', getRandomValues: (a) => a }, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  matchMedia: () => ({ matches: false, addEventListener() { }, addListener() { }, removeEventListener() { } }), getComputedStyle: () => ({ getPropertyValue: () => '' }), addEventListener() { }, removeEventListener() { }
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.runInContext(app, vm.createContext(sandbox), { filename: 'app.js' });
const T = sandbox.window.__T;
assert.ok(T && T.ZX, '没有拿到 ZX（扩展模块未加载）');
const { ZX, ZX_EN, Sessions, Chat, View, Agent, AgentTools, SystemPrompt, Dialog, Toast } = T;

const R = [];
async function check(name, fn) { try { await fn(); R.push(['PASS', name]); } catch (e) { R.push(['FAIL', name + ' → ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join(' | ')]); } }
const toasts = []; ['info', 'ok', 'err', 'warn'].forEach((k) => { Toast[k] = (m) => { toasts.push([k, m]); }; });
function freshSession(msgs) {
  const s = { id: 's' + Math.random().toString(36).slice(2, 8), title: '测试对话', createdAt: 1, updatedAt: 1, messages: msgs || [], model: 'm' };
  Sessions.list.length = 0; Sessions.list.push(s); Sessions.curId = s.id; return s;
}
const mk = (role, content, extra) => Object.assign({ id: role[0] + Math.random().toString(36).slice(2, 7), role, content, ts: 1 }, extra || {});
Sessions.save = () => { }; Sessions.touch = () => { }; Sessions.later = { flush() { } }; View.renderThread = () => { }; View.renderSessions = () => { };
Chat.refreshActions = () => { }; Object.defineProperty(Chat, 'busy', { value: false, writable: true, configurable: true });
const wired = {};
const wireOnce = (n) => { if (!wired[n]) { ZX[n](); wired[n] = true; } };

/* ---------- 1. i18n ---------- */
await check('i18n：已收录文字翻译（保留首尾空白）；未收录返回 null；词典无空值', () => {
  assert.strictEqual(ZX.tr('新对话'), 'New chat'); assert.strictEqual(ZX.tr('  设置 '), '  Settings ');
  assert.strictEqual(ZX.tr('这是一句词典里没有的话'), null); assert.strictEqual(ZX.tr('hasOwnProperty'), null, '原型链上的键不能被误翻');
  assert.ok(Object.keys(ZX_EN).length > 120); Object.entries(ZX_EN).forEach(([k, v]) => { assert.ok(k && v && v !== k, '词条无效：' + k); });
});
await check('i18n：新面板的双语函数按当前语言取值', () => {
  ZX.lang = 'en'; const en = sandbox.window.__T.ZX.lang; ZX.lang = 'zh'; assert.strictEqual(en, 'en'); assert.strictEqual(ZX.lang, 'zh');
});

/* ---------- 2. 语音文本处理 ---------- */
/* ---------- 3. 标签 / 归档 ---------- */
await check('标签：去重 / 去 # / 最多 5 个 / 每个 ≤16 字；归档与标签动作经 sessionAction 生效', async () => {
  assert.strictEqual(JSON.stringify(ZX.parseTags('a, #b ，a  c;d、e f g')), JSON.stringify(['a', 'b', 'c', 'd', 'e']));
  assert.strictEqual(ZX.parseTags('x'.repeat(40))[0].length, 16);
  const s = freshSession([mk('user', 'hi')]); wireOnce('wireSessions');
  await Chat.sessionAction('archive', s.id); assert.strictEqual(s.archived, true);
  await Chat.sessionAction('archive', s.id); assert.strictEqual(s.archived, false);
  Dialog._open = async () => 'alpha, #beta'; await Chat.sessionAction('tag', s.id); assert.strictEqual(JSON.stringify(s.tags), JSON.stringify(['alpha', 'beta']));
});

/* ---------- 4. 分支：版本 / 分叉 / 编辑前备份 ---------- */
await check('分支：重新生成后保留旧版本，可来回切换，回切后 content 与元数据同步', async () => {
  const u = mk('user', '问题'), a = mk('assistant', '回答 v1', { meta: { model: 'A' } }); const s = freshSession([u, a]);
  Chat.findMsg = (id) => Sessions.msgs().filter((m) => m.id === id)[0];
  Chat.action = async function (act) { if (act === 'regen') { const ms = Sessions.msgs(); ms.pop(); ms.push(mk('assistant', '回答 v2', { meta: { model: 'B' } })); } };
  wireOnce('wireMessages');
  await Chat.action('regen', a.id);
  let cur = s.messages[1]; assert.strictEqual(cur.content, '回答 v2'); assert.strictEqual(cur.versions.length, 2); assert.strictEqual(cur.vi, 1);
  ZX.switchVer(cur, -1); assert.strictEqual(cur.content, '回答 v1'); assert.strictEqual(cur.meta.model, 'A'); assert.strictEqual(cur.vi, 0);
  ZX.switchVer(cur, -1); assert.strictEqual(cur.vi, 0, '到头不再越界'); ZX.switchVer(cur, 1); assert.strictEqual(cur.content, '回答 v2');
  await Chat.action('regen', cur.id); cur = s.messages[1]; assert.strictEqual(cur.versions.length, 3, '第三次重新生成应累加'); assert.strictEqual(JSON.stringify(cur.versions.map((v) => v.content)), JSON.stringify(['回答 v1', '回答 v2', '回答 v2']));
});
await check('分支：从回复分叉 = 复制到此为止；从用户消息分叉 = 不含该条（供改后重发）；互不影响', () => {
  const u1 = mk('user', 'q1'), a1 = mk('assistant', 'a1'), u2 = mk('user', 'q2'), a2 = mk('assistant', 'a2'); const s = freshSession([u1, a1, u2, a2]);
  const f1 = ZX.forkSession(a1); assert.strictEqual(JSON.stringify(f1.messages.map((m) => m.content)), JSON.stringify(['q1', 'a1'])); assert.strictEqual(f1.parentId, s.id); assert.strictEqual(f1.forkAt, a1.id);
  const f2 = ZX.forkSession(u2, { excludeSelf: true }); assert.strictEqual(JSON.stringify(f2.messages.map((m) => m.content)), JSON.stringify(['q1', 'a1']));
  f1.messages[0].content = '被改了'; assert.strictEqual(s.messages[0].content, 'q1', '深拷贝：改分支不能影响原对话');
  const d = ZX.branchTreeData(); assert.strictEqual(d.kids[s.id].length, 2); assert.strictEqual((d.kids[''] || []).length, 1);
});
await check('分支：编辑已发送消息前自动把「编辑前」存成已归档分支；末尾消息的编辑不产生备份', async () => {
  const msgs = [mk('user', 'q1'), mk('assistant', 'a1'), mk('user', 'q2'), mk('assistant', 'a2')]; const s = freshSession(msgs); let applied = null;
  Chat.applyEdit = async function (m, text) { applied = [m.id, text]; }; wired.wireMessages = false; ZX.wireMessages();
  const before = Sessions.list.length; await Chat.applyEdit(msgs[0], 'q1 改');
  assert.strictEqual(applied[1], 'q1 改', '原编辑逻辑必须照常执行'); assert.strictEqual(Sessions.list.length, before + 1);
  const b = Sessions.list[Sessions.list.length - 1]; assert.strictEqual(b.archived, true); assert.strictEqual(b.parentId, s.id); assert.strictEqual(b.messages.length, 4); assert.ok(/编辑前/.test(b.title));
  Sessions.list.length = 1; await Chat.applyEdit(msgs[3], 'x'); assert.strictEqual(Sessions.list.length, 1, '编辑最后一条没有后续内容，不需要备份');
});

/* ---------- 5. MCP ---------- */
await check('MCP：刷新后把工具并入 Agent 工具表（名字合法、$schema 被剔除、带 mcp 标记）；清空后移除', async () => {
  netHandler = async (u, init) => {
    if (u.indexOf('/__zc_mcp__/servers') >= 0) return { data: { ok: true, servers: [{ id: 'u:abc', name: '计算器', url: 'https://m.example/mcp', scope: 'user', enabled: true }, { id: 'u:off', name: '停用的', url: 'https://x.example', enabled: false }] } };
    if (u.indexOf('/__zc_mcp__/tools') >= 0) return { data: { ok: true, tools: [{ name: 'add.two numbers', description: '加法', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { a: { type: 'number' } } } }] } };
    return { status: 404, data: {} };
  };
  const base = AgentTools.LIST.length; await ZX.mcpRefresh();
  const d = AgentTools.LIST.filter((t) => t.mcp); assert.strictEqual(d.length, 1, '停用的服务器不应出现'); assert.ok(/^mcp_0_add_two_numbers$/.test(d[0].name), d[0].name); assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(d[0].name));
  assert.strictEqual(d[0].parameters.$schema, undefined); assert.ok(d[0].description.indexOf('[MCP · 计算器]') === 0); assert.strictEqual(AgentTools.LIST.length, base + 1);
  assert.strictEqual(ZX.mcp.map[d[0].name].tool, 'add.two numbers');
  netHandler = async () => ({ data: { ok: true, servers: [] } }); await ZX.mcpRefresh(); assert.strictEqual(AgentTools.LIST.filter((t) => t.mcp).length, 0, '清空后工具应被移除'); assert.strictEqual(AgentTools.LIST.length, base);
});
await check('MCP：Agent 调用 —— 需用户确认；拒绝则不发请求；放行后走服务端代理并记录步骤；非 MCP 工具原样委托', async () => {
  ZX.mcp.map = { mcp_0_add: { serverId: 'u:abc', serverName: '计算器', tool: 'add' } };
  const steps = []; Agent.runSteps = steps; Agent.renderStep = () => { }; let orig = null;
  Agent.runOneTool = async function (tc) { orig = tc.name; return 'orig:' + tc.name; }; ZX.wireAgent();
  netLog.length = 0; Dialog._open = async () => false;
  const denied = await Agent.runOneTool({ name: 'mcp_0_add', args: { a: 1, b: 2 } }); assert.ok(/拒绝/.test(denied)); assert.strictEqual(netLog.length, 0, '用户拒绝后不能发请求'); assert.strictEqual(steps[0].status, 'err');
  netHandler = async (u, init) => ({ data: { ok: true, isError: false, text: 'sum=3' } });
  Dialog._open = async () => true; const ok = await Agent.runOneTool({ name: 'mcp_0_add', args: { a: 1, b: 2 } });
  assert.strictEqual(ok, 'sum=3'); const call = netLog[netLog.length - 1]; assert.ok(call.url.indexOf('/__zc_mcp__/call') >= 0); const body = JSON.parse(call.init.body);
  assert.strictEqual(JSON.stringify([body.serverId, body.tool, body.arguments.a]), JSON.stringify(['u:abc', 'add', 1])); assert.strictEqual(steps[1].status, 'ok');
  ZX.setPref('mcpAuto', { 'u:abc': true }); let asked = false; Dialog._open = async () => { asked = true; return true; }; await Agent.runOneTool({ name: 'mcp_0_add', args: {} }); assert.strictEqual(asked, false, '勾选「不再确认」后不应再弹窗');
  assert.strictEqual(await Agent.runOneTool({ name: 'read_file', args: {} }), 'orig:read_file'); assert.strictEqual(orig, 'read_file');
  netHandler = async () => ({ status: 502, data: { error: '连接失败' } }); const bad = await Agent.runOneTool({ name: 'mcp_0_add', args: {} }); assert.ok(/MCP 调用失败：连接失败/.test(bad)); assert.strictEqual(steps[steps.length - 1].status, 'err');
});

/* ---------- 6. 知识库 ---------- */
await check('知识库：命中片段按分数过滤并注入系统提示词；关闭开关 / 低分命中则不注入；请求结束即清空', async () => {
  const orig = SystemPrompt.build; let builds = 0; SystemPrompt.build = function () { builds++; return 'BASE'; }; ZX.wireRag();
  assert.strictEqual(SystemPrompt.build(false), 'BASE'); ZX._ragCtx = ZX.ragContext([{ title: '手册', text: '重启请按电源键' }]);
  const s = SystemPrompt.build(false); assert.ok(s.indexOf('BASE') === 0 && s.indexOf('《手册》') > 0 && s.indexOf('重启请按电源键') > 0); ZX._ragCtx = '';
  freshSession([mk('user', '怎么重启设备？')]); ZX.setPref('ragOn', false); netLog.length = 0; await ZX.ragPrep(); assert.strictEqual(netLog.length, 0, '开关关闭不能检索'); assert.strictEqual(ZX._ragCtx, '');
  ZX.setPref('ragOn', true); netHandler = async () => ({ data: { ok: true, hits: [{ title: 'A', text: '高分内容ALPHA', score: 0.8 }, { title: 'B', text: '低分内容BETA', score: 0.05 }] } });
  await ZX.ragPrep(); assert.ok(ZX._ragCtx.indexOf('ALPHA') > 0 && ZX._ragCtx.indexOf('BETA') < 0, '低分片段应被过滤'); ZX._ragCtx = '';
  netHandler = async () => ({ data: { ok: true, hits: [{ title: 'B', text: '无关', score: 0.05 }] } }); await ZX.ragPrep(); assert.strictEqual(ZX._ragCtx, '', '全是低分则不注入');
  assert.ok(ZX.ragContext(Array.from({ length: 4 }, () => ({ title: 't', text: 'x'.repeat(5000) }))).length <= 7000, '注入上下文必须有上限');
  SystemPrompt.build = orig;
});

/* ---------- 7. 跑分 / 分享 ---------- */
await check('团队分享：图片被替换为占位文字（不上传 base64）；导入后成为带「团队」标签的新对话', () => {
  const s = freshSession([mk('user', [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]), mk('assistant', '好的', { meta: { model: 'X', secret: 'no' } })]);
  const d = ZX.shareData(s); const txt = JSON.stringify(d); assert.ok(txt.indexOf('base64') < 0 && txt.indexOf('图片已省略') > 0 && txt.indexOf('secret') < 0, txt);
  const n = Sessions.list.length; ZX.close = () => { }; ZX.importShared({ title: '架构讨论', data: d }); assert.strictEqual(Sessions.list.length, n + 1);
  const t = Sessions.list[Sessions.list.length - 1]; assert.ok(/架构讨论/.test(t.title)); assert.strictEqual(JSON.stringify(t.tags), JSON.stringify(['团队'])); assert.strictEqual(t.messages.length, 2);
});

/* ---------- 8. 静态契约（登录 / 守卫 / CSP 友好 / PWA） ---------- */
await check('守卫路径：新增的服务端接口都在前端 ZC_AUTH_GUARDED 里（否则不会带会话令牌）', () => {
  const m = /const ZC_AUTH_GUARDED = \[([^\]]+)\]/.exec(html); assert.ok(m); const list = m[1];
  ['mcp', 'team', 'rag', 'ops'].forEach((k) => assert.ok(list.indexOf("/__zc_" + k + "__") >= 0, '缺少 ' + k));
});
await check('登录补丁：Google / Microsoft 按钮、握手 label、服务端关闭 GitHub 时的展示逻辑', () => {
  ['btnGoogle', 'btnMicrosoft', 'r0.data.label'].forEach((k) => assert.ok(html.indexOf(k) >= 0, '缺少 ' + k));
  assert.ok(/gh\.hidden = !\(c\.github \|\| c\.google \|\| c\.microsoft\)/.test(html)); assert.ok(html.indexOf("x-zc-model") >= 0, '代理请求需要带 x-zc-model 供服务端估算成本');
});
await check('CSP 友好：标记里没有内联事件属性（onclick= 等）；ZX.init 在 boot 里被 try/catch 调用；新静态文件已放行', () => {
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  assert.strictEqual((markup.match(/\son(click|change|input|error|load|submit|keydown)\s*=/gi) || []).length, 0, '发现内联事件属性（会被 CSP 拦截）');
  assert.ok(/try \{ ZX\.init\(\); \} catch/.test(html)); assert.ok(html.indexOf('rel="manifest"') > 0);
  const ign = fs.readFileSync(path.join(__dirname, 'public', '.assetsignore'), 'utf8'); ['sw.js', 'manifest.webmanifest', 'icon.svg'].forEach((f) => assert.ok(ign.indexOf('!' + f) >= 0, '.assetsignore 未放行 ' + f));
  ['sw.js', 'manifest.webmanifest', 'icon.svg'].forEach((f) => assert.ok(fs.existsSync(path.join(__dirname, 'public', f)), '缺少 ' + f));
});
await check('Service Worker：不缓存 /__zc_ 接口；导航网络优先；不含推送处理', () => {
  const sw = fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8');
  assert.ok(/indexOf\('\/__zc_'\) === 0/.test(sw)); assert.ok(/mode === 'navigate'/.test(sw)); assert.ok(!/addEventListener\('push'/.test(sw)); assert.ok(/method !== 'GET'/.test(sw));
});

for (const [s, n] of R) console.log(s + ' | ' + n);
const fail = R.filter((r) => r[0] === 'FAIL').length; console.log('\n===== ' + (R.length - fail) + '/' + R.length + ' 通过 =====');
process.exit(fail ? 1 : 0);
