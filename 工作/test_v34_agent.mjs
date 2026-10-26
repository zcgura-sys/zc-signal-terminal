// v2.34.0：Agent 动效（更接近 Claude）—— 思考块生命周期 / 实时 token 数 / 正文淡入 / 减少动态效果；以及 Agent 模式下的思考一致性守卫
// 真实 Chromium + 脚本化的「模型」+ 内存文件系统；断言的是真正渲染出来的时间线。
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
      (it.reasoning || []).forEach((t) => { b += 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: t }, index: 0 }] }) + '\n\n'; });
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


  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const thinkInfo = () => ev(() => Array.from(document.querySelectorAll('.think')).map((t) => ({ label: (t.querySelector('.tl') || {}).textContent || '', active: t.classList.contains('active'), collapsed: t.classList.contains('collapsed') })));

  mock.main.push(
    { reasoning: ['用户想了解这个项目。', '我先看一下目录结构，再读 README 和源码，最后给出总结。'], text: '我先浏览一下项目结构。', tools: [{ name: 'list_files', args: { path: '' } }], hold: 'h1' },
    { reasoning: ['目录里有 README 和 src。', '读一下 README 与 src/x.txt。'], tools: [{ name: 'read_file', args: { path: 'README.md' } }, { name: 'read_file', args: { path: 'src/x.txt' } }, { name: 'search_files', args: { query: 'demo' } }], hold: 'h2' },
    { reasoning: ['信息够了，整理成结论。'], text: '## 项目概览\n\n这是一个很小的演示项目：\n\n- `README.md` 只有一行标题\n- `src/x.txt` 存放示例文本\n\n**结论**：没有需要修改的地方。', hold: 'h3' }
  );
  await ev(() => { window.__fxSeen = false; window.__tokSeen = ''; new MutationObserver(() => { if (document.querySelector('.fx-in')) window.__fxSeen = true; const s = document.querySelector('.tcw-s'); if (s && /tokens/.test(s.textContent)) window.__tokSeen = s.textContent; }).observe(document.body, { subtree: true, childList: true, characterData: true }); });
  await send('帮我看看这个项目是做什么的');
  await sleep(900); release('h1'); await sleep(1500); release('h2');

  await check('[Agent 动效] 运行中：已结束的思考块是「已思考」、不再流光、已折叠，界面上不残留「正在思考…」', async () => {
    await waitFor(() => ev(() => document.querySelectorAll('.think').length >= 1), 6000, '出现思考块');
    await sleep(600);
    const ts = await thinkInfo(); assert.ok(ts.length >= 1, '至少一个思考块');
    ts.forEach((t) => { assert.ok(/^已思考( \d+ 秒)?$/.test(t.label), '标题：' + t.label); assert.ok(!t.active, '不应还在流光'); assert.ok(t.collapsed, '应已折叠'); });
    assert.ok(!(await ev(() => document.body.innerText.includes('正在思考…'))), '不应残留「正在思考…」');
  });
  await check('[Agent 动效] 运行中：状态行显示实时 token 数（↓ N tokens）', async () => {
    const t = await waitFor(() => ev(() => window.__tokSeen), 4000, 'token 计数');
    assert.ok(/↓ [\d.,]+k? tokens/.test(t), t);
    assert.ok(/^\d+(\.\d+)?s|^\d+m/.test(t.trim()) || /\d+(\.\d+)?s/.test(t), '同时带耗时：' + t);
  });

  release('h3'); await idle();
  await sleep(500);
  await check('[Agent 动效] 收尾：思考块「已思考 N 秒」，最终消息记录 thinkSec', async () => {
    const ts = await thinkInfo(); const last = ts[ts.length - 1];
    assert.ok(last && /^已思考 \d+ 秒$/.test(last.label), JSON.stringify(ts));
    assert.ok(ts.every((t) => !t.active && t.collapsed), JSON.stringify(ts));
    const m = await ev(() => { const ms = ZC.Sessions.msgs(); return ms[ms.length - 1].meta || {}; });
    assert.ok(m.thinkSec >= 1, 'thinkSec=' + m.thinkSec);
    assert.ok(!(await ev(() => document.body.innerText.includes('正在思考…'))));
  });
  await check('[Agent 动效] 正文流式时新文字走淡入（.fx-in），完成后文字内容不变', async () => {
    assert.ok(await ev(() => window.__fxSeen), '没出现过 .fx-in');
    const txt = await ev(() => document.body.innerText);
    assert.ok(txt.includes('项目概览') && txt.includes('没有需要修改的地方'), '正文被淡入 span 破坏');
  });

  await check('[Agent 动效] 单元：思考块生命周期（流光 / 秒数 / 自动折叠 / 手动展开不被收回）', async () => {
    const r = await ev(() => {
      const A = ZC.AgentAnim, out = {};
      const mk = () => { const th = document.createElement('div'); th.className = 'think'; th.innerHTML = '<button class="think-h" aria-expanded="true"><span class="tl">x</span></button><div class="think-b"></div>'; return th; };
      const h = { think: mk(), _tk: { t0: Date.now() - 5000, t1: 0 } };
      A.syncThink(h); out.live = [h.think.querySelector('.tl').textContent, h.think.classList.contains('active'), h.think.classList.contains('collapsed')];
      h._tk.t1 = Date.now(); A.syncThink(h); out.done = [h.think.querySelector('.tl').textContent, h.think.classList.contains('active'), h.think.classList.contains('collapsed'), h.think.querySelector('.think-h').getAttribute('aria-expanded')];
      const u = { think: mk(), _tk: { t0: Date.now() - 3000, t1: Date.now() } }; u.think.setAttribute('data-user', '1'); A.syncThink(u); out.user = u.think.classList.contains('collapsed');
      const q = { t0: 1000, t1: 1400 }; out.short = A.thinkLabel(q, 5000); out.fresh = A.thinkLabel({ t0: 1000, t1: 0 }, 1500);
      return out;
    });
    assert.deepStrictEqual(r.live, ['正在思考…（5 秒）', true, false]);
    assert.deepStrictEqual(r.done, ['已思考 5 秒', false, true, 'false']);
    assert.strictEqual(r.user, false, '用户手动展开过的不能被自动收回');
    assert.strictEqual(r.short, '已思考'); assert.strictEqual(r.fresh, '正在思考…');
  });
  await check('[Agent 动效] 单元：token 估算（流式估算 → 上一步用接口真实用量校正；太少不显示）', async () => {
    const r = await ev(() => {
      const A = ZC.AgentAnim, h = {}, out = {};
      A.tokens(h, { reasoning: 'a', content: '', toolCalls: [] }); out.tiny = h._tokTxt;
      const S1 = { reasoning: 'abcdefgh'.repeat(60), content: '', toolCalls: [], usage: { completion_tokens: 500 } };
      A.tokens(h, S1); out.s1 = h._tokTxt;
      A.tokens(h, { reasoning: '', content: '好'.repeat(40), toolCalls: [] }); out.s2 = h._tokTxt;
      return out;
    });
    assert.strictEqual(r.tiny, '');
    assert.ok(/^ · ↓ \d+ tokens$/.test(r.s1), r.s1);
    const n2 = parseInt(r.s2.replace(/\D/g, ''), 10); assert.ok(n2 >= 500, '换步后应累加上一步的真实用量 500：' + r.s2);
  });
  await check('[Agent 动效] 单元：淡入 span 只包新增文字、不改文本；重绘后接着走；超长文本自动停用', async () => {
    const r = await ev(async () => {
      const A = ZC.AgentAnim, out = {};
      const body = document.createElement('div'); document.body.appendChild(body);
      const h = { body, html: '1' }; body.innerHTML = '<p>Hello</p>'; A.fade(h);
      out.n1 = body.querySelectorAll('.fx-in').length; out.t1 = body.textContent;
      await new Promise((x) => setTimeout(x, 80)); body.innerHTML = '<p>Hello world, <b>bold</b></p>'; h.html = '2'; A.fade(h);
      out.t2 = body.textContent; out.fx2 = Array.from(body.querySelectorAll('.fx-in')).map((n) => n.textContent).join('|');
      out.spans = Array.from(body.querySelectorAll('.fx-in')).map((n) => [n.textContent, parseInt(n.style.animationDelay, 10)]);
      const big = document.createElement('div'); document.body.appendChild(big); big.textContent = 'x'.repeat(40001); const hb = { body: big, html: 'b' }; A.fade(hb); out.big = big.querySelectorAll('.fx-in').length;
      body.remove(); big.remove(); return out;
    });
    assert.ok(r.n1 >= 1 && r.t1 === 'Hello', JSON.stringify(r));
    assert.strictEqual(r.t2, 'Hello world, bold');
    assert.strictEqual(r.spans.map((x) => x[0]).join(''), 'Hello world, bold', '前后两批文字都要在淡入里：' + JSON.stringify(r.spans));
    const first = r.spans.find((x) => x[0] === 'Hello'), later = r.spans.filter((x) => x[0] !== 'Hello');
    assert.ok(first && first[1] <= -60, '先到的文字已经淡入了一会儿，延迟应 ≤ -60ms：' + JSON.stringify(r.spans));
    assert.ok(later.length >= 1 && later.every((x) => x[1] > first[1]), '后到的文字进度更靠前：' + JSON.stringify(r.spans));
    assert.strictEqual(r.big, 0);
  });
  await check('[Agent 动效] 「减少动态效果」：不加淡入 span', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const r = await ev(() => { const A = ZC.AgentAnim; const body = document.createElement('div'); document.body.appendChild(body); body.innerHTML = '<p>Hello</p>'; const h = { body, html: 'r' }; A.fade(h); const n = body.querySelectorAll('.fx-in').length; body.remove(); return { red: A.reduced(), n }; });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    assert.deepStrictEqual(r, { red: true, n: 0 });
  });
  /* ---------- Agent 模式下的思考一致性守卫 ---------- */
  await ev(() => {
    const P = ZC.Projects;
    P.list.push({ id: 'pga', name: '售前助手', instructions: '你是售前助手。思考时不要提及价格和折扣。', readOnce: true, guard: 'local', guardMax: 3, color: '#c6613f', createdAt: Date.now(), updatedAt: Date.now() });
    P.list.push({ id: 'pgb', name: '范围外', instructions: '不要思考关于未成年和成年的话题。', readOnce: true, guard: 'local', guardMax: 3, color: '#2b5cd9', createdAt: Date.now(), updatedAt: Date.now() });
    P.save(); ZC.Sessions.cur().projectId = 'pga';
  });
  await check('[Agent·守卫] 思考提到「价格」→ 中断重试；第 2 次请求带「指令纠偏」+ 项目指令全文再投喂；最终回答来自合规那次，并有标记', async () => {
    reset();
    mock.main.push(
      { reasoning: ['用户想了解功能，', '他可能还会问价格，价格是多少、折扣怎么给，', '这一段不该出现'], text: '违规那次的回答' },
      { reasoning: ['我来整理功能要点，', '按模块逐条说明。'], text: '合规的回答：功能如下……' }
    );
    await send('你们这个产品能做什么'); await idle(); await sleep(300);
    assert.strictEqual(mock.bodies.length, 2, '应正好 2 次请求，实际 ' + mock.bodies.length);
    assert.ok(!sysOf(mock.bodies[0]).includes('【指令纠偏'), '第一次不该带纠偏块');
    const s2 = sysOf(mock.bodies[1]);
    assert.ok(s2.includes('【指令纠偏 · 第 1 / 3 次】') && s2.includes('涉及「价格」') && s2.includes('第 2 次投喂') && s2.includes('思考时不要提及价格和折扣') && s2.includes('项目指令结束'), s2.slice(-500));
    const r = await ev(() => { const ms = ZC.Sessions.msgs(); const a = ms[ms.length - 1]; return { content: a.content, guard: (a.meta || {}).guard, chip: !!document.querySelector('.guard-chip'), text: document.body.innerText }; });
    assert.ok(r.guard && r.guard.retries === 1 && !r.guard.exhausted && r.chip, JSON.stringify(r.guard));
    assert.ok(r.text.includes('合规的回答') && !r.text.includes('违规那次的回答'), '界面上不该留违规那次的回答');
  });
  await check('[Agent·守卫] 第 1 次纠正后换个说法再犯（「他要求报价，价格方面……」），第 2 次照样被拦下；第 3 次合规才继续', async () => {
    reset();
    mock.main.push(
      { reasoning: ['用户想了解功能，', '他可能还会问价格，价格是多少、折扣怎么给，'], text: '违规 1' },
      { reasoning: ['他要求报价，', '价格方面可以分三档，企业版折扣更大。'], text: '违规 2（换了说法）' },
      { reasoning: ['我来整理功能要点，', '按模块逐条说明。'], text: '合规的回答' }
    );
    await send('这个产品怎么样'); await idle(); await sleep(300);
    assert.strictEqual(mock.bodies.length, 3, '应为 1 + 2 次重试，实际 ' + mock.bodies.length);
    const s3 = sysOf(mock.bodies[2]);
    assert.ok(s3.includes('【指令纠偏 · 第 2 / 3 次】') && s3.includes('已经被纠正了 2 次') && s3.includes('思考时不要提及价格和折扣'), s3.slice(-500));
    const g = await ev(() => { const ms = ZC.Sessions.msgs(); return (ms[ms.length - 1].meta || {}).guard; });
    assert.ok(g && g.retries === 2 && !g.exhausted && g.hits.length === 2, JSON.stringify(g));
    assert.ok((await ev(() => document.body.innerText)).includes('合规的回答'));
  });
  await check('[Agent·守卫] 一直违规：用满重试次数后放行最后一次（不会死循环），标记「已用满」', async () => {
    reset();
    for (let i = 0; i < 5; i++) mock.main.push({ reasoning: ['先想想价格，', '价格怎么定。'], text: '回答' + i });
    await send('再问一个'); await idle(); await sleep(300);
    assert.strictEqual(mock.bodies.length, 4, '1 次 + 3 次重试 = 4 次请求，实际 ' + mock.bodies.length);
    const g = await ev(() => { const ms = ZC.Sessions.msgs(); return (ms[ms.length - 1].meta || {}).guard; });
    assert.ok(g && g.retries === 3 && g.exhausted === true, JSON.stringify(g));
  });
  await check('[Agent·守卫] 范围外：涉及未成年 / 年龄的指令不被执行，思考里出现也不重试', async () => {
    reset(); await ev(() => { ZC.Sessions.cur().projectId = 'pgb'; });
    mock.main.push({ reasoning: ['用户问到年龄，先想想未成年相关内容。'], text: '正常回答' });
    await send('问个问题'); await idle(); await sleep(300);
    assert.strictEqual(mock.bodies.length, 1, '不该触发重试，实际 ' + mock.bodies.length);
    assert.ok(!(await ev(() => { const ms = ZC.Sessions.msgs(); return (ms[ms.length - 1].meta || {}).guard; })), '不该有守卫记录');
    await ev(() => { ZC.Sessions.cur().projectId = ''; });
  });
  await check('[Agent 动效] 无脚本错误', () => { assert.deepStrictEqual(D.errs, []); });
  await D.ctx.close();
  await browser.close();
} else results.push(['PASS', '（没有 Playwright / Chromium：浏览器部分跳过）', '']);

results.forEach((r) => console.log(r[0] + ' | ' + r[1] + (r[2] ? ' | ' + r[2] : '')));
const fail = results.filter((r) => r[0] === 'FAIL').length;
console.log('===== ' + (results.length - fail) + '/' + results.length + ' 通过 =====');
process.exit(fail ? 1 : 0);
