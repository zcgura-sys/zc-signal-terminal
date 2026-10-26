// v2.34.2：四个 bug 的回归 ——
//   ① 联网开关不再依赖模型的「需不需要联网」判断（问今天几号也真的会搜），聊天模式开的思考不再串到代码模式
//   ② 思考一致性守卫不再反向纠错（「不许用中文思考」不再被识别成「要求用中文」，复述规则不再被判违规）
//   ③ 项目里的对话不再漏到项目外（切模式 / 切换空白对话 / 点「新对话」都留在项目内）
//   ④ 输入框多行撑高时欢迎页不再被顶出可视区（改为顶对齐 + 可滚动），输入框工具栏的浮层抬到弹窗之上
//
// 上半部分：纯逻辑与静态契约（不依赖浏览器）；下半部分：有 Playwright + Chromium 时做真实交互（没有就跳过）。
import fs from 'node:fs';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const html = fs.readFileSync(process.env.ZC_HTML || 'public/index.html', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const results = [];
async function check(name, fn) { try { const d = await fn(); results.push(['PASS', name, d || '']); } catch (e) { results.push(['FAIL', name, e && e.message ? e.message : String(e)]); } if (process.env.ZC_DEBUG) console.error('[' + results[results.length - 1][0] + '] ' + name.slice(0, 70)); }
const has = (s, re) => (typeof re === 'string' ? s.indexOf(re) >= 0 : re.test(s));

/* 把页面里的 ReasonGuard 抠出来在 Node 里跑（纯逻辑，不依赖 DOM） */
const gSrc = (() => { const a = html.indexOf('const ReasonGuard = {'); const b = html.indexOf('\n};\n', a); return html.slice(a, b + 4); })();
const G = new Function('Projects', 'clamp', 'Toast', 'Audit', 'splitThink', 'Sessions', 'AgentCompressor', gSrc + '\nreturn ReasonGuard;')(
  { instrOf: (p) => String(p.instructions || ''), hashOf: (s) => s.length + ':' + s.slice(0, 30), get: () => null },
  (n, a, b) => Math.max(a, Math.min(b, n)), { info() { } }, { log() { } }, (t) => ({ reasoning: '', content: t }), { cur() { return {}; } }, {});

const L_EN = 'Let me think about this carefully. The user wants a plan, so I should break the problem into several parts and weigh the trade-offs before proposing concrete steps, risks and verification methods.'.repeat(3);
const L_ZH = '让我仔细想想这个问题。用户想要一个完整的方案，我应该先把问题拆成几个部分，逐块分析其中的取舍，再给出具体可执行的步骤、风险和验证方式。'.repeat(3);

/* ================== 一、Bug1 联网：不再依赖模型自行判断 ================== */
await check('联网·开关打开时不再让模型判断「需不需要联网」', () => {
  assert.ok(!has(html, '判断最后一个问题是否需要联网'), '检索系统提示里还在让模型判断需不需要联网');
  assert.ok(!has(html, '明显不需要联网的，直接回复「NO_WEB」'), '规则里还留着 NO_WEB 出口');
  assert.ok(has(html, '不再让你自行判断「需不需要联网」'), '缺少「必须真查」的规则说明');
  assert.ok(has(html, '第 1 轮必须先调用 web_search 搜索'), '缺少首轮必须搜索的硬要求');
});
await check('联网·模型这一轮没调用任何工具（含回 NO_WEB / 接口忽略 tools）一律走兜底检索', () => {
  assert.ok(has(html, /if \(run\.mode === 'tools' && !run\.calls && !ctrl\.signal\.aborted\) run\.mode = 'text';/), '没有无条件回退到兜底检索');
  assert.ok(!has(html, "!/^\\W*(NO_WEB|READY)\\b/i.test(firstText)"), '旧版「NO_WEB 就完全不搜」的判断还在');
});
await check('联网·兜底方案不再依赖 need 字段：没有检索词就用用户最后一句当检索词', () => {
  assert.ok(!has(html, 'if (!j || !j.need) return;'), '旧版 need:false 直接 return 的判断还在');
  assert.ok(has(html, 'let qs = (j && Array.isArray(j.queries))'), '没有改成直接取 queries');
  assert.ok(has(html, "um.text || um.content"), '缺少「用用户最后一句兜底」的检索词');
  assert.ok(has(html, '联网开关已经打开，这一轮一定会去查'), '兜底提示词里没有说明「一定会查」');
});
await check('联网·过程块文案不再出现「正在判断是否需要联网 / 没有联网」', () => {
  assert.ok(!has(html, '正在判断是否需要联网'), '还在显示「正在判断是否需要联网」');
  assert.ok(!has(html, "': '没有联网'"), '还在显示「没有联网」');
});
await check('日期·系统提示词里带上今天的真实日期与时间（问「今天几月几号」不再靠记忆猜）', () => {
  assert.ok(has(html, 'today() {'), 'SystemPrompt 没有 today()');
  assert.ok(has(html, '涉及「今天 / 现在 / 最近」的问题一律以这个时间为准'), '系统提示词没有注入日期');
  assert.ok(has(html, "weekday: 'long'"), '日期没有星期');
  assert.ok(has(html, 'Intl.DateTimeFormat().resolvedOptions().timeZone'), '日期缺少时区');
});

/* ================== 二、Bug1 思考开关：按模式分开 ================== */
await check('思考开关·按聊天 / 代码模式分别存储，切模式时跟着切', () => {
  assert.ok(has(html, "onKey(m) { return 'deep_on_' + (m === 'code' ? 'code' : 'chat'); }"), '缺少按模式分的存储键');
  assert.ok(has(html, 'retarget(mode) {'), '缺少 retarget');
  assert.ok(has(html, "if (typeof Deep !== 'undefined') { try { Deep.retarget(this.cur); }"), 'Mode.paint 没有调用 retarget');
  assert.ok(has(html, "Store.set('deep_for', m, true);"), '没有记录「当前是哪一份」');
});
await check('思考开关·旧数据迁移：第一次升级时把旧值同时给聊天与代码两份', () => {
  assert.ok(has(html, 'const known = !!this.forMode;'), '没有区分「首次迁移」与「切换模式」');
  assert.ok(has(html, "Store.set(this.onKey('chat'), this.on); Store.set(this.levelKey('chat'), lv);"), '迁移没有写入聊天那一份');
  assert.ok(has(html, "Store.set(this.onKey('code'), this.on); Store.set(this.levelKey('code'), lv);"), '迁移没有写入代码那一份');
});
await check('思考开关·两份设置进云同步，换设备也各自保留', () => {
  ["'deep_for'", "'deep_on_chat'", "'deep_level_chat'", "'deep_on_code'", "'deep_level_code'"].forEach((k) => {
    assert.ok(has(html, k), 'SYNC_KEYS 缺少 ' + k);
  });
});

/* ================== 三、Bug2 守卫不再反向纠错 ================== */
await check('守卫·语言要求解析：「不许用中文思考」= 要求用英文，不会再被纠成中文', () => {
  const w = '不许用中文思考';
  const r = G.extract(w, '');
  assert.strictEqual(r.lang, 'en', '「' + w + '」应识别为要求英文思考，实际 ' + JSON.stringify(r.lang));
  assert.deepStrictEqual(r.terms, [], '语言要求不该同时变成禁区词');
  assert.ok(G.checkText(L_ZH, r), '中文思考应被拦下');
  assert.ok(!G.checkText(L_EN, r), '英文思考不该被拦下');
});
await check('守卫·语言要求解析：各种语序都对（含「不许 / 不要 / 禁止 / 别 … 中文思考」）', () => {
  const cases = [
    ['不许用中文思考', 'en'], ['不要用中文思考', 'en'], ['别用中文思考', 'en'], ['禁止用中文思考', 'en'],
    ['思考过程不许用中文', 'en'], ['思考时不要用中文', 'en'], ['思考不要使用中文', 'en'], ['思考不能用中文', 'en'],
    ['思考过程一律使用英文', 'en'], ['思考时使用英文', 'en'], ['请用英文思考', 'en'],
    ['思考请用中文', 'zh'], ['思考用中文', 'zh'], ['思考过程请用中文', 'zh'], ['思考过程必须用中文', 'zh'],
    ['思考时不要用英文', 'zh'], ['不要用英文思考', 'zh'], ['中文思考', 'zh']
  ];
  const bad = [];
  cases.forEach(([instr, want]) => {
    const r = G.extract(instr, '');
    const hitEn = !!G.checkText(L_EN, r), hitZh = !!G.checkText(L_ZH, r);
    const ok = r.lang === want && (want === 'zh' ? (hitEn && !hitZh) : (hitZh && !hitEn));
    if (!ok) bad.push(instr + '→' + r.lang);
  });
  assert.deepStrictEqual(bad, [], '识别错误：' + bad.join('，'));
});
await check('守卫·整句规则不再被当成禁区词（复述规则不会被判违规、也不写进禁令清单）', () => {
  assert.deepStrictEqual(G.extract('不许用中文思考', '').terms, []);
  assert.deepStrictEqual(G.extract('', '不许用中文思考').terms, [], '填在「思考禁区」里的整句规则也不该当词');
  assert.deepStrictEqual(G.extract('不要用中文思考', '').terms, []);
  const r = G.extract('思考时不要提及价格', '');
  assert.deepStrictEqual(r.terms, ['价格'], '正常的禁区词仍然要抽出来');
});
await check('守卫·引用 / 复述用户原话不再被当成违规', () => {
  const r = G.extract('不许用中文思考', '');
  const gs = { rules: r, instr: '不许用中文思考', name: 'P', hits: [], retries: 0, total: 0, max: 5, exhausted: false };
  const b = G.bannedList(gs);
  assert.deepStrictEqual(b, [], '禁令清单不该含「不许用中文思考」这种整句规则');
  // 复述规则的句子：只有引号引用 + 「用户说」这种转述，才走「存疑」交给语义核对，本地不直接判违规
  const q = '用户说「不许用中文思考」，我照办：先把需求拆一下，再逐块分析取舍，最后给结论和验证方式。'.repeat(3);
  const hit = G.checkText(q, r);
  assert.strictEqual(hit, null, '复述规则被本地规则判成违规了：' + JSON.stringify(hit));
});
await check('守卫·纠偏提示按用户要求的方向说（要求英文时不会写「请使用中文」）', () => {
  assert.ok(has(html, "x.kind === 'lang'"), 'suffix 没有区分语言类纠偏的方向');
  assert.ok(has(html, '这是项目指令对「思考语言」的要求，正文回答语言按用户的要求来'), '缺少语言纠偏的方向说明');
});
await check('守卫·禁区词功能没被削弱（真的在谈被禁话题仍然拦下）', () => {
  const r = G.extract('思考时不要提及价格和折扣', '');
  assert.deepStrictEqual(r.terms, ['价格', '折扣']);
  const hit = G.checkText('先算一下价格和折扣，用户问的是这个，我看看怎么报。', r);
  assert.ok(hit, '真的在谈价格却没被拦下');
});

/* ================== 四、Bug3 项目对话不外漏 ================== */
await check('项目·切换模式时只在当前项目里找 / 建空白对话', () => {
  assert.ok(has(html, "const pid = (typeof Projects !== 'undefined') ? Projects.activeId() : '';"), 'Mode.set 没有读当前项目');
  assert.ok(has(html, "(pid ? x.projectId === pid : !x.projectId)"), 'Mode.set 没有按项目过滤空白对话');
});
await check('项目·切到项目外的新空白对话时把它归回项目（切模式 / 点新对话都覆盖）', () => {
  assert.ok(has(html, 'keepBlank() {'), '缺少 keepBlank');
  assert.ok(has(html, "this.curId = id; Store.set('current_session', id); this.keepBlank();"), 'switchTo 没有调用 keepBlank');
  assert.ok(has(html, "['pointerdown', 'focusin', 'visibilitychange'].forEach((ev) => document.addEventListener(ev, keepBlank"), '没有在用户操作 / 回到页面时兜住');
  assert.ok(has(html, 'Sessions.keepBlank()'), 'boot 阶段没有调用');
});
await check('项目·只归空白对话，有内容的对话绝不因为切换而改归属', () => {
  assert.ok(has(html, 'if (!s || s.messages.length || s.projectId === pid || s.noProj) return;'), 'keepBlank 没有排除有内容的对话');
});
await check('项目·用户手动「移出项目」的空白对话不会被自动捡回去', () => {
  assert.ok(has(html, 's.noProj = 1;'), '移出项目没有记 noProj');
  assert.ok(has(html, 'if (pid && this.get(pid)) { s.projectId = pid; delete s.noProj; }'), '移入项目没有清 noProj');
  assert.ok(has(html, '!s.messages.length && !s.archived && !s.noProj'), '迁移时没有跳过 noProj');
});
await check('项目·启动时一次性把漏在项目外的空白对话归回来（只做一次）', () => {
  assert.ok(has(html, 'migrateBlank() {'), '缺少 migrateBlank');
  assert.ok(has(html, 'if (!this._mig) { this._mig = 1;'), '没有「只做一次」的保护');
});

/* ================== 五、Bug4 输入框撑高 ================== */
await check('输入框·放不下时欢迎页改顶对齐并可滚动（不再整体居中把顶部顶出可视区）', () => {
  assert.ok(has(html, '.stage.empty.tight{justify-content:flex-start;padding-bottom:0}'), '缺少 .tight 顶对齐');
  assert.ok(has(html, '.stage.empty.tight .hero{flex:1 1 auto;min-height:0;overflow-y:auto'), '欢迎页没有变成可滚动');
  assert.ok(has(html, 'fitEmpty() {'), '缺少 fitEmpty');
  assert.ok(has(html, "st.classList.toggle('tight', need > st.clientHeight)"), 'fitEmpty 判断不对');
});
await check('输入框·高度变化 / 视口变化后都会重算（键盘升降、旋转、窗口缩放）', () => {
  assert.ok(has(html, "ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; try { View.fitEmpty(); }"), 'autosize 没有重算');
  assert.ok(has(html, "window.visualViewport.addEventListener('resize', onVp"), '没有监听软键盘引起的视口变化');
  assert.ok(has(html, 'this.fitEmpty();   // v2.34.2：放不下时切换成顶对齐 + 可滚动'), 'updateEmpty 没有重算');
});
await check('浮层·输入框工具栏的浮层抬到设置面板 / 项目设置之上（点模型、思考强度能生效）', () => {
  assert.ok(has(html, /#popLayer\{position:fixed;inset:0;z-index:60/), '#popLayer 基础规则不见了');
  assert.ok(has(html, /#popLayer\{z-index:7[2-9]\}/), '#popLayer 仍然低于移动端抽屉(70) / 设置面板(80)');
});

/* ================== 六、版本一致性 ================== */
await check('版本号已升到 package.json 的版本（改动会真正下发，不被 sw 缓存挡住）', () => {
  assert.ok(has(html, "ZC34_VER = '" + pkg.version + "'"), '前端 ZC34_VER 与 package.json 不一致');
  assert.ok(has(fs.readFileSync('_worker.js', 'utf8'), "ZC_VERSION = '" + pkg.version + "'"), 'Worker 版本号不一致');
  assert.ok(has(fs.readFileSync('public/sw.js', 'utf8'), 'zc-gura-v' + pkg.version), 'sw 缓存版本号不一致');
});

/* ================== 七、真实浏览器（没有 Playwright / Chromium 时跳过） ================== */
let pw = null;
try { pw = createRequire(import.meta.url)('playwright'); } catch (e) { pw = null; }
/* 注意：有的容器（例如 E2B 沙箱）里 Chromium 能启动但开不了页面，而且 newPage 的失败可能既不 resolve 也不 reject ——
 * 所以这里给探测加一道超时竞速，浏览器不可用就当作「跳过」，不让整个套件被拖住。 */
const raceMs = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('浏览器探测超时（' + ms + 'ms）')), ms))]);
let browser = null;
try {
  if (pw) {
    browser = await raceMs(pw.chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }), 15000);
    const probe = await raceMs(browser.newContext(), 8000);
    const pp = await raceMs(probe.newPage(), 8000);
    await raceMs(pp.setContent('<h1>ok</h1>'), 8000);
    await probe.close();
  }
} catch (e) {
  results.push(['SKIP', '[浏览器] 浏览器不可用', String((e && e.message) || e).split('\n')[0]]);
  try { if (browser) await browser.close(); } catch (e2) { /* ignore */ }
  browser = null;
}
if (browser) {
  try {
    const PFX = 'zc_gura_', now = Date.now();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html.replace('window.ZC = { Mode,', 'window.ZC = { Pop, View, Settings2, Composer, App, Toast, Dialog, Store, Sessions, Projects, Deep, Mode,') });
      if (u.pathname.startsWith('/__zc_auth__/status')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":false}' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.addInitScript(([PFX]) => {
      const t = Date.now();
      localStorage.setItem(PFX + 'sessions', JSON.stringify([{ id: 's0', title: '新对话', createdAt: t, updatedAt: t, messages: [], model: 'm', mode: 'chat' }]));
      localStorage.setItem(PFX + 'current_session', 's0');
      localStorage.setItem(PFX + 'ui_mode', 'chat');
      localStorage.setItem(PFX + 'projects', JSON.stringify([{ id: 'p1', name: '测试项目', instructions: '思考时不要提及价格', createdAt: t, updatedAt: t }]));
      localStorage.setItem(PFX + 'project_filter', 'p1');
      localStorage.setItem(PFX + 'apis', JSON.stringify([{ id: 'p', name: 'DS', url: 'https://signal.test/v1', key: 'k', model: 'deepseek-flash', format: 'openai', route: 'auto', headers: '' }]));
    }, [PFX]);
    await page.goto('https://signal.test/');
    await page.waitForTimeout(8000);
    const ev = (f, x) => page.evaluate(f, x);

    await check('[浏览器] 长输入时欢迎页改为顶对齐，图标 / 标题仍在可视区内，模型按钮没有被顶出屏幕', async () => {
      await page.click('#input');
      await ev(() => { const i = document.getElementById('input'); i.value = '这是一段很长的输入内容，用来模拟对话里输入了很多字的情况。'.repeat(12); ZC.Composer.autosize(); });
      await page.waitForTimeout(400);
      const r = await ev(() => {
        const g = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
        const hero = document.getElementById('hero'), hb = hero.getBoundingClientRect();
        const logo = document.querySelector('.hero .logo-big'), lb = logo ? logo.getBoundingClientRect() : null;
        const h1 = document.querySelector('.hero h1'), hb2 = h1 ? h1.getBoundingClientRect() : null;
        const comp = document.getElementById('composer').getBoundingClientRect();
        return { tight: document.getElementById('stage').classList.contains('tight'), model: g('modelBtn'), send: g('btnSend'), inputH: Math.round(document.getElementById('input').getBoundingClientRect().height), heroTop: Math.round(hb.top), logoTop: lb ? Math.round(lb.top) : null, h1Top: hb2 ? Math.round(hb2.top) : null, compTop: Math.round(comp.top), vh: innerHeight, vw: innerWidth };
      });
      assert.ok(r.tight, '放不下时没有切到 .tight');
      assert.ok(r.model.top >= 0 && r.model.bottom <= r.vh, '模型按钮被挤出屏幕: ' + JSON.stringify(r.model));
      assert.ok(r.logoTop !== null && r.logoTop >= r.model.bottom - 8, '主页图标被推到顶栏里 / 看不见：' + r.logoTop + ' vs 顶栏底 ' + r.model.bottom);
      assert.ok(r.h1Top > r.logoTop, '标题跑到图标上面了');
      assert.ok(r.compTop > r.h1Top, '输入框盖住了标题');
      assert.ok(r.send.top >= 0, '发送按钮不可见');
      return 'tight=' + r.tight + ' logoTop=' + r.logoTop + ' 输入框高=' + r.inputH;
    });
    await check('[浏览器] 空间够时保持原来的居中观感（没有误切 .tight）', async () => {
      await ev(() => { const i = document.getElementById('input'); i.value = '短'; ZC.Composer.autosize(); });
      await page.waitForTimeout(300);
      assert.strictEqual(await ev(() => document.getElementById('stage').classList.contains('tight')), false);
    });
    await check('[浏览器] 项目内：切换模式 / 新建对话都不会掉到项目外', async () => {
      const r = await ev(() => {
        const pid = ZC.Projects.activeId();
        const out = { pid, before: ZC.Sessions.cur().projectId || '' };
        ZC.Mode.set('code');                       // 项目里切模式
        out.afterSwitch = ZC.Sessions.cur().projectId || '';
        out.mode = ZC.Sessions.cur().mode;
        ZC.Chat.newChat();                          // 项目里点「新对话」
        out.afterNew = ZC.Sessions.cur().projectId || '';
        out.count = ZC.Sessions.list.filter((s) => !s.projectId).length;
        return out;
      });
      assert.strictEqual(r.pid, 'p1', '项目没有被选中');
      assert.strictEqual(r.afterSwitch, 'p1', '切模式掉出了项目：' + JSON.stringify(r));
      assert.strictEqual(r.afterNew, 'p1', '新建对话掉出了项目：' + JSON.stringify(r));
      return JSON.stringify(r);
    });
    await check('[浏览器] 思考开关在两种模式之间互不影响（聊天开的思考不会带到代码模式）', async () => {
      const r = await ev(() => {
        ZC.Deep.retarget('chat'); ZC.Deep.set(true, 'high');
        const chat = { on: ZC.Deep.on, lv: ZC.Deep.level };
        ZC.Deep.retarget('code');
        const code = { on: ZC.Deep.on, lv: ZC.Deep.level };
        ZC.Deep.set(false);
        ZC.Deep.retarget('chat');
        const back = { on: ZC.Deep.on, lv: ZC.Deep.level };
        return { chat, code, back };
      });
      assert.deepStrictEqual(r.chat, { on: true, lv: 'high' }, '聊天里设的思考强度没记住：' + JSON.stringify(r));
      assert.deepStrictEqual(r.code, { on: false, lv: 'medium' }, '代码模式被聊天模式的思考设置串了：' + JSON.stringify(r));
      assert.deepStrictEqual(r.back, { on: true, lv: 'high' }, '切回聊天没恢复：' + JSON.stringify(r));
    });
    await check('[浏览器] 页面无脚本错误', async () => { assert.deepStrictEqual(errs, []); });
    await ctx.close();
  } catch (e) {
    results.push(['SKIP', '[浏览器] 真实交互中途失败', String((e && e.message) || e).split('\n')[0]]);
  } finally { try { await browser.close(); } catch (e) { /* ignore */ } }
} else {
  results.push(['SKIP', '[浏览器] 真实交互（长输入布局 / 项目归属 / 思考开关）', 'Playwright 或 Chromium 起不来，已跳过（纯逻辑与静态契约仍已校验）']);
}

let fail = 0;
for (const [st, n, d] of results) { if (st === 'FAIL') fail++; console.log(st + ' | ' + n + (d ? '  → ' + d : '')); }
const total = results.filter((r) => r[0] !== 'SKIP').length;
console.log('===== ' + results.filter((r) => r[0] === 'PASS').length + '/' + total + ' 通过 =====');
process.exit(fail ? 1 : 0);
