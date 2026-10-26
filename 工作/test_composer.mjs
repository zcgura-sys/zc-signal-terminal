/* test_composer.mjs —— 主页输入框交互回归测试
 *
 * 覆盖 v2.27 的行为约定：
 *   · 回车（含 Shift + 回车）只插入换行，不发消息、不阻止默认行为
 *   · Ctrl / Cmd + Enter 才发送（并阻止换行）
 *   · 输入法选词中的回车（isComposing / keyCode 229）完全放行
 *   · 长按 Ctrl + Enter（e.repeat）不重复发送
 *   · 多行文本（输入 / 粘贴）原样保留，不再被折成空格
 *   · Chat.busy 时 Ctrl + Enter 只提示、不重复发送
 *
 * 做法：从前端页面抽出最大的内联 <script>，在 vm + 手写 DOM stub 里执行，
 * 只调用 Composer.init() 并派发事件，不跑 bootApp（避免无关初始化干扰）。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const all = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).sort((a, b) => b.length - a.length);
let app = all[0];
assert.ok(app && app.length > 1000, '未能抽出前端主脚本');

const EXPOSE = 'window.__T = { Composer, Chat, Toast };\n';
const tail = "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootApp); else bootApp();";
assert.ok(app.includes(tail), '启动锚点缺失：' + tail);
app = app.replace(tail, EXPOSE + tail);

/* ---------- 极简 DOM stub（带事件登记 / 派发） ---------- */
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    _on: Object.create(null),
    style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
    classList: { _s: new Set(), add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {}, children: [], childNodes: [],
    textContent: '', innerHTML: '', hidden: false, value: '', checked: false, type: '', placeholder: '',
    scrollHeight: 24, offsetHeight: 40, offsetWidth: 120, clientHeight: 24,
    selectionStart: 0, selectionEnd: 0, disabled: false,
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, replaceChildren() {}, remove() {}, insertBefore() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener(t, f) { (this._on[t] = this._on[t] || []).push(f); },
    removeEventListener() {},
    dispatch(t, ev) { (this._on[t] || []).forEach((f) => f(ev || {})); },
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    focus() {}, blur() {}, click() {}, closest() { return null; }, scrollIntoView() {},
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    getBoundingClientRect() { return { width: 120, height: 40, top: 0, left: 0, right: 120, bottom: 40 }; },
    animate() { return { cancel() {}, finished: Promise.resolve() }; },
    setPointerCapture() {}, releasePointerCapture() {}, getContext() { return null; }
  };
  return el;
}
const cache = new Map();
const q = (sel) => {
  if (!cache.has(sel)) cache.set(sel, makeEl(sel === '#input' ? 'textarea' : 'div'));
  return cache.get(sel);
};
const storage = {};
const localStorageStub = {
  getItem: (k) => (k in storage ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: (k) => { delete storage[k]; },
  clear: () => { for (const k in storage) delete storage[k]; },
  key: (i) => Object.keys(storage)[i] || null,
  get length() { return Object.keys(storage).length; }
};
const documentStub = {
  readyState: 'loading', addEventListener() {}, removeEventListener() {},
  querySelector: q, querySelectorAll: () => [],
  createElement: (t) => makeEl(t), createTextNode: () => ({}),
  documentElement: makeEl(), head: makeEl(), body: makeEl(),
  visibilityState: 'visible', hidden: false
};
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Symbol,
  AbortController, TextEncoder, TextDecoder, URL, URLSearchParams, structuredClone,
  fetch: () => Promise.reject(new Error('no net')),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  localStorage: localStorageStub, sessionStorage: localStorageStub,
  navigator: { userAgent: 'node', language: 'zh-CN', clipboard: {}, maxTouchPoints: 1 },
  location: { href: 'https://signal.example/', origin: 'https://signal.example', pathname: '/', search: '', hash: '' },
  document: documentStub, crypto: { subtle: {}, randomUUID: () => 'x' },
  requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  addEventListener() {}, removeEventListener() {}
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const ctx = vm.createContext(sandbox);
vm.runInContext(app, ctx, { filename: 'app.js' });
const T = sandbox.window.__T;
assert.ok(T && T.Composer, '未拿到 Composer');

/* ---------- 装配可观测的输入框 ---------- */
const ta = q('#input');
let autos = 0;
T.Composer.autosize = () => { autos++; };   // 只计次数，避免 stub 上的排版噪声
T.Composer.refresh = () => {};
let sent = 0;
let toasts = 0;
T.Chat.send = () => { sent++; };
T.Toast.info = () => { toasts++; };
T.Chat.busy = false;
T.Composer.init();

const key = (opts) => {
  const e = Object.assign({
    key: 'Enter', keyCode: 13, shiftKey: false, ctrlKey: false, metaKey: false,
    isComposing: false, repeat: false,
    defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; }
  }, opts || {});
  ta.dispatch('keydown', e);
  return e;
};

const results = [];
function check(name, fn) {
  try { const d = fn(); results.push(['PASS', name, d ? String(d) : '']); }
  catch (e) { results.push(['FAIL', name, e && e.message ? e.message : String(e)]); }
}

check('回车只换行、不发消息、不阻止默认行为', () => {
  sent = 0;
  const e = key({});
  assert.strictEqual(sent, 0, '回车把消息发出去了，sent=' + sent);
  assert.strictEqual(e.defaultPrevented, false, '回车被阻止了默认换行');
  return 'sent=0，换行交给浏览器';
});

check('Shift + 回车 同样是换行', () => {
  sent = 0;
  const e = key({ shiftKey: true });
  assert.strictEqual(sent, 0, 'Shift+Enter 发送了消息');
  assert.strictEqual(e.defaultPrevented, false, 'Shift+Enter 被阻止了换行');
  return 'ok';
});

check('Ctrl + Enter 发送并阻止换行', () => {
  sent = 0;
  const e = key({ ctrlKey: true });
  assert.strictEqual(sent, 1, 'Ctrl+Enter 没有发送，sent=' + sent);
  assert.strictEqual(e.defaultPrevented, true, 'Ctrl+Enter 没有阻止默认换行');
  return 'sent=1';
});

check('Cmd + Enter（macOS）同样发送', () => {
  sent = 0;
  const e = key({ metaKey: true });
  assert.strictEqual(sent, 1, 'Cmd+Enter 没有发送，sent=' + sent);
  assert.strictEqual(e.defaultPrevented, true, 'Cmd+Enter 没有阻止默认换行');
  return 'sent=1';
});

check('输入法选词中的回车不发送、不拦截', () => {
  sent = 0;
  const e1 = key({ isComposing: true });
  const e2 = key({ keyCode: 229, ctrlKey: true });
  assert.strictEqual(sent, 0, '选词中误发送了');
  assert.strictEqual(e1.defaultPrevented, false, 'isComposing 时不应 preventDefault');
  assert.strictEqual(e2.defaultPrevented, false, 'keyCode 229 时不应 preventDefault');
  return 'ok';
});

check('长按 Ctrl + Enter 只发送一次（忽略 repeat）', () => {
  sent = 0;
  key({ ctrlKey: true, repeat: true });
  assert.strictEqual(sent, 0, 'repeat 事件被当成一次发送');
  return 'ok';
});

check('其他按键不触发发送', () => {
  sent = 0;
  key({ key: 'a', keyCode: 65 });
  key({ key: ' ' });
  assert.strictEqual(sent, 0, '普通按键触发了发送');
  return 'ok';
});

check('生成中 Ctrl + Enter 只提示、不重复发送', () => {
  sent = 0; toasts = 0;
  T.Chat.busy = true;
  try {
    key({ ctrlKey: true });
    assert.strictEqual(sent, 0, '忙碌时仍然发送了');
    assert.ok(toasts >= 1, '忙碌时应给出提示');
  } finally { T.Chat.busy = false; }
  return 'toast=' + toasts;
});

check('多行粘贴原样保留（不再折成空格）', () => {
  ta.value = 'ab\n\ncd\r\ne';
  ta.selectionStart = 3; ta.selectionEnd = 3;
  autos = 0;
  ta.dispatch('input', {});
  assert.strictEqual(ta.value, 'ab\n\ncd\r\ne', '输入框内容被改写了：' + JSON.stringify(ta.value));
  assert.strictEqual(ta.selectionStart, 3, '光标位置被挪动了：' + ta.selectionStart);
  assert.ok(autos >= 1, 'input 后没有触发高度自适配');
  return JSON.stringify(ta.value);
});

check('回车插入的换行不会被改写', () => {
  ta.value = '第一行\n';
  ta.selectionStart = ta.value.length;
  ta.dispatch('input', {});
  assert.strictEqual(ta.value, '第一行\n', '换行被吃掉了：' + JSON.stringify(ta.value));
  return 'ok';
});

/* ---------- 静态约定（防回归） ---------- */
check('源码里不再有「回车直接发送 / 不换行」的实现与文案', () => {
  assert.ok(!/key === 'Enter' && !e\.shiftKey/.test(html), '仍存在旧的 !e.shiftKey 判断');
  assert.ok(html.indexOf('直接发送') < 0, '仍残留「回车直接发送」文案');
  assert.ok(html.indexOf('输入框不换行') < 0, '仍残留「输入框不换行」文案');
  assert.ok(html.indexOf('折成空格') < 0, '仍残留把多行折成空格的实现');
  return 'ok';
});

check('发送快捷键与输入框属性已就位', () => {
  assert.ok(/if \(!e\.ctrlKey && !e\.metaKey\) return;/.test(html), '缺少 Ctrl / Cmd 判断');
  assert.ok(/enterkeyhint="enter"/.test(html), 'enterkeyhint 未改为 enter（移动端回车仍是「发送」）');
  assert.ok(html.indexOf('Ctrl / ⌘ + Enter 发送') >= 0, '底部提示未更新为 Enter 换行 / Ctrl+Enter 发送');
  return 'ok';
});

let failed = 0;
for (const [st, name, extra] of results) {
  if (st === 'FAIL') failed++;
  console.log(st + ' | ' + name + (extra ? '  → ' + extra : ''));
}
console.log('\n===== ' + (results.length - failed) + '/' + results.length + ' 通过 =====');
process.exit(failed ? 1 : 0);
