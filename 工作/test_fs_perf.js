const fs = require('fs');
const assert = require('assert');
const vm = require('vm');

const html = fs.readFileSync(require('path').join(__dirname, 'public', 'index.html'), 'utf8');
// 自动从页面里抽出最大的内联 <script>（不再依赖手工准备的 /tmp/app.js）
const all = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length);
let app = all[0];
const EXPOSE = 'window.__T = { AgentFS, AgentTools, zcWithTimeout };\n';
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
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  clear: () => { for (const k in store) delete store[k]; },
  key: (i) => Object.keys(store)[i] || null,
  get length() { return Object.keys(store).length; }
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


const { AgentFS, AgentTools, zcWithTimeout } = T;
const results = [];
function t(name, ok, extra) { results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? '  → ' + extra : '')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 假的目录句柄：getFile 可设延迟；大文件只按需生成字节，整份读取超过 64MB 直接报错（防回归） ---- */
const stat = { getFile: 0, bytes: 0 };
function mkFile(name, size, o) {
  o = o || {};
  const head = o.head ? Buffer.from(o.head, 'utf8') : Buffer.alloc(0);
  const gen = (a, b) => {
    const out = new Uint8Array(Math.max(0, Math.min(b, size) - a));
    for (let i = 0; i < out.length; i++) { const p = a + i; out[i] = p < head.length ? head[p] : (o.fill != null ? o.fill : 0x61); }
    stat.bytes += out.length;
    return out;
  };
  const file = {
    size,
    slice(a, b) { return { arrayBuffer: async () => gen(a, b).buffer }; },
    async arrayBuffer() { if (size > 64 * 1024 * 1024) throw new Error('FULL READ OF HUGE FILE ' + name); return gen(0, size).buffer; }
  };
  return { kind: 'file', name, getFile: async () => { stat.getFile++; if (o.delay) await sleep(o.delay); return file; } };
}
function mkDir(entries) {
  const m = {}; entries.forEach((e) => { m[e.name] = e; });
  const d = {
    kind: 'directory', name: 'root',
    async *values() { for (const e of entries) yield e; },
    async getFileHandle(n) { if (m[n] && m[n].kind === 'file') return m[n]; throw new Error('NotFound'); },
    async getDirectoryHandle(n) { if (m[n] && m[n].kind === 'directory') return m[n]; throw new Error('NotFound'); }
  };
  return d;
}
function setRoot(entries) { AgentFS.root = mkDir(entries); AgentFS._sz.clear(); stat.getFile = 0; stat.bytes = 0; }

(async () => {
  /* 1) 60 个文件、每个 getFile 400ms：旧版串行要 24 秒；并发后应在几秒内完成且全都有大小 */
  setRoot(Array.from({ length: 60 }, (_, i) => mkFile('f' + i + '.txt', 100 + i, { delay: 400 })));
  let t0 = Date.now(), r = await AgentFS.listDir('');
  let dt = Date.now() - t0;
  t('listDir 并发取大小：60 个慢文件 < 4s（旧版串行约 24s）', dt < 4000 && r.length === 60 && r.every((x) => x.size > 0), dt + 'ms');

  /* 2) 存储卡死：所有 getFile 都要 30 秒 → 目录列表仍按预算返回，条目无 size */
  AgentFS.SIZE_BUDGET_MS = 300;
  setRoot(Array.from({ length: 40 }, (_, i) => mkFile('h' + i + '.dat', 5e8, { delay: 30000 })));
  t0 = Date.now(); r = await AgentFS.listDir('');
  dt = Date.now() - t0;
  t('listDir 卡死时按预算返回（不等 getFile）', dt < 1500 && r.length === 40 && r.every((x) => x.size == null), dt + 'ms');
  t('预算耗尽后不再继续发起新的 getFile（最多并发数个）', stat.getFile <= AgentFS.SIZE_CONCURRENCY, 'getFile=' + stat.getFile);

  /* 3) sizes:false 一次 getFile 都不调用 */
  setRoot([mkFile('a.txt', 1, { delay: 50 }), mkFile('b.txt', 2, { delay: 50 })]);
  r = await AgentFS.listDir('', { sizes: false });
  t('listDir {sizes:false} 不碰文件', stat.getFile === 0 && r.length === 2 && r[0].size == null);

  /* 4) exact:true 等全部取完 */
  AgentFS.SIZE_BUDGET_MS = 100;
  setRoot(Array.from({ length: 5 }, (_, i) => mkFile('e' + i + '.txt', 10 + i, { delay: 300 })));
  r = await AgentFS.listDir('', { exact: true });
  t('listDir {exact:true} 等所有大小取完（同步快照需要精确值）', r.every((x) => x.size > 0));

  /* 5) 缓存：8 秒内再列一次不再 getFile */
  AgentFS.SIZE_BUDGET_MS = 2500;
  setRoot([mkFile('c1.txt', 11), mkFile('c2.txt', 22)]);
  await AgentFS.listDir(''); const g1 = stat.getFile; await AgentFS.listDir('');
  t('大小缓存：短时间内重复列目录不重复取', g1 === 2 && stat.getFile === 2, 'getFile=' + stat.getFile);

  /* 6) 二进制扩展名：读取不碰内容（343MB zip） */
  setRoot([mkFile('hanshuang-pojia-2.0.zip', 343 * 1024 * 1024), mkFile('app.asar', 220 * 1024 * 1024), mkFile('icudtl.dat', 10 * 1024 * 1024)]);
  const z = await AgentFS.readFile('hanshuang-pojia-2.0.zip');
  await AgentFS.readFile('app.asar'); await AgentFS.readFile('icudtl.dat');
  t('read_file 对已知二进制（zip / asar / dat）零字节读取', z.binary === true && z.size === 343 * 1024 * 1024 && stat.bytes === 0, 'bytes=' + stat.bytes);

  /* 7) 未知扩展名的大二进制：只读 4KB 文件头 */
  setRoot([mkFile('blob.xyz', 200 * 1024 * 1024, { head: 'MZ\u0000\u0000binary' })]);
  r = await AgentFS.readFile('blob.xyz');
  t('read_file 未知扩展名的大二进制只读文件头（4096 字节）', r.binary === true && stat.bytes === 4096, 'bytes=' + stat.bytes);

  /* 8) 超大文本：只读前 ~6MB，截断且不留乱码 */
  setRoot([mkFile('big.log', 300 * 1024 * 1024, { head: '日志开头\n' })]);
  r = await AgentFS.readFile('big.log');
  t('read_file 300MB 文本只读前约 6MB 并标记截断', r.binary === false && r.truncated === true && r.text.length <= AgentFS.MAX_READ && stat.bytes < 8 * 1024 * 1024 + 8192, 'bytes=' + stat.bytes + ' chars=' + r.text.length);
  /* CJK 在字节边界被切开：末尾不应出现 U+FFFD */
  const cjk = '汉'.repeat(3 * 1024 * 1024);
  setRoot([mkFile('cjk.txt', Buffer.byteLength(cjk) + 5 * 1024 * 1024, { head: cjk, fill: 0x61 })]);
  AgentFS.MAX_READ = 5 * 1024 * 1024; // 让字节上限落在汉字中间之后的 ascii 区；再用一个落在汉字中间的用例：
  const f2 = mkFile('cut.txt', 20 * 1024 * 1024, { head: '汉'.repeat(6 * 1024 * 1024) });
  setRoot([f2]); AgentFS.MAX_READ = 2 * 1024 * 1024 + 0; // BYTE_CAP = 6MB+16 → 落在第 2097157 个汉字（3 字节）中间
  r = await AgentFS.readFile('cut.txt');
  t('字节截断落在多字节字符中间时不留 U+FFFD 乱码', !/�/.test(r.text) && r.truncated === true);
  AgentFS.MAX_READ = 2 * 1024 * 1024;

  /* 9) 普通小文本行为不变 */
  setRoot([mkFile('hello.js', 12, { head: 'console.log(1)' })]);
  r = await AgentFS.readFile('hello.js');
  t('小文本文件读取行为不变', r.binary === false && r.text.startsWith('console') && !r.truncated);

  /* 10) 内容搜索跳过二进制扩展名 */
  setRoot([mkFile('x.zip', 5 * 1024 * 1024, { head: 'needle' }), mkFile('y.txt', 6, { head: 'needle' })]);
  const sr = await AgentFS.search('needle', { mode: 'content' });
  const spaths = (sr.results || sr).map((x) => x.path);
  t('search_files 内容搜索不打开 .zip 等二进制扩展名', spaths.length === 1 && spaths[0] === 'y.txt' && stat.getFile === 1, JSON.stringify(spaths) + ' getFile=' + stat.getFile);

  /* 11) 超时包装 + 文案不出现 (0B) */
  let msg = '';
  try { await zcWithTimeout(new Promise(() => {}), 50, '超时了'); } catch (e) { msg = e.message; }
  t('zcWithTimeout 到点就放弃', msg === '超时了');
  const txt = AgentTools.fmtEntries([{ kind: 'file', path: 'a.bin' }, { kind: 'file', path: 'b.txt', size: 2048 }]);
  t('list_files 输出：没取到大小的条目不显示 (0B)', txt.indexOf('(0B)') < 0 && /b\.txt\s+\(/.test(txt), txt.replace(/\n/g, ' | '));

  const bad = results.filter((x) => !x).length;
  console.log('===== ' + (results.length - bad) + '/' + results.length + ' 通过 =====');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('FATAL', e); process.exit(1); });
