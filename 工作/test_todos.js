const fs = require('fs');
const assert = require('assert');
const vm = require('vm');

const html = fs.readFileSync(require('path').join(__dirname, 'public', 'index.html'), 'utf8');
// 自动从页面里抽出最大的内联 <script>（不再依赖手工准备的 /tmp/app.js）
const all = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length);
let app = all[0];
const EXPOSE = 'window.__T = { AgentTodos, AgentSnapshot, SystemPromptBuilder, Agent, Store, Sessions, Chat, ToolUI };\n';
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

const results = [];
async function check(name, fn) {
  try { const d = await fn(); results.push(['PASS', name, d ? String(d) : '']); }
  catch (e) { results.push(['FAIL', name, e && e.message ? e.message : String(e)]); }
}

(async () => {
  const HOUR = 3600 * 1000;

  // ===== 问题 1：清单归属与携带 =====
  await check('shouldCarry：新对话 → new-session（不带）', () => {
    const snap = { sessionId: 'sess-A', updatedAt: Date.now(), todos: [{ content: 'x', status: 'pending' }] };
    assert.strictEqual(T.AgentTodos.shouldCarry(snap, 'sess-B'), 'new-session');
    return 'ok';
  });
  await check('shouldCarry：同对话 + 新鲜 + 有未完成 → ok（带）', () => {
    const snap = { sessionId: 'sess-A', updatedAt: Date.now(), todos: [{ content: 'x', status: 'in_progress' }] };
    assert.strictEqual(T.AgentTodos.shouldCarry(snap, 'sess-A'), 'ok');
    return 'ok';
  });
  await check('shouldCarry：超过 6 小时 → stale（不带）', () => {
    const snap = { sessionId: 'sess-A', updatedAt: Date.now() - 7 * HOUR, todos: [{ content: 'x', status: 'pending' }] };
    assert.strictEqual(T.AgentTodos.shouldCarry(snap, 'sess-A'), 'stale');
    return 'ok';
  });
  await check('shouldCarry：全部已完成 → empty（不带）', () => {
    const snap = { sessionId: 'sess-A', updatedAt: Date.now(), todos: [{ content: 'x', status: 'completed' }] };
    assert.strictEqual(T.AgentTodos.shouldCarry(snap, 'sess-A'), 'empty');
    return 'ok';
  });
  await check('shouldCarry：无快照 / 无清单 → empty', () => {
    assert.strictEqual(T.AgentTodos.shouldCarry(null, 's'), 'empty');
    assert.strictEqual(T.AgentTodos.shouldCarry({ todos: [] }, 's'), 'empty');
    return 'ok';
  });
  await check('shouldCarry：旧快照没有 sessionId（兼容）→ 仍可带', () => {
    const snap = { updatedAt: Date.now(), todos: [{ content: 'x', status: 'pending' }] };
    assert.strictEqual(T.AgentTodos.shouldCarry(snap, 'sess-X'), 'ok');
    return 'ok';
  });
  await check('isSettled：全完成 → true；有未完成 → false', () => {
    assert.strictEqual(T.AgentTodos.isSettled({ todos: [{ status: 'completed' }, { status: 'completed' }] }), true);
    assert.strictEqual(T.AgentTodos.isSettled({ todos: [{ status: 'completed' }, { status: 'pending' }] }), false);
    assert.strictEqual(T.AgentTodos.isSettled({ todos: [] }), false);
    return 'ok';
  });
  await check('Snapshot.init 写入 sessionId', () => {
    const s = T.AgentSnapshot.init('t1', '目标', 'sess-Z');
    assert.strictEqual(s.sessionId, 'sess-Z');
    assert.ok(Array.isArray(s.todos) && s.todos.length === 0, 'todos 应为空数组');
    return 'sessionId=' + s.sessionId;
  });
  await check('Snapshot.init 未传 sessionId 时不报错', () => {
    const s = T.AgentSnapshot.init('t2', 'g');
    assert.ok(typeof s.sessionId === 'string');
    return 'ok';
  });

  // ===== 问题 2：开工先立清单 =====
  await check('SystemPromptBuilder：无清单时也注入「先立清单」要求', () => {
    const p = T.SystemPromptBuilder.build({ mode: 'main', snapshot: { todos: [] }, projectContexts: [], plan: null });
    assert.ok(p.indexOf('=== 任务清单（TodoWrite）===') >= 0, '缺少清单段落标题');
    assert.ok(p.indexOf('todo_write') >= 0, '缺少 todo_write 指引');
    assert.ok(p.indexOf('开始执行前') >= 0, '缺少「开工前先建清单」要求');
    assert.ok(p.indexOf('=== 任务清单结束 ===') >= 0, '缺少段落收尾');
    return 'ok';
  });
  await check('SystemPromptBuilder：段落只出现一次（无重复）', () => {
    const p = T.SystemPromptBuilder.build({ mode: 'main', snapshot: { todos: [] }, projectContexts: [], plan: null });
    const a = p.split('=== 任务清单（TodoWrite）===').length - 1;
    const b = p.split('=== 任务清单结束 ===').length - 1;
    assert.strictEqual(a, 1, '标题重复 ' + a + ' 次');
    assert.strictEqual(b, 1, '收尾重复 ' + b + ' 次');
    return '标题x1 收尾x1';
  });
  await check('SystemPromptBuilder：有清单时内容正常注入', () => {
    const snap = { todos: [{ content: '改路由', status: 'in_progress' }, { content: '跑测试', status: 'pending' }] };
    const p = T.SystemPromptBuilder.build({ mode: 'main', snapshot: snap, projectContexts: [], plan: null });
    assert.ok(p.indexOf('[~] 改路由') >= 0, '进行中项未注入');
    assert.ok(p.indexOf('[ ] 跑测试') >= 0, '待办项未注入');
    return 'ok';
  });
  await check('SystemPromptBuilder：沿用旧清单时给出「先重写」提示', () => {
    const snap = { todos: [{ content: '旧项', status: 'pending' }], todosCarried: true };
    const p = T.SystemPromptBuilder.build({ mode: 'main', snapshot: snap, projectContexts: [], plan: null });
    assert.ok(p.indexOf('沿用自上一轮任务') >= 0, '缺少沿用提示');
    return 'ok';
  });

  // ===== 回归：原有能力未被破坏 =====
  await check('回归：normalize 容错仍有效', () => {
    const r = T.AgentTodos.normalize([{ content: 'a', status: 'done' }, { content: 'b', status: 'doing' }, { content: 'c', status: 'in_progress' }, { content: 'd', status: 'x' }]);
    assert.strictEqual(r.list[0].status, 'completed');
    assert.strictEqual(r.list[1].status, 'in_progress');
    assert.strictEqual(r.list[2].status, 'pending', 'in_progress 应被降级为 pending');
    assert.strictEqual(r.demoted, 1);
    assert.strictEqual(r.list[3].status, 'pending');
    return 'ok';
  });
  await check('回归：isContinue 识别「继续」', () => {
    assert.strictEqual(T.AgentTodos.isContinue('继续'), true);
    assert.strictEqual(T.AgentTodos.isContinue('continue'), true);
    assert.strictEqual(T.AgentTodos.isContinue('继续改代码'), false);
    return 'ok';
  });
  await check('回归：carry 只带未完成项且过滤过期', () => {
    const fresh = { updatedAt: Date.now(), todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] };
    const c = T.AgentTodos.carry(fresh);
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].content, 'b');
    const old = { updatedAt: Date.now() - 7 * HOUR, todos: [{ content: 'b', status: 'pending' }] };
    assert.strictEqual(T.AgentTodos.carry(old).length, 0);
    return 'ok';
  });
  await check('回归：dropped 检测「悄悄删项」', () => {
    const prev = [{ content: '改路由', status: 'pending' }, { content: '跑测试', status: 'pending' }];
    const next = [{ content: '改路由', status: 'completed' }];
    const d = T.AgentTodos.dropped(prev, next);
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0], '跑测试');
    return 'ok';
  });

  // ===== 关键源码级校验（确保补丁真落到了正确位置）=====
  await check('源码校验：run() 有「新对话丢弃旧快照」逻辑', () => {
    assert.ok(html.indexOf('检测到这是新对话，已忽略上一轮遗留的任务快照与清单') >= 0, 'missing');
    assert.ok(html.indexOf('__isLeave') >= 0, 'missing __isLeave');
    return 'ok';
  });
  await check('源码校验：clearCurrent 会删除快照', () => {
    const i = html.indexOf('async clearCurrent()');
    assert.ok(i > 0, '找不到 clearCurrent 定义');
    const seg = html.slice(i, i + 1600);
    assert.ok(seg.indexOf("Store.remove('agent_snapshot_'") >= 0, 'clearCurrent 未删除快照');
    assert.ok(seg.indexOf('last_agent_task_id') >= 0, 'clearCurrent 未清理 task id');
    assert.ok(seg.indexOf('Agent.snapshot = null') >= 0, 'clearCurrent 未复位 Agent.snapshot');
    return 'ok';
  });
  await check('源码校验：任务清单面板保留归属校验；全部完成的清单继续显示（不再「完成即隐藏」）', () => {
    const i = html.indexOf('  _todoList() {');
    assert.ok(i > 0, '找不到 _todoList');
    const seg1 = html.slice(i, i + 1400);
    assert.ok(seg1.indexOf('snapSid !== sid') >= 0, 'missing 归属校验');
    const j = html.indexOf('  renderTodos() {');
    assert.ok(j > 0, '找不到 renderTodos');
    const seg2 = html.slice(j, j + 4200);
    assert.ok(seg2.indexOf("'全部完成'") >= 0, '面板应显示「全部完成」状态');
    assert.ok(seg2.indexOf('box.hidden = true') < 0, '面板不应再把清单整体藏起来');
    return 'ok';
  });
  await check('_todoList：别的对话留下的清单不显示；本对话的（含全部完成的）照常显示；运行中不做归属拦截', () => {
    const A = T.Agent, S = T.Sessions, C = T.Chat;
    const keepSid = S.curId, keepSnap = A.snapshot, keepBusy = C.busy;
    try {
      S.curId = 'sess-B'; C.busy = false;
      const todos = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }];
      A.snapshot = { sessionId: 'sess-A', todos: todos };
      assert.strictEqual(A._todoList().length, 0, '别的对话的清单不该显示');
      A.snapshot = { sessionId: 'sess-B', todos: todos };
      assert.strictEqual(A._todoList().length, 2, '本对话全部完成的清单应继续显示');
      A.snapshot = { sessionId: 'sess-B', todos: [{ content: '', status: 'pending' }, null, { content: 'c', status: 'pending' }] };
      assert.strictEqual(A._todoList().length, 1, '空内容 / null 项应被过滤');
      C.busy = true; A.snapshot = { sessionId: 'sess-A', todos: todos };
      assert.strictEqual(A._todoList().length, 2, '运行中的快照一定属于当前任务');
      C.busy = false; A.snapshot = null;
      assert.ok(Array.isArray(A._todoList()), '没有快照时返回空数组');
    } finally { S.curId = keepSid; A.snapshot = keepSnap; C.busy = keepBusy; }
    return 'ok';
  });
  await check('「操作日志」已改成「任务清单」：页面里没有旧日志面板，也没有写它的代码', () => {
    assert.ok(html.indexOf('data-agtab="todo">任务清单<') >= 0, '标签页应为「任务清单」');
    assert.ok(html.indexOf('data-agtab="log"') < 0 && html.indexOf('agPaneLog') < 0 && html.indexOf('agLogBox') < 0, '旧的日志标签页 / 容器仍在');
    assert.ok(html.indexOf('>操作日志<') < 0, '界面上不该再出现「操作日志」');
    assert.ok(html.indexOf('id="agentBarTodo"') >= 0 && html.indexOf('agentBarLog') < 0, '输入框上方的「日志」按钮应改成「清单」');
    assert.ok(html.indexOf('class="astep') < 0 && html.indexOf('.astep') < 0, '旧日志卡片的样式 / 结构应已清除');
    return 'ok';
  });
  await check('步骤与系统提示改走聊天主页：renderStep 只交给 ToolUI；logNote 走 ToolUI.note；模型自己的话不再重复写进日志', () => {
    const i = html.indexOf('  renderStep(step) {');
    const seg = html.slice(i, i + 400);
    assert.ok(seg.indexOf('ToolUI.sync(step)') >= 0 && seg.indexOf('$(') < 0, 'renderStep 应只调用 ToolUI.sync');
    const j = html.indexOf('  logNote(text) {');
    assert.ok(html.slice(j, j + 300).indexOf('ToolUI.note(') >= 0, 'logNote 应调用 ToolUI.note');
    assert.ok(html.indexOf('if (text) this.logNote(text)') < 0, '模型自己说的话已经在聊天里，不应再重复发一遍');
    return 'ok';
  });
  await check('开工前就建好回答气泡（计划阶段的提示也在聊天里可见），并常驻「思考中」状态行', () => {
    const r = html.indexOf('async run(taskText, att) {');
    const seg = html.slice(r, r + 3600);
    const a = seg.indexOf('View.createStream(api.model)'), t = seg.indexOf("this.taskId = ''");
    assert.ok(a > 0 && t > 0 && a < t, '气泡应在 run() 开头（任务登记 / 计划生成之前）创建');
    assert.ok(seg.indexOf('ToolUI.work(h, true)') >= 0, '没有启动「思考中」状态行');
    assert.strictEqual(html.split('View.createStream(api.model)').length - 1, 2, 'Agent.run 里应只创建一次气泡（另一处是普通对话）');
    return 'ok';
  });
  await check('ToolUI：系统提示在没有聊天气泡时安静无副作用；待办卡片标题显示进度（实时 / 落盘回看都行）', () => {
    const U = T.ToolUI, A = T.Agent;
    const keep = A._host; A._host = null;
    try { assert.strictEqual(U.note('x'), null, '没有气泡时 note 应返回 null 且不抛错'); } finally { A._host = keep; }
    assert.strictEqual(U.obj({ tool: 'todo_write', args: { todos: new Array(3) }, detail: '2/3 已完成\n✓ a' }), '2/3 已完成');
    assert.strictEqual(U.obj({ tool: 'todo_write', args: { todos: new Array(3) }, detail: '' }), '3 项');
    assert.strictEqual(U.cat({ tool: 'delegate_subtask' }), 'pl');
    return 'ok';
  });
  await check('源码校验：buildResumePrompt 不再重复注入清单', () => {
    const i = html.indexOf('buildResumePrompt(snapshot) {');
    const seg = html.slice(i, i + 4200);
    const end = seg.indexOf('\n  },');
    const body = seg.slice(0, end > 0 ? end : 4200);
    assert.ok(body.indexOf('const __todos') < 0, 'buildResumePrompt 仍在注入清单');
    return 'ok';
  });

  console.log('\n===== 清单修复测试 =====');
  for (const [s, n, d] of results) console.log(s.padEnd(4) + ' | ' + n + (d ? '  → ' + d : ''));
  const failed = results.filter((x) => x[0] === 'FAIL').length;
  console.log('===== ' + (results.length - failed) + '/' + results.length + ' 通过 =====');
  process.exit(failed ? 1 : 0);
})();