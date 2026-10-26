// v2.33.0：Agent 增强 —— ask_user / 计划模式 / move_file / 撤销检查点 / 循环防护 / 只读探索子 Agent / 运行中追加指令
// 上半部分：静态契约（不需要浏览器）；下半部分：真实 Chromium + 脚本化的「模型」+ 内存文件系统，把整条链路走一遍。
// 模型是一个按队列吐「文本 / 工具调用」的假接口（同时支持流式 SSE 与非流式 JSON），所以断言的是 Agent 真正发出的请求体与真正的界面。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const html = fs.readFileSync('public/index.html', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const results = [];
async function check(name, fn) { try { const d = await fn(); results.push(['PASS', name, d || '']); } catch (e) { results.push(['FAIL', name, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ⏎ ') : String(e)]); } }
const has = (s, re) => (typeof re === 'string' ? s.indexOf(re) >= 0 : re.test(s));
const quietLog = console.log;

/* ================== 一、静态契约 ================== */
await check('版本：前端 ZC33_VER 与 package.json 一致；模块标记与启动钩子齐全', () => {
  assert.ok(has(html, "ZC33_VER = '" + pkg.version + "'"), 'ZC33_VER 与版本不一致');
  ['/* zcV33:begin */', '/* zcV33:end */', '/* zcV33-js:begin */', '/* zcV33-js:end */', 'const AgentPlus = {', 'function zc33Init()'].forEach((k) => assert.ok(has(html, k), '缺少 ' + k));
  assert.ok(has(html, /try \{ ZX\.init\(\); \} catch[^\n]*\n\s*try \{ zc33Init\(\); \}/), 'zc33Init 必须紧跟在 ZX.init 之后调用（AgentPlus 的调度包装要在最外层，才能约束 MCP 工具）');
  assert.ok(has(html, /Pins, AgentPlus, AgentMix(, \w+)* \};/), 'window.ZC 导出里应包含 AgentPlus / AgentMix（v2.34 在其后又追加了新模块）');
});
await check('新增三个工具的定义：ask_user / exit_plan_mode（仅计划模式）/ move_file；delegate_subtask 多了 type=explore', () => {
  ['name: \'ask_user\'', 'name: \'exit_plan_mode\'', 'planOnly: true', 'name: \'move_file\''].forEach((k) => assert.ok(has(html, k), '缺少 ' + k));
  assert.ok(has(html, "type: { type: 'string', enum: ['general', 'explore']"), 'delegate_subtask 缺少 type 参数');
  assert.ok(has(html, "move: ['移动文件', 'mod', 'MOVE']") && has(html, "if (preview.kind === 'move') {"), '确认弹窗没有 move 类型');
});
await check('原有链路上的接线点：主循环注入追加指令 + 请求标记；子 Agent 标记来源；Ctrl+Enter 运行中追加', () => {
  assert.ok(has(html, 'AgentPlus.drainSteer(history)'), '主循环缺少 drainSteer');
  assert.ok(has(html, "flags: flags, __ap: 'main' }"), '主循环请求体没有 __ap 标记');
  assert.ok(has(html, "__ap: 'sub', __ro: !!subAgent.readonly"), '子 Agent 请求体没有 __ap / __ro 标记');
  assert.ok(has(html, 'call.__sub = true; call.__ro = !!subAgent.readonly;'), '子 Agent 的工具调用没有带来源标记');
  assert.ok(has(html, 'AgentPlus.steerFromInput()'), 'Ctrl+Enter 没有接追加指令');
});
await check('不引入新的外链 / 外部脚本；v2.33 的 JS 块里没有 eval / new Function / innerHTML 拼接用户输入', () => {
  const i = html.indexOf('/* zcV33-js:begin */'), j = html.indexOf('/* zcV33-js:end */');
  const code = html.slice(i, j);
  assert.ok(!/\beval\(|new Function\(|document\.write\(/.test(code), '不应使用 eval / new Function / document.write');
  assert.ok(!/https?:\/\//.test(code.replace(/\/\*[\s\S]*?\*\//g, '')), '不应引入外链');
  const inner = [...code.matchAll(/\.innerHTML\s*=/g)].length; assert.strictEqual(inner, 1, '只允许计划审批里渲染 Markdown 这一处 innerHTML（Md.render 自带转义）');
});

/* ================== 二、真实浏览器 ================== */
let pw = null;
try { const req = createRequire(process.env.ZC_PW_DIR || '/home/claude/.npm-global/lib/node_modules/'); pw = req('playwright'); } catch (e) { pw = null; }
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));

if (pw && exe) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcv33-'));
  fs.copyFileSync('_worker.js', path.join(tmpDir, 'worker.mjs'));
  const worker = (await import(path.join(tmpDir, 'worker.mjs'))).default;
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  const ASSETS = { async fetch(req) { const u = new URL(req.url); const file = path.join(path.resolve('public'), decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname)); if (!file.startsWith(path.resolve('public')) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not Found', { status: 404 }); return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } }); } };
  const env = { ASSETS, ZC_KV: null, DB: null };
  const ctx0 = { waitUntil() { }, passThroughOnException() { } };
  const BROWSER_HEADERS = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9', 'accept': 'text/html,*/*;q=0.8', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const mute = async (f) => { const o = console.log; console.log = () => { }; try { return await f(); } finally { console.log = o; } };

  /* ---------- 假模型：按队列吐响应。main = Agent 主循环；sub = 子 Agent；其余请求（生成计划 / 压缩）一律回一句话 ---------- */
  const mock = { main: [], sub: [], bodies: [], subBodies: [], gates: {}, exhausted: 0, cid: 0 };
  const gate = (k) => { if (!mock.gates[k]) { let r; const p = new Promise((res) => { r = res; }); mock.gates[k] = { p, resolve: r }; } return mock.gates[k]; };
  const release = (k) => gate(k).resolve();
  const reset = () => { mock.main = []; mock.sub = []; mock.bodies = []; mock.subBodies = []; mock.exhausted = 0; };
  const reply = (route, it, stream) => {
    const calls = (it.tools || []).map((t, i) => ({ index: i, id: 'call_' + (++mock.cid), type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args || {}) } }));
    if (stream) {
      let b = '';
      if (it.text) b += 'data: ' + JSON.stringify({ choices: [{ delta: { content: it.text }, index: 0 }] }) + '\n\n';
      if (calls.length) b += 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: calls }, index: 0 }] }) + '\n\n';
      b += 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop', index: 0 }] }) + '\n\ndata: [DONE]\n\n';
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: b });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: it.text || '', tool_calls: calls.length ? calls.map((c) => ({ id: c.id, type: c.type, function: c.function })) : undefined }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) });
  };
  const toolNames = (b) => (b.tools || []).map((t) => (t.function && t.function.name) || t.name);
  const lastTool = (b) => { const m = (b.messages || []).filter((x) => x.role === 'tool'); return m.length ? String(typeof m[m.length - 1].content === 'string' ? m[m.length - 1].content : JSON.stringify(m[m.length - 1].content)) : ''; };
  const sysOf = (b) => { const m = (b.messages || []).filter((x) => x.role === 'system')[0]; return m ? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) : ''; };

  const PFX = 'zc_gura_', now = Date.now();
  const sessions = [{ id: 's1', title: 'Agent 测试', createdAt: now - 3000, updatedAt: now - 1000, messages: [], model: 'm', mode: 'code' }];
  const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  async function makePage(opts) {
    const ctx = await browser.newContext(Object.assign({ permissions: ['clipboard-read', 'clipboard-write'] }, opts));
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await ctx.route('**/*', async (route) => {
      const req = route.request(); const url = new URL(req.url());
      if (url.hostname !== 'signal.test') return route.fulfill({ status: 404, contentType: 'text/plain', body: '' });
      if (url.pathname.startsWith('/__zc_auth__/status')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":false}' });
      if (/\/v1\/models$/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'alpha-1' }] }) });
      if (/\/chat\/completions$/.test(url.pathname) || url.pathname.indexOf('/__zc_relay__') === 0) {
        const raw = req.postData() || ''; let body = {}; try { body = JSON.parse(raw); } catch (e) { /* ignore */ }
        const stream = body.stream === true;
        const isSub = raw.indexOf('=== 子Agent模式 ===') >= 0;
        const isMain = !isSub && raw.indexOf('提问 · 追加指令 · 防循环') >= 0;
        if (isSub) mock.subBodies.push(body); else if (isMain) mock.bodies.push(body);
        if (!isSub && !isMain) return reply(route, { text: '好的。' }, stream);
        const q = isSub ? mock.sub : mock.main; const it = q.shift();
        if (!it) { mock.exhausted++; return reply(route, { text: '（脚本用尽）' }, stream); }
        if (it.hold) await gate(it.hold).p;
        return reply(route, it, stream);
      }
      const dest = req.headers()['sec-fetch-dest'] || 'document';
      const r = await mute(() => worker.fetch(new Request(req.url(), { method: req.method(), headers: Object.assign({}, BROWSER_HEADERS, { 'sec-fetch-dest': dest }) }), env, ctx0));
      const headers = {}; r.headers.forEach((v, k) => { if (!/^(content-length|content-encoding|transfer-encoding)$/i.test(k)) headers[k] = v; });
      return route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
    });
    await page.addInitScript(([PFX, sessions]) => {
      let seeded = true; try { seeded = !!sessionStorage.getItem('zc33_seeded'); } catch (e) { return; }
      if (!seeded) {
        sessionStorage.setItem('zc33_seeded', '1');
        localStorage.setItem(PFX + 'sessions', JSON.stringify(sessions)); localStorage.setItem(PFX + 'current_session', 's1');
        localStorage.setItem(PFX + 'apis', JSON.stringify([{ id: 'p', name: 'Demo', url: 'https://signal.test/v1', key: 'k', model: 'alpha-1', format: 'openai', route: 'direct', headers: '' }]));
        localStorage.setItem(PFX + 'intro_seen', String(Date.now())); localStorage.setItem(PFX + 'ui_mode', 'code');
        if (/[?&]zcdark=1/.test(location.search) || sessionStorage.getItem('zcdark')) { sessionStorage.setItem('zcdark', '1'); localStorage.setItem(PFX + 'settings', JSON.stringify({ theme: 'dark' })); }
      }
    }, [PFX, sessions]);
    await page.goto('https://signal.test/?intro=skip' + (process.env.ZC_DARK ? '&zcdark=1' : '')); await page.waitForTimeout(6500);
    return { ctx, page, errs, ev: (f, x) => page.evaluate(f, x) };
  }
  const SHOT = process.env.ZC_SHOT_DIR || '';
  const shot = async (pg, name) => { if (SHOT) { fs.mkdirSync(SHOT, { recursive: true }); await pg.screenshot({ path: path.join(SHOT, name + '.png') }); } };
  const waitFor = async (fn, ms, what) => { const t0 = Date.now(); for (; ;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - t0 > (ms || 6000)) throw new Error('等待超时：' + (what || '')); await new Promise((r) => setTimeout(r, 60)); } };

  const D = await makePage({ viewport: { width: 1440, height: 900 } });
  const { page, ev } = D;
  page.setDefaultTimeout(10000);
  /* 浏览器用例失败时把页面恢复到干净状态，避免一个失败连带后面全部超时 */
  const bcheck = async (name, fn) => {
    const n0 = results.length; await check(name, fn);
    if (results[n0] && results[n0][0] === 'FAIL') { try { await ev(() => { try { ZC.Chat.stop(); } catch (e) { } document.querySelectorAll('.ap-ov').forEach((n) => n.remove()); document.getElementById('agentDiffOv').hidden = true; ZC.Chat.busy = false; ZC.AgentPlus.running = false; }); } catch (e) { /* ignore */ } await new Promise((r) => setTimeout(r, 400)); }
  };

  /* 内存文件系统 + 进入 Agent 模式 */
  await ev(() => {
    const mem = window.__mem = new Map([['README.md', '# demo'], ['src/x.txt', 'old'], ['src/keep.txt', 'keep']]);
    window.__reads = [];
    const A = ZC.AgentFS, norm = (p) => String(p || '').replace(/^\.\//, '').replace(/\/+$/, '');
    A.supported = () => true; A.root = { name: 'mem' }; A.rootName = 'mem'; A.requestPermission = async () => true;
    A.sanitize = (p) => norm(p).split('/').filter(Boolean);
    A.readFile = async (p) => { p = norm(p); window.__reads.push(p); if (!mem.has(p)) throw new Error('文件不存在：' + p); const t = mem.get(p); return { binary: false, text: t, size: t.length, truncated: false }; };
    A.createFile = async (p, c) => { p = norm(p); if (mem.has(p)) throw new Error('创建失败，路径已存在：' + p); mem.set(p, String(c)); };
    A.writeFile = async (p, c) => { p = norm(p); if (!mem.has(p)) throw new Error('文件不存在，无法修改：' + p); mem.set(p, String(c)); };
    A.deleteFile = async (p) => { p = norm(p); if (!mem.has(p)) throw new Error('要删除的文件不存在：' + p); mem.delete(p); };
    A.createDirectory = async () => { };
    A.listDir = async (rel) => { rel = norm(rel === '.' ? '' : rel); const seen = new Map(); for (const k of mem.keys()) { if (rel && k.indexOf(rel + '/') !== 0) continue; const rest = rel ? k.slice(rel.length + 1) : k; const i = rest.indexOf('/'); if (i < 0) seen.set(rest, { name: rest, kind: 'file', path: k, size: mem.get(k).length }); else { const d = rest.slice(0, i); if (!seen.has(d)) seen.set(d, { name: d, kind: 'dir', path: (rel ? rel + '/' : '') + d }); } } return [...seen.values()]; };
    A.search = async () => [];
    ZC.AgentMix.trash = async (p) => { window.__mem.delete(norm(p)); };
    ZC.Agent.backend = 'local'; ZC.Agent._enter();
  });
  const mem = () => ev(() => Object.fromEntries(window.__mem));
  const idle = () => waitFor(() => ev(() => !ZC.Chat.busy), 15000, '任务结束');
  const send = async (text) => { await page.fill('#input', text); await page.keyboard.press('Control+Enter'); };
  const approveDiff = async () => { await page.waitForSelector('#agentDiffOv:not([hidden])', { timeout: 8000 }); await page.click('#agdApprove'); };
  const lastSteps = () => ev(() => { const ms = ZC.Sessions.msgs(); const m = ms[ms.length - 1]; return (m && m.meta && m.meta.steps) || []; });

  await bcheck('[浏览器] 启动正常：AgentPlus 已接线，工具栏多了「计划 / 撤销」两个按钮，三个新工具进入可用列表', async () => {
    assert.deepStrictEqual(D.errs, []);
    const r = await ev(() => ({ wired: ZC.AgentPlus._wired, plan: !!document.getElementById('agentBarPlan'), undo: !!document.getElementById('agentBarUndo'), names: ZC.Agent && ZC.AgentFS ? null : null, bar: !document.getElementById('agentBar').hidden }));
    assert.ok(r.wired && r.plan && r.undo && r.bar, JSON.stringify(r));
    const names = await ev(() => { const L = ZC.Agent.constructor === Object ? null : null; return null; });
    void names;
    await shot(page, 'a1-agent-bar');
  });

  /* ---------- ask_user ---------- */
  await bcheck('[浏览器] ask_user：弹出选择题 → 选项 + 补充说明 → 回答原样进入下一次请求；步骤卡落盘；提问时 Esc 不会停止任务', async () => {
    reset();
    mock.main.push({ tools: [{ name: 'ask_user', args: { question: '用哪个日期库？', header: '依赖选择', options: [{ label: 'dayjs（推荐）', description: '体积小' }, { label: 'luxon', description: '时区强' }] } }] }, { text: '已按你的选择继续。' });
    await send('做个日期工具');
    await page.waitForSelector('#apAskOv', { timeout: 8000 });
    const t = await ev(() => ({ q: document.querySelector('#apAskOv .ap-q').textContent, opts: [...document.querySelectorAll('#apAskOv .ap-opt b')].map((b) => b.textContent), tag: document.querySelector('#apAskOv .ap-tag').textContent }));
    assert.deepStrictEqual(t, { q: '用哪个日期库？', opts: ['dayjs（推荐）', 'luxon'], tag: '依赖选择' });
    await shot(page, 'a2-ask');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    assert.ok(await ev(() => !!document.getElementById('apAskOv') && ZC.Chat.busy), 'Esc 不应关闭提问，也不应停止任务');
    await page.click('#apAskOv .ap-opt >> nth=1'); await page.fill('#apAskOv .ap-other', '注意要支持上海时区');
    await page.click('#apAskOv .ap-act .primary');
    await idle();
    const b = mock.bodies[1]; assert.ok(b, '没有发出第二次请求');
    assert.ok(/选择了：「luxon」；补充说明：注意要支持上海时区/.test(lastTool(b)), lastTool(b));
    const steps = await lastSteps(); const st = steps.find((s) => s.tool === 'ask_user');
    assert.ok(st && st.status === 'ok' && /答：选择了：「luxon」/.test(st.detail), JSON.stringify(st));
    assert.ok(await ev(() => !document.getElementById('apAskOv')), '提交后弹窗应移除');
  });
  await bcheck('[浏览器] ask_user：多选 / 跳过；跳过时模型被告知「基于假设继续」；点停止会关闭弹窗并结束任务', async () => {
    reset();
    mock.main.push({ tools: [{ name: 'ask_user', args: { question: '要哪些功能？', multi: true, options: ['导出', '导入', '分享'] } }] }, { text: 'ok' });
    await send('多选测试'); await page.waitForSelector('#apAskOv');
    await page.click('#apAskOv .ap-opt >> nth=0'); await page.click('#apAskOv .ap-opt >> nth=2');
    assert.strictEqual(await ev(() => document.querySelectorAll('#apAskOv .ap-opt.on').length), 2, '多选应能同时选中两项');
    await page.click('#apAskOv .ap-act .primary'); await idle();
    assert.ok(/选择了：「导出」、「分享」/.test(lastTool(mock.bodies[1])), lastTool(mock.bodies[1]));
    reset();
    mock.main.push({ tools: [{ name: 'ask_user', args: { question: '随便问问' } }] }, { text: 'ok' });
    await send('跳过测试'); await page.waitForSelector('#apAskOv');
    await page.click('#apAskOv .ap-act .btn:not(.primary):not(.ap-stop)'); await idle();
    assert.ok(/没有回答这个问题[\s\S]*合理的假设/.test(lastTool(mock.bodies[1])), lastTool(mock.bodies[1]));
    reset();
    mock.main.push({ tools: [{ name: 'ask_user', args: { question: '会被停止' } }] });
    await send('停止测试'); await page.waitForSelector('#apAskOv');
    await page.click('#apAskOv .ap-stop'); await idle();
    assert.ok(await ev(() => !document.getElementById('apAskOv')), '停止后提问弹窗应关闭');
  });
  await bcheck('[浏览器] ask_user 缺少 question / 参数损坏：给出明确报错，不会卡住', async () => {
    reset();
    mock.main.push({ tools: [{ name: 'ask_user', args: {} }] }, { text: 'ok' });
    await send('缺参'); await idle();
    assert.ok(/缺少必填参数：question/.test(lastTool(mock.bodies[1])), lastTool(mock.bodies[1]));
  });

  /* ---------- 计划模式 ---------- */
  await bcheck('[浏览器] 计划模式：工具栏开关 → 写入类工具从工具列表消失、exit_plan_mode 出现；system 带只读说明；硬调用 create_file 会被拒绝；MCP 工具同样被拦', async () => {
    reset();
    await page.click('#agentBarPlan');
    assert.ok(await ev(() => ZC.AgentPlus.plan && document.getElementById('agentBarPlan').classList.contains('on') && document.getElementById('agentBar').classList.contains('plan-on')));
    mock.main.push({ tools: [{ name: 'create_file', args: { path: 'sneaky.txt', content: 'x' } }] }, { text: '好吧' });
    await send('开始'); await idle();
    const b0 = mock.bodies[0]; const names = toolNames(b0);
    ['create_file', 'write_file', 'edit_file', 'delete_file', 'move_file', 'cloud_run'].forEach((n) => assert.ok(names.indexOf(n) < 0, '计划模式下不应提供 ' + n));
    ['read_file', 'list_files', 'search_files', 'ask_user', 'exit_plan_mode'].forEach((n) => assert.ok(names.indexOf(n) >= 0, '应保留 ' + n));
    assert.ok(/计划模式（只读）/.test(sysOf(b0)), 'system 没有计划模式说明');
    assert.ok(/计划模式（只读）下不能执行「create_file」/.test(lastTool(mock.bodies[1])), lastTool(mock.bodies[1]));
    assert.ok(!(await mem())['sneaky.txt'], '被拒绝的写入不应落盘');
    assert.ok(await ev(() => document.querySelectorAll('#agentDiffOv:not([hidden])').length === 0), '被拒绝的调用不应弹确认框');
    const d = await ev(() => { ZC.ZX.mcp.map.mcp__demo__x = { serverId: 's', serverName: 'd', tool: 'x' }; const r = ZC.AgentPlus.denyReason('mcp__demo__x', {}, {}); delete ZC.ZX.mcp.map.mcp__demo__x; return { mcp: !!r, ro: !!ZC.AgentPlus.denyReason('run_command', { command: 'ls -la' }, {}), rm: !!ZC.AgentPlus.denyReason('run_command', { command: 'rm -rf x' }, {}) }; });
    assert.deepStrictEqual(d, { mcp: true, ro: false, rm: true }, '计划模式：MCP 要拦、只读命令放行、危险命令要拦');
  });
  await bcheck('[浏览器] exit_plan_mode：提交计划 → 「再改改」带意见回到模型 → 再次提交 → 批准后计划模式关闭，写入工具恢复且仍需逐个确认', async () => {
    reset();
    mock.main.push({ tools: [{ name: 'exit_plan_mode', args: { plan: '# 计划\n\n1. 新建 `notes/a.md`\n2. 写入 hello' } }] },
      { tools: [{ name: 'exit_plan_mode', args: { plan: '# 计划（修订）\n\n1. 新建 `notes/a.md`，内容 hello' } }] },
      { tools: [{ name: 'create_file', args: { path: 'notes/a.md', content: 'hello' } }] },
      { text: '完成' });
    await send('写个笔记');
    await page.waitForSelector('#apPlanOv', { timeout: 8000 });
    assert.ok(await ev(() => /新建/.test(document.querySelector('#apPlanOv .ap-plan').textContent) && !!document.querySelector('#apPlanOv .ap-plan li, #apPlanOv .ap-plan ol, #apPlanOv .ap-plan p')), '计划应渲染成 Markdown');
    await shot(page, 'a3-plan');
    await page.fill('#apPlanOv .ap-other', '文件名改短一点'); await page.click('#apPlanOv .ap-act .btn:not(.primary):not(.ap-stop)');
    await waitFor(() => mock.bodies.length >= 2, 6000, '第二次请求');
    assert.ok(/没有批准[\s\S]*修改意见：文件名改短一点[\s\S]*仍处于计划模式/.test(lastTool(mock.bodies[1])), lastTool(mock.bodies[1]));
    assert.ok(await ev(() => ZC.AgentPlus.plan === true), '未批准前应仍是计划模式');
    await page.waitForSelector('#apPlanOv'); await page.click('#apPlanOv .ap-act .primary');
    await waitFor(() => mock.bodies.length >= 3, 6000, '第三次请求');
    assert.ok(/已批准该计划[\s\S]*todo_write/.test(lastTool(mock.bodies[2])), lastTool(mock.bodies[2]));
    assert.ok(await ev(() => ZC.AgentPlus.plan === false && !document.getElementById('agentBar').classList.contains('plan-on')), '批准后应退出计划模式');
    const n3 = toolNames(mock.bodies[2]); assert.ok(n3.indexOf('create_file') >= 0 && n3.indexOf('exit_plan_mode') < 0, '批准后应恢复写入工具、移走 exit_plan_mode');
    assert.ok(/用户已批准的计划/.test(sysOf(mock.bodies[2])) && /修订/.test(sysOf(mock.bodies[2])), '已批准的计划应进入后续请求的 system（压缩历史也不会丢）');
    await approveDiff();   // 写入仍需逐个确认
    await idle();
    assert.strictEqual((await mem())['notes/a.md'], 'hello');
  });

  /* ---------- move_file + 撤销 ---------- */
  await bcheck('[浏览器] move_file：确认弹窗显示 from → to；写入新位置并校验后才移除原文件；目标已存在 / 源不存在 / 同路径都给出明确错误', async () => {
    reset();
    mock.main.push({ tools: [{ name: 'move_file', args: { from: 'notes/a.md', to: 'docs/b.md' } }] },
      { tools: [{ name: 'move_file', args: { from: 'docs/b.md', to: 'src/x.txt' } }] },
      { tools: [{ name: 'move_file', args: { from: 'nope.txt', to: 'z.txt' } }] },
      { tools: [{ name: 'move_file', args: { from: 'README.md', to: './README.md' } }] },
      { text: '搞定' });
    await send('整理文件');
    await page.waitForSelector('#agentDiffOv:not([hidden])', { timeout: 8000 });
    const m = await ev(() => ({ title: document.getElementById('agdTitle').textContent, tag: document.querySelector('#agdBody .tag').textContent, txt: document.querySelector('#agdBody .diff-file').textContent, add: document.querySelector('#agdBody .dline.add .tx').textContent, del: document.querySelector('#agdBody .dline.del .tx').textContent }));
    assert.ok(m.title === '移动文件确认' && m.tag === 'MOVE' && m.del === 'notes/a.md' && m.add === 'docs/b.md', JSON.stringify(m));
    await shot(page, 'a4-move-confirm');
    await page.click('#agdApprove'); await idle();
    const fsn = await mem(); assert.ok(fsn['docs/b.md'] === 'hello' && !('notes/a.md' in fsn), JSON.stringify(fsn));
    assert.ok(/文件已移动：notes\/a\.md → docs\/b\.md/.test(lastTool(mock.bodies[1])), lastTool(mock.bodies[1]));
    assert.ok(/目标已存在[\s\S]*不会覆盖/.test(lastTool(mock.bodies[2])), lastTool(mock.bodies[2]));
    assert.ok(/无法读取源文件 "nope\.txt"/.test(lastTool(mock.bodies[3])), lastTool(mock.bodies[3]));
    assert.ok(/源路径和目标路径相同/.test(lastTool(mock.bodies[4])), lastTool(mock.bodies[4]));
    assert.strictEqual((await mem())['src/x.txt'], 'old', '目标已存在时不能覆盖');
  });
  await bcheck('[浏览器] move_file 被拒绝：文件原样不动，并告诉模型不要重复请求', async () => {
    reset();
    mock.main.push({ tools: [{ name: 'move_file', args: { from: 'docs/b.md', to: 'docs/c.md' } }] }, { text: '好' });
    await send('再移一次'); await page.waitForSelector('#agentDiffOv:not([hidden])'); await page.click('#agdReject'); await idle();
    assert.ok(/用户拒绝了这次移动/.test(lastTool(mock.bodies[1])), lastTool(mock.bodies[1]));
    const f = await mem(); assert.ok('docs/b.md' in f && !('docs/c.md' in f));
  });
  await bcheck('[浏览器] 撤销：按「轮」记录；只能从最近一轮逐轮撤销；移动被移回、新建被删除；工具栏角标显示轮数', async () => {
    const n = await ev(() => ZC.AgentPlus.turns.length);
    assert.strictEqual(n, 2, '前面两轮有文件改动（新建一次、移动一次），应有 2 个检查点：' + n);
    assert.strictEqual(await ev(() => document.querySelector('#agentBarUndo .ab-n').textContent), '2');
    await page.click('#agentBarUndo'); await page.waitForSelector('#apUndoOv');
    const ui = await ev(() => ({ turns: document.querySelectorAll('#apUndoOv .ap-turn').length, hint: document.querySelectorAll('#apUndoOv .ap-turn .hint').length, first: document.querySelector('#apUndoOv .ap-turn .ap-op').textContent }));
    assert.deepStrictEqual([ui.turns, ui.hint], [2, 1]); assert.ok(/移动/.test(ui.first) && /docs\/b\.md/.test(ui.first), ui.first);
    await shot(page, 'a5-undo');
    await page.click('#apUndoOv .ap-act .primary'); await waitFor(() => ev(() => !document.getElementById('apUndoOv') || document.querySelectorAll('#apUndoOv .ap-turn').length === 1), 5000, '第一次撤销');
    let f = await mem(); assert.ok(f['notes/a.md'] === 'hello' && !('docs/b.md' in f), '移动应被移回：' + JSON.stringify(f));
    assert.strictEqual(await ev(() => ZC.AgentPlus.turns.length), 1);
    await waitFor(() => ev(() => !!document.getElementById('apUndoOv')), 3000, '撤销面板重新打开');
    await page.click('#apUndoOv .ap-act .primary'); await waitFor(() => ev(() => !document.getElementById('apUndoOv')), 5000, '第二次撤销');
    f = await mem(); assert.ok(!('notes/a.md' in f), '新建的文件应被删除：' + JSON.stringify(f));
    assert.strictEqual(await ev(() => ZC.AgentPlus.turns.length), 0);
    assert.strictEqual(await ev(() => document.querySelector('#agentBarUndo .ab-n').hidden), true);
  });
  await bcheck('[浏览器] 撤销冲突保护：修改 / 删除可还原；Agent 写入之后被人改过的文件默认跳过，勾选「也覆盖」才还原', async () => {
    reset();
    mock.main.push({ tools: [{ name: 'write_file', args: { path: 'src/x.txt', content: 'agent-v1' } }] },
      { tools: [{ name: 'edit_file', args: { path: 'src/keep.txt', edits: [{ old_str: 'keep', new_str: 'keep+edited' }] } }] },
      { tools: [{ name: 'delete_file', args: { path: 'README.md' } }] }, { text: '改完了' });
    await send('改几个文件');
    for (let i = 0; i < 3; i++) await approveDiff().then(() => page.waitForTimeout(250));
    await idle();
    let f = await mem(); assert.ok(f['src/x.txt'] === 'agent-v1' && f['src/keep.txt'] === 'keep+edited' && !('README.md' in f), JSON.stringify(f));
    assert.strictEqual(await ev(() => ZC.AgentPlus.turns.length), 1); assert.strictEqual(await ev(() => ZC.AgentPlus.turns[0].ops.length), 3);
    await ev(() => window.__mem.set('src/x.txt', 'user-edit-after-agent'));   // 用户在 Agent 之后又改了这个文件
    await page.click('#agentBarUndo'); await page.waitForSelector('#apUndoOv');
    await waitFor(() => ev(() => !!document.querySelector('#apUndoOv .ap-op.warn')), 4000, '冲突标记');
    assert.ok(await ev(() => /x\.txt/.test(document.querySelector('#apUndoOv .ap-op.warn').textContent) && /又被改动/.test(document.querySelector('#apUndoOv .ap-op.warn').textContent)));
    await page.click('#apUndoOv .ap-act .primary'); await page.waitForTimeout(800);
    f = await mem();
    assert.strictEqual(f['src/x.txt'], 'user-edit-after-agent', '冲突文件默认应跳过，不能覆盖用户的改动');
    assert.ok(f['src/keep.txt'] === 'keep' && f['README.md'] === '# demo', '其余两个应被还原：' + JSON.stringify(f));
    assert.strictEqual(await ev(() => ZC.AgentPlus.turns[0].ops.length), 1, '跳过的操作应留在记录里');
    await waitFor(() => ev(() => !!document.getElementById('apUndoOv')), 3000, '面板重开');
    await page.check('#apUndoForce'); await page.click('#apUndoOv .ap-act .primary'); await page.waitForTimeout(800);
    f = await mem(); assert.strictEqual(f['src/x.txt'], 'old', '勾选「也覆盖」后应还原成 Agent 写入前的内容');
    assert.strictEqual(await ev(() => ZC.AgentPlus.turns.length), 0);
  });
  await bcheck('[浏览器] 撤销的安全阀：切换工作区后拒绝撤销；任务运行中不能撤销', async () => {
    reset();
    mock.main.push({ tools: [{ name: 'create_file', args: { path: 'tmp/z.txt', content: 'z' } }] }, { text: 'ok' });
    await send('建一个文件'); await approveDiff(); await idle();
    const r = await ev(async () => { const t = ZC.AgentPlus.turns[0]; const old = ZC.AgentFS.rootName; ZC.AgentFS.rootName = 'other-dir'; let msg = ''; try { await ZC.AgentPlus.undoTurn(t, false); } catch (e) { msg = e.message; } ZC.AgentFS.rootName = old; return msg; });
    assert.ok(/工作区已切换/.test(r), r);
    assert.ok('tmp/z.txt' in (await mem()), '被拒绝撤销时文件不应被动');
    await ev(() => ZC.AgentPlus.undoTurn(ZC.AgentPlus.turns[0], false)); assert.ok(!('tmp/z.txt' in (await mem())));
  });

  /* ---------- 循环防护 ---------- */
  await bcheck('[浏览器] 循环防护：同一调用得到同一结果，第 3 次附预警，第 5 次之后直接拦截且不再触碰后端；改文件成功后计数重置', async () => {
    reset();
    for (let i = 0; i < 7; i++) mock.main.push({ tools: [{ name: 'read_file', args: { path: 'missing/ghost.txt' } }] });
    mock.main.push({ text: '放弃' });
    await ev(() => { window.__reads.length = 0; });
    await send('读那个文件'); await idle();
    const reads = await ev(() => window.__reads.filter((p) => p === 'missing/ghost.txt').length);
    assert.strictEqual(reads, 5, '后端只应被真正访问 5 次，之后被拦截：' + reads);
    assert.ok(!/循环预警/.test(lastTool(mock.bodies[2])), '第 2 次结果不应带预警');
    assert.ok(/循环预警[\s\S]*连续 3 次/.test(lastTool(mock.bodies[3])), '第 3 次结果应带预警：' + lastTool(mock.bodies[3]));
    assert.ok(/已被系统拦截/.test(lastTool(mock.bodies[6])), '第 6 次应被拦截：' + lastTool(mock.bodies[6]));
    const steps = await lastSteps(); assert.ok(steps.some((s) => /已拦截重复调用/.test(s.summary || '') && s.status === 'skip'), '被拦截的调用应在步骤里可见');
    // 改文件成功之后：同一调用重新允许
    reset();
    mock.main.push({ tools: [{ name: 'read_file', args: { path: 'missing/ghost.txt' } }] }, { tools: [{ name: 'create_file', args: { path: 'missing/ghost.txt', content: 'now exists' } }] }, { tools: [{ name: 'read_file', args: { path: 'missing/ghost.txt' } }] }, { text: 'ok' });
    await send('先读后建再读'); await approveDiff(); await idle();
    assert.ok(/now exists/.test(lastTool(mock.bodies[3])), lastTool(mock.bodies[3]));
    await ev(() => window.__mem.delete('missing/ghost.txt'));
  });
  await bcheck('[浏览器] 循环防护不误伤：todo_write / ask_user 重复不计数；参数不同或结果不同都不算重复', async () => {
    reset();
    for (let i = 0; i < 6; i++) mock.main.push({ tools: [{ name: 'todo_write', args: { todos: [{ content: '做事', status: 'in_progress' }] } }] });
    for (let i = 0; i < 4; i++) mock.main.push({ tools: [{ name: 'read_file', args: { path: 'src/keep.txt', start_line: i + 1 } }] });
    mock.main.push({ text: 'ok' });
    await send('重复的清单'); await idle();
    const all = mock.bodies.map((b) => lastTool(b)).join('\n');
    assert.ok(!/循环预警|已被系统拦截/.test(all), '不应误报：' + all.slice(0, 300));
  });

  /* ---------- 只读探索子 Agent ---------- */
  await bcheck('[浏览器] 只读探索子 Agent：delegate_subtask(type=explore)——system 带只读说明；写文件 / 提问 / 危险命令被拒绝且不弹审批；读文件正常；结果回到主 Agent', async () => {
    reset();
    mock.main.push({ tools: [{ name: 'delegate_subtask', args: { goal: '摸清 src 目录', type: 'explore', max_steps: 6 } }] }, { text: '主 Agent 收到报告' });
    mock.sub.push({ tools: [{ name: 'create_file', args: { path: 'sub-wrote.txt', content: 'x' } }] },
      { tools: [{ name: 'ask_user', args: { question: '子 Agent 想问' } }] },
      { tools: [{ name: 'run_command', args: { command: 'rm -rf src' } }] },
      { tools: [{ name: 'read_file', args: { path: 'src/keep.txt' } }] },
      { text: '发现：src/keep.txt 内容为 keep' });
    await send('分头调研'); await idle();
    assert.ok(mock.subBodies.length >= 5, '子 Agent 请求数：' + mock.subBodies.length);
    assert.ok(/只读探索模式/.test(sysOf(mock.subBodies[0])) || JSON.stringify(mock.subBodies[0]).indexOf('只读探索模式') >= 0, '子 Agent 的 system 缺少只读说明');
    assert.ok(!/提问 · 追加指令/.test(JSON.stringify(mock.subBodies[0])), '子 Agent 不应收到主 Agent 的提问 / 追加指令说明');
    assert.ok(/只读探索模式下不能执行「create_file」/.test(lastTool(mock.subBodies[1])), lastTool(mock.subBodies[1]));
    assert.ok(/子 Agent 不能向用户提问/.test(lastTool(mock.subBodies[2])), lastTool(mock.subBodies[2]));
    assert.ok(/只读探索模式下不能执行「run_command」/.test(lastTool(mock.subBodies[3])), lastTool(mock.subBodies[3]));
    assert.ok(/keep/.test(lastTool(mock.subBodies[4])), '读文件应正常：' + lastTool(mock.subBodies[4]));
    const f = await mem(); assert.ok(!('sub-wrote.txt' in f) && 'src/keep.txt' in f, '只读子 Agent 不能改任何东西');
    assert.ok(/发现：src\/keep\.txt/.test(lastTool(mock.bodies[1])), '子 Agent 的报告应回到主 Agent：' + lastTool(mock.bodies[1]));
    assert.strictEqual(await ev(() => ZC.Approvals.localPending().length), 0, '只读子 Agent 不应产生待审批项');
    assert.ok(await ev(() => document.querySelectorAll('#agentDiffOv:not([hidden])').length === 0));
  });

  /* ---------- 运行中追加指令 ---------- */
  await bcheck('[浏览器] 运行中追加指令：Agent 工作时有字则发送键变「追加」，Ctrl+Enter 也可；下一次请求前并入最近的工具结果，并持续列在 system 里；步骤卡可见；没字时发送键仍是停止', async () => {
    reset();
    mock.main.push({ tools: [{ name: 'list_files', args: { path: '.' } }], hold: 'g-steer-1' }, { text: '收到追加的指令，已调整。' });
    await send('开始一个长任务');
    await waitFor(() => ev(() => ZC.Chat.busy && ZC.AgentPlus.canSteer()), 5000, '任务进行中');
    await waitFor(() => mock.bodies.length >= 1, 8000, '主请求已发出并挂起');
    assert.strictEqual(await ev(() => document.getElementById('input').placeholder), 'Agent 运行中 · 输入后点发送，可追加指令');
    assert.strictEqual(await ev(() => document.getElementById('btnSend').title), '停止生成', '没字时仍是停止');
    await page.fill('#input', '另外：不要改 README');
    assert.ok(await ev(() => document.getElementById('btnSend').classList.contains('steer') && /追加指令/.test(document.getElementById('btnSend').title)), '有字时应变成追加');
    await shot(page, 'a6-steer-button');
    await page.click('#btnSend');
    assert.strictEqual(await ev(() => ZC.AgentPlus.steerQ.length), 1); assert.strictEqual(await ev(() => document.getElementById('input').value), '', '追加后应清空输入框');
    assert.ok(await ev(() => ZC.Chat.busy), '追加指令不能停止任务');
    await page.fill('#input', '还有：用中文回答'); await page.keyboard.press('Control+Enter');
    assert.strictEqual(await ev(() => ZC.AgentPlus.steerQ.length), 2);
    release('g-steer-1'); await idle();
    const b = mock.bodies[1]; const tl = lastTool(b);
    assert.ok(/用户中途补充指令/.test(tl) && /不要改 README/.test(tl) && /用中文回答/.test(tl), tl);
    assert.ok(/本次任务中用户追加过的指令/.test(sysOf(b)) && /不要改 README/.test(sysOf(b)), 'system 里应持续列出追加指令');
    const steps = await lastSteps(); assert.ok(steps.some((s) => s.tool === 'user_steer' && /不要改 README/.test(s.detail)), '步骤卡里应能看到你的补充');
    assert.strictEqual(await ev(() => ZC.AgentPlus.steerQ.length), 0);
    assert.strictEqual(await ev(() => document.getElementById('input').placeholder.indexOf('Agent 运行中') < 0), true, '任务结束后应恢复占位符');
  });
  await bcheck('[浏览器] 追加指令来不及注入（任务已结束）：内容放回输入框，不丢', async () => {
    reset();
    mock.main.push({ text: '这就结束了。', hold: 'g-steer-2' });
    await send('很快结束的任务');
    await waitFor(() => ev(() => ZC.Chat.busy && ZC.AgentPlus.canSteer()), 5000, '任务进行中');
    await waitFor(() => mock.bodies.length >= 1, 8000, '主请求已发出并挂起');
    await page.fill('#input', '来不及的补充'); await page.keyboard.press('Control+Enter');
    assert.strictEqual(await ev(() => ZC.AgentPlus.steerQ.length), 1);
    release('g-steer-2'); await idle();
    await waitFor(() => ev(() => document.getElementById('input').value === '来不及的补充'), 4000, '追加内容放回输入框');
    assert.strictEqual(await ev(() => ZC.AgentPlus.steerQ.length), 0);
  });
  await bcheck('[浏览器] 不在 Agent 运行时：Ctrl+Enter 的行为不变（空闲时发送）；普通聊天忙碌时发送键仍是停止', async () => {
    const r = await ev(() => { const P = ZC.AgentPlus; const a = P.canSteer(); P.running = true; const b = P.canSteer(); ZC.Chat.busy = false; P.running = false; return [a, b]; });
    assert.deepStrictEqual(r, [false, false], '空闲时不能追加（Chat.busy 为 false）');
    const r2 = await ev(() => { ZC.Chat.busy = true; const a = ZC.AgentPlus.canSteer(); ZC.Chat.busy = false; return a; });
    assert.strictEqual(r2, false, '普通生成忙碌（非 Agent 运行）时不能追加');
  });

  await bcheck('[浏览器] 退出 Agent 模式会关闭计划模式；整个流程没有脚本错误', async () => {
    await page.click('#agentBarPlan'); assert.ok(await ev(() => ZC.AgentPlus.plan));
    await page.click('#agentBarExit'); await page.waitForTimeout(400);
    assert.strictEqual(await ev(() => ZC.AgentPlus.plan), false);
    assert.deepStrictEqual(D.errs, []);
  });
  await D.ctx.close();

  /* ---------- 手机：工具栏不溢出、对话框可用 ---------- */
  const M = await makePage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const { page: mp, ev: mev } = M;
  await mev(() => {
    const mem = window.__mem = new Map([['a.txt', 'a']]);
    const A = ZC.AgentFS; const norm = (p) => String(p || '').replace(/^\.\//, '');
    A.supported = () => true; A.root = { name: 'mem' }; A.rootName = 'mem'; A.requestPermission = async () => true; A.sanitize = (p) => norm(p).split('/').filter(Boolean);
    A.readFile = async (p) => { p = norm(p); if (!mem.has(p)) throw new Error('文件不存在：' + p); const t = mem.get(p); return { binary: false, text: t, size: t.length, truncated: false }; };
    A.listDir = async () => [{ name: 'a.txt', kind: 'file', path: 'a.txt', size: 1 }]; A.search = async () => [];
    ZC.Agent.backend = 'local'; ZC.Agent._enter();
  });
  await check('[浏览器·手机] Agent 工具栏在 390px 宽下不溢出，「计划 / 撤销」收成图标；点计划可开关', async () => {
    await mev(() => { const sc = document.querySelector('.ag-scrim'); if (sc) sc.click(); }); await mp.waitForTimeout(500);   // 手机上进入 Agent 会自动展开右侧抽屉，先收起
    const r = await mev(() => { const b = document.getElementById('agentBar'); return { sw: b.scrollWidth, cw: b.clientWidth, planTxt: getComputedStyle(document.querySelector('#agentBarPlan .ab-t')).display, n: b.querySelectorAll('button').length }; });
    assert.ok(r.sw <= r.cw + 1, '工具栏溢出：' + JSON.stringify(r)); assert.strictEqual(r.planTxt, 'none');
    await mp.tap('#agentBarPlan'); assert.ok(await mev(() => ZC.AgentPlus.plan)); await shot(mp, 'a7-mobile-bar');
    await mp.tap('#agentBarPlan'); assert.ok(await mev(() => !ZC.AgentPlus.plan));
  });
  await check('[浏览器·手机] 提问对话框：选项可点、内容区可滚动、按钮不被挤出屏幕', async () => {
    mev(() => { ZC.AgentPlus.ask({ question: '一个很长的问题 '.repeat(20), options: Array.from({ length: 6 }, (_, i) => ({ label: '选项 ' + (i + 1), description: '说明文字 '.repeat(8) })) }).then((v) => { window.__askRes = v; }); });
    await mp.waitForSelector('#apAskOv');
    const r = await mev(() => { const d = document.querySelector('#apAskOv .ap-dlg').getBoundingClientRect(); const ok = document.querySelector('#apAskOv .ap-act .primary').getBoundingClientRect(); return { dTop: d.top, dBottom: d.bottom, okBottom: ok.bottom, vh: innerHeight, vw: innerWidth, dw: d.width }; });
    assert.ok(r.dTop >= 0 && r.dBottom <= r.vh + 1 && r.okBottom <= r.vh && r.dw <= r.vw, JSON.stringify(r)); await shot(mp, 'a8-mobile-ask');
    await mp.tap('#apAskOv .ap-opt >> nth=3'); await mp.tap('#apAskOv .ap-act .primary'); await mp.waitForTimeout(300);
    assert.strictEqual(await mev(() => window.__askRes), '选择了：「选项 4」');
  });
  await check('[浏览器·手机] 无脚本错误', async () => { assert.deepStrictEqual(M.errs, []); });
  await M.ctx.close();
  await browser.close();
} else {
  results.push(['SKIP', '[浏览器] Agent 增强交互测试', '未找到 Playwright / Chromium，已跳过（静态契约仍已校验）']);
}

let fail = 0;
for (const [st, n, d] of results) { if (st === 'FAIL') fail++; quietLog(st + ' | ' + n + (d ? '  → ' + d : '')); }
quietLog('===== ' + results.filter((r) => r[0] === 'PASS').length + '/' + results.filter((r) => r[0] !== 'SKIP').length + ' 通过 =====');
process.exit(fail ? 1 : 0);
