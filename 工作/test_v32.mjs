// v2.32.0：Artifacts 预览面板（沙箱路由）/ PWA 图标与缓存版本 / 项目 + 置顶 / Agent 按钮与模型选择两个 bug
// 上半部分：Worker + 静态文件契约（不需要浏览器）；下半部分：真实 Chromium（没有 Playwright / Chromium 时跳过）。
// 浏览器部分直接用 Worker 的真实响应头（含 CSP）去喂页面，所以「父页 CSP 会不会拦沙箱 iframe」是真测出来的，不是假设。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const html = fs.readFileSync('public/index.html', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const workerSrc = fs.readFileSync('_worker.js', 'utf8');
const results = [];
async function check(name, fn) { try { const d = await fn(); results.push(['PASS', name, d || '']); } catch (e) { results.push(['FAIL', name, e && e.message ? e.message : String(e)]); } }
const has = (s, re) => (typeof re === 'string' ? s.indexOf(re) >= 0 : re.test(s));

/* ---------- Worker 底座（与 harness.mjs 同一套做法，但 ASSETS 多放行 sw.js / 图标 / manifest） ---------- */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcv32-'));
fs.copyFileSync('_worker.js', path.join(tmpDir, 'worker.mjs'));
const worker = (await import(path.join(tmpDir, 'worker.mjs'))).default;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const ASSETS = {
  async fetch(req) {
    const u = new URL(req.url);
    const file = path.join(path.resolve('public'), decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
    if (!file.startsWith(path.resolve('public')) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not Found', { status: 404 });
    return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } });
  }
};
const env = { ASSETS, ZC_KV: null, DB: null };
const ctx0 = { waitUntil() { }, passThroughOnException() { } };
const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', 'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document'
};
const call = (p, init, base) => worker.fetch(new Request((base || 'https://signal.example') + p, Object.assign({}, init, { headers: Object.assign({}, BROWSER_HEADERS, (init && init.headers) || {}) })), env, ctx0);
const quietLog = console.log; // Worker 的结构化日志走 console.log，测试里静音，只保留我们自己的输出
const mute = async (f) => { const o = console.log; console.log = () => { }; try { return await f(); } finally { console.log = o; } };

/* ================== 一、版本一致性 / PWA ================== */
await check('版本一致：package.json = Worker ZC_VERSION = sw.js 缓存名（以后发版只改 ZC_VERSION，sw.js 响应时自动换代）', async () => {
  const m = /const ZC_VERSION = '([^']+)'/.exec(workerSrc); assert.ok(m, '找不到 ZC_VERSION');
  assert.strictEqual(m[1], pkg.version, 'package.json 与 ZC_VERSION 不一致');
  const swFile = fs.readFileSync('public/sw.js', 'utf8'); const sv = /const VER = 'zc-gura-v([^']+)'/.exec(swFile); assert.ok(sv, 'sw.js 缺少 VER');
  assert.strictEqual(sv[1], pkg.version, 'public/sw.js 里的 VER 与版本不一致');
  const r = await mute(() => call('/sw.js')); assert.strictEqual(r.status, 200);
  assert.ok(has(await r.text(), "const VER = 'zc-gura-v" + pkg.version + "';"), '/sw.js 响应没有按 ZC_VERSION 注入');
  assert.ok(has(html, "ZC32_VER = '" + pkg.version + "'"), '前端 ZC32_VER 与版本不一致');
  return pkg.version;
});
await check('sw.js 预缓存壳里有 PNG 图标，且单个文件失败不会让整个安装失败', () => {
  const sw = fs.readFileSync('public/sw.js', 'utf8');
  ['/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'].forEach((k) => assert.ok(has(sw, k), 'SHELL 缺少 ' + k));
  assert.ok(has(sw, /Promise\.all\(SHELL\.map\(\(?u\)? => c\.add\(u\)\.catch\(/), 'install 应逐个 add 并吞掉单个失败');
});
const pngSize = (f) => { const b = fs.readFileSync(f); assert.strictEqual(b.slice(1, 4).toString(), 'PNG', f + ' 不是 PNG'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
await check('PNG 图标：180 / 192 / 512 / 512(maskable) 尺寸正确；manifest 与 apple-touch-icon 都指向 PNG；.assetsignore 放行', () => {
  assert.deepStrictEqual(pngSize('public/apple-touch-icon.png'), [180, 180]);
  assert.deepStrictEqual(pngSize('public/icon-192.png'), [192, 192]);
  assert.deepStrictEqual(pngSize('public/icon-512.png'), [512, 512]);
  assert.deepStrictEqual(pngSize('public/icon-maskable-512.png'), [512, 512]);
  const mf = JSON.parse(fs.readFileSync('public/manifest.webmanifest', 'utf8'));
  const by = (s, p) => mf.icons.find((i) => i.sizes === s && i.type === 'image/png' && (i.purpose || 'any').indexOf(p) >= 0);
  assert.ok(by('192x192', 'any') && by('512x512', 'any') && by('512x512', 'maskable'), 'manifest 缺少 PNG 图标');
  assert.ok(mf.icons.some((i) => i.type === 'image/svg+xml'), '保留原有 SVG 图标');
  assert.ok(has(html, /<link rel="apple-touch-icon"[^>]*href="\/apple-touch-icon\.png"/), 'apple-touch-icon 应指向 PNG');
  const ig = fs.readFileSync('public/.assetsignore', 'utf8');
  ['!icon-192.png', '!icon-512.png', '!icon-maskable-512.png', '!apple-touch-icon.png'].forEach((k) => assert.ok(has(ig, k), '.assetsignore 缺少 ' + k));
});

/* ================== 二、/__zc_artifact__ 沙箱路由 ================== */
await check('/__zc_artifact__：独立 CSP（sandbox 指令、无 allow-same-origin、frame-ancestors self）、可被同源 iframe 嵌入、只允许 GET/HEAD', async () => {
  const r = await mute(() => call('/__zc_artifact__?v=' + pkg.version, { headers: { 'sec-fetch-dest': 'iframe' } }));
  assert.strictEqual(r.status, 200); assert.ok(has(r.headers.get('content-type'), 'text/html'));
  const csp = r.headers.get('content-security-policy') || '';
  assert.ok(/(^|; )sandbox allow-scripts[^;]*$/.test(csp) || /; sandbox allow-scripts/.test(csp), 'CSP 缺少 sandbox 指令：' + csp);
  assert.ok(!/allow-same-origin/.test(csp), 'sandbox 不能带 allow-same-origin（否则脚本能读站点的 localStorage / Cookie）');
  assert.ok(has(csp, "frame-ancestors 'self'") && has(csp, "default-src 'none'") && has(csp, "script-src 'unsafe-inline'"), 'CSP 内容不对：' + csp);
  assert.ok(has(csp, 'https://cdn.jsdelivr.net'), 'script-src 应放行 Mermaid 所在的 CDN');
  assert.ok(/SAMEORIGIN|DENY/i.test(r.headers.get('x-frame-options') || 'SAMEORIGIN') && !/DENY/i.test(r.headers.get('x-frame-options') || ''), 'X-Frame-Options 不能是 DENY');
  assert.strictEqual((await mute(() => call('/__zc_artifact__', { method: 'POST', body: '{}' }))).status, 405);
  assert.strictEqual((await mute(() => call('/__zc_artifact__', { method: 'HEAD' }))).status, 200);
});
await check('沙箱运行页：内联脚本语法可编译；只收 window.parent 的消息；不读任何站点存储', async () => {
  const r = await mute(() => call('/__zc_artifact__')); const t = await r.text();
  const scripts = [...t.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]); assert.ok(scripts.length >= 1);
  scripts.forEach((s) => new vm.Script(s));
  assert.ok(!/<script[^>]+src=/i.test(t), '运行页本身不能引外部脚本');
  assert.ok(has(t, 'e.source !== P'), '必须校验消息来源是 window.parent');
  const code = scripts.join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // 去掉注释（注释里会提到「读不到 localStorage」）
  assert.ok(!/localStorage|sessionStorage|document\.cookie|indexedDB/.test(code), '运行页不应触碰站点存储');
  return scripts.length + ' 段脚本';
});
await check('父页 CSP 放行 frame-src 同源（沙箱 iframe）与 Cloudflare 验证；其余策略不被放宽', async () => {
  const r = await mute(() => call('/')); assert.strictEqual(r.status, 200);
  const csp = r.headers.get('content-security-policy') || '';
  assert.ok(has(csp, "frame-src 'self' https://challenges.cloudflare.com"), 'frame-src 不对：' + csp);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), '父页 script-src 不能放宽成 unsafe-inline');
  assert.ok(has(csp, "frame-ancestors 'self'") && has(csp, "object-src 'none'"));
});

/* ================== 三、前端静态契约 ================== */
await check('前端：预览面板 / 置顶 / 项目 的模块、标记与钩子齐全', () => {
  ['const Artifacts = {', 'const Pins = {', 'const Projects = {', 'function zc32Init()'].forEach((k) => assert.ok(has(html, k), '缺少 ' + k));
  ['id="artPanel"', 'id="artSeg"', 'id="artCopy"', 'id="artDl"', 'id="artFull"', 'id="artClose"', 'id="artPrev"', 'id="artCodeV"', 'id="artFoot"', 'id="projPill"'].forEach((k) => assert.ok(has(html, k), '缺少 ' + k));
  assert.ok(has(html, 'zc32Init();'), '启动时没有调用 zc32Init');
  assert.ok(has(html, "act === 'pin'") && has(html, "'data-sact': 'pin'"), '侧栏没有置顶按钮 / 动作');
  assert.ok(has(html, "'projects'];") || has(html, ", 'projects']"), 'projects 没进云同步');
  assert.ok(has(html, 'projectId: __pid || undefined'), '知识库检索没带 projectId');
  assert.ok(has(html, "sandbox: this.SANDBOX") && !/SANDBOX: '[^']*allow-same-origin/.test(html), '预览 iframe 的 sandbox 不能带 allow-same-origin');
});

/* ================== 四、真实浏览器 ================== */
let pw = null;
try { const req = createRequire(process.env.ZC_PW_DIR || '/home/claude/.npm-global/lib/node_modules/'); pw = req('playwright'); } catch (e) { pw = null; }
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));

if (pw && exe) {
  const PFX = 'zc_gura_', now = Date.now();
  const u = (t, id) => ({ id, role: 'user', content: t, ts: now });
  const a = (t, id) => ({ id, role: 'assistant', content: t, ts: now, meta: { model: 'm' } });
  const F = '```';
  const HTML_DEMO = '<div id="x">idle</div><div id="ls">?</div><div id="tp">?</div>\n<script>\ndocument.getElementById("x").textContent="ran";\ntry{localStorage.getItem("zc_gura_apis");document.getElementById("ls").textContent="leak"}catch(e){document.getElementById("ls").textContent="blocked"}\ntry{window.top.document.title;document.getElementById("tp").textContent="leak"}catch(e){document.getElementById("tp").textContent="blocked"}\nsetTimeout(function(){throw new Error("boom-from-artifact")},50);\n</script>';
  const reply = [
    '先给你几个预览：', '', F + 'html', HTML_DEMO, F, '',
    F + 'svg', '<svg viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="40" fill="#c6613f"/></svg>', F, '',
    F + 'markdown', '# 标题\n\n这是 **加粗** 的文字', F, '',
    F + 'mermaid', 'graph TD; A-->B;', F, '',
    F + 'python', 'print("no preview for plain python blocks")', F, '',
    F + 'html title="card.html"', '<h1 id="h">card</h1>', F, '',
    F + 'python title="tool.py"', 'def f():\n    return 1', F
  ].join('\n');
  const S = (id, title, msgs, ex) => Object.assign({ id, title, createdAt: now - 3000, updatedAt: now - 1000, messages: msgs, model: 'm', mode: 'chat' }, ex || {});
  const sessions = [
    S('s1', '预览演示', [u('给我几个预览', 'u1'), a(reply, 'a1')]),
    S('s2', '普通聊天', [u('hi', 'u2'), a('hello', 'a2')]),
    S('s3', '另一个聊天', [u('hey', 'u3'), a('yo', 'a3')])
  ];
  const MERMAID_STUB = 'window.mermaid={initialize:function(){},render:function(id,code){return Promise.resolve({svg:"<svg id=\\""+id+"\\"><text>mermaid-ok:"+code.length+"</text></svg>"})}};';

  const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const seen = { api: [], rag: [], mermaid: 0, blockedCsp: [] };
  async function makePage(opts, codeMode) {
    const ctx = await browser.newContext(Object.assign({ permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true }, opts));
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => { if (!/boom-from-artifact/.test(e.message)) errs.push(e.message); });   // 演示用的 HTML 故意抛了一个错，用来验证底部报错条；它不算站点自己的脚本错误
    page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) seen.blockedCsp.push(t.slice(0, 260)); });
    await ctx.route('**/*', async (route) => {
      const req = route.request(); const url = new URL(req.url());
      if (url.hostname === 'cdn.jsdelivr.net' && /mermaid/.test(url.pathname)) { seen.mermaid++; return route.fulfill({ status: 200, contentType: 'text/javascript', body: MERMAID_STUB }); }
      if (url.hostname !== 'signal.test') return route.fulfill({ status: 404, contentType: 'text/plain', body: '' });
      if (url.pathname.startsWith('/__zc_auth__/status')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":false}' });
      if (url.pathname.startsWith('/__zc_rag__/')) {
        let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* ignore */ }
        seen.rag.push({ path: url.pathname, body });
        if (url.pathname.endsWith('/search')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, hits: [{ doc: 'd1', title: '项目手册', text: 'RAG-SNIPPET-FROM-PROJECT', score: 0.9 }] }) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, configured: true, model: 'm', docs: [], maxDocs: 40 }) });
      }
      if (/\/v1\/models$/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: ['alpha-1', 'beta-2', 'gamma-3'].map((id) => ({ id })) }) });
      if (/\/chat\/completions$/.test(url.pathname) || url.pathname.indexOf('/__zc_relay__') === 0) {
        seen.api.push({ path: url.pathname, body: req.postData() || '' });
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"收到"},"index":0}]}\n\ndata: [DONE]\n\n' });
      }
      // 页面本体 / 沙箱路由 / sw.js 等：直接交给真实 Worker，带回它的真实响应头（含 CSP）
      const dest = req.headers()['sec-fetch-dest'] || 'document';
      const r = await mute(() => worker.fetch(new Request(req.url(), { method: req.method(), headers: Object.assign({}, BROWSER_HEADERS, { 'sec-fetch-dest': dest }) }), env, ctx0));
      const headers = {}; r.headers.forEach((v, k) => { if (!/^(content-length|content-encoding|transfer-encoding)$/i.test(k)) headers[k] = v; });
      return route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
    });
    const seedSessions = codeMode ? sessions.map((x) => Object.assign({}, x, { mode: 'code' })) : sessions;
    await page.addInitScript(([PFX, sessions, codeMode]) => {
      let seeded = true; try { seeded = !!sessionStorage.getItem('zc32_seeded'); } catch (e) { return; }   // 沙箱 iframe（不透明源）里读不到存储，直接跳过
      if (!seeded) {
        sessionStorage.setItem('zc32_seeded', '1');
        localStorage.setItem(PFX + 'sessions', JSON.stringify(sessions)); localStorage.setItem(PFX + 'current_session', 's1');
        localStorage.setItem(PFX + 'apis', JSON.stringify([{ id: 'p', name: 'Demo', url: 'https://signal.test/v1', key: 'k', model: 'alpha-1', format: 'openai', route: 'direct', headers: '' }]));
        localStorage.setItem(PFX + 'intro_seen', String(Date.now()));
        if (codeMode) localStorage.setItem(PFX + 'ui_mode', 'code');
        if (/[?&]zcdark=1/.test(location.search) || sessionStorage.getItem('zcdark')) { sessionStorage.setItem('zcdark', '1'); localStorage.setItem(PFX + 'settings', JSON.stringify({ theme: 'dark' })); }
      }
    }, [PFX, seedSessions, !!codeMode]);
    await page.goto('https://signal.test/?intro=skip' + (process.env.ZC_DARK ? '&zcdark=1' : '')); await page.waitForTimeout(7500);
    return { ctx, page, errs, ev: (f, x) => page.evaluate(f, x) };
  }
  const SHOT = process.env.ZC_SHOT_DIR || '';   // 设了就在关键界面截图（人工看样式用，默认不截）
  const shot = async (pg, name) => { if (SHOT) { fs.mkdirSync(SHOT, { recursive: true }); await pg.screenshot({ path: path.join(SHOT, name + '.png') }); } };
  const frameOf = (page, pred) => page.frames().find(pred);
  const runner = (page) => frameOf(page, (f) => /__zc_artifact__/.test(f.url()));
  const inner = (page) => frameOf(page, (f) => f.parentFrame() && /__zc_artifact__/.test(f.parentFrame().url()));
  const waitFor = async (fn, ms, what) => { const t0 = Date.now(); for (; ;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - t0 > (ms || 6000)) throw new Error('等待超时：' + (what || '')); await new Promise((r) => setTimeout(r, 120)); } };

  /* ---------- 桌面：预览面板 / 置顶 / 项目 ---------- */
  const D = await makePage({ viewport: { width: 1440, height: 900 } });
  const { page, ev } = D;

  await check('[浏览器] 页面在真实 CSP 下正常启动，没有脚本错误', async () => { assert.deepStrictEqual(D.errs, []); assert.ok(await ev(() => !!(window.ZC && ZC.Artifacts && ZC.Projects && ZC.Pins)), '模块未导出'); });
  await check('[浏览器] 代码块 / 文件卡的「预览」按钮：html·svg·markdown·mermaid 有；普通 python 没有；命名文件卡都有', async () => {
    const r = await ev(() => ({
      code: [...document.querySelectorAll('.code')].map((c) => (c.querySelector('.code-h span') || {}).textContent + ':' + ((c.querySelector('button[data-pv]') || {}).getAttribute ? c.querySelector('button[data-pv]').getAttribute('data-pv') : '-')),
      cards: [...document.querySelectorAll('.fcard')].map((c) => (c.querySelector('.fc-pv') || { getAttribute: () => '-' }).getAttribute('data-pv'))
    }));
    assert.deepStrictEqual(r.code, ['html:html', 'svg:svg', 'markdown:markdown', 'mermaid:mermaid', 'python:-'], JSON.stringify(r));
    assert.deepStrictEqual(r.cards, ['html', 'code'], JSON.stringify(r));
  });
  await check('[浏览器] HTML 预览：沙箱 iframe（不带 allow-same-origin）里的内联脚本真的执行；读不到站点 localStorage / 父页；脚本报错回显到面板底部', async () => {
    await page.click('.code:nth-of-type(1) button[data-pv]');
    await waitFor(() => ev(() => document.getElementById('app').classList.contains('artOpen')), 3000, '面板打开');
    const sb = await ev(() => document.querySelector('#artPrev iframe.art-frame').getAttribute('sandbox')); assert.ok(sb.indexOf('allow-scripts') >= 0 && sb.indexOf('allow-same-origin') < 0, 'sandbox=' + sb);
    const inn = await waitFor(() => { const f = inner(page); return f && f; }, 8000, '内层 srcdoc iframe');
    await waitFor(async () => (await inn.evaluate(() => document.getElementById('x') && document.getElementById('x').textContent)) === 'ran', 5000, '内联脚本执行');
    assert.deepStrictEqual(await inn.evaluate(() => [document.getElementById('ls').textContent, document.getElementById('tp').textContent]), ['blocked', 'blocked']);
    await waitFor(() => ev(() => { const f = document.getElementById('artFoot'); return !f.hidden && /boom-from-artifact/.test(document.getElementById('artErrTx').textContent); }), 5000, '底部报错条');
    assert.strictEqual(await ev(() => document.getElementById('artName').textContent), 'code.html');
    await shot(page, '1-html-preview');
    return seen.blockedCsp.length ? '（控制台里有 CSP 提示 ' + seen.blockedCsp.length + ' 条）' : '';
  });
  await check('[浏览器] 「预览 / 代码」切换、复制、下载、全屏、Esc 关闭', async () => {
    await page.click('#artSeg button[data-t="code"]'); await shot(page, '2-code-tab');
    assert.ok(await ev(() => document.getElementById('artPrev').hidden && !document.getElementById('artCodeV').hidden && /boom-from-artifact/.test(document.getElementById('artCodeV').textContent)), '代码页没出来');
    await page.click('#artSeg button[data-t="preview"]');
    assert.ok(await ev(() => !!document.querySelector('#artPrev iframe.art-frame')), '切回预览应保留 iframe');
    await page.click('#artCopy'); await page.waitForTimeout(300);
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())).indexOf('boom-from-artifact') >= 0, '剪贴板里没有代码');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#artDl')]); assert.strictEqual(dl.suggestedFilename(), 'code.html');
    await page.click('#artFull'); assert.ok(await ev(() => document.getElementById('app').classList.contains('artFull') && document.getElementById('artFull').getAttribute('aria-pressed') === 'true'));
    await page.click('#artFull'); assert.ok(await ev(() => !document.getElementById('app').classList.contains('artFull')));
    await page.mouse.click(5, 5); await page.keyboard.press('Escape');
    await waitFor(() => ev(() => !document.getElementById('app').classList.contains('artOpen')), 2000, 'Esc 关闭');
    assert.ok(await ev(() => !document.querySelector('#artPrev iframe')), '关闭后应卸载 iframe（停掉脚本）');
  });
  await check('[浏览器] SVG 预览（图片渲染，脚本不会执行）与 Markdown 预览（父页渲染）', async () => {
    await page.click('.code:nth-of-type(2) button[data-pv]');
    const rf = await waitFor(() => runner(page), 8000, '运行页');
    await waitFor(() => rf.evaluate(() => { const i = document.querySelector('#d img'); return !!(i && i.complete && i.naturalWidth > 0 && getComputedStyle(document.getElementById('d')).display !== 'none'); }), 6000, 'SVG 渲染');
    await page.click('.code:nth-of-type(3) button[data-pv]');
    await waitFor(() => ev(() => { const s = document.querySelector('#artPrev .art-md strong'); return s && s.textContent === '加粗'; }), 4000, 'Markdown');
    assert.ok(await ev(() => !document.querySelector('#artPrev iframe')) && await ev(() => document.getElementById('artReload').hidden), 'Markdown 不需要 iframe 与重新运行');
  });
  await check('[浏览器] Mermaid：运行页在自己的 CSP 下按需加载库并渲染（库用桩替代，真实库需部署后在 cdn.jsdelivr.net 可达时验证）', async () => {
    await page.click('.code:nth-of-type(4) button[data-pv]');
    const rf = await waitFor(() => runner(page), 8000, '运行页');
    await waitFor(() => rf.evaluate(() => /mermaid-ok:\d+/.test(document.getElementById('d').textContent)), 6000, 'Mermaid 渲染'); await shot(page, '3-mermaid');
    assert.ok(seen.mermaid >= 1, '没有请求 Mermaid 库');
  });
  await check('[浏览器] 命名文件卡：HTML 卡预览；非预览类型（.py）只有「代码」页', async () => {
    await page.click('.fcard:nth-of-type(1) .fc-pv, .fcard .fc-pv[data-pv="html"]');
    assert.strictEqual(await ev(() => document.getElementById('artName').textContent), 'card.html');
    await waitFor(() => { const f = inner(page); return f && f.evaluate(() => !!document.getElementById('h')); }, 8000, 'HTML 卡渲染');
    await page.click('.fcard .fc-pv[data-pv="code"]');
    const st = await ev(() => ({ name: document.getElementById('artName').textContent, single: document.getElementById('artSeg').classList.contains('single'), codeShown: !document.getElementById('artCodeV').hidden, txt: document.getElementById('artCodeV').textContent }));
    assert.strictEqual(st.name, 'tool.py'); assert.ok(st.single && st.codeShown && /def f\(\)/.test(st.txt), JSON.stringify(st));
    await page.click('#artClose'); assert.ok(await ev(() => !document.getElementById('app').classList.contains('artOpen')));
  });

  await check('[浏览器] 置顶：侧栏「置顶」分组排最前、可取消、刷新后仍在；顶栏 ⋯ 菜单也能置顶', async () => {
    await page.hover('#sessionList .sess[data-id="s3"]');
    await page.click('#sessionList .sess[data-id="s3"] [data-sact="pin"]'); await page.waitForTimeout(300);
    const first = await ev(() => { const g = document.querySelector('#sessionList .grp'); return { cls: g.className, txt: g.textContent, firstRow: (g.nextElementSibling || {}).getAttribute ? g.nextElementSibling.getAttribute('data-id') : '' }; });
    assert.ok(/pin-grp/.test(first.cls) && first.txt === '置顶' && first.firstRow === 's3', JSON.stringify(first)); await shot(page, '4-pinned');
    assert.ok(await ev(() => !!document.querySelector('#sessionList .sess[data-id="s3"] .s-pin')), '行上应有置顶图标');
    assert.strictEqual(await ev(() => ZC.Sessions.list.find((s) => s.id === 's3').pinned), true);
    await page.reload(); await page.waitForTimeout(7000);
    assert.ok(await ev(() => /pin-grp/.test(document.querySelector('#sessionList .grp').className) && document.querySelector('#sessionList .grp + .sess').getAttribute('data-id') === 's3'), '刷新后置顶丢了');
    await page.hover('#sessionList .sess[data-id="s3"]'); await page.click('#sessionList .sess[data-id="s3"] [data-sact="pin"]'); await page.waitForTimeout(300);
    assert.ok(await ev(() => !document.querySelector('#sessionList .pin-grp') && ZC.Sessions.list.find((s) => s.id === 's3').pinned !== true), '取消置顶失败');
    // 顶栏 ⋯ 菜单：置顶当前对话 / 移到项目…
    await page.click('#btnMore'); await page.waitForSelector('#popLayer .pop .it');
    const labels = await ev(() => [...document.querySelectorAll('#popLayer .pop .it')].map((b) => b.textContent.trim()));
    assert.ok(labels.some((t) => t === '置顶当前对话') && labels.some((t) => /^移到项目…/.test(t)), '⋯ 菜单缺少置顶 / 移到项目：' + labels);
    await page.click('#popLayer .pop .it:has-text("置顶当前对话")'); await page.waitForTimeout(300);
    assert.strictEqual(await ev(() => ZC.Sessions.cur().pinned), true);
    await page.click('#btnMore'); await page.click('#popLayer .pop .it:has-text("取消置顶当前对话")'); await page.waitForTimeout(300);
    assert.notStrictEqual(await ev(() => ZC.Sessions.cur().pinned), true);
  });

  await check('[浏览器] 项目：新建（指令）→ 侧栏出现 → 点选后只看项目对话、新对话自动归入 → 顶栏项目标签', async () => {
    await page.click('.proj-add'); await page.waitForSelector('#projOv:not([hidden])');
    await page.fill('#pjName', '周报助手'); await page.fill('#pjInstr', '总是用三点式回答，并以【周报】开头。');
    await shot(page, '5-project-editor');
    await page.click('#pjSave'); await page.waitForTimeout(400);
    assert.ok(await ev(() => !!document.querySelector('.proj-row .pn') && document.querySelector('.proj-row .pn').textContent === '周报助手'), '侧栏没有项目');
    await page.click('.proj-row'); await page.waitForTimeout(500);
    const st = await ev(() => { const c = ZC.Sessions.cur(); return { pid: ZC.Projects.activeId(), curProject: c.projectId, msgs: c.messages.length, rows: [...document.querySelectorAll('#sessionList .sess')].length, pill: !document.getElementById('projPill').hidden }; });
    assert.ok(st.pid && st.curProject === st.pid && st.msgs === 0 && st.pill, '点项目应新开一个归属该项目的空对话：' + JSON.stringify(st));
    assert.strictEqual(st.rows, 1, '项目视图里只应有这一个对话（其余对话不属于该项目）'); await shot(page, '6-project-view');
    assert.strictEqual(await ev(() => document.getElementById('projPillTx').textContent), '周报助手');
    // 把另一个对话移进项目：顶栏项目标签 / 归属 / 过滤列表一致
    await ev(() => { const s = ZC.Sessions.list.find((x) => x.id === 's2'); ZC.Projects.assign(s, ZC.Projects.activeId()); });
    assert.strictEqual(await ev(() => ZC.Projects.count(ZC.Projects.activeId())), 2);
    return JSON.stringify(st);
  });
  await check('[浏览器] 云同步：projects 在同步范围内；按 id 合并（新者胜）、墓碑生效；置顶 / 归属随会话同步', async () => {
    const r = await ev(() => {
      const t = Date.now(); const local = JSON.parse(localStorage.getItem('zc_gura_projects'));
      const remote = [Object.assign({}, local[0], { name: '远端改名', updatedAt: t + 5000 }), { id: 'pr_new', name: '远端新建', instructions: '', updatedAt: t }, { id: 'pr_gone', name: '被删', updatedAt: t }];
      const changed = ZC.Sync.merge({ ts: t + 10000, kv: { projects: JSON.stringify(remote) }, tomb: [{ id: 'pr_gone', ts: t + 100 }] });
      const merged = JSON.parse(localStorage.getItem('zc_gura_projects'));
      const s3 = ZC.Sessions.list.find((x) => x.id === 's3'); s3.pinned = true; s3.pinnedAt = t; s3.projectId = local[0].id; ZC.Sessions.save();
      const col = ZC.Sync.collect().kv; const cs = JSON.parse(col.sessions).find((x) => x.id === 's3');
      delete s3.pinned; delete s3.pinnedAt; delete s3.projectId; ZC.Sessions.save();
      return { changed, names: merged.map((p) => p.name).sort(), hasKey: 'projects' in col, pinned: cs.pinned, pid: cs.projectId === local[0].id };
    });
    assert.ok(r.changed && r.hasKey, JSON.stringify(r));
    assert.deepStrictEqual(r.names, ['远端改名', '远端新建'].sort(), '合并结果不对（新者胜 / 墓碑）：' + JSON.stringify(r));
    assert.ok(r.pinned === true && r.pid, '置顶 / 项目归属应出现在会话同步载荷里：' + JSON.stringify(r));
    await ev(() => { ZC.Sync.reloadFromStorage(); });
    assert.ok(await ev(() => ZC.Projects.list.some((p) => p.name === '远端改名')), '重新加载后项目列表应更新');
    await ev(() => { ZC.Projects.list = ZC.Projects.list.filter((p) => p.id !== 'pr_new'); ZC.Projects.list[0].name = '周报助手'; ZC.Projects.save(); });
  });
  await check('[浏览器] 项目对话发送：项目指令并入 system；有知识库文件时检索只带 projectId（+ 全局开关）；项目外对话不带', async () => {
    seen.api.length = 0; seen.rag.length = 0;
    await ev(() => { const p = ZC.Projects.get(ZC.Projects.activeId()); p.kbCount = 2; ZC.Projects.save(); });
    await page.fill('#input', '这周做了什么？'); await page.keyboard.press('Control+Enter');
    await waitFor(() => seen.api.length > 0, 8000, '聊天请求发出');
    const body = JSON.parse(seen.api[0].body.indexOf('{') === 0 ? seen.api[0].body : '{}');
    const sys = JSON.stringify(body.messages || body);
    assert.ok(sys.indexOf('三点式回答') >= 0 && sys.indexOf('周报助手') >= 0, '项目指令没并入 system：' + sys.slice(0, 400));
    const sr = seen.rag.find((r) => /\/search$/.test(r.path)); assert.ok(sr, '项目对话应检索项目知识库');
    assert.ok(sr.body.projectId && sr.body.projectId === (await ev(() => ZC.Projects.activeId())) && sr.body.includeGlobal === false, JSON.stringify(sr.body));
    assert.ok(sys.indexOf('RAG-SNIPPET-FROM-PROJECT') >= 0, '检索到的片段没有进入上下文');
    await page.waitForTimeout(800);
    // 回到「全部」，打开一个项目外对话再发消息：不应带项目指令，也不检索
    await ev(() => ZC.Projects.setFilter(''));
    await ev(() => { const s = ZC.Sessions.list.find((x) => x.id === 's3'); ZC.Sessions.switchTo(s.id); });
    seen.api.length = 0; seen.rag.length = 0;
    await page.fill('#input', '普通问题'); await page.keyboard.press('Control+Enter');
    await waitFor(() => seen.api.length > 0, 8000, '第二次聊天请求');
    assert.ok(seen.api[0].body.indexOf('三点式回答') < 0, '项目指令不应漏进别的对话');
    assert.strictEqual(seen.rag.filter((r) => /\/search$/.test(r.path)).length, 0, '没开全局知识库时项目外对话不检索');
  });
  await check('[浏览器] 删除项目：对话保留但移出项目；项目记录与过滤清掉', async () => {
    await ev(() => ZC.Projects.openEditor(ZC.Projects.list[0].id)); await page.waitForSelector('#projOv:not([hidden])');
    await page.click('#pjDel'); await page.waitForSelector('#dialogOv:not([hidden])'); await page.click('#dlgOk'); await page.waitForTimeout(600);
    const st = await ev(() => ({ n: ZC.Projects.list.length, tagged: ZC.Sessions.list.filter((s) => s.projectId).length, total: ZC.Sessions.list.length, f: ZC.Projects.activeId() }));
    assert.strictEqual(st.n, 0); assert.strictEqual(st.tagged, 0); assert.strictEqual(st.f, ''); assert.ok(st.total >= 3, '对话不应被删：' + JSON.stringify(st));
  });
  await check('[浏览器] 桌面端无脚本错误', async () => { assert.deepStrictEqual(D.errs, []); });
  await D.ctx.close();

  /* ---------- 手机：Agent 按钮再点收起；模型检测后不再弹键盘、选择不会消失；预览是抽屉 ---------- */
  const M = await makePage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, true);   // Agent 按钮在「代码」模式才出现
  const mp = M.page, mev = M.ev;
  await check('[浏览器·手机] Agent 按钮：点一下弹出 4 个选项，再点一下收起（aria-expanded 同步），可反复开关', async () => {
    // 让 4 种后端都「可用」（本地目录 / 云端 + 本地 / 云端工作区 / GitHub 终端），这样点 Agent 按钮才会出现 4 个选项
    await mev(() => { ZC.AgentFS.supported = () => true; ZC.CloudFS.available = true; ZC.CloudFS._checked = true; ZC.GhtTerm.state = 'ready'; ZC.GhtTerm.repo = 'o/r'; });
    const cnt = () => mev(() => document.querySelectorAll('#popLayer .pop .it').length);
    await mp.tap('#btnAgent'); await mp.waitForTimeout(500);
    const n1 = await cnt(); assert.strictEqual(n1, 4, '应有 4 个选项，实际 ' + n1);
    assert.strictEqual(await mev(() => document.getElementById('btnAgent').getAttribute('aria-expanded')), 'true');
    await mp.tap('#btnAgent'); await mp.waitForTimeout(500);
    assert.strictEqual(await cnt(), 0, '再点一次应该收起');
    assert.strictEqual(await mev(() => document.getElementById('btnAgent').getAttribute('aria-expanded')), 'false');
    await mp.tap('#btnAgent'); await mp.waitForTimeout(500); assert.strictEqual(await cnt(), 4, '收起后还能再打开'); await shot(mp, '9-mobile-agent-menu');
    await mp.tap('#btnAgent'); await mp.waitForTimeout(500); assert.strictEqual(await cnt(), 0);
    await mp.tap('#btnAgent'); await mp.waitForTimeout(400); await mp.tap('#btnSend', { force: true }).catch(() => { }); await mp.mouse.click(200, 120); await mp.waitForTimeout(400);
    assert.strictEqual(await cnt(), 0, '点别处也应收起');
  });
  await check('[浏览器·手机] 检测模型：焦点不落在输入框（不拉起键盘）；候选以芯片显示；模拟键盘收起（视口高度变化）后选择区仍在，且可点选写回', async () => {
    await mev(() => { document.getElementById('btnSettings').click(); });
    await mp.waitForSelector('#settingsOv:not([hidden])', { timeout: 4000 });
    await mev(() => { const t = [...document.querySelectorAll('#settingsOv [data-tab], #settingsOv .tab, #settingsOv button')].find((b) => /API|接口/.test(b.textContent)); if (t) t.click(); });
    await mp.waitForSelector('#fDetect', { state: 'visible', timeout: 4000 });
    await mp.tap('#fModel'); await mp.waitForTimeout(300);                 // 用户点了模型输入框（会弹键盘）
    await mp.tap('#fDetect'); await mp.waitForTimeout(1500);
    const st = await mev(() => ({ ae: document.activeElement && document.activeElement.tagName, chips: [...document.querySelectorAll('#fModelPick .mdl-chip')].map((c) => c.textContent.trim()), shown: !document.getElementById('fModelPick').hidden, floats: document.querySelectorAll('.zf-pop').length }));
    assert.ok(st.ae !== 'INPUT' && st.ae !== 'TEXTAREA', '检测完不应让输入框保持焦点（会拉起键盘）：' + st.ae);
    assert.ok(st.shown && st.chips.length === 3, JSON.stringify(st)); await shot(mp, '7-mobile-model-chips');
    for (const h of [520, 844, 480, 844]) { await mp.setViewportSize({ width: 390, height: h }); await mp.waitForTimeout(250); }   // 键盘升起 / 收起 = 视口高度来回变
    const st2 = await mev(() => ({ shown: !document.getElementById('fModelPick').hidden, chips: document.querySelectorAll('#fModelPick .mdl-chip').length }));
    assert.ok(st2.shown && st2.chips === 3, '键盘收起后候选不应消失：' + JSON.stringify(st2));
    await mp.tap('#fModelPick .mdl-chip:nth-child(1)', { timeout: 3000 }).catch(async () => { await mp.tap('#fModelPick .mdl-chip >> nth=1'); });
    await mp.waitForTimeout(300);
    const v = await mev(() => document.getElementById('fModel').value); assert.ok(/^(alpha-1|beta-2|gamma-3)$/.test(v), '点选后应写回模型输入框：' + v);
    assert.ok(await mev(() => document.querySelectorAll('#fModelPick .mdl-chip[aria-selected="true"]').length === 1), '选中的芯片应高亮');
    return JSON.stringify(st);
  });
  await check('[浏览器·手机] 预览在手机上是抽屉（artDrawer），不是并排面板；关闭后恢复', async () => {
    await mev(() => { document.getElementById('settingsOv').hidden = true; });
    await mev(() => ZC.Artifacts.show({ name: 'm.svg', lang: 'svg', kind: 'svg', code: '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>' }));
    await mp.waitForTimeout(600);
    assert.ok(await mev(() => document.getElementById('app').classList.contains('artDrawer') && !document.getElementById('app').classList.contains('artOpen')));
    assert.ok(await mev(() => document.getElementById('artPanel').getBoundingClientRect().width >= 360), '抽屉应占满手机宽度'); await shot(mp, '8-mobile-drawer');
    await mp.tap('#artClose'); await mp.waitForTimeout(400);
    assert.ok(await mev(() => !document.getElementById('app').classList.contains('artDrawer')));
  });
  await check('[浏览器·手机] 无脚本错误', async () => { assert.deepStrictEqual(M.errs, []); });
  await M.ctx.close();
  await browser.close();
} else {
  results.push(['SKIP', '[浏览器] 交互测试', '未找到 Playwright / Chromium，已跳过（静态与 Worker 契约仍已校验）']);
}

let fail = 0;
for (const [st, n, d] of results) { if (st === 'FAIL') fail++; quietLog(st + ' | ' + n + (d ? '  → ' + d : '')); }
quietLog('===== ' + results.filter((r) => r[0] === 'PASS').length + '/' + results.filter((r) => r[0] !== 'SKIP').length + ' 通过 =====');
process.exit(fail ? 1 : 0);
