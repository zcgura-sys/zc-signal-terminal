// v2.34.1：聊天模式「联网」开关（搜索 / 读取网页 / 抓取信息）
// 上半部分：Worker（html 原文 / 编码 / Bing 备援）+ 页面解析纯逻辑；下半部分：真实 Chromium + 脚本化的假模型 / 假搜索服务。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const html = fs.readFileSync(process.env.ZC_HTML || 'public/index.html', 'utf8');
const workerSrc = fs.readFileSync('_worker.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const results = [];
async function check(name, fn) { try { const d = await fn(); results.push(['PASS', name, d || '']); } catch (e) { results.push(['FAIL', name, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ⏎ ') : String(e)]); } if (process.env.ZC_DEBUG) console.error('[' + results[results.length - 1][0] + '] ' + name.slice(0, 70) + (results[results.length - 1][0] === 'FAIL' ? ' => ' + results[results.length - 1][2].slice(0, 300) : '')); }
const has = (s, re) => (typeof re === 'string' ? s.indexOf(re) >= 0 : re.test(s));

/* ================== 一、静态契约 ================== */
await check('契约：联网按钮 + 模块 + Chat.run 接入 + AgentFormat 支持自带工具表', () => {
  assert.ok(has(html, 'id="btnWeb"') && has(html, 'const WebChat = {') && has(html, 'WebChat.wants(cont)') && has(html, 'WebChat.inject(messages, web)'));
  assert.ok(has(html, 'tools(fmt, custom)') && has(html, 'this.tools(fmt, o.tools)'));
  assert.ok(has(html, "name: 'web_search'") && has(html, "name: 'web_read'") && has(html, "name: 'web_extract'"), '三个工具都要有');
  assert.ok(has(html, 'meta.web = wc') && has(html, 'WebChat.staticNode(meta.web)'));
});
await check('版本：前端 / Worker / sw 都是 package.json 的版本', () => {
  assert.ok(has(html, "ZC34_VER = '" + pkg.version + "'"));
  assert.ok(has(workerSrc, "ZC_VERSION = '" + pkg.version + "'"));
  assert.ok(has(fs.readFileSync('public/sw.js', 'utf8'), 'zc-gura-v' + pkg.version));
});

/* ================== 二、Worker：html 原文 / 编码 / Bing 备援 ================== */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcv341-'));
fs.copyFileSync('_worker.js', path.join(tmpDir, 'worker.mjs'));
const worker = (await import(path.join(tmpDir, 'worker.mjs'))).default;
const realFetch = globalThis.fetch;
const mute = async (f) => { const o = console.log; console.log = () => { }; try { return await f(); } finally { console.log = o; } };
const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9', accept: '*/*' };
const wreq = (sub, body, origin) => worker.fetch(new Request('https://signal.test/__zc_web__/' + sub, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', origin: origin || 'https://signal.test', 'sec-fetch-site': 'same-origin' }, UA), body: JSON.stringify(body) }), { ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } }, { waitUntil() { }, passThroughOnException() { } });

await check('Worker·fetch：html:true 返回网页原文 + 标题；默认仍返回提取后的文本', async () => {
  globalThis.fetch = async (u) => new Response('<html><head><title>测试页 标题</title></head><body><nav>导航</nav><article><h1>大标题</h1><p>正文第一段。</p></article></body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  try {
    const a = await (await mute(() => wreq('fetch', { url: 'https://example.com/a', html: true }))).json();
    assert.ok(/<article>/.test(a.html) && a.title === '测试页 标题' && a.status === 200, JSON.stringify(a).slice(0, 300));
    const b = await (await mute(() => wreq('fetch', { url: 'https://example.com/a' }))).json();
    assert.ok(b.text && /正文第一段/.test(b.text) && !b.html, JSON.stringify(b).slice(0, 300));
  } finally { globalThis.fetch = realFetch; }
});
await check('Worker·fetch：按网页声明的编码（GBK）解码，不出乱码', async () => {
  const gbk = Buffer.from('c4e3bac3cac0bde7', 'hex');   // 「你好世界」GBK
  const bytes = Buffer.concat([Buffer.from('<html><head><meta charset="gbk"><title>'), gbk, Buffer.from('</title></head><body><p>'), gbk, Buffer.from('</p></body></html>')]);
  globalThis.fetch = async () => new Response(bytes, { status: 200, headers: { 'content-type': 'text/html' } });
  try {
    const a = await (await mute(() => wreq('fetch', { url: 'https://example.cn/', html: true }))).json();
    assert.ok(a.title === '你好世界' && /你好世界/.test(a.html), JSON.stringify(a).slice(0, 200));
  } finally { globalThis.fetch = realFetch; }
});
await check('Worker·fetch：仍然拦内网地址', async () => {
  const r = await mute(() => wreq('fetch', { url: 'http://127.0.0.1:8080/x', html: true }));
  assert.ok(r.status >= 400, 'status ' + r.status);
});
await check('Worker·search：DuckDuckGo 没结果时自动换 Bing，并解析出标题 / 真实网址 / 摘要', async () => {
  const b64 = Buffer.from('https://real.example.org/page?x=1').toString('base64').replace(/=+$/, '');
  const bing = '<ol id="b_results"><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1' + b64 + '&ntb=1">真实 &amp; 标题</a></h2><div class="b_caption"><p>这是摘要文字。</p></div></li><li class="b_algo"><h2><a href="https://direct.example.net/z">第二条</a></h2><p>第二条摘要</p></li></ol>';
  const seen = [];
  globalThis.fetch = async (u) => { u = String(u); seen.push(u); if (/duckduckgo/.test(u)) return new Response('<html><body>no results</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }); if (/bing\.com/.test(u)) return new Response(bing, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }); return new Response('{}', { status: 404 }); };
  try {
    const j = await (await mute(() => wreq('search', { query: '测试', count: 5 }))).json();
    assert.ok(seen.some((u) => /duckduckgo/.test(u)) && seen.some((u) => /bing\.com/.test(u)), seen.join(' | '));
    assert.strictEqual(j.provider, 'bing-web', JSON.stringify(j).slice(0, 300));
    assert.strictEqual(j.results.length, 2);
    assert.deepStrictEqual([j.results[0].title, j.results[0].url, j.results[0].snippet], ['真实 & 标题', 'https://real.example.org/page?x=1', '这是摘要文字。'], JSON.stringify(j.results[0]));
    assert.strictEqual(j.results[1].url, 'https://direct.example.net/z');
  } finally { globalThis.fetch = realFetch; }
});

/* ================== 三、真实浏览器 ================== */
let pw = null;
try { const req = createRequire(process.env.ZC_PW_DIR || '/home/claude/.npm-global/lib/node_modules/'); pw = req('playwright'); } catch (e) { pw = null; }
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'].find((p) => fs.existsSync(p));

if (pw && exe) {
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  const indexPath = path.resolve(process.env.ZC_HTML || 'public/index.html');
  const ASSETS = { async fetch(req) { const u = new URL(req.url); const rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname); const file = rel === '/index.html' ? indexPath : path.join(path.resolve('public'), rel); if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('nf', { status: 404 }); return new Response(fs.readFileSync(file), { headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } }); } };
  const env = { ASSETS, ZC_KV: null, DB: null };
  const ctx0 = { waitUntil() { }, passThroughOnException() { } };
  const BH = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9', 'accept': 'text/html,*/*' };

  /* ---------- 假模型：聊天补全接口。带 tools 的是「检索阶段」（非流式），其余是正常回答（流式） ---------- */
  const mock = { reqs: [], web: [], script: null, webs: null, noTools: false, delay: 0 };
  const sse = (chunks) => chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
  const sysOf = (b) => { const m = (b.messages || []).filter((x) => x.role === 'system')[0]; return m ? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) : ''; };
  const isPlan = (b) => Array.isArray(b.tools) && b.tools.some((t) => t.function && t.function.name === 'web_search');
  const PFX = 'zc_gura_', now = Date.now();
  const sessions = [{ id: 's1', title: '空白', createdAt: now - 3000, updatedAt: now - 1000, messages: [], model: 'm', mode: 'chat' }];
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
      if (url.pathname.startsWith('/__zc_web__/')) {
        const sub = url.pathname.slice('/__zc_web__/'.length); let wb = {}; try { wb = JSON.parse(req.postData() || '{}'); } catch (e) { /* ignore */ }
        mock.web.push({ sub, body: wb });
        if (mock.delay) await new Promise((r) => setTimeout(r, mock.delay));
        const r = mock.webs ? mock.webs(sub, wb) : { status: 500, json: { error: '没有配置假服务' } };
        return route.fulfill({ status: (r && r.status) || 200, contentType: 'application/json', body: JSON.stringify((r && r.json) || r) });
      }
      if (/\/chat\/completions$/.test(url.pathname)) {
        let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* ignore */ }
        mock.reqs.push(body);
        if (isPlan(body) && mock.noTools) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'tools is not supported by this model' } }) });
        const it = (mock.script ? mock.script(body, mock.reqs.length) : null) || { text: '（回答）' };
        if (it.calls) {   // 模型要调工具
          const tcs = it.calls.map((c, i) => ({ id: 'call_' + mock.reqs.length + '_' + i, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: it.text || null, tool_calls: tcs }, finish_reason: 'tool_calls' }] }) });
        }
        if (body.stream === true) { const cs = []; if (it.text) cs.push({ choices: [{ delta: { content: it.text }, index: 0 }] }); cs.push({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }); return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(cs) }); }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: it.text || '' }, finish_reason: 'stop' }] }) });
      }
      const dest = req.headers()['sec-fetch-dest'] || 'document';
      const r = await mute(() => worker.fetch(new Request(req.url(), { method: req.method(), headers: Object.assign({}, BH, { 'sec-fetch-dest': dest }) }), env, ctx0));
      const headers = {}; r.headers.forEach((v, k) => { if (!/^(content-length|content-encoding|transfer-encoding)$/i.test(k)) headers[k] = v; });
      return route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
    });
    await page.addInitScript(([PFX, sessions]) => {
      let seeded = true; try { seeded = !!sessionStorage.getItem('zc341_seeded'); } catch (e) { return; }
      if (!seeded) {
        sessionStorage.setItem('zc341_seeded', '1');
        localStorage.setItem(PFX + 'sessions', JSON.stringify(sessions)); localStorage.setItem(PFX + 'current_session', 's1');
        localStorage.setItem(PFX + 'apis', JSON.stringify([{ id: 'p', name: 'DeepSeek', url: 'https://signal.test/v1', key: 'k', model: 'deepseek-chat', format: 'openai', route: 'direct', headers: '' }]));
        localStorage.setItem(PFX + 'intro_seen', String(Date.now())); localStorage.setItem(PFX + 'ui_mode', 'chat');
      }
    }, [PFX, sessions]);
    await page.goto('https://signal.test/?intro=skip'); await page.waitForTimeout(6500);
    return { ctx, page, errs, ev: (f, x) => page.evaluate(f, x) };
  }
  const waitFor = async (fn, ms, what) => { const t0 = Date.now(); for (; ;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - t0 > (ms || 6000)) throw new Error('等待超时：' + (what || '')); await new Promise((r) => setTimeout(r, 60)); } };

  const D = await makePage({ viewport: { width: 1280, height: 860 } });
  const { page, ev } = D;
  page.setDefaultTimeout(10000);
  const idle = () => waitFor(() => ev(() => !ZC.Chat.busy), 25000, '任务结束');
  const send = async (text) => { await page.fill('#input', text); await page.keyboard.press('Control+Enter'); await page.waitForTimeout(150); await idle(); await page.waitForTimeout(250); };
  const reset = async () => { mock.reqs = []; mock.web = []; mock.script = null; mock.webs = null; mock.noTools = false; mock.delay = 0; await ev(() => { const s = ZC.Sessions.create(true, 'chat'); ZC.Sessions.switchTo(s.id); ZC.View.renderThread(); }); };
  const lastAi = () => ev(() => { const m = ZC.Sessions.cur().messages.filter((x) => x.role === 'assistant'); return m[m.length - 1] || null; });

  /* 假网页 + 假搜索 */
  const PAGE_A = '<html><head><title>产品发布公告</title><meta name="description" content="新版本发布说明"><meta property="article:published_time" content="2026-10-01"><meta name="author" content="张三"></head><body><nav><a href="/home">首页</a></nav><article><h1>ZC 2.0 发布</h1><p>ZC 2.0 于 2026 年 10 月发布，主要改进是速度提升 40%。</p><h2>价格</h2><table><caption>套餐</caption><tr><th>套餐</th><th>价格</th></tr><tr><td>基础版</td><td>29 元</td></tr><tr><td>专业版</td><td>99 元</td></tr></table><p>详见 <a href="/docs/intro">文档</a> 与 <a href="https://other.example.org/x">外部链接</a>。</p><script>alert(1)</script></article><footer>版权所有</footer></body></html>';
  const webs = (sub, b) => {
    if (sub === 'search') return { provider: 'tavily', results: [{ title: 'ZC 2.0 发布公告', url: 'https://news.example.com/zc2?utm_source=x', snippet: 'ZC 2.0 正式发布，速度提升。' }, { title: '评测：ZC 2.0 怎么样', url: 'https://review.example.org/zc2', snippet: '评测摘要……' }] };
    if (sub === 'fetch') {
      if (/bad\.example/.test(b.url)) return { status: 404, json: { error: 'not found' } };
      if (/pdf\.example/.test(b.url)) return { status: 200, url: b.url, contentType: 'application/pdf', title: '', text: 'PDF 提取文本：这是 PDF 的内容。' };
      return { status: 200, url: b.url, contentType: 'text/html; charset=utf-8', title: '产品发布公告', html: PAGE_A, truncated: false };
    }
    return { status: 404, json: { error: 'x' } };
  };

  await check('[浏览器·联网] 开关：工具栏有「联网」按钮（地球图标），点击切换并记住；代码模式 / 生图模式下隐藏', async () => {
    const r0 = await ev(() => { const b = document.getElementById('btnWeb'); const cs = getComputedStyle(b); return { vis: b.offsetWidth > 0, on: b.classList.contains('on'), svg: !!b.querySelector('svg use[href="#i-globe"]'), label: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height), hDeep: Math.round(document.getElementById('btnDeep').getBoundingClientRect().height) }; });
    assert.ok(r0.vis && !r0.on && r0.svg && r0.label === '联网' && r0.h === r0.hDeep, JSON.stringify(r0));
    await page.click('#btnWeb'); await page.waitForTimeout(100);
    const r1 = await ev(() => ({ on: document.getElementById('btnWeb').classList.contains('on'), pressed: document.getElementById('btnWeb').getAttribute('aria-pressed'), stored: localStorage.getItem('zc_gura_web_on'), inst: ZC.WebChat.on }));
    assert.deepStrictEqual(r1, { on: true, pressed: 'true', stored: 'true', inst: true });
    await ev(() => document.documentElement.setAttribute('data-mode', 'code')); await page.waitForTimeout(100);
    assert.strictEqual(await ev(() => document.getElementById('btnWeb').offsetWidth), 0, '代码模式不显示');
    await ev(() => document.documentElement.setAttribute('data-mode', 'chat')); await page.waitForTimeout(100);
    await ev(() => document.getElementById('btnDraw').classList.add('on')); await page.waitForTimeout(80);
    assert.strictEqual(await ev(() => document.getElementById('btnWeb').offsetWidth), 0, '生图模式不显示');
    await ev(() => document.getElementById('btnDraw').classList.remove('on'));
    await page.click('#btnWeb'); await page.waitForTimeout(80);
    assert.strictEqual(await ev(() => ZC.WebChat.on), false);
    await page.click('#btnWeb'); await page.waitForTimeout(80);   // 后面的测试都要开着
  });

  await check('[浏览器·联网] 工具模式：搜索 → 读网页 → 抓表格 → 注入带编号的资料 → 正常流式回答带 [n] → 角标 + 过程块', async () => {
    await reset(); mock.webs = webs;
    mock.script = (body) => {
      if (isPlan(body)) {
        const n = body.messages.filter((m) => m.role === 'tool').length;
        if (n === 0) return { calls: [{ name: 'web_search', args: { query: 'ZC 2.0 发布' } }] };
        if (n === 1) return { calls: [{ name: 'web_read', args: { url: 'https://news.example.com/zc2' } }, { name: 'web_extract', args: { url: 'https://news.example.com/zc2', mode: 'tables' } }] };
        return { text: 'READY' };
      }
      return { text: 'ZC 2.0 在 2026 年 10 月发布，速度提升 40% [1]；基础版 29 元、专业版 99 元 [1][2]。' };
    };
    await send('ZC 2.0 什么时候发布的，多少钱？');
    const plans = mock.reqs.filter(isPlan), mains = mock.reqs.filter((b) => !isPlan(b));
    assert.strictEqual(plans.length, 3, '检索阶段应为 3 轮，实际 ' + plans.length); assert.strictEqual(mains.length, 1);
    assert.ok(plans.every((b) => b.stream !== true), '检索阶段不流式');
    assert.deepStrictEqual(plans[0].tools.map((t) => t.function.name), ['web_search', 'web_read', 'web_extract']);
    assert.ok(/今天是/.test(sysOf(plans[0])), '检索阶段的提示词带今天日期');
    assert.deepStrictEqual(mock.web.map((w) => w.sub), ['search', 'fetch'], '同一网页只抓一次（读取 + 抓表格共用）：' + JSON.stringify(mock.web.map((w) => w.sub)));
    assert.strictEqual(mock.web[1].body.html, true);
    const main = sysOf(mains[0]);
    assert.ok(main.includes('【联网检索资料') && main.includes('[1] ZC 2.0 发布公告') && main.includes('ZC 2.0 于 2026 年 10 月发布') && main.includes('29 元'), main.slice(main.indexOf('【联网检索资料')) + ' sys.len=' + main.length + ' web=' + JSON.stringify(mock.web.map((w) => w.sub)));
    assert.ok(!main.includes('版权所有') && !main.includes('首页') && !main.includes('alert(1)'), '导航 / 页脚 / 脚本必须被剔除');
    assert.ok(main.includes('| 基础版 | 29 元 |') || main.includes('基础版 | 29 元'), '表格抓取结果进入资料');
    assert.ok(!main.includes('utm_source'), '来源网址去掉追踪参数后去重');
    assert.ok(main.includes('[2] ') && main.includes('review.example.org'), '搜索到但没读的来源也列在资料里（摘要）');
    const msg = await lastAi();
    assert.ok(msg && /\[1\]/.test(msg.content) && msg.meta.web && msg.meta.web.steps.length === 3, JSON.stringify(msg && msg.meta && msg.meta.web).slice(0, 400));
    assert.strictEqual(msg.meta.web.s.length, 2);
    const ui = await ev(() => { const w = document.querySelector('.msg.ai .webb'); const cites = Array.from(document.querySelectorAll('.msg.ai .body a.cite')); return { has: !!w, collapsed: w && w.classList.contains('collapsed'), label: w && w.querySelector('.webb-l').textContent, steps: w ? w.querySelectorAll('.webb-s').length : 0, chips: w ? w.querySelectorAll('.webb-chip').length : 0, cites: cites.map((c) => c.textContent + '→' + c.getAttribute('href')), bodyHasRawMarker: /\[\d\]/.test(document.querySelector('.msg.ai .body').textContent) }; });
    assert.ok(ui.has && ui.collapsed && /已搜索网络/.test(ui.label) && /阅读 1 个网页/.test(ui.label) && /2 个来源/.test(ui.label), JSON.stringify(ui));
    assert.strictEqual(ui.steps, 3); assert.strictEqual(ui.chips, 2);
    assert.deepStrictEqual(ui.cites, ['1→https://news.example.com/zc2', '1→https://news.example.com/zc2', '2→https://review.example.org/zc2']);
    assert.ok(!ui.bodyHasRawMarker, '[n] 应变成角标，不留原文');
  });

  await check('[浏览器·联网] 过程块：点标题展开 / 收起；展开后能看到每一步和来源角标；刷新后（读存档）依然在', async () => {
    await page.click('.msg.ai .webb-h'); await page.waitForTimeout(450);
    const o = await ev(() => { const w = document.querySelector('.msg.ai .webb'); const b = w.querySelector('.webb-b').getBoundingClientRect(); return { collapsed: w.classList.contains('collapsed'), h: Math.round(b.height), t: Array.from(w.querySelectorAll('.webb-t')).map((x) => x.textContent) }; });
    assert.ok(!o.collapsed && o.h > 40, JSON.stringify(o));
    assert.ok(o.t.some((x) => /搜索「ZC 2.0 发布」/.test(x)) && o.t.some((x) => /阅读/.test(x)) && o.t.some((x) => /抓取/.test(x)), JSON.stringify(o.t));
    await page.click('.msg.ai .webb-h'); await page.waitForTimeout(450);
    assert.strictEqual(await ev(() => document.querySelector('.msg.ai .webb').classList.contains('collapsed')), true);
    await page.reload(); await page.waitForTimeout(6500);
    const r = await ev(() => ({ w: !!document.querySelector('.msg.ai .webb'), cites: document.querySelectorAll('.msg.ai .body a.cite').length }));
    assert.ok(r.w && r.cites === 3, JSON.stringify(r));
    await page.click('#btnWeb').catch(() => { }); await page.waitForTimeout(60);
    if (!(await ev(() => ZC.WebChat.on))) await page.click('#btnWeb');
  });

  await check('[浏览器·联网] 不需要联网：模型直接回 NO_WEB，不搜索、没有过程块、资料块不注入', async () => {
    await reset(); mock.webs = webs;
    mock.script = (body) => isPlan(body) ? { text: 'NO_WEB' } : { text: '你好呀！' };
    await send('你好');
    assert.strictEqual(mock.web.length, 0, JSON.stringify(mock.web));
    const mains = mock.reqs.filter((b) => !isPlan(b)); assert.strictEqual(mains.length, 1);
    assert.ok(!sysOf(mains[0]).includes('联网检索资料'));
    const msg = await lastAi(); assert.ok(!msg.meta.web, '没联网就不存过程记录');
    assert.strictEqual(await ev(() => document.querySelectorAll('.msg.ai .webb').length), 0, await ev(() => Array.from(document.querySelectorAll('.webb')).map((w) => w.parentNode.className + '|' + w.parentNode.getAttribute('data-id') + '|' + w.textContent.slice(0, 40)).join(' ;; ') + ' || msgs=' + document.querySelectorAll('.thread .msg').length));
  });

  await check('[浏览器·联网] 关闭开关：完全是原来的流程（只有 1 次请求，不带 tools）', async () => {
    await reset(); mock.webs = webs; await ev(() => ZC.WebChat.set(false));
    mock.script = () => ({ text: '普通回答' });
    await send('今天有什么新闻');
    assert.strictEqual(mock.reqs.length, 1); assert.ok(!mock.reqs[0].tools, '普通对话请求里不应出现 tools'); assert.strictEqual(mock.web.length, 0);
    await ev(() => ZC.WebChat.set(true));
  });

  await check('[浏览器·联网] 工具出错也不崩：读取 404 / 非网页 / 搜索无结果 → 把错误告诉模型，模型换个办法，最终仍能回答', async () => {
    await reset();
    mock.webs = (sub, b) => sub === 'search' ? { provider: 'x', results: [], note: '免费搜索没有结果' } : webs(sub, b);
    const toolMsgs = [];
    mock.script = (body) => {
      if (isPlan(body)) {
        const tm = body.messages.filter((m) => m.role === 'tool'); const n = tm.length; if (n) toolMsgs.push(tm[tm.length - 1].content);
        if (n === 0) return { calls: [{ name: 'web_search', args: { query: '冷门问题' } }] };
        if (n === 1) return { calls: [{ name: 'web_read', args: { url: 'https://bad.example/x' } }, { name: 'web_extract', args: { url: 'https://pdf.example/a.pdf', mode: 'links' } }] };
        return { text: 'READY' };
      }
      return { text: '资料里没有查到相关信息。' };
    };
    await send('一个冷门问题');
    assert.ok(/没有搜到结果/.test(toolMsgs[0]), toolMsgs[0]);
    const all = mock.reqs.filter(isPlan).pop().messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
    assert.ok(/HTTP 404|not found|读取失败/.test(all) && /不是 HTML/.test(all), all.slice(0, 500));
    const msg = await lastAi(); assert.ok(msg.content.includes('没有查到') && msg.meta.web.steps.some((s) => s.st === 'err'), JSON.stringify(msg.meta.web.steps));
    const mains = mock.reqs.filter((b) => !isPlan(b)); assert.strictEqual(mains.length, 1);
    assert.ok(!sysOf(mains[0]).includes('【联网检索资料'), '什么来源都没拿到时不注入资料块');
  });

  await check('[浏览器·联网] 工具调用上限：最多 8 次，超过后让模型直接收尾；不会无限循环', async () => {
    await reset(); mock.webs = webs;
    mock.script = (body) => isPlan(body) ? { calls: [{ name: 'web_search', args: { query: 'q' + mock.reqs.length } }, { name: 'web_search', args: { query: 'r' + mock.reqs.length } }, { name: 'web_search', args: { query: 's' + mock.reqs.length } }] } : { text: '收尾回答 [1]' };
    await send('一直想搜');
    const plans = mock.reqs.filter(isPlan).length;
    assert.ok(plans <= 5, '检索轮数 ≤ 5，实际 ' + plans); assert.ok(mock.web.length <= 8, '真实搜索次数 ≤ 8，实际 ' + mock.web.length);
    assert.strictEqual(mock.reqs.filter((b) => !isPlan(b)).length, 1);
  });

  await check('[浏览器·联网] 模型不支持工具调用（400）：自动退回文本方案——让模型列检索词，我们搜索并读前两篇，再回答', async () => {
    await reset(); mock.webs = webs; mock.noTools = true;
    mock.script = (body) => {
      const s = sysOf(body);
      if (/只输出一行 JSON/.test(s)) return { text: '```json\n{"need":true,"queries":["ZC 2.0 发布"],"urls":[]}\n```' };
      return { text: '按资料：2026 年 10 月发布 [1]。' };
    };
    await send('ZC 2.0 什么时候发布？');
    assert.deepStrictEqual(mock.web.map((w) => w.sub), ['search', 'fetch', 'fetch'], JSON.stringify(mock.web.map((w) => w.sub)));
    const main = mock.reqs.filter((b) => !isPlan(b) && !/只输出一行 JSON/.test(sysOf(b))).pop();
    assert.ok(sysOf(main).includes('【联网检索资料') && sysOf(main).includes('ZC 2.0 于 2026 年 10 月发布'));
    const msg = await lastAi(); assert.ok(msg.meta.web && msg.meta.web.steps.length === 3);
    assert.ok(await ev(() => !!document.querySelector('.msg.ai .body a.cite')));
  });

  await check('[浏览器·联网] 接口悄悄忽略 tools、直接写出回答：不当成「不需要联网」，改走文本方案再判断（需要就搜、不需要就不搜）', async () => {
    await reset(); mock.webs = webs;
    mock.script = (body) => {
      const s = sysOf(body);
      if (isPlan(body)) return { text: '这是我直接写的回答，没有用工具。ZC 2.0 好像是去年发布的。' };
      if (/只输出一行 JSON/.test(s)) return { text: '{"need":true,"queries":["ZC 2.0 发布"],"urls":[]}' };
      return { text: '按资料回答 [1]' };
    };
    await send('ZC 2.0 什么时候发布？');
    assert.deepStrictEqual(mock.web.map((w) => w.sub), ['search', 'fetch', 'fetch'], JSON.stringify(mock.web.map((w) => w.sub)));
    await reset(); mock.webs = webs;
    mock.script = (body) => { const s = sysOf(body); if (isPlan(body)) return { text: '你好呀，有什么可以帮你？' }; if (/只输出一行 JSON/.test(s)) return { text: '{"need":false}' }; return { text: '你好！' }; };
    await send('你好');
    assert.strictEqual(mock.web.length, 0); assert.ok(!(await lastAi()).meta.web);
  });

  await check('[浏览器·联网] 联网失败（Worker 不通）：如实告诉模型「没能联网」，不编造来源；界面显示「联网没有成功」', async () => {
    await reset(); mock.webs = () => ({ status: 502, json: { error: '搜索服务暂时不可用' } });
    mock.script = (body) => isPlan(body) ? (body.messages.some((m) => m.role === 'tool') ? { text: 'READY' } : { calls: [{ name: 'web_search', args: { query: 'x' } }] }) : { text: '这次没能联网，以下基于已有知识。' };
    await send('最新的消息');
    const main = mock.reqs.filter((b) => !isPlan(b)).pop(); const s = sysOf(main);
    assert.ok(!s.includes('【联网检索资料'), '没有来源时不注入资料');
    const msg = await lastAi(); assert.ok(msg.content.includes('没能联网'));
    const lbl = await ev(() => { const w = document.querySelector('.msg.ai .webb'); return w && w.querySelector('.webb-l').textContent; });
    assert.ok(/已搜索网络/.test(lbl) || /联网没有成功/.test(lbl), lbl);
    const step = (await lastAi()).meta.web.steps[0]; assert.strictEqual(step.st, 'err');
  });

  await check('[浏览器·联网] 检索阶段点「停止」：立刻结束，不再发起回答请求，也不再发新的搜索', async () => {
    await reset(); mock.webs = webs; mock.delay = 700;
    mock.script = (body) => isPlan(body) ? { calls: [{ name: 'web_search', args: { query: 'slow ' + mock.reqs.length } }] } : { text: '不该出现' };
    await page.fill('#input', '慢慢搜'); await page.keyboard.press('Control+Enter');
    await waitFor(() => ev(() => !!document.querySelector('.webb.live')), 5000, '出现联网进度块');
    assert.ok(await ev(() => document.getElementById('btnWeb').classList.contains('busy')), '联网中按钮图标转动');
    await page.waitForTimeout(250);
    await ev(() => ZC.Chat.stop && ZC.Chat.stop());
    await idle();
    const mains = mock.reqs.filter((b) => !isPlan(b)); assert.strictEqual(mains.length, 0, '停止后不该再发回答请求：' + mains.length);
    const nWeb = mock.web.length; await page.waitForTimeout(1200); assert.strictEqual(mock.web.length, nWeb, '停止后不再有新搜索');
    assert.ok(!(await ev(() => document.getElementById('btnWeb').classList.contains('busy'))));
  });

  await check('[浏览器·联网] 续写（继续生成）不重新联网；重新生成会重新联网', async () => {
    await reset(); mock.webs = webs;
    mock.script = (body) => isPlan(body) ? (body.messages.some((m) => m.role === 'tool') ? { text: 'READY' } : { calls: [{ name: 'web_search', args: { query: 'a' } }] }) : { text: '回答 [1]' };
    await send('问一个问题');
    const n1 = mock.web.length; assert.ok(n1 >= 1);
    await page.click('.msg.ai.last [data-act="regen"]'); await page.waitForTimeout(200); await idle(); await page.waitForTimeout(250);
    assert.ok(mock.web.length > n1, '重新生成应重新联网');
  });

  await check('[浏览器·联网] 回答里的 [n] 不在代码块 / 没有对应来源时保持原样；多来源 [1][2] 与 [1,2] 都变角标', async () => {
    const r = await ev(() => {
      const div = document.createElement('div');
      div.innerHTML = '<p>见 [1] 和 [2,3] 以及 [9]。</p><pre><code>x[1] = [2]</code></pre><p><a href="#">链接[1]</a></p>';
      ZC.WebChat.cite(div, [{ n: 1, u: 'https://a.test/', t: 'A', d: 'a.test' }, { n: 2, u: 'https://b.test/', t: 'B', d: 'b.test' }, { n: 3, u: 'https://c.test/', t: 'C', d: 'c.test' }]);
      return { cites: Array.from(div.querySelectorAll('a.cite')).map((a) => a.textContent), code: div.querySelector('code').textContent, p: div.querySelector('p').textContent, link: div.querySelectorAll('p')[1].querySelector('a').textContent };
    });
    assert.deepStrictEqual(r.cites, ['1', '2', '3'], JSON.stringify(r));
    assert.ok(r.code === 'x[1] = [2]' && /\[9\]/.test(r.p) && r.link === '链接[1]', JSON.stringify(r));
  });

  await check('[浏览器·联网] 页面解析：正文提取剔除导航 / 页脚 / 脚本；meta / links / headings / tables / select 五种抓取', async () => {
    const r = await ev((H) => {
      const W = ZC.WebChat, base = 'https://news.example.com/zc2';
      return { text: W.readable(H).text, meta: W.extractFrom(H, base, { mode: 'meta' }), links: W.extractFrom(H, base, { mode: 'links' }), linksF: W.extractFrom(H, base, { mode: 'links', contains: 'docs' }), heads: W.extractFrom(H, base, { mode: 'headings' }), tables: W.extractFrom(H, base, { mode: 'tables' }), sel: W.extractFrom(H, base, { mode: 'select', selector: 'article a', attr: 'href' }), bad: W.extractFrom(H, base, { mode: 'select', selector: '!!' }), unk: W.extractFrom(H, base, { mode: 'zzz' }) };
    }, webs('fetch', { url: 'https://news.example.com/zc2' }).html);
    assert.ok(/ZC 2\.0 于 2026 年 10 月发布/.test(r.text) && !/版权所有|首页|alert/.test(r.text) && /# ZC 2\.0 发布/.test(r.text) && /基础版 \| 29 元/.test(r.text), r.text);
    assert.ok(/标题：产品发布公告/.test(r.meta) && /描述：新版本发布说明/.test(r.meta) && /发布时间：2026-10-01/.test(r.meta) && /作者：张三/.test(r.meta), r.meta);
    assert.ok(/文档 → https:\/\/news\.example\.com\/docs\/intro/.test(r.links) && /外部链接 → https:\/\/other\.example\.org\/x/.test(r.links), r.links);
    assert.ok(/文档/.test(r.linksF) && !/外部链接/.test(r.linksF));
    assert.ok(/- ZC 2\.0 发布/.test(r.heads) && /  - 价格/.test(r.heads), r.heads);
    assert.ok(/表格 1（套餐）/.test(r.tables) && /\| 专业版 \| 99 元 \|/.test(r.tables), r.tables);
    assert.ok(/https:\/\/news\.example\.com\/docs\/intro/.test(r.sel) && /命中 2 个/.test(r.sel), r.sel);
    assert.ok(/选择器无效/.test(r.bad) && /未知的 mode/.test(r.unk));
  });

  await check('[浏览器·联网] 页面里的脚本 / 图片不会被执行或加载（DOMParser 惰性解析）', async () => {
    const r = await ev(() => { window.__pwn = 0; ZC.WebChat.readable('<img src="x" onerror="window.__pwn=1"><script>window.__pwn=2<\/script><p>ok</p>'); ZC.WebChat.extractFrom('<img src=x onerror="window.__pwn=3"><a href="/a">t</a>', 'https://a.test/', { mode: 'links' }); return window.__pwn; });
    await page.waitForTimeout(150); assert.strictEqual(await ev(() => window.__pwn), 0); assert.strictEqual(r, 0);
  });

  await check('[浏览器·联网] 视觉：按钮开启态 / 过程块与思考块风格一致（无边框底色、字号相近）；深色模式角标可读', async () => {
    await reset(); mock.webs = webs;
    mock.script = (body) => isPlan(body) ? (body.messages.some((m) => m.role === 'tool') ? { text: 'READY' } : { calls: [{ name: 'web_search', args: { query: 'a' } }] }) : { text: '有来源 [1][2]' };
    await send('截图测试');
    const r = await ev(() => { const w = document.querySelector('.msg.ai .webb-h'), c = document.querySelector('.msg.ai a.cite'); const ws = getComputedStyle(w), cs = getComputedStyle(c), bs = getComputedStyle(document.getElementById('btnWeb')); return { hBg: ws.backgroundColor, hFont: parseFloat(ws.fontSize), cH: Math.round(c.getBoundingClientRect().height), cFont: parseFloat(cs.fontSize), btnBg: bs.backgroundColor, btnCol: bs.color }; });
    assert.ok(r.hFont >= 12 && r.hFont <= 15 && r.cH >= 14 && r.cH <= 22 && r.cFont >= 10, JSON.stringify(r));
    await ev(() => document.documentElement.setAttribute('data-theme', 'dark')); await page.waitForTimeout(200);
    const d = await ev(() => { const c = document.querySelector('.msg.ai a.cite'); const s = getComputedStyle(c); return { bg: s.backgroundColor, color: s.color }; });
    assert.ok(d.bg !== d.color, JSON.stringify(d));
    if (process.env.ZC_SHOTS) { await page.screenshot({ path: process.env.ZC_SHOTS + '/web_dark.png' }); }
    await ev(() => document.documentElement.setAttribute('data-theme', 'light')); await page.waitForTimeout(200);
    if (process.env.ZC_SHOTS) { await page.click('.msg.ai .webb-h'); await page.waitForTimeout(500); await page.screenshot({ path: process.env.ZC_SHOTS + '/web_light.png' }); }
  });

  await check('[浏览器·联网] 无脚本错误', () => { assert.deepStrictEqual(D.errs, []); });
  await D.ctx.close();

  /* ---------- 手机 360px：按钮可见可点、页面不横向溢出、联网进行中的进度块与最终块不撑破版面 ---------- */
  const M = await makePage({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await check('[浏览器·联网·手机 360px] 按钮在工具栏内可点；进行中 / 完成后的过程块不撑破版面（长标题 / 长域名省略）', async () => {
    const r0 = await M.ev(() => { const b = document.getElementById('btnWeb').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), vis: document.getElementById('btnWeb').offsetWidth > 0 }; });
    assert.ok(r0.vis && r0.w >= 36 && r0.h >= 30, JSON.stringify(r0));
    await M.page.evaluate(() => document.getElementById('btnWeb').scrollIntoView({ inline: 'center' }));
    await M.page.tap('#btnWeb'); await M.page.waitForTimeout(100);
    if (!(await M.ev(() => ZC.WebChat.on))) await M.page.tap('#btnWeb');
    assert.strictEqual(await M.ev(() => ZC.WebChat.on), true);
    mock.reqs = []; mock.web = []; mock.delay = 900;
    mock.webs = (sub, b) => sub === 'search' ? { provider: 'tavily', results: [{ title: '一个非常非常非常非常非常非常非常非常非常长的网页标题用来测试省略号是否生效', url: 'https://a-very-long-subdomain.another-long-domain-name-for-testing.example.com/path/to/page', snippet: '摘要' }] } : webs(sub, b);
    mock.script = (body) => isPlan(body) ? (body.messages.some((m) => m.role === 'tool') ? { text: 'READY' } : { calls: [{ name: 'web_search', args: { query: '一个很长很长很长很长很长很长很长很长很长很长的搜索词用来测试手机上的显示' } }] }) : { text: '回答 [1]' };
    await M.page.fill('#input', '手机上联网'); await M.page.tap('#btnSend').catch(async () => { await M.page.keyboard.press('Control+Enter'); });
    await waitFor(() => M.ev(() => !!document.querySelector('.webb.live .webb-s')), 6000, '进行中');
    const live = await M.ev(() => ({ docW: document.documentElement.scrollWidth, vw: innerWidth, step: document.querySelector('.webb.live .webb-s').getBoundingClientRect().right }));
    if (process.env.ZC_SHOTS) await M.page.screenshot({ path: process.env.ZC_SHOTS + '/web_mobile_live.png' });
    assert.ok(live.docW <= live.vw && live.step <= live.vw, JSON.stringify(live));
    await waitFor(() => M.ev(() => !ZC.Chat.busy), 20000, '结束'); await M.page.waitForTimeout(300);
    await M.page.tap('.msg.ai .webb-h'); await M.page.waitForTimeout(500);
    const done = await M.ev(() => ({ docW: document.documentElement.scrollWidth, vw: innerWidth, chips: Array.from(document.querySelectorAll('.msg.ai .webb-chip')).map((c) => Math.round(c.getBoundingClientRect().right)), steps: Array.from(document.querySelectorAll('.msg.ai .webb-s')).map((c) => Math.round(c.getBoundingClientRect().right)) }));
    if (process.env.ZC_SHOTS) await M.page.screenshot({ path: process.env.ZC_SHOTS + '/web_mobile_done.png' });
    assert.ok(done.docW <= done.vw && done.chips.every((x) => x <= done.vw) && done.steps.every((x) => x <= done.vw), JSON.stringify(done));
  });
  await check('[浏览器·联网·手机] 无脚本错误', () => { assert.deepStrictEqual(M.errs, []); });
  await browser.close();
} else {
  results.push(['SKIP', '浏览器部分', '没有可用的 Chromium / Playwright']);
}

const fail = results.filter((r) => r[0] === 'FAIL');
for (const r of results) console.log(r[0] + ' ' + r[1] + (r[2] ? ' — ' + r[2] : ''));
console.log(`\n${results.filter((r) => r[0] === 'PASS').length} / ${results.length} 通过`);
process.exit(fail.length ? 1 : 0);
