// v2.30.6：分支继承模式 / 侧栏显示全部模式 / 圆角下拉与模型选择器 / 触控 —— 静态契约 + （有浏览器时）真实交互
import fs from 'node:fs';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const html = fs.readFileSync('public/index.html', 'utf8');
const results = [];
async function check(name, fn) { try { const d = await fn(); results.push(['PASS', name, d || '']); } catch (e) { results.push(['FAIL', name, e && e.message ? e.message : String(e)]); } }
const has = (s, re) => (typeof re === 'string' ? s.indexOf(re) >= 0 : re.test(s));

await check('forkSession 写入 mode（分支与来源对话同一模式）', () => {
  assert.ok(has(html, "messages: copy, model: cur.model, mode: Sessions.modeOf(cur), parentId: cur.id, forkAt: m.id"), 'forkSession 没写 mode');
});
await check('Mode.stamp 修复旧版错位分支；Mode.follow 让模式跟着对话走', () => {
  assert.ok(has(html, /const p = x\.forkAt && x\.parentId \? by\[x\.parentId\] : null;/), '缺少分支修复');
  assert.ok(has(html, /follow\(\) \{[\s\S]{0,900}Agent\.exitMode\(\)/), 'follow 切到聊天时应退出 Agent 模式');
});
await check('侧栏列表不再只显示当前模式；有徽章与模式筛选', () => {
  assert.ok(!has(html, "filter((s) => Sessions.modeOf(s) === Mode.cur);   // 只显示当前模式的对话"), '仍在按当前模式过滤');
  assert.ok(has(html, "class: 's-mode m-' + sm"), '缺少模式徽章');
  assert.ok(has(html, 'modeSeg(cnt, mf)') && has(html, 'sess_mode_filter'), '缺少模式筛选');
});
await check('打开另一种模式的对话 / 分支树节点会切换模式', () => {
  assert.ok(has(html, /Sessions\.later\.flush\(\); Sessions\.switchTo\(id\);\s*try \{ Mode\.follow\(\); \}/), 'openSession 没有 follow');
  assert.ok(has(html, /Sessions\.switchTo\(s\.id\); try \{ Mode\.follow\(\); \}/), '分支树没有 follow');
  assert.ok(has(html, "class: 's-mode m-' + Sessions.modeOf(s)"), '分支树缺少徽章');
});
await check('圆角下拉 / 圆角建议 / 模型选择器 / 手势 已就位，且模型菜单不再用原生 <select>', () => {
  ['const Float = {', 'const ZSel = {', 'const ZCombo = {', 'const ModelPicker = {', 'const EdgeSwipe = {'].forEach((k) => assert.ok(has(html, k), '缺少 ' + k));
  assert.ok(has(html, 'modelMenu(anchor) { ModelPicker.open(anchor); }'), 'modelMenu 没有改用 ModelPicker');
  assert.ok(!has(html, "el('select', { 'aria-label': '选择模型' })"), '模型菜单仍在用原生 select');
  assert.ok(has(html, 'ZSel.init(); ZCombo.init(); EdgeSwipe.init();'), '启动时没有挂载');
});
await check('样式：圆角令牌抬高、浮层高于设置面板、复选框 / 滑条圆角、尊重减少动效', () => {
  assert.ok(has(html, '--r:16px;--r-sm:12px;--r-lg:24px'), '圆角令牌');
  assert.ok(has(html, /#zfLayer\{[^}]*z-index:97/), '浮层层级必须高于设置面板(80)');
  assert.ok(has(html, 'input[type=checkbox]{-webkit-appearance:none'), '复选框');
  assert.ok(has(html, /@media \(prefers-reduced-motion:reduce\)\{\s*\.zf-pop/), '减少动效');
  assert.ok(!has(html, 'cubic-bezier(.3,1.7,.5,1)'), '触碰回弹不应再过冲');
});

// ---------- 真实浏览器交互（没有 Playwright / Chromium 时跳过） ----------
let pw = null;
try { const req = createRequire(process.env.ZC_PW_DIR || '/home/claude/.npm-global/lib/node_modules/'); pw = req('playwright'); } catch (e) { pw = null; }
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
if (pw && exe) {
  const PFX = 'zc_gura_', now = Date.now();
  const u = (t, id) => ({ id, role: 'user', content: t, ts: now });
  const a = (t, id, ag) => ({ id, role: 'assistant', content: t, ts: now, meta: ag ? { agent: true, steps: [], model: 'x' } : { model: 'm' } });
  const S = (id, title, mode, msgs, ex) => Object.assign({ id, title, createdAt: now - 1000, updatedAt: now - 500, messages: msgs, model: 'm', mode }, ex || {});
  const sessions = [
    S('s1', '写脚本', 'code', [u('q1', 'u1'), a('a1', 'a1'), u('q2', 'u2'), a('a2', 'a2')]),
    S('s2', '聊天', 'chat', [u('hi', 'u9'), a('hello', 'a9')]),
    S('s4', '（编辑前）写脚本', 'chat', [u('q1', 'u1'), a('a1', 'a1')], { parentId: 's1', forkAt: 'a1', archived: true })   // 旧版错位数据
  ];
  const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.route('**/*', (route) => {
    const u2 = new URL(route.request().url());
    if (u2.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html.replace('window.ZC = { Mode,', 'window.ZC = { Pop, View, Settings2, Composer, App, Toast, Dialog, Store, Mode,') });
    if (u2.pathname.startsWith('/__zc_auth__/status')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":false}' });
    return route.fulfill({ status: u2.hostname === 'signal.test' ? 200 : 404, contentType: 'application/json', body: '{}' });
  });
  await page.addInitScript(([PFX, sessions]) => {
    localStorage.setItem(PFX + 'sessions', JSON.stringify(sessions)); localStorage.setItem(PFX + 'current_session', 's1'); localStorage.setItem(PFX + 'ui_mode', 'code');
    localStorage.setItem(PFX + 'apis', JSON.stringify([{ id: 'p', name: 'DS', url: 'https://signal.test/v1', key: 'k', model: 'deepseek-flash', format: 'openai', route: 'auto', headers: '' }]));
    localStorage.setItem(PFX + 'detected_models', JSON.stringify(['deepseek-flash', 'deepseek-pro', 'gpt-5', 'qwen3-max', 'glm-4.6', 'kimi-k2', 'gemini-2.5-pro']));
  }, [PFX, sessions]);
  await page.goto('https://signal.test/'); await page.waitForTimeout(8500);
  const ev = (f, x) => page.evaluate(f, x);

  await check('[浏览器] 旧版错位的分支启动时被修复回来源模式', async () => { assert.strictEqual(await ev(() => ZC.Sessions.list.find((s) => s.id === 's4').mode), 'code'); });
  await check('[浏览器] 代码模式（无 Agent 消息）里新建的分支仍是代码模式', async () => {
    const r = await ev(() => { const f = ZC.ZX.forkSession(ZC.Sessions.list[0].messages[1], { archived: true }); return f.mode; });
    assert.strictEqual(r, 'code');
  });
  await check('[浏览器] 侧栏同时列出两种模式并带徽章；筛选与自动切模式可用', async () => {
    await page.click('#btnMenu'); await page.waitForTimeout(700);
    const rows = await ev(() => [...document.querySelectorAll('#sessionList .sess')].filter((r) => r.style.display !== 'none').map((r) => r.getAttribute('data-mode')));
    assert.ok(rows.indexOf('chat') >= 0 && rows.indexOf('code') >= 0, '应同时有聊天和代码: ' + rows);
    assert.ok(await ev(() => !!document.querySelector('.sess .s-mode')), '没有徽章');
    await page.click('.s-modeseg button[data-f="chat"]'); await page.waitForTimeout(300);
    assert.ok((await ev(() => [...document.querySelectorAll('#sessionList .sess')].filter((r) => r.style.display !== 'none').map((r) => r.getAttribute('data-mode')))).every((m) => m === 'chat'));
    await page.click('.s-modeseg button[data-f=""]'); await page.waitForTimeout(200);
    await page.click('#sessionList .sess[data-id="s2"] .t'); await page.waitForTimeout(600);
    assert.deepStrictEqual(await ev(() => [ZC.Mode.cur, document.documentElement.getAttribute('data-mode')]), ['chat', 'chat']);
    return 'rows=' + rows.join(',');
  });
  await check('[浏览器] 模型选择器：手机是底部抽屉，可搜索、可选中并写回 API', async () => {
    await page.click('#modelBtn'); await page.waitForTimeout(700);
    assert.ok(await ev(() => !!document.querySelector('.zf-sheet.in .mp')), '没有抽屉');
    await page.fill('.mp-q', 'glm'); await page.waitForTimeout(300);
    await page.click('.mp-list .zs-opt'); await page.waitForTimeout(600);
    assert.strictEqual(await ev(() => ZC.Api.current().model), 'glm-4.6') ;
    assert.ok(await ev(() => !document.querySelector('.zf-sheet')), '抽屉没关');
  });
  await check('[浏览器] 设置里的原生 <select> 全部被圆角下拉取代，选择后值与事件正确', async () => {
    await ev(() => ZC.Settings2.open('api')); await page.waitForTimeout(700);
    assert.strictEqual(await ev(() => [...document.querySelectorAll('select')].filter((s) => !s.classList.contains('zs-native')).length), 0);
    await ev(() => { window.__chg = 0; document.getElementById('fFormat').addEventListener('change', () => { window.__chg++; }); });
    await page.click('#fFormat ~ .zs-btn'); await page.waitForTimeout(600);
    await page.click('.zs-opt:nth-child(2)'); await page.waitForTimeout(500);
    assert.deepStrictEqual(await ev(() => [document.getElementById('fFormat').value, window.__chg]), ['anthropic', 1]);
    await ev(() => { document.getElementById('fFormat').value = 'gemini'; });   // 代码里直接赋值也要同步按钮文字
    assert.strictEqual(await ev(() => document.querySelector('#fFormat ~ .zs-btn .zs-v').textContent), 'Google Gemini');
  });
  await check('[浏览器] 页面无脚本错误', async () => { assert.deepStrictEqual(errs, []); });
  await browser.close();
} else {
  results.push(['SKIP', '[浏览器] 交互测试', '未找到 Playwright / Chromium，已跳过（静态契约仍已校验）']);
}

let fail = 0;
for (const [st, n, d] of results) { if (st === 'FAIL') fail++; console.log(st + ' | ' + n + (d ? '  → ' + d : '')); }
console.log('===== ' + results.filter((r) => r[0] === 'PASS').length + '/' + results.filter((r) => r[0] !== 'SKIP').length + ' 通过 =====');
process.exit(fail ? 1 : 0);
