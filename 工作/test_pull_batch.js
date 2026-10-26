/* v2.30.4：云端 → 本地「拉回」批量读取（readmany）/ 并发 / 进度 / 时间预算，以及 Agent 进行中消息的存档与重进恢复。 */
const fs = require('fs');
const assert = require('assert');
const vm = require('vm');

const html = fs.readFileSync(require('path').join(__dirname, 'public', 'index.html'), 'utf8');
const all = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length);
let app = all[0];
const EXPOSE = 'window.__T = { AgentFS, AgentMix, CloudFS, Sessions, Agent, ToolUI };\n';
const tail = "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootApp); else bootApp();";
assert.ok(app.indexOf(tail) >= 0, 'tail not found');
app = app.replace(tail, EXPOSE + tail);

function stubEl() {
  return {
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [], childNodes: [], textContent: '', innerHTML: '', hidden: false, value: '', checked: false, type: '',
    appendChild(c) { this.children.push(c); return c; }, removeChild() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    querySelector() { return stubEl(); }, querySelectorAll() { return []; },
    focus() {}, click() {}, closest() { return null; }, insertBefore() {}, replaceChildren() {}, scrollIntoView() {}
  };
}
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }, clear: () => { for (const k in store) delete store[k]; },
  key: (i) => Object.keys(store)[i] || null, get length() { return Object.keys(store).length; }
};
const documentStub = {
  readyState: 'loading', addEventListener() {}, removeEventListener() {},
  querySelector() { return stubEl(); }, querySelectorAll() { return []; },
  createElement() { return stubEl(); }, createTextNode() { return {}; },
  documentElement: stubEl(), head: stubEl(), body: stubEl(), visibilityState: 'visible', hidden: false
};
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Math, Date, Object, Array,
  String, Number, Boolean, RegExp, Error, Map, Set, Symbol, AbortController, TextEncoder, TextDecoder, URL, URLSearchParams,
  fetch: () => Promise.reject(new Error('no net')),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  localStorage, sessionStorage: localStorage,
  navigator: { userAgent: 'node', language: 'zh-CN', clipboard: {} },
  location: { href: 'https://x/', origin: 'https://x', pathname: '/', search: '', hash: '' },
  document: documentStub, crypto: { subtle: {}, randomUUID: () => 'x' },
  requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }), addEventListener() {}, removeEventListener() {}
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.runInContext(app, vm.createContext(sandbox), { filename: 'app.js' });
const T = sandbox.window.__T;
assert.ok(T, 'expose failed');
const { AgentFS, AgentMix, CloudFS, Sessions, Agent, ToolUI } = T;


const results = [];
function t(name, ok, extra) { results.push(!!ok); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? '  → ' + extra : '')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const crypto = require('crypto');
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

/* ---- 假云端：path → Buffer；统计每种接口的调用次数 ---- */
let cloud = {}, calls = { readmany: 0, readchunk: 0 }, lat = 0, noMany = false;
CloudFS.norm = (p) => String(p);
CloudFS.api = async (sub, body) => {
  if (lat) await sleep(lat);
  if (sub === 'readmany') {
    calls.readmany++;
    if (noMany) { const e = new Error('未知的沙箱接口：readmany'); e.status = 404; throw e; }
    let tot = 0;
    return { ok: true, results: body.paths.map((p) => {
      const b = cloud[p]; if (!b) return { path: p, st: 'missing' };
      if (b.length > 120000) return { path: p, st: 'big', size: b.length };
      if (tot + b.length > 120000) return { path: p, st: 'defer', size: b.length };
      tot += b.length; return { path: p, st: 'ok', size: b.length, sha1: sha1(b), b64: b.toString('base64') };
    }) };
  }
  if (sub === 'readchunk') {
    calls.readchunk++;
    const b = cloud[body.path]; const off = body.offset || 0;
    const part = b.subarray(off, off + (body.length || 120000));
    return { ok: true, path: body.path, size: b.length, offset: off, len: part.length, b64: part.toString('base64'), sha1: off === 0 ? sha1(b) : '' };
  }
  throw new Error('unexpected ' + sub);
};
/* ---- 假本地目录 ---- */
let local = {}, writes = 0;
AgentFS.localBytes = undefined;
AgentMix.localBytes = async (p) => (p in local ? new Uint8Array(local[p]) : null);
AgentFS.writeFile = async (p, u8) => { writes++; local[p] = Buffer.from(u8); };
AgentFS.createFile = async (p, u8) => { writes++; local[p] = Buffer.from(u8); };
function reset() { cloud = {}; local = {}; writes = 0; calls = { readmany: 0, readchunk: 0 }; lat = 0; noMany = false; AgentMix.reset(); }

(async () => {
  /* 1) 200 个小文本文件：批量读取，几次往返就完成 */
  reset();
  for (let i = 0; i < 200; i++) cloud['src/f' + i + '.py'] = Buffer.from('print(' + i + ')\n' + 'x'.repeat(2000 + (i % 7) * 300));
  let list = Object.keys(cloud).map((p) => ({ path: p, size: cloud[p].length }));
  let ticks = 0, lastPg = null;
  let r = await AgentMix.pullList(list, { allowBig: false, onProgress: (pg) => { ticks++; lastPg = pg; } });
  t('200 个小文件全部拉回，内容逐字节一致', r.pulled === 200 && Object.keys(local).length === 200 && Object.keys(cloud).every((p) => local[p] && local[p].equals(cloud[p])), 'pulled=' + r.pulled);
  t('小文件走 readmany：往返次数从 200+ 降到十几次，不再逐个 readchunk', calls.readmany > 0 && calls.readmany <= 20 && calls.readchunk === 0, 'readmany=' + calls.readmany + ' readchunk=' + calls.readchunk);
  t('有进度回调，最后一次是 200/200', ticks >= 2 && lastPg && lastPg.done === 200 && lastPg.total === 200, 'ticks=' + ticks);
  t('拉回后记入 pushed（diffCloud 下次不再重复拉）', AgentMix.pushed['src/f0.py'] === cloud['src/f0.py'].length);

  /* 2) 再拉一次：内容相同 → 全部 same，不重复写 */
  const w0 = writes;
  r = await AgentMix.pullList(list, { allowBig: false });
  t('重复拉回：内容一致的自动跳过、不重复写入', r.same === 200 && r.pulled === 0 && writes === w0, 'same=' + r.same);

  /* 3) 二进制：未授权跳过，授权后拉回；大文件走 readchunk 分块 */
  reset();
  cloud['a.txt'] = Buffer.from('hello');
  cloud['img.png'] = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), crypto.randomBytes(3000)]);
  cloud['big.js'] = Buffer.from('y'.repeat(300000));
  list = Object.keys(cloud).map((p) => ({ path: p, size: cloud[p].length }));
  r = await AgentMix.pullList(list, { allowBig: false });
  t('未授权：文本拉回，二进制跳过并说明需授权', r.pulled === 2 && r.skipped.some((x) => x.path === 'img.png' && /授权/.test(x.reason)), JSON.stringify(r.skipped.map((x) => x.path)));
  t('>100KB 的大文件走 readchunk 分块（3 块）', calls.readchunk >= 3 && local['big.js'] && local['big.js'].equals(cloud['big.js']), 'readchunk=' + calls.readchunk);
  r = await AgentMix.pullList([{ path: 'img.png', size: cloud['img.png'].length }], { allowBig: true });
  t('授权后二进制按原字节拉回', r.pulled === 1 && local['img.png'].equals(cloud['img.png']));

  /* 4) 后端没有 readmany（旧 Worker）→ 自动退回逐个读取，结果仍正确 */
  reset(); noMany = true;
  for (let i = 0; i < 12; i++) cloud['d/f' + i + '.txt'] = Buffer.from('v' + i);
  list = Object.keys(cloud).map((p) => ({ path: p, size: cloud[p].length }));
  r = await AgentMix.pullList(list, { allowBig: false });
  t('旧后端（readmany 404）自动回退逐个读取', r.pulled === 12 && calls.readchunk >= 12 && r.failed === 0, 'readchunk=' + calls.readchunk);

  /* 5) 时间预算：用完就停止派发，已拉回的保留，剩下的记 deferred；再调一次能补齐 */
  reset(); lat = 120;
  for (let i = 0; i < 400; i++) cloud['m/f' + i + '.txt'] = Buffer.from('z'.repeat(9000));
  list = Object.keys(cloud).map((p) => ({ path: p, size: cloud[p].length }));
  r = await AgentMix.pullList(list, { allowBig: false, budgetMs: 300 });
  const got1 = r.pulled;
  t('时间预算到点就停：部分拉回 + 明确的 deferred 数，没有无限等待', r.deferred > 0 && got1 > 0 && got1 + r.deferred + r.skipped.length === 400, 'pulled=' + got1 + ' deferred=' + r.deferred + ' skipped=' + r.skipped.length);
  t('describe() 会提示模型再调用一次继续', /再调用一次 pull_from_cloud/.test(AgentMix.describe(r)));
  lat = 0;
  const rest = list.filter((x) => !local[x.path]);
  r = await AgentMix.pullList(rest, { allowBig: false });
  t('再调用一次补齐剩余部分', Object.keys(local).length === 400 && r.failed === 0, 'local=' + Object.keys(local).length);

  /* 6) 文件在云端被删 → 如实记失败，不影响其它文件 */
  reset(); cloud['ok.txt'] = Buffer.from('ok');
  r = await AgentMix.pullList([{ path: 'ok.txt', size: 2 }, { path: 'gone.txt', size: 5 }], { allowBig: false });
  t('云端文件已不存在：记失败原因，其余文件照常拉回', r.pulled === 1 && r.failed === 1 && /不存在/.test(r.failedFiles[0]));

  /* 7) Agent 进行中消息：边跑边存档 / 结束写回同一条 / 重进恢复成「已中断」 */
  const sess = Sessions.create(true);
  Sessions.add('user', '帮我拉回文件', { agent: true });
  Agent.runSteps = [{ tool: 'run_command', status: 'ok', summary: '执行命令', detail: 'ok', args: { command: 'ls' } }, { tool: 'pull_from_cloud', status: 'run', summary: '拉回', detail: '正在从云端拉回 200 个文件…', args: {} }];
  Agent._runMsg = Sessions.add('assistant', '', { agent: true, running: true, steps: [] });
  Agent._lastS = { reasoning: '先看看目录', content: '正在拉回' };
  try { Agent._persistRun(true); } catch (e) { console.log('persist err', e.message); }
  const saved = JSON.parse(localStorage.getItem(Object.keys(store).find((k) => /sessions/.test(k)) ) || 'null');
  const raw = Object.keys(store).map((k) => store[k]).find((v) => v.indexOf('正在从云端拉回 200 个文件') >= 0);
  t('进行中的步骤 / 思考 / 已输出文字已写进存档（还没结束就能看到）', !!raw && raw.indexOf('先看看目录') >= 0 && raw.indexOf('"running":true') >= 0);
  /* 模拟「关页面再进来」：从存档里重新 init */
  const snapStore = JSON.stringify(Sessions.list);
  Sessions.list = JSON.parse(snapStore);
  Sessions.list.forEach((s) => s.messages.forEach((m) => { if (m.role === 'assistant' && m.meta && m.meta.running) Sessions.recoverRunning(m); }));
  const rm = Sessions.list.find((s) => s.id === sess.id).messages.find((m) => m.role === 'assistant');
  t('重进后：不再是「进行中」，标成已中断，保留已完成步骤，转圈的步骤收口', rm && !rm.meta.running && rm.meta.interrupted && rm.meta.steps.length === 2 && rm.meta.steps[0].status === 'ok' && rm.meta.steps[1].status === 'stop');
  t('重进后：保留已输出文字并提示发「继续」', rm && /正在拉回/.test(rm.content) && /继续/.test(rm.content));
  /* 结束时写回同一条消息，不新增 */
  Sessions.curId = sess.id;
  const cur = Sessions.cur();
  Agent._runMsg = Sessions.add('assistant', '', { agent: true, running: true, steps: [] });
  const n0 = cur.messages.length;
  const fin = Agent._commitRunMsg('任务完成', { agent: true, steps: [] });
  t('任务结束：把最终内容写回占位消息（消息数不变、running 清除）', cur.messages.length === n0 && fin.content === '任务完成' && !fin.meta.running);
  t('上下文构建不会带上空的占位消息', !Sessions.context(30).some((m) => m.role === 'assistant' && m.content === ''));

  const ok = results.filter(Boolean).length;
  console.log('\n===== ' + ok + '/' + results.length + ' 通过 =====');
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
