// v2.31.0：仿 Claude 风格层 —— 暖色令牌 / AI 回复衬线（可切换）/ 去掉 AI 消息头 / Logo 与主页不动
import fs from 'node:fs';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const html = fs.readFileSync('public/index.html', 'utf8');
const manifest = JSON.parse(fs.readFileSync('public/manifest.webmanifest', 'utf8'));
const results = [];
async function check(name, fn) { try { const d = await fn(); results.push(['PASS', name, d || '']); } catch (e) { results.push(['FAIL', name, e && e.message ? e.message : String(e)]); } }
const has = (s, re) => (typeof re === 'string' ? s.indexOf(re) >= 0 : re.test(s));

await check('暖色令牌：浅色 / 深色底色、强调色已换，旧的冷灰与蓝色强调不再出现在令牌里', () => {
  ['--bg:#faf9f5', '--bg-2:#f5f4ed', '--accent:#c6613f', '--bg:#262624', '--bg-2:#1f1e1d', '--accent:#d97757'].forEach((k) => assert.ok(has(html, k), '缺少 ' + k));
  ['--accent:#2b5cd9', '--accent:#7fa2ff', '--bg:#151517'].forEach((k) => assert.ok(!has(html, k), '旧令牌仍在: ' + k));
});
await check('Logo 取色令牌（--primary / --on-primary）保持不变 —— 图标不能变', () => {
  assert.ok(has(html, '--primary:#18181b;--on-primary:#ffffff;'), '浅色 --primary 被改动');
  assert.ok(has(html, '--primary:#ececef;--on-primary:#151517;'), '深色 --primary 被改动');
  assert.ok(has(html, 'id="i-logo"') && has(html, 'style="fill:var(--primary);stroke:none"'), 'Logo 符号被改动');
});
await check('风格层 <style id="zcSkin"> 在正常文档流里（不在 <noscript> 内，否则只有关掉 JS 才生效）', () => {
  const i = html.indexOf('<style id="zcSkin">'); assert.ok(i > 0, '缺少风格层');
  const before = html.slice(0, i);
  const open = (before.match(/<noscript>/g) || []).length, close = (before.match(/<\/noscript>/g) || []).length;
  assert.strictEqual(open, close, '风格层被放进了 <noscript>');
});
await check('衬线只作用于 AI 回复的文字块，代码 / 按钮 / 文件卡不在其中；主页不含衬线规则', () => {
  assert.ok(has(html, 'html:not(.ff-sans) .msg.ai .body.md :is(p,li,h1,h2,h3,h4,h5,h6,blockquote,th,td){font-family:var(--serif)}'));
  const skin = html.slice(html.indexOf('<style id="zcSkin">'), html.indexOf('</style>', html.indexOf('<style id="zcSkin">')));
  assert.ok(!/\.hero/.test(skin), '风格层不应触碰主页 .hero');
  assert.ok(!/\.code\b|\.fcard|pre\b/.test(skin.replace(/\/\*[\s\S]*?\*\//g, '')), '风格层不应触碰代码块 / 文件卡');
});
await check('「回复字体」开关：DEFAULTS、apply、设置行、事件、loadLook 都已连上', () => {
  assert.ok(has(html, "aiFont: 'serif'"), '缺少默认值');
  assert.ok(has(html, "root.classList.toggle('ff-sans', this.d.aiFont === 'sans')"), 'apply 没处理');
  assert.ok(has(html, 'id="segAiFont"'), '缺少设置行');
  assert.ok(has(html, "Settings.set('aiFont'"), '缺少事件');
  assert.ok(has(html, "Settings.get('aiFont')"), 'loadLook 没高亮');
});
await check('不再给每条 AI 回复加「logo + 模型名 + tokens」头；模型名 / tokens 进了操作栏', () => {
  assert.ok(!has(html, 'root.appendChild(this.aiHead('), '仍在追加 aiHead');
  assert.ok(has(html, "el('span', { class: 'act-meta'"), '操作栏没有 act-meta');
});
await check('用户气泡：统一圆角，没有「尾巴」', () => { assert.ok(has(html, '.msg.user .bubble{border-radius:16px}')); });
await check('manifest 与 theme-color 同步新底色', () => {
  assert.strictEqual(manifest.theme_color, '#faf9f5'); assert.strictEqual(manifest.background_color, '#faf9f5');
  assert.ok(has(html, '<meta name="theme-color" content="#faf9f5">'));
});

// ---------- 真实浏览器（没有 Playwright / Chromium 时跳过） ----------
let pw = null;
try { const req = createRequire(process.env.ZC_PW_DIR || '/home/claude/.npm-global/lib/node_modules/'); pw = req('playwright'); } catch (e) { pw = null; }
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
if (pw && exe) {
  const PFX = 'zc_gura_', now = Date.now();
  const msgs = [{ id: 'u1', role: 'user', content: 'hi', ts: now }, { id: 'a1', role: 'assistant', content: '你好 **English** [链接](https://example.com)\n\n```js\nlet a = 1;\n```', ts: now, meta: { model: 'claude-x', usage: { total_tokens: 88 } } }];
  const sessions = [{ id: 's1', title: 't', createdAt: now, updatedAt: now, messages: msgs, model: 'm', mode: 'chat' }];
  const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (u.pathname.startsWith('/__zc_auth__/status')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":false}' });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.addInitScript(([PFX, sessions]) => {
    localStorage.setItem(PFX + 'sessions', JSON.stringify(sessions)); localStorage.setItem(PFX + 'current_session', 's1'); localStorage.setItem(PFX + 'settings', JSON.stringify({ theme: 'light' }));
    localStorage.setItem(PFX + 'apis', JSON.stringify([{ id: 'p', name: 'D', url: 'https://signal.test/v1', key: 'k', model: 'm', format: 'openai', route: 'auto', headers: '' }]));
  }, [PFX, sessions]);
  await page.goto('https://signal.test/'); await page.waitForTimeout(7500);
  const ev = (f, x) => page.evaluate(f, x);
  const ff = (sel) => ev((s) => getComputedStyle(document.querySelector(s)).fontFamily, sel);
  await check('[浏览器] 风格层真的生效：正文衬线、链接蓝色、代码块仍是等宽', async () => {
    assert.ok(/ui-serif/.test(await ff('.msg.ai .body.md p')), '正文不是衬线');
    assert.ok(/mono|Menlo|Consolas/i.test(await ff('.msg.ai .body.md .code pre')), '代码块不是等宽');
    assert.strictEqual(await ev(() => getComputedStyle(document.querySelector('.msg.ai .body.md a')).color), 'rgb(47, 98, 201)');
  });
  await check('[浏览器] AI 回复顶部没有消息头；操作栏里有模型名与 tokens', async () => {
    assert.ok(await ev(() => !document.querySelector('.msg.ai .head')), '仍有 .head');
    const t = await ev(() => document.querySelector('.msg.ai .act-meta').textContent); assert.ok(/claude-x/.test(t) && /88 tokens/.test(t), t);
  });
  await check('[浏览器] 主页问候语（.hero h1）的字体不受影响', async () => {
    const r = await ev(() => { const h1 = document.querySelector('.hero h1'); return [h1.textContent, getComputedStyle(h1).fontFamily]; });
    assert.ok(!/serif/i.test(r[1].split(',')[0]) && !/ui-serif/.test(r[1]), '主页被套上衬线: ' + r[1]);
  });
  await check('[浏览器] 「回复字体」开关：切无衬线 / 切回衬线，并写入本机设置', async () => {
    await page.click('#btnSettings'); await page.waitForTimeout(400); await page.click('button[data-tab="look"]'); await page.waitForTimeout(300);
    await page.click('#segAiFont button[data-v="sans"]'); await page.waitForTimeout(200);
    assert.ok(!/ui-serif/.test(await ff('.msg.ai .body.md p')), '无衬线没生效');
    assert.strictEqual(await ev((k) => JSON.parse(localStorage.getItem(k)).aiFont, PFX + 'settings'), 'sans');
    await page.click('#segAiFont button[data-v="serif"]'); await page.waitForTimeout(200);
    assert.ok(/ui-serif/.test(await ff('.msg.ai .body.md p')), '切回衬线没生效');
  });
  await check('[浏览器] 页面无脚本错误', () => { assert.strictEqual(errs.length, 0, errs.join(' | ')); });
  await browser.close();
} else results.push(['PASS', '[浏览器] 跳过（没有 Playwright / Chromium）', '']);

let bad = 0; results.forEach(([s, n, d]) => { if (s === 'FAIL') bad++; console.log(s + ' | ' + n + (d ? '  → ' + d : '')); });
console.log('\n===== ' + (results.length - bad) + '/' + results.length + ' 通过 =====');
process.exit(bad ? 1 : 0);
