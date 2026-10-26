// v2.33.1：项目模式修复 —— ① Agent 回合「编辑并重发」不再掉回普通对话 ② 手机画面固定（不缩放）
// ③ 项目里的归档 / 分支在选中项目时可见 ④ 项目指令：完整读取要求 + 「指令只读一次」开关（分支 / 归档 / 各项目各算各的）
// 上半部分：静态契约；下半部分：真实 Chromium + 脚本化的假模型（同时记录 Agent 请求与普通对话请求，断言的是真正发出去的 system 与界面）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const html = fs.readFileSync(process.env.ZC_HTML || 'public/index.html', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const results = [];
async function check(name, fn) { try { const d = await fn(); results.push(['PASS', name, d || '']); } catch (e) { results.push(['FAIL', name, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ⏎ ') : String(e)]); } }
const has = (s, re) => (typeof re === 'string' ? s.indexOf(re) >= 0 : re.test(s));

/* ================== 一、静态契约 ================== */
await check('版本：前端 / Worker / sw 都是 package.json 的版本', () => {
  assert.ok(has(html, "ZC32_VER = '" + pkg.version + "'") && has(html, "ZC33_VER = '" + pkg.version + "'"), '前端版本号不一致');
  assert.ok(has(fs.readFileSync('_worker.js', 'utf8'), "ZC_VERSION = '" + pkg.version + "'"), 'Worker 版本号不一致');
  assert.ok(has(fs.readFileSync('public/sw.js', 'utf8'), 'zc-gura-v' + pkg.version), 'sw 缓存版本号不一致');
});
await check('画面固定：viewport 禁缩放；触屏输入框 ≥16px；全页 touch-action: manipulation；gesture 事件被拦', () => {
  assert.ok(has(html, /<meta name="viewport"[^>]*maximum-scale=1[^>]*user-scalable=no/), 'viewport 没有禁用缩放');
  assert.ok(has(html, /@media \(pointer:coarse\)\{input:not\(\[type=checkbox\]\)[^}]*font-size:max\(16px,1em\)!important/), '触屏输入框字号规则缺失');
  assert.ok(has(html, '*{touch-action:manipulation}'), '缺少全页 touch-action');
  assert.ok(has(html, "['gesturestart', 'gesturechange', 'gestureend']"), '缺少 gesture 拦截');
});
await check('接线：编辑重发预检 / Agent 回合判定 / 分支继承项目 / 子 Agent 带项目指令', () => {
  ['isAgentTurn(m) {', 'editBlock(m, newText) {', 'if (__agent) {', 'Agent.run(task, { imgs: [], files: [], content:', "s.projectId = cur.projectId;", "o.mode === 'subagent') ? r + Projects.promptFor(Sessions.cur(), { sub: true })", '(_att.content != null)'].forEach((k) => assert.ok(has(html, k), '缺少 ' + k));
  assert.ok(has(html, '!(Chat.editBlock && Chat.editBlock(m, text))'), '编辑前备份没有走预检');
});

/* ================== 二、真实浏览器 ================== */
let pw = null;
try { const req = createRequire(process.env.ZC_PW_DIR || '/home/claude/.npm-global/lib/node_modules/'); pw = req('playwright'); } catch (e) { pw = null; }
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));

if (pw && exe) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcv331-'));
  fs.copyFileSync('_worker.js', path.join(tmpDir, 'worker.mjs'));
  const worker = (await import(path.join(tmpDir, 'worker.mjs'))).default;
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  const indexPath = path.resolve(process.env.ZC_HTML || 'public/index.html');
  const ASSETS = { async fetch(req) { const u = new URL(req.url); const rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname); const file = rel === '/index.html' ? indexPath : path.join(path.resolve('public'), rel); if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not Found', { status: 404 }); return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } }); } };
  const env = { ASSETS, ZC_KV: null, DB: null };
  const ctx0 = { waitUntil() { }, passThroughOnException() { } };
  const BROWSER_HEADERS = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9', 'accept': 'text/html,*/*;q=0.8', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const mute = async (f) => { const o = console.log; console.log = () => { }; try { return await f(); } finally { console.log = o; } };

  /* ---------- 假模型：Agent 主循环（system 带「提问 · 追加指令 · 防循环」）与普通对话分开记录 ---------- */
  const mock = { main: [], plain: [], all: [], cid: 0 };
  const reset = () => { mock.main = []; mock.plain = []; mock.all = []; };
  const reply = (route, it, stream) => {
    if (stream) {
      let b = '';
      if (it.text) b += 'data: ' + JSON.stringify({ choices: [{ delta: { content: it.text }, index: 0 }] }) + '\n\n';
      b += 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }) + '\n\ndata: [DONE]\n\n';
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: b });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: it.text || '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) });
  };
  const sysOf = (b) => { const m = (b.messages || []).filter((x) => x.role === 'system')[0]; return m ? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) : ''; };

  const PFX = 'zc_gura_', now = Date.now();
  const sessions = [{ id: 's1', title: '空白', createdAt: now - 3000, updatedAt: now - 1000, messages: [], model: 'm', mode: 'code' }];
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
        const isMain = raw.indexOf('提问 · 追加指令 · 防循环') >= 0;
        const isPlan = raw.indexOf('你是严谨的任务规划器') >= 0;
        if (isPlan) return reply(route, { text: '好的。' }, stream);
        const kind = isMain ? 'main' : 'plain';
        mock.all.push({ kind, body });
        const q = isMain ? mock.main : mock.plain; const it = q.shift() || { text: isMain ? '（Agent 回答）' : '（普通回答）' };
        return reply(route, it, stream);
      }
      const dest = req.headers()['sec-fetch-dest'] || 'document';
      const r = await mute(() => worker.fetch(new Request(req.url(), { method: req.method(), headers: Object.assign({}, BROWSER_HEADERS, { 'sec-fetch-dest': dest }) }), env, ctx0));
      const headers = {}; r.headers.forEach((v, k) => { if (!/^(content-length|content-encoding|transfer-encoding)$/i.test(k)) headers[k] = v; });
      return route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
    });
    await page.addInitScript(([PFX, sessions]) => {
      let seeded = true; try { seeded = !!sessionStorage.getItem('zc331_seeded'); } catch (e) { return; }
      if (!seeded) {
        sessionStorage.setItem('zc331_seeded', '1');
        localStorage.setItem(PFX + 'sessions', JSON.stringify(sessions)); localStorage.setItem(PFX + 'current_session', 's1');
        localStorage.setItem(PFX + 'apis', JSON.stringify([{ id: 'p', name: 'Demo', url: 'https://signal.test/v1', key: 'k', model: 'alpha-1', format: 'openai', route: 'direct', headers: '' }]));
        localStorage.setItem(PFX + 'intro_seen', String(Date.now())); localStorage.setItem(PFX + 'ui_mode', 'code');
      }
    }, [PFX, sessions]);
    await page.goto('https://signal.test/?intro=skip'); await page.waitForTimeout(6500);
    return { ctx, page, errs, ev: (f, x) => page.evaluate(f, x) };
  }
  const waitFor = async (fn, ms, what) => { const t0 = Date.now(); for (; ;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - t0 > (ms || 6000)) throw new Error('等待超时：' + (what || '')); await new Promise((r) => setTimeout(r, 60)); } };

  const D = await makePage({ viewport: { width: 1440, height: 900 } });
  const { page, ev } = D;
  page.setDefaultTimeout(10000);
  const bcheck = async (name, fn) => {
    const n0 = results.length; await check(name, fn);
    if (results[n0] && results[n0][0] === 'FAIL') { try { await ev(() => { try { ZC.Chat.stop(); } catch (e) { } document.querySelectorAll('.ap-ov').forEach((n) => n.remove()); ZC.Chat.busy = false; }); } catch (e) { /* ignore */ } await new Promise((r) => setTimeout(r, 400)); }
  };
  const idle = () => waitFor(() => ev(() => !ZC.Chat.busy), 15000, '任务结束');
  const send = async (text) => { await page.fill('#input', text); await page.keyboard.press('Control+Enter'); await page.waitForTimeout(150); await idle(); await page.waitForTimeout(150); };

  /* 项目：3000 字指令，结尾带一个只有读到最后才会知道的标记 */
  const INSTR = '【规则】' + '请用简体中文回答。'.repeat(300) + '结尾标记XYZ';
  await ev((INSTR) => {
    const P = ZC.Projects;
    P.list.push({ id: 'pj1', name: '测试项目', instructions: INSTR, readOnce: true, color: '#c6613f', createdAt: Date.now(), updatedAt: Date.now() });
    P.list.push({ id: 'pj2', name: '另一个项目', instructions: '只回答英文。', readOnce: true, color: '#2b5cd9', createdAt: Date.now(), updatedAt: Date.now() });
    P.save(); P.setFilter('pj1');
    /* 内存文件系统 + 进入 Agent 模式 */
    const mem = window.__mem = new Map([['README.md', '# demo']]);
    const A = ZC.AgentFS, norm = (p) => String(p || '').replace(/^\.\//, '').replace(/\/+$/, '');
    A.supported = () => true; A.root = { name: 'mem' }; A.rootName = 'mem'; A.requestPermission = async () => true;
    A.sanitize = (p) => norm(p).split('/').filter(Boolean);
    A.readFile = async (p) => { p = norm(p); if (!mem.has(p)) throw new Error('文件不存在：' + p); const t = mem.get(p); return { binary: false, text: t, size: t.length, truncated: false }; };
    A.listDir = async () => [{ name: 'README.md', kind: 'file', path: 'README.md', size: 6 }];
    A.search = async () => [];
    ZC.Agent.backend = 'local'; ZC.Agent._enter();
  }, INSTR);

  await bcheck('[浏览器] 启动正常；选中项目后，当前空白对话归入该项目', async () => {
    assert.deepStrictEqual(D.errs, []);
    const r = await ev(() => ({ pid: ZC.Sessions.cur().projectId, agent: ZC.Chat && document.getElementById('btnAgent').classList.contains('agent-on'), filter: ZC.Projects.activeId() }));
    assert.deepStrictEqual(r, { pid: 'pj1', agent: true, filter: 'pj1' }, JSON.stringify(r));
  });

  /* ---------- 项目指令：完整读取 + 读一次 ---------- */
  await bcheck('[浏览器] Agent 首次发言：system 带「完整读取要求」+ 指令全文（含结尾标记）+ 字数；此时还不是「已读」', async () => {
    reset();
    await send('说一句话');
    const mains = mock.all.filter((x) => x.kind === 'main');
    assert.ok(mains.length >= 1, '没有 Agent 请求');
    const sys = sysOf(mains[0].body);
    assert.ok(sys.includes('【完整读取要求】') && sys.includes('800、1000、2000 字'), '缺完整读取要求');
    assert.ok(sys.includes('结尾标记XYZ') && sys.includes('项目指令开始（共 ' + INSTR.length + ' 字）') && sys.includes('项目指令结束（以上 ' + INSTR.length + ' 字全部有效'), '指令全文 / 字数 / 结束标记不全');
    assert.ok(!sys.includes('你在本对话里已经完整读过'), '首次不该是「已读」');
    const a = await ev(() => { const s = ZC.Sessions.cur(); const last = s.messages[s.messages.length - 1]; return { ack: s.projAck, last: last.id, agent: !!(last.meta && last.meta.agent) }; });
    assert.ok(a.ack && a.ack.pid === 'pj1' && a.ack.mid === a.last && a.agent, JSON.stringify(a));
  });
  await bcheck('[浏览器] Agent 第二次发言：system 改成「已读已答应，不要重读 / 复述 / 确认，接着做」，原文仍留档（不会被忘掉）', async () => {
    reset();
    await send('继续下一件事');
    const sys = sysOf(mock.all.filter((x) => x.kind === 'main')[0].body);
    assert.ok(sys.includes('你在本对话里已经完整读过') && sys.includes('不要再重新读取') && sys.includes('接着上一轮的进度继续完成任务'), '没有切到已读写法');
    assert.ok(!sys.includes('【完整读取要求】'), '已读时不该再要求「完整读取」');
    assert.ok(sys.includes('结尾标记XYZ') && sys.includes('全部有效'), '原文必须仍然在请求里');
  });
  await bcheck('[浏览器] 普通对话模式也一样：首次完整读取 → 之后「已读」（同一份记忆）', async () => {
    reset();
    const sid = await ev(() => { const s = ZC.Sessions.create(true, 'chat'); s.projectId = 'pj1'; ZC.Sessions.switchTo(s.id); ZC.Agent.exitMode(); ZC.Mode.follow(); ZC.View = ZC.View; return s.id; });
    await send('你好');
    await send('再说一句');
    const plains = mock.all.filter((x) => x.kind === 'plain');
    assert.ok(plains.length >= 2, '普通请求数不对：' + plains.length);
    assert.ok(sysOf(plains[0].body).includes('【完整读取要求】') && !sysOf(plains[0].body).includes('已经完整读过'), '普通模式首次不对');
    assert.ok(sysOf(plains[1].body).includes('你在本对话里已经完整读过') && sysOf(plains[1].body).includes('结尾标记XYZ'), '普通模式第二次没变「已读」');
    const ent = await ev(() => ZC.Sessions.cur().projAck && ZC.Sessions.cur().projAck.pid);
    assert.strictEqual(ent, 'pj1');
  });
  await bcheck('[浏览器] 开关关闭：每次都按首次写法送（和旧行为一致，只多了完整读取要求）；换项目 / 改指令 → 重新读一次；各项目各算各的', async () => {
    const r = await ev(() => {
      const P = ZC.Projects, S = ZC.Sessions, s = S.cur(), p = P.get('pj1'); const out = {};
      out.on = P.promptFor(s).includes('已经完整读过');
      p.readOnce = false; out.off = P.promptFor(s).includes('已经完整读过'); p.readOnce = true;
      const old = p.instructions; p.instructions = old + '追加一条'; out.edited = P.promptFor(s).includes('已经完整读过'); p.instructions = old;
      out.restored = P.promptFor(s).includes('已经完整读过');
      s.projectId = 'pj2'; out.otherProj = P.promptFor(s).includes('已经完整读过') || !P.promptFor(s).includes('只回答英文'); s.projectId = 'pj1';
      out.back = P.promptFor(s).includes('已经完整读过');
      return out;
    });
    assert.deepStrictEqual(r, { on: true, off: false, edited: false, restored: true, otherProj: false, back: true }, JSON.stringify(r));
  });

  /* ---------- Agent 回合编辑后继续走 Agent ---------- */
  await bcheck('[浏览器] 回到 Agent 对话：编辑第一条消息并「保存并重新生成」→ 仍走 Agent（带工具的主循环请求），回答带 agent 标记，Agent 模式没掉', async () => {
    const sid = await ev(() => { const s = ZC.Sessions.create(true, 'code'); s.projectId = 'pj1'; ZC.Sessions.switchTo(s.id); ZC.Mode.follow(); ZC.Chat.openSession; return s.id; });
    await ev(() => { ZC.Agent.backend = 'local'; ZC.Agent._enter(); });
    reset();
    await send('说一句话');
    await send('再来一句');
    const before = await ev(() => ZC.Sessions.msgs().map((m) => m.role + ':' + !!(m.meta && m.meta.agent)));
    assert.deepStrictEqual(before, ['user:true', 'assistant:true', 'user:true', 'assistant:true']);
    reset();
    const first = await ev(() => ZC.Sessions.msgs()[0].id);
    await ev((first) => { const m = ZC.Chat.findMsg(first); ZC.Chat.beginEdit(m); const ta = document.querySelector('.msg.user .edit-box textarea'); ta.value = '改成：说两句话'; [...document.querySelectorAll('.edit-box button')].find((b) => /重新生成/.test(b.textContent)).click(); }, first);
    await waitFor(() => ev(() => !ZC.Chat.busy && ZC.Sessions.msgs().length === 2), 15000, '编辑重发完成');
    const mains = mock.all.filter((x) => x.kind === 'main'), plains = mock.all.filter((x) => x.kind === 'plain');
    assert.ok(mains.length >= 1 && plains.length === 0, 'main=' + mains.length + ' plain=' + plains.length + '（旧版这里会是 plain=1）');
    const st = await ev(() => { const ms = ZC.Sessions.msgs(); return { roles: ms.map((m) => m.role + ':' + !!(m.meta && m.meta.agent)), text: ZC.Chat.userText(ms[0]), agentOn: document.getElementById('btnAgent').classList.contains('agent-on'), mode: ZC.Sessions.modeOf(ZC.Sessions.cur()) }; });
    assert.deepStrictEqual(st, { roles: ['user:true', 'assistant:true'], text: '改成：说两句话', agentOn: true, mode: 'code' }, JSON.stringify(st));
    /* 编辑把「已读」那条回答截掉了 → 模型实际上看不到那次阅读 → 这一轮要重新读一次 */
    assert.ok(sysOf(mains[0].body).includes('【完整读取要求】') && !sysOf(mains[0].body).includes('已经完整读过'), '被截断后应重新完整读取');
    const ack = await ev(() => { const s = ZC.Sessions.cur(); return s.projAck && s.projAck.mid === s.messages[1].id; });
    assert.ok(ack, '重新读完后应记新的已读凭证');
  });
  await bcheck('[浏览器] 编辑 Agent 回合时 Agent 模式被关掉了（例如刷新后）：自动回到 Agent 模式再跑；没选目录则拒绝且不改对话、不存备份', async () => {
    const r = await ev(() => { const s = ZC.Sessions.cur(); return { n: ZC.Sessions.list.length, text: ZC.Chat.userText(s.messages[0]) }; });
    /* ① 先关掉 Agent 模式再编辑 */
    reset();
    await ev(() => { ZC.Agent.exitMode(); });
    assert.strictEqual(await ev(() => ZC.Composer ? 0 : 0), 0);
    const id0 = await ev(() => ZC.Sessions.msgs()[0].id);
    await ev((id0) => { const m = ZC.Chat.findMsg(id0); ZC.Chat.applyEdit(m, '第二次编辑'); }, id0);
    await waitFor(() => ev(() => !ZC.Chat.busy && ZC.Sessions.msgs().length === 2 && ZC.Chat.userText(ZC.Sessions.msgs()[0]) === '第二次编辑'), 15000, '二次编辑完成');
    assert.ok(mock.all.some((x) => x.kind === 'main') && !mock.all.some((x) => x.kind === 'plain'), '关掉 Agent 模式后编辑，应自动回到 Agent 而不是普通对话');
    assert.ok(await ev(() => document.getElementById('btnAgent').classList.contains('agent-on')), 'Agent 模式应被重新打开');
    /* ② 没有工作区 → 预检拒绝 */
    const n0 = await ev(() => ZC.Sessions.list.length);
    await ev(() => { window.__root = ZC.AgentFS.root; ZC.AgentFS.root = null; });
    const id1 = await ev(() => ZC.Sessions.msgs()[0].id);
    await ev((id1) => { ZC.Chat.applyEdit(ZC.Chat.findMsg(id1), '不该生效'); }, id1);
    await page.waitForTimeout(500);
    const r2 = await ev(() => ({ n: ZC.Sessions.list.length, text: ZC.Chat.userText(ZC.Sessions.msgs()[0]), len: ZC.Sessions.msgs().length }));
    await ev(() => { ZC.AgentFS.root = window.__root; });
    assert.deepStrictEqual(r2, { n: n0, text: '第二次编辑', len: 2 }, '预检失败时对话应原封不动：' + JSON.stringify(r2));
    void r;
  });
  await bcheck('[浏览器] 普通聊天消息的编辑重发行为不变：仍走普通对话，不会被带进 Agent', async () => {
    reset();
    await ev(() => {
      const s = ZC.Sessions.create(true, 'chat'); s.projectId = 'pj1'; ZC.Sessions.switchTo(s.id);
      s.messages.push({ id: 'u1', role: 'user', content: '旧问题', ts: 1 }, { id: 'a1', role: 'assistant', content: '旧回答', ts: 2, meta: { model: 'm' } });
      ZC.Mode.follow(); ZC.Sessions.save();
    });
    await ev(() => { ZC.Chat.applyEdit(ZC.Chat.findMsg('u1'), '新问题'); });
    await waitFor(() => ev(() => !ZC.Chat.busy && ZC.Sessions.msgs().length === 2 && ZC.Chat.userText(ZC.Sessions.msgs()[0]) === '新问题'), 15000, '普通编辑完成');
    assert.ok(mock.all.some((x) => x.kind === 'plain') && !mock.all.some((x) => x.kind === 'main'), '普通消息不该进 Agent');
    assert.ok(!(await ev(() => !!(ZC.Sessions.msgs()[1].meta && ZC.Sessions.msgs()[1].meta.agent))), '回答不该带 agent 标记');
  });

  /* ---------- 归档 / 分支在项目视图里可见 ---------- */
  await bcheck('[浏览器] 「编辑前」备份继承项目：选中项目时，在来源对话下面（折叠区）能看到它，不用点「显示全部」；v2.34 起自动备份不再堆进「归档」', async () => {
    await ev(() => { ZC.Projects.setFilter('pj1'); });
    const cs = await ev(() => { const s = ZC.Sessions.create(true, 'code'); s.projectId = 'pj1'; ZC.Sessions.switchTo(s.id); ZC.Mode.follow(); ZC.Agent.backend = 'local'; ZC.Agent._enter(); return s.id; });
    reset();
    await send('第一问'); await send('第二问');
    const first = await ev(() => ZC.Sessions.msgs()[0].id);
    await ev((first) => { ZC.Chat.applyEdit(ZC.Chat.findMsg(first), '第一问（改）'); }, first);
    await waitFor(() => ev(() => !ZC.Chat.busy && ZC.Sessions.msgs().length === 2), 15000, '编辑重发完成');
    const bk = await ev(() => { const b = ZC.Sessions.list.filter((s) => s.kind === 'backup' && s.parentId === ZC.Sessions.curId); const last = b[b.length - 1]; return { n: b.length, id: last && last.id, pid: last && last.projectId, mode: last && last.mode, ack: !!(last && last.projAck), msgs: last && last.messages.length, arch: !!(last && last.archived) }; });
    assert.ok(bk.n >= 1 && bk.pid === 'pj1' && bk.mode === 'code' && bk.msgs === 4, JSON.stringify(bk));
    assert.ok(bk.ack, '备份里还包含「已读」那条回答，应带上已读记录');
    assert.ok(!bk.arch, '自动备份应折叠在来源对话下面，而不是堆进「归档」');
    await ev(() => { ZC.ZX.tagFilter = ''; ZC.Sessions.save(); ZC.View.renderSessions(); });
    const kids = () => ev((id) => { const k = document.querySelector('#sessionList .sess-kids:not([hidden])'); return k ? [...k.querySelectorAll('.sess')].map((n) => n.getAttribute('data-id')) : null; }, bk.id);
    assert.strictEqual(await kids(), null, '默认收起，列表里只有真正的对话');
    const cur = await ev(() => ZC.Sessions.curId);
    await page.click('#sessionList .sess[data-id="' + cur + '"] .s-fork'); await page.waitForTimeout(250);
    const opened = await kids();
    assert.ok(opened && opened.includes(bk.id), '展开后应在项目视图里看到备份：' + JSON.stringify(opened));
    await page.click('#sessionList .sess[data-id="' + cur + '"] .s-fork'); await page.waitForTimeout(150);
    await ev(() => { ZC.ZX.tagFilter = ''; ZC.Sessions.save(); });
  });
  await bcheck('[浏览器] 手动「从这里创建分支」：分支属于同一个项目、同一模式；侧栏计数不含归档，归档计数只算当前项目', async () => {
    const r = await ev(() => {
      const ms = ZC.Sessions.msgs(); const a = ms[ms.length - 1];
      const f = ZC.ZX.forkSession(a, {});
      const cnt = ZC.Projects.count('pj1');
      ZC.Projects.setFilter('pj2');
      ZC.Sessions.save();
      const chip2 = [...document.querySelectorAll('.zx-chip')].map((n) => n.textContent);
      ZC.Projects.setFilter('pj1');
      return { pid: f.projectId, mode: f.mode, ackKept: !!f.projAck, cnt: cnt, chip2: chip2 };
    });
    assert.strictEqual(r.pid, 'pj1'); assert.strictEqual(r.mode, 'code'); assert.ok(r.ackKept, '分支应继承已读记录');
    assert.ok(!r.chip2.some((t) => /归档/.test(t)), '另一个项目里不该出现 pj1 的归档数：' + JSON.stringify(r.chip2));
  });
  await bcheck('[浏览器] 旧数据修复：没有 projectId 的旧分支，按来源对话补上（只修一次）', async () => {
    const r = await ev(() => {
      const par = ZC.Sessions.cur();
      const old = { id: 'oldfork', title: '（编辑前）旧备份', createdAt: 1, updatedAt: 1, messages: [{ id: 'x1', role: 'user', content: 'q' }], mode: 'code', parentId: par.id, forkAt: 'x1', archived: true };
      ZC.Sessions.list.push(old);
      localStorage.removeItem('zc_gura_proj_branch_fix');
      const done = ZC.Projects.repairBranches();
      const again = ZC.Projects.repairBranches();
      return { done, again, pid: old.projectId, parent: par.projectId };
    });
    assert.ok(r.done && !r.again && r.pid === r.parent && r.pid === 'pj1', JSON.stringify(r));
  });
  await bcheck('[浏览器] 项目视图里新建 / 删除当前对话 / 切换聊天·代码模式落到的空白对话，都归入当前项目', async () => {
    const r = await ev(() => {
      const out = {}; ZC.Projects.setFilter('pj1');
      const keep = ZC.Sessions.msgs().length; if (!keep) { ZC.Sessions.msgs().push({ id: 'k1', role: 'user', content: 'x', ts: 1 }); }
      const a = ZC.Sessions.create(true, 'code'); out.created = a.projectId;
      ZC.Sessions.curId = a.id; const b = ZC.Sessions.create(true, 'chat'); out.chat = b.projectId;
      ZC.Projects.setFilter('');
      const c = ZC.Sessions.create(true, 'code'); out.noFilter = c.projectId || '';
      ZC.Projects.setFilter('pj1');
      return out;
    });
    assert.deepStrictEqual(r, { created: 'pj1', chat: 'pj1', noFilter: '' }, JSON.stringify(r));
  });
  await bcheck('[浏览器] 在项目视图里删除当前对话：优先落到同一项目里的对话，不跳出项目', async () => {
    const r = await ev(() => {
      ZC.Projects.setFilter('pj1');
      const mk = (id, pid) => { const s = { id, title: id, createdAt: Date.now(), updatedAt: Date.now() + (id === 'in1' ? 5 : 9), messages: [{ id: id + 'm', role: 'user', content: 'x', ts: 1 }], mode: 'code' }; if (pid) s.projectId = pid; ZC.Sessions.list.push(s); return s; };
      mk('in1', 'pj1'); mk('out1', ''); const cur = mk('cur1', 'pj1'); cur.updatedAt = Date.now() + 20;
      ZC.Sessions.switchTo('cur1'); ZC.Sessions.remove('cur1');
      const now = ZC.Sessions.cur();
      return { pid: now.projectId, id: now.id !== 'out1' };
    });
    assert.deepStrictEqual(r, { pid: 'pj1', id: true }, JSON.stringify(r));
  });
  await bcheck('[浏览器] 项目弹窗：「指令只读一次」开关可开关并随项目保存；新建项目默认开启', async () => {
    await ev(() => { ZC.Projects.openEditor(null); });
    const on0 = await ev(() => document.getElementById('pjOnce').checked);
    await ev(() => { document.getElementById('pjName').value = '开关测试'; document.getElementById('pjOnce').checked = false; document.getElementById('pjSave').click(); });
    const r = await ev(() => { const p = ZC.Projects.list.filter((x) => x.name === '开关测试')[0]; return p && p.readOnce; });
    await ev(() => { const p = ZC.Projects.list.filter((x) => x.name === '开关测试')[0]; ZC.Projects.openEditor(p.id); });
    const again = await ev(() => document.getElementById('pjOnce').checked);
    await ev(() => { document.getElementById('pjClose').click(); });
    assert.deepStrictEqual([on0, r, again], [true, false, false]);
  });
  await bcheck('[浏览器] 桌面：整个流程没有脚本错误', async () => { assert.deepStrictEqual(D.errs, []); });

  /* ---------- 手机：画面固定 ---------- */
  const M = await makePage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  M.page.setDefaultTimeout(10000);
  await bcheck('[浏览器·手机] viewport 禁缩放；项目弹窗里所有输入框 ≥16px（不再触发 iOS 自动放大）', async () => {
    const r = await M.ev(() => {
      const meta = document.querySelector('meta[name=viewport]').content;
      ZC.Projects.openEditor(null);
      const fs = ['pjName', 'pjInstr'].map((id) => parseFloat(getComputedStyle(document.getElementById(id)).fontSize));
      document.getElementById('pjPasteTg').click();
      const fs2 = ['pjPTitle', 'pjPText'].map((id) => parseFloat(getComputedStyle(document.getElementById(id)).fontSize));
      const inp = parseFloat(getComputedStyle(document.getElementById('input')).fontSize);
      return { meta, fs, fs2, inp, coarse: matchMedia('(pointer:coarse)').matches, ta: getComputedStyle(document.documentElement).touchAction, star: getComputedStyle(document.getElementById('pjName')).touchAction };
    });
    assert.ok(/maximum-scale=1/.test(r.meta) && /user-scalable=no/.test(r.meta), r.meta);
    assert.ok(r.coarse, '模拟的手机应是触屏（pointer: coarse）');
    assert.ok([...r.fs, ...r.fs2, r.inp].every((x) => x >= 16), '输入框字号：' + JSON.stringify(r));
    assert.strictEqual(r.star, 'manipulation');
  });
  await bcheck('[浏览器·手机] 弹窗边框固定：展开「粘贴文本」/ 加文件 / 收起，弹窗尺寸与位置纹丝不动；弹窗不超出屏幕；页面没有被顶偏、没有被放大', async () => {
    const box = () => M.ev(() => { const r = document.querySelector('.pj').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), sy: Math.round(window.scrollY), vv: window.visualViewport ? +window.visualViewport.scale.toFixed(3) : 1, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }; });
    const b0 = await box();
    await M.ev(() => { document.getElementById('pjPasteTg').click(); });
    await M.page.tap('#pjPTitle'); await M.page.fill('#pjPTitle', '随便写点'); await M.page.waitForTimeout(150);
    const b1 = await box();
    await M.ev(() => { document.getElementById('pjPasteTg').click(); document.getElementById('pjPick').focus(); });
    await M.page.waitForTimeout(150);
    const b2 = await box();
    for (const b of [b1, b2]) { assert.deepStrictEqual({ x: b.x, y: b.y, w: b.w, h: b.h }, { x: b0.x, y: b0.y, w: b0.w, h: b0.h }, '弹窗框变了：' + JSON.stringify([b0, b1, b2])); assert.strictEqual(b.sy, 0); assert.strictEqual(b.vv, 1); assert.ok(b.sw <= b.cw, '页面横向溢出'); }
    assert.ok(b0.y >= 0 && b0.y + b0.h <= 844 && b0.x >= 0 && b0.x + b0.w <= 390, '弹窗超出屏幕：' + JSON.stringify(b0));
    await M.ev(() => { document.getElementById('pjClose').click(); });
  });
  await bcheck('[浏览器·手机] 项目弹窗里的内容区能滚动、底部按钮始终可点（不被挤出屏幕）', async () => {
    await M.ev(() => { ZC.Projects.openEditor(null); const t = document.getElementById('pjInstr'); t.value = '长文本\n'.repeat(400); t.dispatchEvent(new Event('input')); });
    const r = await M.ev(() => { const b = document.querySelector('.pj-b'); const f = document.getElementById('pjSave').getBoundingClientRect(); return { scrollable: b.scrollHeight > b.clientHeight + 10, saveVisible: f.bottom <= innerHeight && f.top >= 0 }; });
    assert.deepStrictEqual(r, { scrollable: true, saveVisible: true }, JSON.stringify(r));
    await M.ev(() => { document.getElementById('pjClose').click(); });
  });
  await bcheck('[浏览器·手机] 无脚本错误', async () => { assert.deepStrictEqual(M.errs, []); });
  await browser.close();
} else {
  results.push(['SKIP', '[浏览器] 没有 Playwright / Chromium，浏览器部分已跳过', '']);
}

for (const r of results) console.log(r[0] + ' | ' + r[1] + (r[0] === 'FAIL' ? ' | ' + r[2] : ''));
const fail = results.filter((r) => r[0] === 'FAIL').length;
console.log('===== ' + results.filter((r) => r[0] === 'PASS').length + '/' + results.filter((r) => r[0] !== 'SKIP').length + ' 通过 =====');
process.exit(fail ? 1 : 0);
