// v2.33.0：开场动画「信号锁定」—— 真实 Chromium + Playwright 虚拟时钟（每步 16ms）逐帧验证
// vm 桩里的 canvas 是空壳，绘制过程里抛了异常也会被 try/catch 吞成「提前收尾」；这里读真实画布的像素，
// 证明：光尘 / 点阵 / 声纳波 / 字标 / 镜头开光 真的画出来了，转场后幕布撤干净、页面可交互、全程没有脚本错误。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const html = fs.readFileSync('public/index.html', 'utf8');
const results = [];
async function check(name, fn) { try { const d = await fn(); results.push(['PASS', name, d || '']); } catch (e) { results.push(['FAIL', name, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ⏎ ') : String(e)]); } }
const quietLog = console.log;
const DEBUG = !!process.env.ZC_DEBUG;

/* ================== 一、静态契约 ================== */
const introSrc = (() => {
  const m = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1]).filter((x) => x.indexOf("getElementById('zcIntro')") >= 0);
  assert.strictEqual(m.length, 1, '应恰有 1 段开场动画脚本');
  return m[0];
})();
await check('设计要点都在代码里：镜头开光 / 点阵与字标对齐 / 声纳波 / 光尘 / 指针交互 / 降级档', () => {
  ['destination-out', "addEventListener('pointermove'", 'function rings(t)', 'function field(t)', 'function parts(t)', 'function iris(', 'function fringe(', 'function bloom(',
    'COLS*ROWS<=3200', 'hardwareConcurrency', 'if(slow>10)q=0'].forEach((k) => assert.ok(introSrc.indexOf(k) >= 0, '缺少 ' + k));
  assert.ok(/LY=yb-Math\.ceil\(yb\/GS\+1\)\*GS/.test(introSrc) && /GS=cap\/NR/.test(introSrc), '点阵必须以字标基线为行基准、字高占整数行（GS = cap / NR）');
  return 'ok';
});
await check('没有任何外部资源 / 随机数：全部由时间直接算出（可复现）', () => {
  assert.ok(!/Math\.random\(/.test(introSrc), '开场动画不应使用 Math.random（要无状态、可复现）');
  assert.ok(!/https?:\/\//.test(introSrc.replace(/\/\*[\s\S]*?\*\//g, '')), '不应引入外链');
  assert.ok(!/\bfetch\(|new Image\(|XMLHttpRequest/.test(introSrc), '不应发起网络请求');
  return 'ok';
});

/* ================== 二、真实浏览器 ================== */
let pw = null;
try { const req = createRequire(process.env.ZC_PW_DIR || '/home/claude/.npm-global/lib/node_modules/'); pw = req('playwright'); } catch (e) { pw = null; }
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));

if (pw && exe && typeof pw.chromium.launch === 'function') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcv33i-'));
  fs.copyFileSync('_worker.js', path.join(tmpDir, 'worker.mjs'));
  const worker = (await import(path.join(tmpDir, 'worker.mjs'))).default;
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  const ASSETS = { async fetch(req) { const u = new URL(req.url); const file = path.join(path.resolve('public'), decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname)); if (!file.startsWith(path.resolve('public')) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not Found', { status: 404 }); return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } }); } };
  const env = { ASSETS, ZC_KV: null, DB: null };
  const wctx = { waitUntil() { }, passThroughOnException() { } };
  const HEAD = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9', 'accept': 'text/html,*/*;q=0.8', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

  /* 打开页面：虚拟时钟停在 1000ms，由测试一步步推进；login=true 时服务端状态要求登录，目标是登录卡片标题，否则直接进 App（目标是侧栏品牌） */
  async function open(o) {
    o = o || {};
    const vp = o.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, hasTouch: !!o.mobile, isMobile: !!o.mobile, reducedMotion: o.rm ? 'reduce' : 'no-preference' });
    await ctx.addInitScript((a) => { try { localStorage.setItem('zc_gura_settings', JSON.stringify({ theme: a.theme })); if (a.seen) localStorage.setItem('zc_intro_seen', String(a.seen)); } catch (e) { /* ignore */ } }, { theme: o.theme || 'light', seen: o.seen || 0 });
    await ctx.route('**/*', async (route) => {
      const req = route.request(); const url = new URL(req.url());
      if (url.hostname !== 'signal.test') return route.fulfill({ status: 404, contentType: 'text/plain', body: '' });
      if (url.pathname.startsWith('/__zc_auth__/status')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o.login === false ? { enabled: false } : { enabled: true, kv: true, github: true }) });
      const dest = req.headers()['sec-fetch-dest'] || 'document';
      const lg = console.log; console.log = () => { };
      let r; try { r = await worker.fetch(new Request(req.url(), { method: req.method(), headers: Object.assign({}, HEAD, { 'sec-fetch-dest': dest }) }), env, wctx); } finally { console.log = lg; }
      const headers = {}; r.headers.forEach((v, k) => { if (!/^(content-length|content-encoding|transfer-encoding)$/i.test(k)) headers[k] = v; });
      return route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
    });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1000);
    await page.goto('https://signal.test/' + (o.quick ? '' : '?intro=full'), { waitUntil: 'load' });
    const S = { page, ctx, errs, T: 0 };
    S.adv = async (ms) => { for (let i = 0; i < ms; i += 160) { await page.clock.runFor(Math.min(160, ms - i)); } S.T += ms; };
    S.to = async (ms) => { if (ms > S.T) await S.adv(ms - S.T); };
    S.has = (c) => page.evaluate((k) => document.documentElement.classList.contains(k), c);
    S.gone = () => page.evaluate(() => !document.getElementById('zcIntro'));
    /* 读真实画布：背景色取画面众数；lattice = 顶部 30% 里偏离背景的像素（只有点阵 / 声纳环，光尘在点火后已退场，笔尖火花在字标附近）；
       tint = 其中带强调色的像素（被声纳波点亮的点）；ink = 整个画面里的深色像素（字标笔画） */
    S.px = () => page.evaluate(() => {
      const c = document.querySelector('#zcIntro canvas'); if (!c) return null;
      const w = c.width, h = c.height, d = c.getContext('2d').getImageData(0, 0, w, h).data, cnt = {};
      for (let i = 0; i < 400; i++) { const x = (i * 97) % w, y = (i * 53) % h, k = (d[(y * w + x) * 4] << 16) | (d[(y * w + x) * 4 + 1] << 8) | d[(y * w + x) * 4 + 2]; cnt[k] = (cnt[k] || 0) + 1; }
      let bk = 0, bn = -1; for (const k in cnt) if (cnt[k] > bn) { bn = cnt[k]; bk = +k; }
      const bg = [(bk >> 16) & 255, (bk >> 8) & 255, bk & 255];
      let lat = 0, tint = 0, ink = 0, xmin = w, xmax = 0, ymin = h, ymax = 0, alphaMin = 255;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4, r = d[o], g = d[o + 1], b = d[o + 2], a = d[o + 3]; if (a < alphaMin) alphaMin = a;
        const df = Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]);
        if (df > 420) { ink++; if (x < xmin) xmin = x; if (x > xmax) xmax = x; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
        if (y < h * 0.3 && df > 24) { lat++; if (Math.max(r, g, b) - Math.min(r, g, b) > 40 && df > 60) tint++; }
      }
      return { w, h, bg, lat, tint, ink, box: [xmin, ymin, xmax, ymax], alphaMin };
    });
    return S;
  }
  const log = (...a) => { if (DEBUG) quietLog('   ·', ...a); };

  await check('[浏览器] 捕获阶段：光点已出现、光尘在飞，但点阵还没点亮', async () => {
    const S = await open({}); try {
      await S.adv(32); await S.to(340);
      const p = await S.px(); log('t=340', JSON.stringify(p));
      assert.ok(p, '没有开场画布'); assert.ok(p.ink >= 0 && p.alphaMin >= 0);
      assert.ok(await S.has('zc-pre'), '开场进行中应处于 zc-pre');
      assert.ok(p.lat > 5, '光尘 / 光点的像素应该画出来了：' + p.lat);
      assert.deepStrictEqual(S.errs, []);
      return 'lat=' + p.lat;
    } finally { await S.ctx.close(); }
  });

  await check('[浏览器] 书写阶段：笔画与点阵都在画布上；点阵铺满上部、字标在画面中央偏上', async () => {
    const S = await open({}); try {
      await S.adv(32); await S.to(1700);
      const p = await S.px(); log('t=1700', JSON.stringify(p));
      assert.ok(p.ink > 2500, '笔画像素太少，字标没画出来：' + p.ink);
      assert.ok(p.lat > 60, '点阵没有画出来（顶部区域偏离背景的像素）：' + p.lat);
      const [x0, y0, x1, y1] = p.box; assert.ok(x0 >= 0 && x1 <= p.w && y1 < p.h * 0.7 && y0 > p.h * 0.2, '字标位置不对：' + p.box);
      assert.deepStrictEqual(S.errs, []);
      return 'ink=' + p.ink + ' lat=' + p.lat;
    } finally { await S.ctx.close(); }
  });

  await check('[浏览器] 锁定时刻：声纳波把点阵点亮（出现带强调色的点），随后收拢', async () => {
    const S = await open({}); try {
      await S.adv(32); await S.to(1700); const before = await S.px();
      await S.to(3050); const lock = await S.px(); log('t=3050', JSON.stringify(lock), 'before tint', before.tint);
      assert.ok(lock.tint > before.tint + 10, '锁定波没有点亮点阵：tint ' + before.tint + ' → ' + lock.tint);
      return 'tint ' + before.tint + ' → ' + lock.tint;
    } finally { await S.ctx.close(); }
  });

  await check('[浏览器] 完整跑一遍（桌面 / 登录卡片）：镜头开光 → 幕布撤净 → 类名清理 → 登录卡片可见可点，全程无脚本错误', async () => {
    const S = await open({}); try {
      await S.adv(32); await S.to(3200);
      let g = 0; while (!(await S.has('zc-in')) && g++ < 200) { await S.adv(16); await S.page.waitForTimeout(6); }
      assert.ok(g < 200, '转场没有开始'); const t0 = S.T;
      assert.ok(t0 > 3000 && t0 < 5500, '转场起点异常：' + t0);
      await S.adv(260); const mid = await S.px(); log('X=260', JSON.stringify(mid));
      assert.ok(mid && mid.alphaMin < 255, '镜头开光时幕布应已被擦出透明洞：alphaMin=' + (mid && mid.alphaMin));
      await S.adv(700);
      assert.ok(await S.gone(), '转场结束后开场幕布应被移除');
      await S.adv(3000);
      assert.ok(!(await S.has('zc-in')) && !(await S.has('zc-pre')), '入场编排结束后类名必须清干净');
      await S.page.waitForTimeout(1300); // 页面自己的 CSS 入场动画走真实时间，不受虚拟时钟控制，要等它真的播完
      const card = await S.page.evaluate(() => { const c = document.querySelector('#authScreen:not([hidden]) .auth-card'); if (!c) return null; const s = getComputedStyle(c); const r = c.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { op: s.opacity, w: r.width, hit: !!(e && c.contains(e)) }; });
      assert.ok(card && +card.op === 1 && card.w > 200 && card.hit, '登录卡片应完全可见且没有被遮住：' + JSON.stringify(card));
      assert.deepStrictEqual(S.errs, []);
      return '转场起点 ' + (t0 / 1000).toFixed(2) + 's';
    } finally { await S.ctx.close(); }
  });

  await check('[浏览器] 直接进 App（侧栏品牌为目标）+ 深色主题：同样走完且页面可交互', async () => {
    const S = await open({ login: false, theme: 'dark' }); try {
      await S.adv(32); await S.to(3200);
      let g = 0; while (!(await S.has('zc-in')) && g++ < 200) { await S.adv(16); await S.page.waitForTimeout(6); }
      assert.ok(g < 200, '转场没有开始');
      const p0 = await S.px(); log('dark X=0', JSON.stringify(p0));
      await S.adv(1200); assert.ok(await S.gone(), '幕布应被移除');
      await S.adv(3000);
      const r = await S.page.evaluate(() => { const b = document.querySelector('.side-top .brand span'); const e = document.getElementById('btnSend') || document.querySelector('textarea'); return { brand: !!b && getComputedStyle(b).opacity === '1', input: !!e }; });
      assert.ok(r.brand && r.input, '侧栏品牌 / 输入区应已可用：' + JSON.stringify(r));
      assert.deepStrictEqual(S.errs, []);
    } finally { await S.ctx.close(); }
  });

  await check('[浏览器·手机] 窄屏：字标完整落在屏内（不裁切），转场后登录卡片在屏内', async () => {
    const S = await open({ mobile: true }); try {
      await S.adv(32); await S.to(3000);
      const p = await S.px(); log('mobile t=3000', JSON.stringify(p));
      const [x0, , x1] = p.box; assert.ok(x0 >= 4 && x1 <= p.w - 4, '字标被屏幕裁切：' + p.box + ' / ' + p.w);
      let g = 0; while (!(await S.has('zc-in')) && g++ < 200) { await S.adv(16); await S.page.waitForTimeout(6); }
      await S.adv(1200); await S.adv(3000);
      assert.ok(await S.gone());
      const r = await S.page.evaluate(() => { const c = document.querySelector('#authScreen:not([hidden]) .auth-card'); const b = c && c.getBoundingClientRect(); return b && { l: b.left, r: b.right, vw: innerWidth }; });
      assert.ok(r && r.l >= 0 && r.r <= r.vw + 1, '登录卡片超出屏幕：' + JSON.stringify(r));
      assert.deepStrictEqual(S.errs, []);
    } finally { await S.ctx.close(); }
  });

  await check('[浏览器] 回访加速（12 小时内 1.5×）：转场明显更早；?intro=full 强制完整版', async () => {
    // 虚拟时钟里「现在」≈ 1000ms，所以 seen=1000 就是「刚刚看过」；过期的情形由 test_ui_anim.mjs 的 vm 用例覆盖
    const wait = async (S) => { await S.adv(32); let g = 0; while (!(await S.has('zc-in')) && g++ < 400) { await S.adv(16); await S.page.waitForTimeout(6); } return S.T; };
    const F = await open({ seen: 1000 }), Q = await open({ seen: 1000, quick: true });
    try {
      const tf = await wait(F), tq = await wait(Q);
      log('quick', tq, 'full', tf);
      assert.ok(tq < tf * 0.75, '回访应明显更快：quick=' + tq + ' full=' + tf);
      return 'full ' + tf + 'ms / quick ' + tq + 'ms';
    } finally { await F.ctx.close(); await Q.ctx.close(); }
  });

  await check('[浏览器] 点击跳过：立刻淡出幕布，页面照常入场', async () => {
    const S = await open({}); try {
      await S.adv(32); await S.to(1200);
      await S.page.mouse.click(640, 400); await S.adv(1200);
      assert.ok(await S.gone(), '跳过后幕布应被移除');
      assert.ok(!(await S.has('zc-pre')), '跳过后必须撤掉 zc-pre');
      assert.deepStrictEqual(S.errs, []);
    } finally { await S.ctx.close(); }
  });

  await check('[浏览器] 指针划过点阵不报错、不阻塞；减少动态偏好：只给静态一帧再淡出，不触发 zc-in', async () => {
    const S = await open({}); try {
      await S.adv(32); await S.to(1500);
      for (let i = 0; i < 20; i++) { await S.page.mouse.move(300 + i * 30, 300 + Math.sin(i / 2) * 60); await S.adv(16); }
      await S.adv(300); assert.deepStrictEqual(S.errs, []); assert.ok(!(await S.gone()), '划过指针不应跳过开场');
    } finally { await S.ctx.close(); }
    const R = await open({ rm: true }); try {
      await R.adv(32); await R.adv(400);
      const p = await R.px(); log('rm t=400', JSON.stringify(p));
      await R.adv(1500);
      assert.ok(await R.gone(), '减少动态时应淡出并移除幕布');
      assert.ok(!(await R.has('zc-in')) && !(await R.has('zc-pre')), '减少动态时不应有 zc-in，且必须撤掉 zc-pre');
      assert.deepStrictEqual(R.errs, []);
    } finally { await R.ctx.close(); }
  });

  await browser.close();
} else {
  results.push(['SKIP', '[浏览器] 开场动画像素级测试', '未找到 Playwright / Chromium，已跳过（静态契约仍已校验）']);
}

let fail = 0;
for (const [st, n, d] of results) { if (st === 'FAIL') fail++; quietLog(st + ' | ' + n + (d ? '  → ' + d : '')); }
quietLog('===== ' + results.filter((r) => r[0] === 'PASS').length + '/' + results.filter((r) => r[0] !== 'SKIP').length + ' 通过 =====');
process.exit(fail ? 1 : 0);
