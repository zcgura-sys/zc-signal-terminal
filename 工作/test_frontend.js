const fs = require('fs');
const assert = require('assert');
const vm = require('vm');

// ---- 取出前端主脚本，并在结尾暴露内部对象（仅测试用，不改源文件）----
let app;
if (fs.existsSync('/tmp/app.js') && process.env.USE_TMP_APP) app = fs.readFileSync('/tmp/app.js', 'utf8');
else {
  // 自动从前端页面里抽出最大的内联 <script>（v2.23.1：不再需要手工准备 /tmp/app.js）
  const html = fs.readFileSync(require('path').join(__dirname, 'public', 'index.html'), 'utf8');
  const all = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length);
  app = all[0];
}
const EXPOSE = 'window.__T = { AgentCompressor, AgentTodos, Agent, AgentPlan, AgentTools, Api, Net, Format, Settings, Store, AgentSnapshot, SystemPromptBuilder, AgentFormat };\n';
const tail = 'if (document.readyState === \'loading\') document.addEventListener(\'DOMContentLoaded\', bootApp); else bootApp();';
assert.ok(app.includes(tail), 'tail anchor missing');
app = app.replace(tail, EXPOSE + tail);

function stubEl() {
  return {
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [], childNodes: [], textContent: '', innerHTML: '', hidden: false, value: '', checked: false, type: '',
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, querySelector() { return stubEl(); },
    querySelectorAll() { return []; }, focus() {}, click() {}, closest() { return null; },
    insertBefore() {}, replaceChildren() {}, scrollIntoView() {}
  };
}
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }, clear: () => { for (const k in store) delete store[k]; }
};
const documentStub = {
  readyState: 'loading', addEventListener() {}, removeEventListener() {},
  querySelector() { return stubEl(); }, querySelectorAll() { return []; },
  createElement() { return stubEl(); }, createTextNode() { return {}; },
  documentElement: stubEl(), head: stubEl(), body: stubEl(), visibilityState: 'visible', hidden: false
};
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Symbol, AbortController, TextEncoder, TextDecoder, URL, URLSearchParams,
  fetch: () => Promise.reject(new Error('no net')),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  localStorage, sessionStorage: localStorage, navigator: { userAgent: 'node', language: 'zh-CN', clipboard: {} },
  location: { href: 'https://signal.example/', origin: 'https://signal.example', pathname: '/', search: '', hash: '' },
  document: documentStub, crypto: { subtle: {}, randomUUID: () => 'x' },
  requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }), addEventListener() {}, removeEventListener() {}
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;

const ctx = vm.createContext(sandbox);
vm.runInContext(app, ctx, { filename: 'app.js' });
const T = sandbox.window.__T;
assert.ok(T, 'expose failed');

// 跨 realm 安全比较（避免 deepStrictEqual 的 prototype 校验）
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const results = [];
async function check(name, fn) {
  try { const d = await fn(); results.push(['PASS', name, d ? String(d) : '']); }
  catch (e) { results.push(['FAIL', name, e && e.message ? e.message : String(e)]); }
}

(async () => {
  // ===== 1. TodoWrite =====
  await check('todo_write 工具已注册', () => {
    const def = T.AgentTools.find('todo_write');
    assert.ok(def, 'tool not found');
    assert.ok(def.parameters.properties.todos, 'no todos param');
    assert.ok(eq(def.parameters.required, ['todos']), 'required mismatch: ' + JSON.stringify(def.parameters.required));
    return 'ok';
  });
  await check('工具清单包含 todo_write', () => {
    const names = T.AgentTools.LIST.map((t) => t.name);
    assert.ok(names.indexOf('todo_write') >= 0, 'missing');
    return names.length + ' 个工具';
  });

  // ===== 2. 模型生成 Plan =====
  await check('_parsePlanJson：纯 JSON', () => {
    const r = T.AgentPlan._parsePlanJson('{"phases":[{"title":"A","description":"d1"},{"title":"B"}]}');
    assert.strictEqual(r.phases.length, 2);
    assert.strictEqual(r.phases[0].title, 'A');
    assert.strictEqual(r.phases[0].status, 'pending');
    assert.ok(eq(r.phases.map((p) => p.id), ['p1', 'p2']), 'ids: ' + r.phases.map((p) => p.id).join(','));
    return '2 phases';
  });
  await check('_parsePlanJson：代码块包裹 + 前后文字', () => {
    const r = T.AgentPlan._parsePlanJson('好的，这是我的计划：\n' + '\u0060\u0060\u0060json\n{"phases":[{"title":"X"}]}\n\u0060\u0060\u0060' + '\n以上。');
    assert.strictEqual(r.phases[0].title, 'X');
    return 'X';
  });
  await check('_parsePlanJson：别名 plan/steps', () => {
    assert.strictEqual(T.AgentPlan._parsePlanJson('前言 {"plan":[{"name":"P"}]} 后语').phases[0].title, 'P');
    assert.strictEqual(T.AgentPlan._parsePlanJson('<json>{"steps":[{"phase":"S"}]}</json>').phases[0].title, 'S');
    return 'ok';
  });
  await check('_parsePlanJson：非法输入抛错', () => {
    assert.throws(() => T.AgentPlan._parsePlanJson('完全不是 JSON'), /不是合法 JSON/);
    assert.throws(() => T.AgentPlan._parsePlanJson('{"phases":[]}'), /phases 为空/);
    return 'ok';
  });
  await check('_parsePlanJson：阶段上限 8', () => {
    const many = { phases: Array.from({ length: 20 }, (_, i) => ({ title: 'T' + i })) };
    assert.strictEqual(T.AgentPlan._parsePlanJson(JSON.stringify(many)).phases.length, 8);
    return 'capped';
  });
  await check('_inferPhases 关键词回退仍可用', () => {
    const p = T.AgentPlan._inferPhases('帮我重构这个模块', {});
    assert.ok(p.length >= 3);
    return p.map((x) => x.id).join(',');
  });
  await check('generate：无 API 时回退关键词推断', async () => {
    T.Api.list = []; T.Api.idx = 0;
    const plan = await T.AgentPlan.generate('修复登录报错', {});
    assert.strictEqual(plan.source, 'heuristic');
    assert.ok(plan.phases.length >= 3);
    assert.strictEqual(plan.phases[0].status, 'running');
    assert.ok(plan.modelError, 'modelError 应记录');
    return 'source=' + plan.source + ' phases=' + plan.phases.length;
  });
  await check('generate：模型可用时用模型计划', async () => {
    T.Api.list = [{ id: 'a1', url: 'https://api.example/v1/chat/completions', key: 'k', model: 'gpt-4o', format: 'openai', route: 'auto' }];
    T.Api.idx = 0;
    const orig = T.Net.call;
    T.Net.call = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"phases":[{"title":"读代码","description":"先看结构"},{"title":"改代码"},{"title":"跑测试"}]}' } }] }), text: async () => '' });
    try {
      const plan = await T.AgentPlan.generate('给登录加验证码', { projectContexts: [] });
      assert.strictEqual(plan.source, 'model');
      assert.strictEqual(plan.phases.length, 3);
      assert.strictEqual(plan.phases[0].title, '读代码');
      assert.strictEqual(plan.phases[0].status, 'running');
      return plan.phases.map((p) => p.title).join(' / ');
    } finally { T.Net.call = orig; }
  });
  await check('generate：模型返回垃圾时回退', async () => {
    const orig = T.Net.call;
    T.Net.call = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '我建议先看代码。' } }] }), text: async () => '' });
    try {
      const plan = await T.AgentPlan.generate('实现导出功能', {});
      assert.strictEqual(plan.source, 'heuristic');
      return 'fallback（' + String(plan.modelError).slice(0, 24) + '）';
    } finally { T.Net.call = orig; }
  });
  await check('buildProgressSummary 标注来源', () => {
    const s = T.AgentPlan.buildProgressSummary({ source: 'model', phases: [{ id: 'a', title: 'A', status: 'done', result: 'r' }, { id: 'b', title: 'B', status: 'running' }] });
    assert.ok(s.indexOf('模型生成') >= 0, 'no label');
    return 'ok';
  });

  // ===== 3. 上下文压缩 =====
  await check('need：未达阈值不触发', () => {
    T.Settings.d.autoCompact = true; T.Settings.d.compactThreshold = 70;
    assert.strictEqual(T.AgentCompressor.need([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }]), null);
    return 'ok';
  });
  await check('need：超阈值触发', () => {
    T.Api.list = [{ id: 'a1', url: 'u', key: 'k', model: 'gpt-4', format: 'openai', route: 'auto' }]; T.Api.idx = 0;
    const lim = T.AgentCompressor.thresholdChars();
    const big = 'x'.repeat(Math.ceil(lim / 10) + 1000);
    const h = [];
    for (let i = 0; i < 10; i++) h.push({ role: i % 2 ? 'assistant' : 'user', content: big });
    const r = T.AgentCompressor.need(h);
    assert.ok(r, 'should need compaction');
    return 'limit=' + r.limit + ' est=' + r.est;
  });
  await check('need：关闭开关不触发', () => {
    T.Settings.d.autoCompact = false;
    const lim = T.AgentCompressor.thresholdChars();
    const h = [];
    for (let i = 0; i < 10; i++) h.push({ role: i % 2 ? 'assistant' : 'user', content: 'y'.repeat(Math.ceil(lim / 10) + 1000) });
    const r = T.AgentCompressor.need(h);
    T.Settings.d.autoCompact = true;
    assert.strictEqual(r, null);
    return 'ok';
  });
  await check('contextLimit 按模型区分', () => {
    T.Api.list = [{ id: 'a', url: 'u', model: 'gemini-2.0-flash', format: 'gemini', route: 'auto' }]; T.Api.idx = 0;
    const g = T.AgentCompressor.contextLimit();
    T.Api.list[0].model = 'claude-sonnet-4'; const c = T.AgentCompressor.contextLimit();
    T.Api.list[0].model = 'gpt-4o-mini'; const m = T.AgentCompressor.contextLimit();
    assert.ok(g > c && c > m, g + '/' + c + '/' + m);
    return 'gemini=' + g + ' claude=' + c + ' mini=' + m;
  });
  await check('compactHistory：模型摘要路径', async () => {
    const hist = [];
    for (let i = 0; i < 20; i++) hist.push({ role: i % 3 === 0 ? 'user' : 'assistant', content: 'msg' + i, text: 'msg' + i, toolCalls: i % 3 === 1 ? [{ name: 'read_file', args: { path: 'a' + i + '.js' } }] : [] });
    hist[13] = { role: 'user', content: 'boundary' };
    const orig = T.AgentCompressor.ask;
    T.AgentCompressor.ask = async () => '## 任务目标\n测试';
    try {
      const r = await T.AgentCompressor.compactHistory(hist, T.Api.current(), null);
      assert.ok(r.did, 'not compacted');
      assert.strictEqual(r.fallback, false);
      assert.ok(hist[0].__compacted, 'no marker');
      assert.ok(String(hist[0].content).indexOf('历史已压缩') >= 0);
      assert.strictEqual(hist.length, r.kept + 1);
      return '移除 ' + r.removed + ' 条，保留 ' + r.kept + ' 条';
    } finally { T.AgentCompressor.ask = orig; }
  });
  await check('compactHistory：模型失败 → 结构化兜底', async () => {
    const hist = [];
    for (let i = 0; i < 12; i++) hist.push({ role: i % 2 ? 'assistant' : 'user', content: 'a' + i, text: 'a' + i, toolCalls: [{ name: 'create_file', args: { path: 'f' + i + '.js' } }, { name: 'run_command', args: { command: 'npm test' } }] });
    const orig = T.AgentCompressor.ask;
    T.AgentCompressor.ask = async () => { throw new Error('HTTP 500'); };
    try {
      const r = await T.AgentCompressor.compactHistory(hist, T.Api.current(), null);
      assert.ok(r.did && r.fallback === true, 'fallback 未生效');
      assert.ok(String(hist[0].content).indexOf('结构化截断') >= 0);
      assert.ok(String(hist[0].content).indexOf('npm test') >= 0, '命令丢失');
      return 'fallback ok（' + r.chars + ' 字符）';
    } finally { T.AgentCompressor.ask = orig; }
  });
  await check('compactSnapshot：压缩快照记录', async () => {
    const snap = T.AgentSnapshot.init('t1', '测试任务');
    for (let i = 0; i < 25; i++) {
      snap.context.commandOutputs.push({ command: 'cmd' + i, exitCode: i % 2, output: 'out'.repeat(50), timestamp: Date.now() });
      snap.context.toolCalls.push({ name: 'run_command', args: '{"command":"cmd' + i + '"}', result: 'ok', timestamp: Date.now() });
    }
    snap.context.filesWritten['src/a.js'] = { operation: 'create' };
    const orig = T.AgentCompressor.ask;
    T.AgentCompressor.ask = async () => '## 已完成的工作\n写了 a.js';
    try {
      const r = await T.AgentCompressor.compactSnapshot(snap, T.Api.current(), null);
      assert.ok(r.did, 'not compacted');
      assert.strictEqual(r.keptCmds, 8);
      assert.strictEqual(r.keptCalls, 16);
      assert.ok(snap.context.summary.indexOf('a.js') >= 0);
      return '命令 ' + r.cmds + '→' + r.keptCmds + '，调用 ' + r.calls + '→' + r.keptCalls;
    } finally { T.AgentCompressor.ask = orig; }
  });
  await check('compactSnapshot：记录太少时不动', async () => {
    const snap = T.AgentSnapshot.init('t2', 'x');
    snap.context.toolCalls.push({ name: 'read_file', args: '{}', result: '', timestamp: 1 });
    const r = await T.AgentCompressor.compactSnapshot(snap, T.Api.current(), null);
    assert.strictEqual(r.did, false);
    return r.reason;
  });

  // ===== 4. 续接提示词 =====
  await check('buildResumePrompt 注入压缩摘要（清单改由 SystemPromptBuilder 统一注入）', () => {
    const snap = T.AgentSnapshot.init('t3', '目标');
    snap.totalSteps = 5;
    snap.todos = [{ content: '第一步', status: 'completed' }, { content: '第二步', status: 'in_progress' }];
    snap.context.summary = '这是压缩摘要';
    const p = T.AgentSnapshot.buildResumePrompt(snap);
    assert.ok(p.indexOf('这是压缩摘要') >= 0, 'summary missing');
    // v2.23.2：清单不再在这里注入（避免与 SystemPromptBuilder 的段落重复）
    assert.ok(p.indexOf('[x] 第一步') < 0, 'todos 不应在 buildResumePrompt 里重复注入');
    return 'ok';
  });
  await check('SystemPromptBuilder 注入清单', () => {
    const snap = T.AgentSnapshot.init('t4', 'g');
    snap.todos = [{ content: '待办A', status: 'pending' }];
    const p = T.SystemPromptBuilder.build({ mode: 'main', snapshot: snap, projectContexts: [], plan: null });
    assert.ok(p.indexOf('待办A') >= 0, 'todo 未注入');
    assert.ok(p.indexOf('todo_write') >= 0, '缺 todo_write 指令');
    return 'ok';
  });
  await check('snapshot.init 带 todos 字段', () => {
    const s = T.AgentSnapshot.init('t5', 'g');
    assert.ok(Array.isArray(s.todos) && s.todos.length === 0, 'todos 字段缺失');
    return 'ok';
  });

  // ===== 4. v2.23.1：压缩切分修复 / 微压缩 / 清单增强 =====
  // 真实 Agent.run 的历史形态：只有第 0 条是 user，其余全是 assistant / tool
  const mkAgentHist = (n, toolSize) => {
    const h = [{ role: 'user', text: '任务：重构 _worker.js', content: '任务：重构 _worker.js' }];
    for (let i = 0; i < n; i++) {
      h.push({ role: 'assistant', text: '读取文件 ' + i, toolCalls: [{ id: 'c' + i, name: 'read_file', args: { path: 'src/f' + i + '.js' } }] });
      h.push({ role: 'tool', toolCallId: 'c' + i, name: 'read_file', text: 'x'.repeat(toolSize) });
    }
    return h;
  };
  const withModel = (model) => { T.Api.list = [{ id: 'z', url: 'u', key: 'k', model: model, format: 'openai', route: 'auto' }]; T.Api.idx = 0; T.Settings.d.autoCompact = true; T.Settings.d.compactThreshold = 70; T.Settings.d.ctxWindow = 0; };

  await check('【回归】agent 历史形态下压缩真的会变小（旧版每次只压第 0 条、体积不变）', async () => {
    withModel('gpt-4');
    const hist = mkAgentHist(60, 8000);
    const before = T.AgentCompressor.estimate(hist);
    const orig = T.AgentCompressor.ask; T.AgentCompressor.ask = async () => '## 任务目标\n摘要';
    try {
      const r = await T.AgentCompressor.compactHistory(hist, T.Api.current(), null);
      const after = T.AgentCompressor.estimate(hist);
      assert.ok(r.did && r.removed > 20, 'removed=' + r.removed);
      assert.ok(after < before * 0.5, 'before=' + before + ' after=' + after);
      return 'removed=' + r.removed + ' est ' + before + ' → ' + after;
    } finally { T.AgentCompressor.ask = orig; }
  });
  await check('压缩保留用户原始任务原文 + 摘要附在同一条 user 消息里', async () => {
    withModel('gpt-4');
    const hist = mkAgentHist(40, 6000);
    const orig = T.AgentCompressor.ask; T.AgentCompressor.ask = async () => '## 已完成的工作\n读了很多文件';
    try {
      await T.AgentCompressor.compactHistory(hist, T.Api.current(), null);
      assert.ok(String(hist[0].content).indexOf('任务：重构 _worker.js') === 0, '原始任务丢失');
      assert.ok(String(hist[0].content).indexOf('历史已压缩') > 0 && String(hist[0].content).indexOf('读了很多文件') > 0);
      assert.strictEqual(hist.filter((m) => m.role === 'user').length, 1, '不应出现连续 user 消息');
      return 'ok';
    } finally { T.AgentCompressor.ask = orig; }
  });
  await check('压缩后尾部从 assistant 起头，tool_call 与 tool_result 不被拆开', async () => {
    withModel('gpt-4');
    const hist = mkAgentHist(50, 5000);
    const orig = T.AgentCompressor.ask; T.AgentCompressor.ask = async () => '摘要';
    try {
      await T.AgentCompressor.compactHistory(hist, T.Api.current(), null);
      assert.strictEqual(hist[1].role, 'assistant', '尾部应从 assistant 开始，实际 ' + hist[1].role);
      const ids = new Set(); hist.forEach((m) => (m.toolCalls || []).forEach((c) => ids.add(c.id)));
      hist.filter((m) => m.role === 'tool').forEach((m) => assert.ok(ids.has(m.toolCallId), '孤立的 tool_result ' + m.toolCallId));
      return 'ok';
    } finally { T.AgentCompressor.ask = orig; }
  });
  await check('多模态首条消息（图片 / 文件）压缩后附件保留', async () => {
    withModel('gpt-4');
    const hist = mkAgentHist(40, 5000);
    hist[0] = { role: 'user', text: '看图改代码', content: [{ type: 'text', text: '看图改代码' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] };
    const orig = T.AgentCompressor.ask; T.AgentCompressor.ask = async () => '摘要';
    try {
      await T.AgentCompressor.compactHistory(hist, T.Api.current(), null);
      assert.ok(Array.isArray(hist[0].content) && hist[0].content.some((p) => p.type === 'image_url'), '图片丢失');
      const s = T.Format.split(hist[0].content);
      assert.ok(s.text.indexOf('看图改代码') >= 0 && s.text.indexOf('历史已压缩') >= 0 && s.images.length === 1);
      return 'ok';
    } finally { T.AgentCompressor.ask = orig; }
  });
  await check('二次压缩：合并上一份摘要，不叠加、不丢任务', async () => {
    withModel('gpt-4');
    const hist = mkAgentHist(40, 5000);
    let seenPrompt = '';
    const orig = T.AgentCompressor.ask; T.AgentCompressor.ask = async (p) => { seenPrompt = p; return '摘要V' + (T.AgentCompressor.__n = (T.AgentCompressor.__n || 0) + 1); };
    try {
      await T.AgentCompressor.compactHistory(hist, T.Api.current(), null);
      for (let i = 0; i < 40; i++) { hist.push({ role: 'assistant', text: 'more ' + i, toolCalls: [{ id: 'm' + i, name: 'read_file', args: { path: 'm' + i } }] }); hist.push({ role: 'tool', toolCallId: 'm' + i, name: 'read_file', text: 'y'.repeat(5000) }); }
      await T.AgentCompressor.compactHistory(hist, T.Api.current(), null);
      assert.ok(seenPrompt.indexOf('【此前的摘要】') >= 0 && seenPrompt.indexOf('摘要V1') >= 0, '没有带上上一份摘要');
      const c = String(hist[0].content);
      assert.ok(c.indexOf('摘要V2') > 0 && c.indexOf('摘要V1') < 0, '摘要应被替换而不是叠加');
      assert.ok(c.indexOf('任务：重构 _worker.js') === 0);
      return 'ok';
    } finally { T.AgentCompressor.ask = orig; delete T.AgentCompressor.__n; }
  });
  await check('压缩摘要里带上当前任务清单（压缩不再丢清单）', async () => {
    withModel('gpt-4');
    const hist = mkAgentHist(40, 5000);
    const orig = T.AgentCompressor.ask; T.AgentCompressor.ask = async () => '摘要';
    try {
      await T.AgentCompressor.compactHistory(hist, T.Api.current(), null, null, { todos: [{ content: '改路由', status: 'in_progress' }, { content: '跑测试', status: 'pending' }] });
      assert.ok(String(hist[0].content).indexOf('[~] 改路由') > 0 && String(hist[0].content).indexOf('[ ] 跑测试') > 0);
      return 'ok';
    } finally { T.AgentCompressor.ask = orig; }
  });
  await check('onNote 回调拿到摘要（供写进快照）', async () => {
    withModel('gpt-4');
    const hist = mkAgentHist(40, 5000); let got = '';
    const orig = T.AgentCompressor.ask; T.AgentCompressor.ask = async () => '## 摘要X';
    try { await T.AgentCompressor.compactHistory(hist, T.Api.current(), null, (x) => { got = x; }); assert.strictEqual(got, '## 摘要X'); return 'ok'; }
    finally { T.AgentCompressor.ask = orig; }
  });
  await check('用户点停止（signal.aborted）时摘要不再兜底继续，直接抛出', async () => {
    withModel('gpt-4');
    const hist = mkAgentHist(40, 5000);
    const orig = T.AgentCompressor.ask; T.AgentCompressor.ask = async () => { throw new Error('abort'); };
    try {
      let threw = false;
      try { await T.AgentCompressor.compactHistory(hist, T.Api.current(), { aborted: true }); } catch (e) { threw = true; }
      assert.ok(threw);
      return 'ok';
    } finally { T.AgentCompressor.ask = orig; }
  });
  await check('消息太少 / 找不到安全切点 → 不压缩（不会误切）', async () => {
    withModel('gpt-4');
    const r = await T.AgentCompressor.compactHistory([{ role: 'user', content: 'a' }, { role: 'assistant', text: 'b' }], T.Api.current(), null);
    assert.strictEqual(r.did, false);
    return 'ok';
  });
  await check('microCompact：旧工具输出只留头尾，最近 8 条原样', () => {
    const hist = mkAgentHist(30, 8000);
    const r = T.AgentCompressor.microCompact(hist);
    const tools = hist.filter((m) => m.role === 'tool');
    assert.strictEqual(r.cleared, tools.length - T.AgentCompressor.KEEP_TOOL_RECENT, 'cleared=' + r.cleared);
    assert.ok(tools[0].text.length < 1500 && tools[0].text.indexOf('已清理') > 0, '旧输出没被清理');
    assert.strictEqual(tools[tools.length - 1].text.length, 8000, '最近输出被误清理');
    assert.strictEqual(T.AgentCompressor.microCompact(hist).cleared, 0, '重复调用应幂等');
    return 'cleared=' + r.cleared + ' saved=' + r.saved;
  });
  await check('need() 统计 tool 消息体积（旧版只算 content，工具输出全漏算）', () => {
    withModel('gpt-4');
    const hist = mkAgentHist(30, 8000);
    assert.ok(T.AgentCompressor.estimate(hist) > 70000, 'estimate=' + T.AgentCompressor.estimate(hist));
    assert.ok(T.AgentCompressor.need(hist), '应触发');
    return 'ok';
  });
  await check('need()：接口返回的真实 prompt token 超阈值也触发', () => {
    withModel('gpt-4');
    const hist = mkAgentHist(8, 100);
    assert.strictEqual(T.AgentCompressor.need(hist, 0), null);
    const r = T.AgentCompressor.need(hist, 40000);
    assert.ok(r && r.real === 40000);
    return 'ok';
  });
  await check('设置里手动指定上下文窗口优先于按模型名估算', () => {
    withModel('gpt-4');
    const auto = T.AgentCompressor.contextLimit();
    T.Settings.d.ctxWindow = 200000;
    const manual = T.AgentCompressor.contextLimit();
    T.Settings.d.ctxWindow = 0;
    assert.ok(manual === 200000 && auto !== manual);
    return 'auto=' + auto + ' manual=' + manual;
  });
  await check('contextLimit：deepseek / kimi / gpt-4o 不再被一刀切成 30K', () => {
    const lim = (m) => { withModel(m); return T.AgentCompressor.contextLimit(); };
    assert.ok(lim('deepseek-chat') >= 60000 && lim('kimi-k2') >= 100000 && lim('gpt-4o-mini') >= 100000 && lim('gpt-4') === 48000);
    return 'ok';
  });

  // ---- AgentTodos ----
  await check('AgentTodos.normalize：容错归一 + 只留一个进行中 + 上限', () => {
    const r = T.AgentTodos.normalize([{ content: 'A', status: 'DONE' }, { content: 'B', status: 'doing', activeForm: '正在 B' }, { content: 'C', status: 'in_progress' }, { content: '', status: 'pending' }, { content: 'D', status: '乱写' }]);
    assert.ok(eq(r.list.map((t) => t.status), ['completed', 'in_progress', 'pending', 'pending']));
    assert.strictEqual(r.demoted, 1);
    assert.strictEqual(r.list[1].activeForm, '正在 B');
    const many = T.AgentTodos.normalize(Array.from({ length: 50 }, (_, i) => ({ content: 'T' + i, status: 'pending' })));
    assert.strictEqual(many.list.length, T.AgentTodos.MAX_ITEMS);
    return 'ok';
  });
  await check('AgentTodos.dropped：点名「悄悄删掉的未完成项」，改写不误报', () => {
    const prev = [{ content: '修改 _worker.js 路由', status: 'in_progress' }, { content: '跑测试', status: 'pending' }, { content: '写文档', status: 'completed' }];
    const next = [{ content: '修改 _worker.js 路由（zcSecDispatch）', status: 'completed' }];
    const lost = T.AgentTodos.dropped(prev, next);
    assert.ok(eq(lost, ['跑测试']));
    assert.ok(eq(T.AgentTodos.dropped(prev, prev), []));
    return 'ok';
  });
  await check('AgentTodos.reminder / startNudge / format / counts', () => {
    const l = [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' }];
    const r = T.AgentTodos.reminder(l, 8);
    assert.ok(r.indexOf('system-reminder') >= 0 && r.indexOf('[x] A') >= 0 && r.indexOf('[~] B') >= 0 && r.indexOf('[ ] C') >= 0 && r.indexOf('8 步') >= 0);
    assert.ok(T.AgentTodos.startNudge().indexOf('todo_write') >= 0);
    const c = T.AgentTodos.counts(l); assert.ok(c.done === 1 && c.total === 3 && c.open === 2);
    return 'ok';
  });
  await check('AgentTodos.isContinue：识别「继续」类指令，不误伤正常需求', () => {
    ['继续', ' 继续吧 ', 'continue', 'Go on', '接着做。'].forEach((x) => assert.ok(T.AgentTodos.isContinue(x), x));
    ['继续优化压缩逻辑', '帮我继续写测试', 'fix the bug'].forEach((x) => assert.ok(!T.AgentTodos.isContinue(x), x));
    return 'ok';
  });
  await check('AgentTodos.carry：只带走 6 小时内「未完成」的项', () => {
    const snap = { updatedAt: Date.now() - 1000, todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' }] };
    assert.ok(eq(T.AgentTodos.carry(snap).map((t) => t.content), ['B', 'C']));
    snap.updatedAt = Date.now() - 7 * 3600 * 1000;
    assert.ok(eq(T.AgentTodos.carry(snap), []));
    assert.ok(eq(T.AgentTodos.carry(null), []));
    return 'ok';
  });
  await check('SystemPromptBuilder：遗留清单带「与新需求无关请重写」声明', () => {
    const snap = T.AgentSnapshot.init('t9', 'g'); snap.todos = [{ content: '旧事', status: 'pending' }]; snap.todosCarried = true;
    const p = T.SystemPromptBuilder.build({ mode: 'main', projectContexts: [], plan: null, snapshot: snap });
    assert.ok(p.indexOf('沿用自上一轮任务') >= 0);
    snap.todosCarried = false;
    assert.ok(T.SystemPromptBuilder.build({ mode: 'main', projectContexts: [], plan: null, snapshot: snap }).indexOf('沿用自上一轮任务') < 0);
    return 'ok';
  });
  await check('todo_write 工具 schema 含 activeForm', () => {
    const t = T.AgentTools.available().filter((x) => x.name === 'todo_write')[0];
    assert.ok(t && t.parameters.properties.todos.items.properties.activeForm, 'activeForm 缺失');
    return 'ok';
  });

  // ---- Net 直连卡死快速降级 ----
  await check('Net.request：直连卡住时 fastFallbackMs 到点就改走代理（旧版要等满整个超时）', async () => {
    const realSend = T.Net._send; const seen = [];
    T.Net._send = async (route, url, opts, tmo) => { seen.push(route + ':' + tmo); if (route === 'direct') { const e = new Error('timeout'); e.kind = 'timeout'; throw e; } return { ok: true, status: 200, zcRoute: route, headers: { get: () => null } }; };
    try {
      T.Net.cache = {};
      const r = await T.Net.request('https://api.example.com/v1/chat/completions', { method: 'POST', timeoutMs: 120000, fastFallbackMs: 25000, route: 'auto' });
      assert.strictEqual(r.zcRoute, 'relay');
      assert.deepStrictEqual(seen, ['direct:25000', 'relay:120000']);
      seen.length = 0;
      T.Net.cache = {};
      await T.Net.request('https://api2.example.com/x', { method: 'POST', timeoutMs: 120000, route: 'auto' });
      assert.strictEqual(seen[0], 'direct:120000', '未传 fastFallbackMs 时应保持原行为');
      return seen.join(' → ');
    } finally { T.Net._send = realSend; T.Net.cache = null; }
  });

  // ---- 流式读取空闲看门狗 ----
  await check('Agent.consume：上游卡住不发数据时 idleMs 到点自动断开（旧版会永远卡住）', async () => {
    const Agent = T.Agent;
    assert.ok(Agent, 'Agent 未暴露');
    let cancelled = false, pending;
    const body = { getReader() { return { read() { return new Promise((res) => { pending = res; }); }, cancel() { cancelled = true; if (pending) pending({ done: true }); } }; } };
    const resp = { headers: { get: () => 'text/event-stream' }, body: body };
    const S = { content: '', reasoning: '', toolCalls: [], finish: null, ended: false, usage: null };
    const t0 = Date.now();
    await Agent.consume(resp, 'openai', S, () => {}, { signal: {} }, 150);
    assert.ok(cancelled && S.idle === true, 'idle 未触发');
    assert.ok(Date.now() - t0 < 2000, '耗时过长');
    return 'idle after ' + (Date.now() - t0) + 'ms';
  });


  console.log('\n===== 前端功能测试 =====');
  for (const [s, n, d] of results) console.log(s.padEnd(4) + ' | ' + n + (d ? '  → ' + d : ''));
  const failed = results.filter((x) => x[0] === 'FAIL').length;
  console.log('===== ' + (results.length - failed) + '/' + results.length + ' 通过 =====');
  process.exit(failed ? 1 : 0);
})();