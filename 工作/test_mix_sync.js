/* v2.30.3：混合模式「本地 → 云端沙箱」同步提速（AgentMix.snapshot / push）+ Claude 式扁平工具行 的契约与行为测试。
 * 用「假目录句柄」模拟约 1GB 的 Electron 程序目录（343MB 的 zip、dll、pak、asar 只有大小、没有真实字节；整份读取 >64MB 会直接抛错）。 */
const fs = require('fs');
const assert = require('assert');
const vm = require('vm');

const html = fs.readFileSync(require('path').join(__dirname, 'public', 'index.html'), 'utf8');
const all = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length);
let app = all[0];
const EXPOSE = 'window.__T = { AgentFS, AgentMix, CloudFS };\n';
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
const { AgentFS, AgentMix, CloudFS } = T;

const results = [];
function t(name, ok, extra) { results.push(!!ok); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? '  → ' + extra : '')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;

/* ---- 假目录 ---- */
const stat = { getFile: 0, names: [], reads: {} };
function toAB(b) { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
function mkFile(name, o) {
  o = o || {};
  const buf = o.bytes ? Buffer.from(o.bytes) : Buffer.from(o.text == null ? '' : o.text, 'utf8');
  const size = o.size != null ? o.size : buf.length;
  const file = {
    size, name, lastModified: 1,
    async arrayBuffer() { stat.reads[name] = (stat.reads[name] || 0) + 1; if (size > 64 * MB) throw new Error('整份读取超大文件：' + name); return toAB(buf); },
    slice(a, b) { return { async arrayBuffer() { stat.reads[name] = (stat.reads[name] || 0) + 1; return toAB(buf.subarray(a, b)); } }; }
  };
  return {
    kind: 'file', name,
    async getFile() { stat.getFile++; stat.names.push(name); if (o.hang) await new Promise(() => {}); if (o.delay) await sleep(o.delay); return file; }
  };
}
function mkDir(name, entries, o) {
  return {
    kind: 'directory', name,
    async *values() { if (o && o.fail) throw new Error('permission'); for (const e of entries) yield e; },
    async getFileHandle(n) { const e = entries.find((x) => x.kind === 'file' && x.name === n); if (!e) throw new Error('NotFoundError'); return e; },
    async getDirectoryHandle(n) { const e = entries.find((x) => x.kind === 'directory' && x.name === n); if (!e) throw new Error('NotFoundError'); return e; }
  };
}
function resetStat() { stat.getFile = 0; stat.names = []; stat.reads = {}; }

const calls = { log: [], del: [], inflight: 0, maxInflight: 0, finished: 0 };
function resetCloud() { calls.log = []; calls.del = []; calls.inflight = 0; calls.maxInflight = 0; calls.finished = 0; }
CloudFS.rebuilds = 0;
CloudFS.writeMany = async (files) => {
  calls.inflight++; calls.maxInflight = Math.max(calls.maxInflight, calls.inflight);
  calls.log.push({ n: files.length, inflightAtStart: calls.inflight, finishedBefore: calls.finished });
  await sleep(25);
  calls.inflight--; calls.finished++;
  return { results: files.map((f) => ({ path: f.path, ok: true })) };
};
CloudFS.deleteFile = async (p) => { calls.del.push(p); };

function fresh(root) { AgentMix.reset(); resetStat(); resetCloud(); AgentFS.root = root; }
const SAVE = { b: AgentMix.SCAN_BUDGET_MS, g: AgentMix.SCAN_GUARD_MS };

(async () => {
  /* ===== 1. 约 1GB 的 Electron 目录：二进制扩展名一个都不碰 ===== */
  {
    const loc = []; for (let i = 0; i < 200; i++) loc.push(mkFile('lang-' + i + '.pak', { size: 1 * MB }));
    const root = mkDir('', [
      mkDir('locales', loc),
      mkDir('resources', [mkFile('app.asar', { size: 300 * MB }), mkFile('electron.asar', { size: 100 * MB }), mkDir('app', [mkFile('main.js', { text: 'console.log(1)' }), mkFile('package.json', { text: '{"name":"x"}' })])]),
      mkFile('hanshuang-pojia-2.0.zip', { size: 343 * MB }), mkFile('d3dcompiler_47.dll', { size: 4.69 * MB }), mkFile('ffmpeg.dll', { size: 2.79 * MB }),
      mkFile('icudtl.dat', { size: 9.98 * MB }), mkFile('libGLESv2.dll', { size: 8.03 * MB }), mkFile('chrome_100_percent.pak', { size: 148 * 1024 }),
      mkFile('LICENSE.electron.txt', { text: 'MIT' }), mkFile('LICENSES.chromium.html', { size: 8.75 * MB }), mkFile('portable-uninstall.ps1', { text: 'Write-Host hi' })
    ]);
    fresh(root);
    const t0 = Date.now();
    const sc = await AgentMix.snapshot();
    const ms = Date.now() - t0;
    t('大目录扫描：二进制扩展名（zip / dll / pak / asar / dat）一个都不 getFile', stat.names.every((n) => !AgentFS.BIN_EXT.test(n)), '共 getFile ' + stat.getFile + ' 次：' + stat.names.join(','));
    t('大目录扫描：只对 5 个文本类文件取大小', stat.getFile === 5, String(stat.getFile));
    t('大目录扫描：二进制只记名字（200 个 pak + 2 asar + zip + 3 dll + dat + pak = 208）', Object.keys(sc.bins).length === 208, String(Object.keys(sc.bins).length));
    t('大目录扫描：8.75MB 的 html 记大小但不带 File（超过 MAX_FILE）', sc.files['LICENSES.chromium.html'] === Math.round(8.75 * MB) && !sc.objs['LICENSES.chromium.html'] && sc.objs['resources/app/main.js'], '');
    t('大目录扫描：完整、耗时 < 1 秒', !sc.partial && ms < 1000, ms + 'ms');
    const r = await AgentMix.push();
    t('大目录推送：只推 4 个小文本、没有任何整份读取超大文件的异常', r.pushed === 4 && r.failed === 0, 'pushed=' + r.pushed + ' skipped=' + r.skipped + ' failed=' + r.failed);
    t('大目录推送：跳过数 = 208 个二进制 + 1 个超限 html', r.skipped === 209, String(r.skipped));
    t('大目录推送：不据此删云端文件、不标 partial', r.deleted === 0 && !r.partial && calls.del.length === 0, '');
  }

  /* ===== 2. 判定过的二进制 / 超限文件，大小没变就不再重读 ===== */
  {
    const root = mkDir('', [mkFile('n.txt', { text: 'hello' }), mkFile('big.log', { size: 3 * MB }), mkFile('blob.xyz', { bytes: [1, 2, 0, 0, 5] })]);
    fresh(root);
    const r1 = await AgentMix.push();
    t('二进制 / 超限：第一次判定', r1.pushed === 1 && r1.skipped === 2 && stat.reads['blob.xyz'] === 1, JSON.stringify({ p: r1.pushed, s: r1.skipped, reads: stat.reads['blob.xyz'] }));
    const r2 = await AgentMix.push();
    t('二进制 / 超限：第二次不再重读（旧版每次执行都重读），但仍如实计入跳过数', r2.pushed === 0 && r2.skipped === 2 && stat.reads['blob.xyz'] === 1 && r2.skippedFiles.some((x) => x.indexOf('blob.xyz') === 0), JSON.stringify({ p: r2.pushed, s: r2.skipped, reads: stat.reads['blob.xyz'] }));
    AgentMix.markDirty('blob.xyz');
    await AgentMix.push();
    t('二进制 / 超限：被标记为改动（dirty）的文件会重新判定', stat.reads['blob.xyz'] === 2, String(stat.reads['blob.xyz']));
  }

  /* ===== 3. 删除云端镜像：扫描完整才删；本地仍在的二进制不能被当成「已删除」 ===== */
  {
    const root = mkDir('', [mkFile('a.js', { text: 'x' }), mkDir('img', [mkFile('p.png', { size: 5 * MB })])]);
    fresh(root);
    AgentMix.pushed = { 'gone.js': 3, 'img/p.png': 5 * MB };
    const r = await AgentMix.push();
    t('扫描完整：本地已不存在的文件才删云端', r.deleted === 1 && calls.del.length === 1 && calls.del[0] === 'gone.js' && !('gone.js' in AgentMix.pushed), JSON.stringify(calls.del));
    t('拉回过的二进制（本地仍在）不会被当成已删除而误删云端', calls.del.indexOf('img/p.png') < 0 && AgentMix.pushed['img/p.png'] === 5 * MB, '');
  }
  {
    const many = []; for (let i = 0; i < 600; i++) many.push(mkFile('f' + i + '.txt', { text: 'v' + i }));
    fresh(mkDir('', many));
    AgentMix.pushed = { 'old/keep.js': 10 };
    const r = await AgentMix.push();
    t('文本文件超过 500 个：只推前 500 个、标 partial、不删云端文件', r.partial && r.why.indexOf('500') >= 0 && r.pushed <= 500 && r.pushed >= 480 && r.deleted === 0 && calls.del.length === 0, 'pushed=' + r.pushed + ' why=' + r.why);
  }
  {
    fresh(mkDir('', [mkFile('good.js', { text: 'ok' }), mkDir('locked', [], { fail: true })]));
    AgentMix.pushed = { 'locked/x.js': 5 };
    const r = await AgentMix.push();
    t('有目录读取失败：标 partial、不删云端文件', r.partial && r.why.indexOf('locked') >= 0 && calls.del.length === 0 && r.pushed === 1, r.why);
  }

  /* ===== 4. 总时间预算 + 卡死保险丝 ===== */
  {
    const slow = []; for (let i = 0; i < 300; i++) slow.push(mkFile('s' + i + '.txt', { text: 'x', delay: 25 }));
    fresh(mkDir('', slow));
    AgentMix.SCAN_BUDGET_MS = 60; AgentMix.SCAN_GUARD_MS = 300;
    const t0 = Date.now(); const sc = await AgentMix.snapshot(); const ms = Date.now() - t0;
    t('时间预算：超时就返回已扫到的部分并标 partial', sc.partial && sc.why.indexOf('扫描超过') === 0 && Object.keys(sc.files).length > 0 && Object.keys(sc.files).length < 300 && ms < 1500, 'files=' + Object.keys(sc.files).length + ' ' + ms + 'ms');
    fresh(mkDir('', [mkFile('ok.js', { text: 'a' }), mkFile('stuck.js', { hang: true })]));
    const t1 = Date.now(); const sc2 = await AgentMix.snapshot(); const ms2 = Date.now() - t1;
    t('保险丝：某个 getFile 永远不返回，也只多等 预算 + 保险丝 时间', sc2.partial && ms2 < 1500, ms2 + 'ms');
    AgentMix.SCAN_BUDGET_MS = SAVE.b; AgentMix.SCAN_GUARD_MS = SAVE.g;
  }

  /* ===== 5. 批量推送：第一批单独发，其余 3 路并发；进度回调 ===== */
  {
    const m = []; for (let i = 0; i < 60; i++) m.push(mkFile('m' + i + '.txt', { text: 'content ' + i }));
    fresh(mkDir('', m));
    const msgs = [];
    const r = await AgentMix.push({ onProgress: (x) => msgs.push(x) });
    t('批量推送：60 个文件 = 5 批（每批 ≤12 个）', r.pushed === 60 && calls.log.length === 5 && calls.log.every((c) => c.n <= 12), JSON.stringify(calls.log.map((c) => c.n)));
    t('批量推送：第一批单独发（防止并发请求各自重建沙箱），之后才并发', calls.log[0].inflightAtStart === 1 && calls.log[1].finishedBefore >= 1, JSON.stringify(calls.log[1]));
    t('批量推送：其余批次并发（最多 3 路）', calls.maxInflight >= 2 && calls.maxInflight <= 3, 'max=' + calls.maxInflight);
    t('进度回调：扫描 / 读取 / 推送三个阶段都有实时文字', msgs.some((x) => x.indexOf('正在扫描本地文件') === 0) && msgs.some((x) => x.indexOf('正在读取本地文件') === 0) && msgs.some((x) => x.indexOf('正在推送文件到云端沙箱 60/60') === 0), msgs.length + ' 条');
  }

  /* ===== 6. _readFileObj 与 readFile 结果一致（拆分是纯重构） ===== */
  {
    const fh = mkFile('a.txt', { text: '你好 hello' });
    AgentFS.root = mkDir('', [fh]); resetStat();
    const a = await AgentFS.readFile('a.txt');
    const b = await AgentFS._readFileObj(await fh.getFile(), 'a.txt');
    t('readFile 与 _readFileObj 结果一致', JSON.stringify(a) === JSON.stringify(b) && a.text === '你好 hello' && a.binary === false, JSON.stringify(a));
    const z = await AgentFS._readFileObj((await mkFile('x.zip', { size: 343 * MB }).getFile()), 'x.zip');
    t('_readFileObj：已知二进制扩展名零字节读取', z.binary === true && !stat.reads['x.zip'], '');
  }

  /* ===== 7. 静态契约：调用点与 Claude 式扁平行 ===== */
  {
    t('调用点把进度写进步骤详情（onProgress）', html.indexOf('await AgentMix.push({ onProgress:') >= 0 && html.indexOf('__pr.partial') >= 0, '');
    const i = html.indexOf('.think.collapsed .think-b{display:block;max-height:0;');
    const j = html.indexOf('/* —— 新消息浮起', i);
    const seg = html.slice(i, j);
    ['.tcr,.tcg{border:0;border-radius:0;background:none;overflow:visible}',
      '.tcr-bi{margin-left:8px;padding:0 0 0 14px;border-left:2px solid var(--border)}',
      '.tcr.is-run::after,.tcg.is-run>.tcg-h::after,.tcg .tcr.is-run::after{display:none}',
      '.tcr.is-wait,.tcr.is-err,.tcr.is-run,.tcg.is-run{border-color:transparent;background:none}',
      '.tcr-t .o{padding:0;border-radius:0;background:none;color:var(--text-3)}',
      '.tcg .tcr-bi{margin-left:0;border-left:0}',
      '.tcg-bi{margin-left:8px;padding:0 0 0 14px;border-left:2px solid var(--border)}',
      '.tcg .tcg>.tcg-b .tcg-bi{margin-left:0;border-left:0}'].forEach((k) => t('扁平行样式：' + k.slice(0, 48) + '…', seg.indexOf(k) >= 0, ''));
    t('扁平行样式：没有再给卡片描 1px 边 / 铺底色', !/border:1px|border-radius:1[0-9]px|background:var\(--surface\)/.test(seg), '');
    t('原卡片基础样式仍在（被扁平层覆盖，而不是被删）', html.indexOf('.tcr,.tcg{position:relative;min-width:0;border:1px solid var(--border);border-radius:12px;') >= 0, '');
  }

  const bad = results.filter((x) => !x).length;
  console.log('\n===== ' + (results.length - bad) + '/' + results.length + ' 通过 =====');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常：', e); process.exit(2); });
