/* test_ui_anim.mjs —— v2.26 动画体系 + Agent 修复点回归测试
 *
 * 两部分：
 *  A. 静态契约：CSS 关键帧 / 类别色 / 交错与落定 / reduced-motion 兜底 / 打字机 2.0
 *     必须在 public/index.html 里存在，且被 JS 真正使用（防止只写 CSS 没接线）。
 *  B. 行为：在 vm 沙箱里加载前端脚本，直接调用 Agent._canBatchSubtask 与
 *     Agent._runSubtaskBatch（stub 掉 SubAgent 执行），验证：
 *       · mode 大小写不再把 "Sequential" 当并行
 *       · 一批子任务的「执行轨迹」只附在第一个结果里（旧版每个结果都塞一份）
 *       · 批结束后 _currentSubId / _currentSubGoal 清空（旧版只写不清）
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

const EXPOSE = 'window.__T = (function () { try { return { Agent, SubAgent, Audit, ToolUI }; } catch (e) { return {}; } })();\n';
const tail = "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootApp); else bootApp();";
assert.ok(app.includes(tail), '启动锚点缺失');
app = app.replace(tail, EXPOSE + tail);

/* ---------- DOM stub（与 test_composer.mjs 同一套思路） ---------- */
function makeEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    _on: Object.create(null),
    style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
    nodeType: 1, className: '', isConnected: true,
    get firstChild() { return this.children[0]; }, get lastChild() { return this.children[this.children.length - 1]; },
    classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; if (on) this._s.add(c); else this._s.delete(c); return on; }, contains(c) { return this._s.has(c); } },
    dataset: {}, children: [], childNodes: [],
    textContent: '', innerHTML: '', hidden: false, value: '', disabled: false, placeholder: '',
    scrollHeight: 24, offsetHeight: 40, offsetWidth: 120, clientHeight: 24,
    appendChild(c) { this.children.push(c); return c; }, removeChild() {}, replaceChildren() {},
    remove() {}, insertBefore() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener(t, f) { (this._on[t] = this._on[t] || []).push(f); },
    removeEventListener() {}, dispatch(t, ev) { (this._on[t] || []).forEach((f) => f(ev || {})); },
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    focus() {}, blur() {}, click() {}, closest() { return null; }, scrollIntoView() {},
    setSelectionRange() {}, getBoundingClientRect() { return { width: 120, height: 40, top: 0, left: 0, right: 120, bottom: 40 }; },
    animate() { return { cancel() {}, finished: Promise.resolve() }; },
    setPointerCapture() {}, releasePointerCapture() {}, getContext() { return null; }
  };
}
const cache = new Map();
const q = (sel) => { if (!cache.has(sel)) cache.set(sel, makeEl(sel === '#input' ? 'textarea' : 'div')); return cache.get(sel); };
const store = {};
const lsStub = {
  getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }, clear: () => { for (const k in store) delete store[k]; },
  key: (i) => Object.keys(store)[i] || null, get length() { return Object.keys(store).length; }
};
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Symbol,
  AbortController, TextEncoder, TextDecoder, URL, URLSearchParams, structuredClone,
  fetch: () => Promise.reject(new Error('no net')),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  localStorage: lsStub, sessionStorage: lsStub,
  navigator: { userAgent: 'node', language: 'zh-CN', clipboard: {}, maxTouchPoints: 1 },
  location: { href: 'https://signal.example/', origin: 'https://signal.example', pathname: '/', search: '', hash: '' },
  document: {
    readyState: 'loading', addEventListener() {}, removeEventListener() {},
    querySelector: q, querySelectorAll: () => [], createElement: (t) => makeEl(t), createElementNS: (ns, t) => makeEl(t), createTextNode: (x) => ({ nodeType: 3, textContent: String(x) }),
    documentElement: makeEl(), head: makeEl(), body: makeEl(), visibilityState: 'visible', hidden: false
  },
  crypto: { subtle: {}, randomUUID: () => 'x' },
  requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  addEventListener() {}, removeEventListener() {}
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(app, ctx, { filename: 'app.js' });
const T = sandbox.window.__T;
assert.ok(T && T.Agent && T.SubAgent, '未拿到 Agent / SubAgent');

const results = [];
async function check(name, fn) {
  try { const d = await fn(); results.push(['PASS', name, d ? String(d) : '']); }
  catch (e) { results.push(['FAIL', name, e && e.message ? e.message : String(e)]); }
}

/* ================= A. 静态契约 ================= */
await check('工具行动画关键帧齐备（扫光 / 落定 / 弹簧 / 淡入 / 交错）', () => {
  ['tcSheen', 'tcSettle', 'tcSettleBad', 'tcTxt', 'tcBump', 'tcIn', 'agspin'].forEach((k) => {
    assert.ok(html.indexOf('@keyframes ' + k) >= 0, '缺少关键帧 ' + k);
  });
  return '7 个关键帧';
});

await check('类别色：5 档 CSS 变量 + JS 真的写 data-cat', () => {
  ['ex', 'wr', 'sh', 'pl', 'ot'].forEach((c) => {
    assert.ok(html.indexOf('data-cat="' + c + '"') >= 0, '缺少 data-cat="' + c + '" 规则');
  });
  assert.ok(/row\.dataset\.cat\s*=\s*this\.cat\(step\)/.test(html), 'JS 未把类别写到 row.dataset.cat（CSS 会变成死代码）');
  assert.ok(html.indexOf('--tca:var(--cl)') >= 0 && html.indexOf('color:var(--tca,var(--zg2))') >= 0,
    '信标（单色 / 回退色）没有吃到类别色');
  return 'ok';
});

await check('交错入场 / 落定收尾 / 计数 pop 都接在 JS 上', () => {
  assert.ok(/this\.stagger\(row\)/.test(html), 'stagger 未被调用');
  assert.ok(/classList\.add\('tc-in'\)/.test(html), '行入场未加 tc-in');
  assert.ok(/classList\.add\('just'\)/.test(html), '完成/失败未加 just 落定动画');
  assert.ok(/'tc-bump'/.test(html) && /'vt-in'/.test(html), '计数 pop / 文案替换动画未接线');
  return 'ok';
});

await check('reduced-motion 下扫光被关掉、动效时长归零', () => {
  const i = html.indexOf('@media (prefers-reduced-motion:reduce){\n  .zcm *,.tcr *,.tcg *');
  assert.ok(i >= 0, '缺少 reduced-motion 兜底块');
  const seg = html.slice(i, i + 400);
  assert.ok(seg.indexOf('.tcr.is-run::after,.tcg.is-run>.tcg-h::after{display:none}') >= 0, '减少动效时扫光仍在播');
  assert.ok(seg.indexOf('animation-duration:.01ms!important') >= 0, '减少动效时没有压缩时长');
  return 'ok';
});

await check('Claude 风格卡片 + ZC 信标：关键帧 / 样式 / 渐变定义都在，且被 JS 真正用到', () => {
  ['tcShimmer', 'agtPop', 'agtGPop', 'zcmA', 'zcmB', 'zcmC'].forEach((k) => {
    assert.ok(html.indexOf('@keyframes ' + k) >= 0, '缺少关键帧 ' + k);
    assert.ok(new RegExp('animation:' + k + '[ ;}]').test(html), '关键帧 ' + k + ' 没有任何规则在用（死代码）');
  });
  ['.tcr{', '.tcr,.tcg{', '.tcw{', '.tcn{', '.tcs-i', '.agt-i', '.agt-bar', '#agTabs .tb', '.zcm'].forEach((k) => assert.ok(html.indexOf(k) >= 0, '缺少样式 ' + k));
  assert.ok(/this\.mark\(\)/.test(html) && /ToolUI\.mark\(\)/.test(html), '信标没有被卡片 / 清单 / 思考指示器使用');
  assert.ok(html.indexOf('id="zcmG"') >= 0 && html.indexOf('--zg1:') >= 0 && html.indexOf('html[data-theme="dark"]{--cl:') >= 0, '渐变定义或深色取值缺失');
  assert.ok(!/ToolUI\.spark|this\.spark\(|tcSpark|--cl-spark/.test(html), '旧的 Claude 星芒不应残留');
  assert.ok(html.indexOf('Coding Agent') < 0 || !/<b id="agHeadName">Coding Agent/.test(html), '面板标题应为 ZC-Agent');
  return 'ok';
});

await check('ToolUI：「思考中」状态行启动 / 关闭、动词轮换文案、关闭后清理定时器', () => {
  const U = T.ToolUI;
  const h = { root: (() => { const r = document0(); return r; })() };
  function document0() { const n = sandbox.document.createElement('div'); n.isConnected = true; return n; }
  h.body = sandbox.document.createElement('div');
  U.work(h, true);
  assert.ok(h._tw && h._tw.el, '没有创建状态行');
  assert.ok(h.root.classList.contains('is-working'), '气泡上没有 is-working（会让「…」打字点和状态行同时出现）');
  const t = h._tw.el.children[1];
  assert.ok(U.VERBS.some((v) => t.textContent === v + '…'), '状态行文案不是轮换动词：' + t.textContent);
  U.work(h, true);                                  // 重复启动不叠加
  assert.strictEqual(h.root.children.length, 1, '重复启动产生了多个状态行');
  U.work(h, false);
  assert.strictEqual(h._tw, null); assert.ok(!h.root.classList.contains('is-working'));
  return t.textContent;
});

await check('ToolUI：待办卡片点击 = 打开右侧任务清单（不展开）；其它卡片没有这个行为', () => {
  const U = T.ToolUI;
  const todo = U.mkRow({ tool: 'todo_write', status: 'ok', args: {} });
  const read = U.mkRow({ tool: 'read_file', status: 'ok', args: {} });
  assert.ok(todo.classList.contains('tcr-link'), '待办卡片应带 tcr-link');
  assert.ok(!read.classList.contains('tcr-link'));
  assert.strictEqual(todo.dataset.tool, 'todo_write');
  // 待办卡片没有展开体：写 detail 也不会生成 body
  const st = { tool: 'todo_write', status: 'ok', args: { todos: new Array(2) }, detail: '1/2 已完成\n✓ a\n○ b', _row: todo };
  U.paintRow(st);
  assert.ok(todo.classList.contains('no-body'), '待办卡片不该展开清单（清单只放右侧面板）');
  return 'ok';
});

await check('ToolUI：子 Agent 轨迹被画成时间轴（✓ / ✗ / ▸ / ⤷ + 结论）', () => {
  const U = T.ToolUI;
  const box = U.subTimeline('步限额 20 · 已启动\n ✓ read_file：a.js\n ✗ read_file：b.js\n ⤷ 结论：只有一处\n▸ search_files "x"（执行中…）\n\n结论：\n最终结论正文');
  const cls = box.children.map((c) => c.className);
  assert.deepStrictEqual(cls, ['tcs-h', 'tcs-i ok', 'tcs-i err', 'tcs-i say', 'tcs-i run', 'tcs-res'], '时间轴结构不对：' + cls.join(' | '));
  assert.ok(box.children[5].textContent.indexOf('最终结论正文') === 0);
  return cls.length + ' 行';
});

await check('打字机 2.0：写出来 + 回退 + 光标收尾', () => {
  assert.ok(html.indexOf('@keyframes tywipe') >= 0 && html.indexOf('@supports ((-webkit-background-clip:text)') >= 0,
    '缺少「从左到右写出来」的 background-clip 实现 / 回退分支');
  assert.ok(html.indexOf('.ty-cur::after') >= 0 && html.indexOf('.ty-cur.off::after') >= 0, '光标结构缺失');
  assert.ok(html.indexOf('@keyframes tyoff') >= 0, '光标没有收尾动画');
  return 'ok';
});

await check('打字机按北京时间分 6 个时段换词：每段多句且各不相同、一轮内不重复、与设备时区无关', () => {
  const m = html.match(/const HeroType = \{[\s\S]*?\n  setText\(t\)/);
  assert.ok(m, '找不到 HeroType');
  const H = new Function(m[0].replace(/\n  setText\(t\)$/, '\n}').replace('const HeroType =', 'return'))();
  const names = ['凌晨', '早上', '上午', '中午', '下午', '晚上'];
  assert.deepEqual(Object.keys(H.WORDS), names, '时段不是 凌晨/早上/上午/中午/下午/晚上');
  const all = new Set();
  names.forEach((k) => {
    const L = H.WORDS[k];
    assert.ok(L.length >= 6, k + ' 的词句太少（' + L.length + '）');
    assert.equal(new Set(L).size, L.length, k + ' 里有重复词句');
    L.forEach((t) => { assert.ok(!all.has(t), '跨时段重复：' + t); all.add(t); });
  });
  const raw = Date.now;
  try {
    const want = { 0: '凌晨', 5: '凌晨', 6: '早上', 8: '早上', 9: '上午', 10: '上午', 11: '中午', 12: '中午', 13: '下午', 17: '下午', 18: '晚上', 23: '晚上' };
    for (const h in want) {
      Date.now = () => Date.UTC(2026, 9, 14, +h - 8, 30, 0);   // 北京时间 h:30（h<8 时落在前一天的 UTC）
      assert.equal(H.period(), want[h], '北京时间 ' + h + ':30 应为 ' + want[h]);
    }
    Date.now = () => Date.UTC(2026, 9, 14, 3, 0, 0);            // 北京 11:00 整 → 中午
    const seen = new Set();
    for (let i = 0; i < H.WORDS['中午'].length; i++) seen.add(H.pick());
    assert.equal(seen.size, H.WORDS['中午'].length, '一轮之内出现了重复');
    let prev = null;
    for (let i = 0; i < 200; i++) { const t = H.pick(); assert.notEqual(t, prev, '相邻两次抽到同一句'); prev = t; }
  } finally { Date.now = raw; }
  return 'ok';
});

await check('打字机：开场动画盖着页面（html.zc-pre）时不抢跑，幕布揭开后才开始写', () => {
  const m = html.match(/const HeroType = \{[\s\S]*?\n\};\n/); assert.ok(m, '找不到 HeroType');
  const src = m[0];
  assert.ok(src.indexOf("classList.contains('zc-pre')") >= 0 && src.indexOf('whenRevealed(') >= 0, '没有等待开场动画的逻辑');
  assert.ok(/stop\(\) \{[^\n]*this\.gate\.disconnect\(\)/.test(src), 'stop() 没有取消等待中的揭幕监听（重复触发会叠加）');
  assert.ok(/this\.whenRevealed\(\(lead\) =>/.test(src) && src.indexOf('setTimeout(step, lead)') >= 0, 'play() 没有经由 whenRevealed 开写');
  return 'ok';
});

await check('触摸反馈：按下缩放 + 触屏 hover 不残留', () => {
  assert.ok(/:active\{transform:scale\(\.93\)\}/.test(html), '缺少按下缩放反馈');
  assert.ok(html.indexOf('@media (hover:none)') >= 0, '缺少触屏 hover 抑制块');
  return 'ok';
});

/* ================= A2. 开场动画 / 转场（v2.28） ================= */
const introSrc = (() => {
  const m = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1]).filter((x) => x.indexOf("getElementById('zcIntro')") >= 0);
  assert.strictEqual(m.length, 1, '应恰有 1 段开场动画脚本，实际 ' + m.length);
  return m[0];
})();

await check('开场脚本语法可编译', () => { new vm.Script(introSrc, { filename: 'intro.js' }); return introSrc.length + ' 字节'; });

await check('转场关键帧齐备且全部被 html.zc-in / 登录切换规则真正使用', () => {
  ['zcFade', 'zcRise', 'zcDrop', 'zcSlide', 'zcPop', 'zcCard', 'zcLeave', 'zcAppIn'].forEach((k) => {
    assert.ok(html.indexOf('@keyframes ' + k) >= 0, '缺少关键帧 ' + k);
    assert.ok(new RegExp('animation:' + k + '[ ;}]').test(html), '关键帧 ' + k + ' 没有任何规则在用（死代码）');
  });
  return '8 个关键帧';
});

await check('入场动画一律 backwards 填充（播完不留残余样式 / 层叠上下文）', () => {
  const rules = html.match(/html\.zc-in [^{]+\{animation:[^}]+\}/g) || [];
  assert.ok(rules.length >= 15, '入场规则数量异常：' + rules.length);
  rules.forEach((r) => assert.ok(/backwards\}$/.test(r), '没有用 backwards 填充：' + r.slice(0, 70)));
  assert.ok(/body\.authed \.app\{animation:zcAppIn [^}]*backwards\}/.test(html), 'App 淡入没有用 backwards');
  return rules.length + ' 条';
});

await check('侧栏本身只淡入，不加 transform（移动端抽屉靠 transform 藏起来）', () => {
  const m = html.match(/html\.zc-in \.app>\.sidebar\{animation:([^}]+)\}/);
  assert.ok(m, '缺少侧栏入场规则');
  assert.ok(/^zcFade /.test(m[1]), '侧栏本身的入场必须是纯淡入：' + m[1]);
  assert.ok(html.indexOf('html.zc-in .sidebar>*{animation:zcSlide') >= 0, '侧栏子元素应负责位移入场');
  return 'ok';
});

await check('JS 的 LAND / XF 与 CSS 中真实标题的交叉淡入严格同步', () => {
  const j = introSrc.match(/LAND=([\d.]+),XF=([\d.]+)/);
  assert.ok(j, '找不到 LAND / XF 常量');
  const want = 'animation:zcFade ' + j[2] + 's ease-out ' + j[1] + 's backwards';
  assert.ok(html.indexOf('html.zc-in .auth-title{' + want + '}') >= 0, '登录标题的 CSS 延迟 / 时长与 JS 不一致，应为 ' + want);
  assert.ok(html.indexOf('html.zc-in .side-top .brand span{' + want + '}') >= 0, '侧栏品牌的 CSS 延迟 / 时长与 JS 不一致，应为 ' + want);
  return 'LAND=' + j[1] + ' XF=' + j[2];
});

await check('目标对齐：用 Range 量文字真实宽度 + 基线探针；就绪判定读真实页面状态', () => {
  assert.ok(introSrc.indexOf('createRange') >= 0 && introSrc.indexOf('selectNodeContents') >= 0, '没有用 Range 量文字宽度（块级容器宽度会让字标飞偏）');
  assert.ok(introSrc.indexOf('vertical-align:baseline') >= 0 && introSrc.indexOf('actualBoundingBoxAscent') >= 0, '缺少基线 / 大写字高对齐');
  assert.ok(/function ready\(\)\{[^}]*authScreen[^}]*authed/.test(introSrc), 'ready() 应同时读 authScreen 与 body.authed');
  assert.ok(introSrc.indexOf('(ready()||real>6.5)') >= 0, '转场应等就绪、并有 6.5 秒兜底');
  return 'ok';
});

await check('Auth.enter：登录卡片淡出（交叉溶解），首次进入走原路径', () => {
  assert.ok(/enter\(logged\)\s*\{[\s\S]{0,700}classList\.add\('leaving'\)/.test(html), 'enter() 没有接 leaving 淡出');
  assert.ok(/as\.hidden = true; as\.classList\.remove\('leaving'\)/.test(html), 'leaving 结束后没有真正隐藏');
  return 'ok';
});

/* 行为：在 vm 里用虚拟时钟真跑一遍开场脚本 */
function runIntro(o) {
  o = o || {};
  let now = 0, timers = [], rafs = [], tid = 1;
  const winL = {}, elL = {}, deC = new Set(), elC = new Set();
  const st = { removed: false, scrHidden: o.ready === false ? true : false, authed: false, loaded: o.loaded !== false };
  const ls = { v: o.seen != null ? String(o.seen) : null };
  const cnt = { fillRect: 0, iris: false };
  const ctx2d = new Proxy({ fillStyle: '#000', createRadialGradient() { return { addColorStop() {} }; }, createLinearGradient() { return { addColorStop() {} }; }, measureText() { return { actualBoundingBoxAscent: 10 }; } },
    { get(t, k) { if (k === 'fillRect') return function () { cnt.fillRect++; }; return k in t ? t[k] : function () {}; }, set(t, k, v) { if (k === 'globalCompositeOperation' && v === 'destination-out') cnt.iris = true; t[k] = v; return true; } });
  const cv = { width: 0, height: 0, style: {}, getContext: () => ctx2d };
  const el = { firstChild: cv, style: {}, parentNode: {}, classList: { add: (...c) => c.forEach((x) => elC.add(x)), remove: (...c) => c.forEach((x) => elC.delete(x)) },
    remove() { st.removed = true; this.parentNode = null; }, addEventListener(t, f) { (elL[t] = elL[t] || []).push(f); } };
  const de = { classList: { add: (...c) => c.forEach((x) => deC.add(x)), remove: (...c) => c.forEach((x) => deC.delete(x)) } };
  const scr = { get hidden() { return st.scrHidden; } };
  const sb = {
    Math, Object, Array, Date: { now: () => 1.7e12 + now }, parseInt, String, RegExp,
    innerWidth: o.w || 1280, innerHeight: o.h || 800, devicePixelRatio: 1,
    matchMedia: () => ({ matches: !!o.rm }),
    getComputedStyle: (n) => ({ color: 'rgb(24,24,27)', getPropertyValue: () => '' }),
    localStorage: { getItem: () => ls.v, setItem: (k, v) => { ls.v = v; } },
    location: { search: o.search || '' },
    document: {
      readyState: st.loaded ? 'complete' : 'loading', documentElement: de,
      body: { classList: { contains: (c) => c === 'authed' && st.authed } },
      getElementById: (id) => (id === 'zcIntro' ? el : id === 'authScreen' ? scr : null), querySelector: () => null,
      createElement: () => ({ style: {} }), createRange: () => ({})
    },
    addEventListener: (t, f) => { (winL[t] = winL[t] || []).push(f); },
    setTimeout: (f, ms) => { const id = tid++; timers.push({ id, at: now + (ms || 0), f }); return id; },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
    requestAnimationFrame: (f) => { const id = tid++; rafs.push({ id, f }); return id; },
    cancelAnimationFrame: (id) => { rafs = rafs.filter((r) => r.id !== id); }
  };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.runInContext(introSrc, vm.createContext(sb), { filename: 'intro.js' });
  const api = {
    deC, elC, st, cnt,
    step(ms) {
      const end = now + ms;
      while (now < end) {
        now += (o.dt || 16);
        timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at).forEach((t) => { if (timers.indexOf(t) >= 0) { timers = timers.filter((x) => x !== t); t.f(); } });
        const rs = rafs; rafs = []; rs.forEach((r) => r.f(now));
      }
    },
    /* 推进到某个条件成立，返回此刻（毫秒）；超时返回 -1 */
    until(fn, max) { const t0 = now; while (now - t0 < max) { api.step(16); if (fn()) return now; } return -1; },
    now: () => now, fire(t) { (winL[t] || []).forEach((f) => f({})); }, tap() { (elL.pointerdown || []).forEach((f) => f({})); }, move(x, y) { (elL.pointermove || []).forEach((f) => f({ clientX: x, clientY: y })); },
    seen: () => ls.v
  };
  return api;
}

await check('开场：隐身前景（zc-pre）→ 就绪后转场（zc-in）→ 幕布移除 → 类名清干净', () => {
  const a = runIntro({});
  assert.ok(a.deC.has('zc-pre'), '开场开始时应进入 zc-pre');
  const tIn = a.until(() => a.deC.has('zc-in'), 8000);
  assert.ok(tIn > 3000 && tIn < 5500, '完整版应在 3~5.5 秒开始转场，实际 ' + tIn);
  assert.ok(!a.deC.has('zc-pre'), '转场开始后必须撤掉 zc-pre');
  assert.ok(a.until(() => a.st.removed, 3000) > 0, '转场后应移除开场幕布');
  assert.ok(a.until(() => !a.deC.has('zc-in'), 4000) > 0, '入场编排结束后应清掉 zc-in');
  return '转场起点 ' + (tIn / 1000).toFixed(2) + 's';
});

await check('开场：目标页没就绪就不转场，就绪后才走（等待态）', () => {
  const a = runIntro({ ready: false });
  a.step(5800);
  assert.ok(a.deC.has('zc-pre') && !a.deC.has('zc-in') && !a.st.removed, '没就绪时不应转场：zc-in=' + a.deC.has('zc-in'));
  a.st.scrHidden = false;
  const t = a.until(() => a.deC.has('zc-in'), 1000);
  assert.ok(t > 0, '就绪后应立刻转场');
  return '就绪后 ' + (t - 5800) + 'ms 内起飞';
});

await check('开场：页面资源没加载完不转场，load 事件后才走', () => {
  const a = runIntro({ loaded: false });
  a.step(6000);
  assert.ok(!a.deC.has('zc-in'), 'load 前不应转场');
  a.fire('load');
  assert.ok(a.until(() => a.deC.has('zc-in'), 1000) > 0, 'load 后应转场');
  return 'ok';
});

await check('开场：永远等不到就绪时 6.5 秒后强行转场（不会卡死）', () => {
  const a = runIntro({ ready: false });
  const t = a.until(() => a.deC.has('zc-in'), 9000);
  assert.ok(t > 6400 && t < 7200, '兜底应在 6.5 秒左右触发，实际 ' + t);
  return (t / 1000).toFixed(2) + 's';
});

await check('开场：回访（12 小时内）1.5 倍速，?intro=full 强制完整版，过期恢复完整版', () => {
  const full = runIntro({});
  const tFull = full.until(() => full.deC.has('zc-in'), 8000);
  const quick = runIntro({ seen: 1.7e12 - 3600e3 });
  const tQuick = quick.until(() => quick.deC.has('zc-in'), 8000);
  assert.ok(tQuick > 0 && tQuick < tFull * 0.75, '回访应明显更快：quick=' + tQuick + ' full=' + tFull);
  const forced = runIntro({ seen: 1.7e12 - 3600e3, search: '?intro=full' });
  const tForced = forced.until(() => forced.deC.has('zc-in'), 8000);
  assert.ok(Math.abs(tForced - tFull) < 40, '?intro=full 应回到完整版：' + tForced + ' vs ' + tFull);
  const old = runIntro({ seen: 1.7e12 - 13 * 3600e3 });
  const tOld = old.until(() => old.deC.has('zc-in'), 8000);
  assert.ok(Math.abs(tOld - tFull) < 40, '超过 12 小时应恢复完整版：' + tOld);
  assert.ok(full.seen() && Number(full.seen()) > 1.7e12, '转场开始时应记下「看过了」');
  return 'full ' + tFull + 'ms / quick ' + tQuick + 'ms';
});

await check('开场：点击任意处立即跳过（淡出幕布 + 页面照常入场）', () => {
  const a = runIntro({});
  a.step(1200);
  a.tap();
  a.step(40);
  assert.ok(a.elC.has('out'), '跳过后幕布应进入淡出');
  assert.ok(a.deC.has('zc-in') && !a.deC.has('zc-pre'), '跳过后页面应正常入场');
  assert.ok(a.until(() => a.st.removed, 1500) > 0, '幕布应被移除');
  return 'ok';
});

await check('开场：减少动态偏好下不飞字标，就绪后直接淡出', () => {
  const a = runIntro({ rm: true });
  assert.ok(a.deC.has('zc-pre'));
  assert.ok(a.until(() => a.elC.has('out'), 3000) > 0, '减少动态时应在就绪后淡出幕布');
  assert.ok(!a.deC.has('zc-in') && !a.deC.has('zc-pre'), '减少动态时不应触发 zc-in，且必须撤掉 zc-pre');
  return 'ok';
});

await check('开场 v2.33「信号锁定」：镜头开光 / 点阵对齐与封顶 / 帧率自适应 / 指针交互 的接线都在', () => {
  ['function iris(', "'destination-out'", 'function rings(', 'function field(', 'function parts(', 'function fringe(', "addEventListener('pointermove'", 'hardwareConcurrency', 'COLS*ROWS<=3200', 'if(slow>10)q=0'].forEach((k) => assert.ok(introSrc.indexOf(k) >= 0, '开场脚本缺少 ' + k));
  assert.ok(/NR=Math\.max\(2,Math\.min\(6,Math\.round\(cap\/24\)\)\)/.test(introSrc) && introSrc.indexOf('GS=cap/NR') >= 0, '点阵格距必须由字高整除（字高占整数行，基线落在某一行上）');
  assert.ok(introSrc.indexOf('LY=yb-Math.ceil(yb/GS+1)*GS') >= 0, '点阵行必须以字标基线 yb 为基准');
  return 'ok';
});

await check('开场：转场阶段真的在幕布上挖「镜头」洞（destination-out），而且之前没有', () => {
  const a = runIntro({});
  a.step(1500);
  assert.ok(!a.cnt.iris, '转场前不该有镜头洞');
  assert.ok(a.until(() => a.deC.has('zc-in'), 8000) > 0, '应进入转场');
  a.step(120);
  assert.ok(a.cnt.iris, '转场开始后应在幕布上挖镜头洞');
  assert.ok(a.until(() => a.st.removed, 3000) > 0, '镜头开完后应移除幕布');
  return 'ok';
});

await check('开场：点阵数量封顶（4K 屏也不会每帧画几万个点），指针移动不影响时序', () => {
  const big = runIntro({ w: 3840, h: 2160 });
  big.step(2000); big.cnt.fillRect = 0; big.step(16);
  assert.ok(big.cnt.fillRect > 0 && big.cnt.fillRect <= 3300, '4K 屏每帧 fillRect 应 ≤ 3300，实际 ' + big.cnt.fillRect);
  const a = runIntro({});
  a.step(1400); a.move(500, 400); a.move(540, 430); a.step(300); a.move(900, 300);
  const t = a.until(() => a.deC.has('zc-in'), 8000);
  assert.ok(t > 3000 && t < 5500, '指针移动后转场时间应不变，实际 ' + t);
  return '4K ' + big.cnt.fillRect + ' 个点 / 帧';
});

await check('开场：持续掉帧（20fps）自动降级，点阵减半；正常帧率不降级', () => {
  const per = (o) => { const a = runIntro(o); a.step(2600); a.cnt.fillRect = 0; a.step(o.dt || 16); return a.cnt.fillRect; };
  const ok = per({}), slow = per({ dt: 50 });
  assert.ok(ok > 200, '正常帧率时点阵应完整绘制，实际 ' + ok);
  assert.ok(slow < ok * 0.7, '掉帧时应降级（点数 < 70%）：正常 ' + ok + ' / 掉帧 ' + slow);
  return '正常 ' + ok + ' → 掉帧 ' + slow;
});

/* ================= B. Agent 行为 ================= */
const A = T.Agent;
const call = (args) => ({ id: 'c1', name: 'delegate_subtask', args: args });

await check('_canBatchSubtask：Sequential / SEQUENTIAL 不再被当并行', () => {
  assert.strictEqual(A._canBatchSubtask(call({ goal: 'x', mode: 'sequential' })), false, '小写 sequential 判定错');
  assert.strictEqual(A._canBatchSubtask(call({ goal: 'x', mode: 'Sequential' })), false, '「Sequential」被当成并行了');
  assert.strictEqual(A._canBatchSubtask(call({ goal: 'x', mode: 'SEQUENTIAL' })), false, '「SEQUENTIAL」被当成并行了');
  assert.strictEqual(A._canBatchSubtask(call({ goal: 'x', mode: 'Parallel' })), true, '「Parallel」应可批量');
  assert.strictEqual(A._canBatchSubtask(call({ goal: 'x' })), true, '未指定 mode 应可批量');
  assert.strictEqual(A._canBatchSubtask(call({ goals: ['a', 'b'] })), true, 'goals 数组应可批量');
  assert.strictEqual(A._canBatchSubtask(call({ __parse_error__: true })), false, '参数解析失败的调用不应批量');
  assert.strictEqual(A._canBatchSubtask(call({ goals: [] })), false, '空 goals 不应批量');
  return '8 项';
});

await check('一批子任务的执行轨迹只附一次（旧版每份结果都塞一遍）', async () => {
  const captured = {};
  const realParallel = T.SubAgent.runParallel;
  const realFlush = T.SubAgent.flushCache;
  const realLog = T.Audit.log;
  try {
    T.SubAgent.runParallel = async (subs, snap, opts) => {
      captured.n = subs.length; captured.limit = opts && opts.limit;
      return subs.map((s, i) => ({ goal: s.goal, status: 'done', result: 'R' + i }));
    };
    T.SubAgent.flushCache = () => 'TRACE-BODY';
    T.SubAgent.runSequential = async () => { throw new Error('不该走串行'); };
    T.Audit.log = () => {};
    A.snapshot = { t: 1 };
    A.taskId = 'task-1';
    A._subAgentQuiet = false;
    A._currentSubId = 'stale'; A._currentSubGoal = 'stale';

    const out = await A._runSubtaskBatch([
      { id: 'a', args: { goal: 'G1', max_parallel: 3 } },
      { id: 'b', args: { goal: 'G2', mode: 'Parallel', max_parallel: 2 } }
    ]);
    assert.strictEqual(out.length, 2, '返回条数应与输入调用数一致');
    const joined = out.map((o) => o.text).join('\n@@\n');
    const times = joined.split('--- 执行轨迹 ---').length - 1;
    assert.strictEqual(times, 1, '轨迹出现了 ' + times + ' 次，应只出现 1 次');
    assert.ok(out[0].text.indexOf('TRACE-BODY') >= 0, '第一条结果应带轨迹');
    assert.ok(out[1].text.indexOf('TRACE-BODY') < 0, '第二条结果不该再带同一份轨迹');
    assert.strictEqual(captured.n, 2, '并行子任务数不对：' + captured.n);
    assert.strictEqual(captured.limit, 3, '并发数未取批内最大值：' + captured.limit);
    assert.strictEqual(A._currentSubId, '', '批结束后 _currentSubId 未清空');
    assert.strictEqual(A._currentSubGoal, '', '批结束后 _currentSubGoal 未清空');
    return '轨迹 1 份 / limit=3 / 标记已清';
  } finally {
    T.SubAgent.runParallel = realParallel; T.SubAgent.flushCache = realFlush; T.Audit.log = realLog;
  }
});

await check('缺少 goal 的调用被挡在派发之前', async () => {
  A.snapshot = { t: 1 };
  const out = await A._runSubtaskBatch([{ id: 'z', args: {} }]);
  assert.strictEqual(out.length, 1);
  assert.ok(/明确目标/.test(out[0].text), '未给出提示文本：' + out[0].text);
  return out[0].text.slice(0, 20);
});

let failed = 0;
for (const [st, name, extra] of results) {
  if (st === 'FAIL') failed++;
  console.log(st + ' | ' + name + (extra ? '  → ' + extra : ''));
}
await check('v2.30.2 动画细节：思考块扁平 + 平滑展开、清单划线动画、状态行间距、页签滑动下划线、改名', () => {
  assert.ok(/\.think\{margin:0 0 8px;border:0;border-radius:0;background:none/.test(html), '思考块没有改成扁平样式');
  assert.ok(/\.think\.collapsed \.think-b\{display:block;max-height:0;opacity:0/.test(html), '思考块收起不是平滑过渡（还在 display:none）');
  assert.ok(/\.agt-s\{background:linear-gradient/.test(html) && /\.agt-i\.completed \.agt-s\{background-size:100% 1px\}/.test(html), '清单划线动画缺失');
  assert.ok(/class: 'agt-s'/.test(html), '清单文字没有放进 .agt-s 内层 span');
  assert.ok(/\.tct:has\(\+ \.tcw\)\{margin-bottom:2px\}/.test(html) && /\.body\.md:has\(>\.typing:only-child\)\{display:none\}/.test(html), '状态行与卡片之间的间距没收紧');
  assert.ok(/_tabInk\(\)\s*\{/.test(html) && /\.ag-tabs\.ink::after/.test(html), '页签滑动下划线缺失');
  assert.ok(!/agent-turn \+ \.agent-turn\{[^}]*dashed/.test(html), '回合之间不应再有虚线分隔');
  assert.ok(/<b id="agHeadName">ZC-Agent<\/b>/.test(html) && /'ZC-Agent · ' \+ nm/.test(html), '面板标题没有改成 ZC-Agent');
  assert.ok(!/Coding Agent/.test(html), '页面里还残留「Coding Agent」');
  return 'ok';
});

console.log('\n===== ' + (results.length - failed) + '/' + results.length + ' 通过 =====');
process.exit(failed ? 1 : 0);
