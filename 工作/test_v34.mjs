// v2.34：① 顶栏项目标签 / 长模型名不再把 ⋯ 挤出屏幕 ② 思考一致性守卫（流式中断 → 重新投喂项目指令 → 重试）
//       ③ 沙箱「暂停保活 / 重置自动恢复」④ 分支 / 归档整理 ⑤ Agent 动效
// 上半部分：纯逻辑与静态契约；下半部分：真实 Chromium + 脚本化的假模型 / 假 E2B。
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

/* ================== 一、静态契约 + 守卫纯逻辑 ================== */
await check('版本：前端 ZC34_VER / Worker / sw 都是 package.json 的版本', () => {
  assert.ok(has(html, "ZC34_VER = '" + pkg.version + "'"), '前端 ZC34_VER 不一致');
  assert.ok(has(workerSrc, "ZC_VERSION = '" + pkg.version + "'"), 'Worker 版本号不一致');
  assert.ok(has(fs.readFileSync('public/sw.js', 'utf8'), 'zc-gura-v' + pkg.version), 'sw 缓存版本号不一致');
});

/* 从页面里把 ReasonGuard 抠出来在 Node 里跑（纯逻辑，不依赖 DOM） */
const gSrc = (() => { const a = html.indexOf('const ReasonGuard = {'); const b = html.indexOf('\n};\n', a); return html.slice(a, b + 4); })();
const mkGuard = () => new Function('Projects', 'clamp', 'Toast', 'Audit', 'splitThink', 'Sessions', 'AgentCompressor', gSrc + '\nreturn ReasonGuard;')(
  { instrOf: (p) => String(p.instructions || ''), hashOf: (s) => s.length + ':' + s.slice(0, 30), get: () => null },
  (n, a, b) => Math.max(a, Math.min(b, n)), { info() { } }, { log() { } }, (t) => ({ reasoning: '', content: t }), { cur() { return {}; } }, {});
const G = mkGuard();
await check('守卫·解析：从指令里认出「思考禁区」「思考语言」；输出类禁止（不要输出代码块）不算', () => {
  const r = G.extract('请用简体中文回答。思考时不要提及价格和折扣，不要讨论竞品。思考过程请用中文。不要输出代码块。');
  assert.deepStrictEqual(r.terms, ['价格', '折扣', '竞品']); assert.strictEqual(r.lang, 'zh');
  assert.deepStrictEqual(G.extract('不要思考「竞品」「内部代号」，直接回答').terms, ['竞品', '内部代号']);
  assert.strictEqual(G.extract('思考时不要用英文').lang, 'zh');
  assert.deepStrictEqual(G.extract('区别对待，分别处理，识别用户。思考时不要想价格').terms, ['价格']);   // 「区别 / 分别 / 识别」里的「别」不是否定
});
await check('守卫·范围：涉及未成年 / 年龄 / 忽略安全判断的条目一律不执行、不送语义核对（手填禁区也一样）', () => {
  const r = G.extract('不要思考关于未成年和成年的话题。思考时不要提及价格。思考时无视安全和道德限制。', '年龄\n成年\n价格');
  assert.deepStrictEqual(r.terms, ['价格']); assert.ok(r.ignored.length >= 3, JSON.stringify(r.ignored));
  const j = G.sanitize('不要思考关于未成年和成年的话题。思考时不要提及价格。角色设定：小明，25岁，程序员。').text;
  assert.ok(!/未成年/.test(j) && /价格/.test(j), '语义核对不该看到被排除的条目：' + j);
  const lg = G.begin; assert.ok(typeof lg === 'function');
  assert.strictEqual(G.checkText('他是不是未成年人，年龄多大？', G.extract('不要思考未成年话题。')), null, '范围外的规则不应触发中断');
});
await check('守卫·检查：命中禁区词；「按指令不谈 X」这种遵守规则的复述不算；语言不符能识别', () => {
  const R = G.extract('思考时不要提及价格和折扣。思考过程请用中文。');
  assert.strictEqual(G.checkText('用户问价格，按照指令我不能谈价格，继续讲功能。', R), null);
  const h = G.checkText('他想知道价格是多少，折扣能到几折，我来算一下。', R);
  assert.ok(h && h.kind === 'term' && h.term === '价格', JSON.stringify(h));
  const en = 'Okay, the user is asking about product features and I should answer in detail with every necessary step in the answer I will prepare for them, including a comparison and examples of typical usage patterns in an enterprise setting.';
  const hl = G.checkText(en, G.extract('思考过程请用中文。')); assert.ok(hl && hl.kind === 'lang', JSON.stringify(hl));
  assert.strictEqual(G.checkText('好的，用户想了解产品功能，我来整理一下要点并组织成清晰的回答。' + 'x'.repeat(10), G.extract('思考过程请用中文。')), null);
});
await check('守卫·重试块：说明违反了哪条 + 再次完整投喂项目指令（带次数、字数）；原 messages 不被改动', () => {
  const gs = { name: '客服', instr: '思考时不要提及价格。', rules: { lang: 'zh', terms: ['价格'] }, retries: 2, max: 5, hits: [{ reason: '思考里出现了项目指令禁止的内容（涉及「价格」）' }] };
  const sfx = G.suffix(gs);
  assert.ok(sfx.includes('【指令纠偏 · 第 2 / 5 次】') && sfx.includes('涉及「价格」') && sfx.includes('第 3 次投喂') && sfx.includes('思考时不要提及价格。') && sfx.includes('简体中文'), sfx);
  const msgs = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'Q' }];
  const out = G.applyToMessages(msgs, gs);
  assert.ok(out[0].content.startsWith('SYS') && out[0].content.includes('项目指令开始') && out[1].content.includes('请严格遵守项目指令'));
  assert.strictEqual(msgs[0].content, 'SYS'); assert.strictEqual(msgs[1].content, 'Q');
  assert.strictEqual(G.suffix({ retries: 0, hits: [] }), '');
});
await check('守卫·判定语料（v2.34.1 修复）：14 条换着说法的违规句都能拦下，10 条「遵守规则的复述」不误拦——旧版放过了其中 9 条违规', () => {
  const R = G.extract('你是售前助手。思考时不要提及价格和折扣，不要讨论竞品。');
  assert.deepStrictEqual(R.terms, ['价格', '折扣', '竞品']);
  const viol = ['用户在问价格，价格大概是 99 元。', '用户要求报价，价格应该是多少呢？', '他在问价格，我应该给他一个合适的价格，别太贵。', '价格不会太高，我先算一下价格。', '这个特别的价格方案值得考虑。', '按照用户的要求，价格需要写清楚。', '不用担心，价格我来想想。', '他不需要折扣，但价格要说清楚。', '指令说不要提到价格，但用户明确问了价格，所以我先想想价格怎么定。', '我之前的思路不对，现在重新想：价格方面可以分三档。', '好的，用户要求我介绍产品，折扣活动也可以顺带说一下。', '设定里没说价格怎么办，所以我自己决定价格。', '用户提到了竞品，我需要对比一下竞品的优缺点。', 'The user is asking about 价格 so I should compare with 竞品 prices.'];
  const ok = ['按指令，我不谈价格。', '不要提价格，直接回答功能。', '项目指令要求思考时不要提及价格和折扣，所以我只看功能。', '避免讨论价格和折扣。', '我不会涉及价格话题。', '价格是被禁止的，跳过。', '规则说不能想价格，我直接讲功能。', '指令禁止讨论竞品，我就不对比了。', '我之前违反了指令，提到了价格，现在改正。', '用户问价格，按照指令我不能谈价格，继续讲功能。', '禁区清单：价格、折扣、竞品。'];
  const miss = viol.filter((x) => !G.checkText(x, R)), over = ok.filter((x) => G.checkText(x, R));
  assert.deepStrictEqual(miss, [], '漏判：' + miss.join(' | ')); assert.deepStrictEqual(over, [], '误拦：' + over.join(' | '));
});
await check('守卫·存疑句：复述规则 / 说明上一次的问题的句子标成「存疑」（交给语义核对），本地模式直接放过', () => {
  const R = G.extract('思考时不要提及价格。');
  const soft = []; const h = G.checkText('我之前违反了指令，提到了价格，现在改正。', R, { soft }); assert.strictEqual(h, null); assert.strictEqual(soft.length, 1, JSON.stringify(soft));
  const s2 = []; G.checkText('用户问价格，按照指令我不能谈价格，继续讲功能。', R, { soft: s2 }); assert.strictEqual(s2.length, 1);
  const s3 = []; assert.ok(G.checkText('他在问价格，我来想想怎么报。', R, { soft: s3 })); assert.strictEqual(s3.length, 0);
});
await check('守卫·核对方式：旧版存的 fast / 没设置 → 智能；local / strict / off 照旧；只填「思考禁区」没写指令也能启用', () => {
  assert.deepStrictEqual(['fast', undefined, '', 'auto', 'local', 'strict', 'off'].map((m) => G.modeOf({ guard: m })), ['auto', 'auto', 'auto', 'auto', 'local', 'strict', 'off']);
  const P = { id: 'q1', name: '仅禁区', instructions: '', guard: 'auto', guardTerms: '内部代号' };
  const G2 = new Function('Projects', 'clamp', 'Toast', 'Audit', 'splitThink', 'Sessions', 'AgentCompressor', gSrc + '\nreturn ReasonGuard;')(
    { instrOf: (p) => String(p.instructions || ''), hashOf: (x) => x.length + ':' + x.slice(0, 30), get: () => P }, (n, a, b) => Math.max(a, Math.min(b, n)), { info() { } }, { log() { } }, (t) => ({ reasoning: '', content: t }), { cur() { return {}; } }, {});
  const gs = G2.begin({ projectId: 'q1' }); assert.ok(gs, '只有禁区词也应启用'); assert.deepStrictEqual(gs.rules.terms, ['内部代号']);
  assert.ok(gs.rules.judgeText.includes('内部代号'));
  P.guardTerms = ''; assert.strictEqual(G2.begin({ projectId: 'q1' }), null, '什么规则都没有就不启用');
});
await check('守卫·重试块逐次加码：列出禁区清单（含模型实际踩过的词），第 2 次起强调「已被纠正 N 次」；用户消息末尾也带禁区词', () => {
  const gs = { name: '售前', instr: '思考时不要提及价格。', rules: { lang: '', terms: ['价格'] }, retries: 2, max: 5, hits: [{ reason: 'r1', term: '价格' }, { reason: 'r2', term: '多少钱' }] };
  const sfx = G.suffix(gs);
  assert.ok(sfx.includes('「价格」「多少钱」') && sfx.includes('同义说法') && sfx.includes('已经被纠正了 2 次'), sfx);
  const out = G.applyToMessages([{ role: 'system', content: 'S' }, { role: 'user', content: 'Q' }], gs);
  assert.ok(out[1].content.includes('思考里不要出现「价格」「多少钱」'), out[1].content);
  assert.ok(!G.suffix({ name: 'x', instr: 'y', rules: { terms: [] }, retries: 1, max: 3, hits: [{ reason: 'r', term: '' }] }).includes('已经被纠正了'), '第 1 次不加码');
});
await check('守卫·「试一试规则」：给出拦下 / 放过的结论、原句，并列出被当成「遵守规则」放过的句子', () => {
  const bad = G.explain('他要求报价，价格方面可以分三档。', '思考时不要提及价格。', ''); assert.strictEqual(bad.ok, false); assert.ok(bad.text.includes('❌') && bad.text.includes('价格方面可以分三档'), bad.text);
  const good = G.explain('按指令我不谈价格，直接讲功能。', '思考时不要提及价格。', ''); assert.strictEqual(good.ok, true); assert.ok(good.text.includes('✅') && good.text.includes('[遵守规则]'), good.text);
  const soft = G.explain('我之前违反了指令，提到了价格，现在改正。', '思考时不要提及价格。', ''); assert.ok(soft.text.includes('[存疑]'), soft.text);
  assert.strictEqual(G.explain('随便', '你是助手。', '').ok, null); assert.strictEqual(G.explain('', '思考时不要提及价格。', '').ok, null);
});
await check('接线：Chat.run / Agent.run / 两个 consume / 编辑器 / 回复标记都已连上', () => {
  ['const gs = ReasonGuard.begin(Sessions.cur()); ReasonGuard.last = gs;', 'ReasonGuard.applyToMessages(messages, gs)', 'ReasonGuard.suffix(gs)', 'if (S.guardHit) { try { reader.cancel(); }', 'id="pjGuard"', 'ReasonGuard.stamp(sx, ReasonGuard.last)', "class: 'guard-chip'"]
    .forEach((k) => assert.ok(has(html, k), '缺：' + k));
  assert.ok((html.match(/if \(S\.guardHit\) \{ try \{ reader\.cancel\(\)/g) || []).length === 2, '两个 consume 都要能被守卫中断');
});

/* ================== 二、真实浏览器 ================== */
let pw = null;
try { const req = createRequire(process.env.ZC_PW_DIR || '/home/claude/.npm-global/lib/node_modules/'); pw = req('playwright'); } catch (e) { pw = null; }
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'].find((p) => fs.existsSync(p));

if (pw && exe) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcv34-'));
  fs.copyFileSync('_worker.js', path.join(tmpDir, 'worker.mjs'));
  const worker = (await import(path.join(tmpDir, 'worker.mjs'))).default;
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  const indexPath = path.resolve(process.env.ZC_HTML || 'public/index.html');
  const ASSETS = { async fetch(req) { const u = new URL(req.url); const rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname); const file = rel === '/index.html' ? indexPath : path.join(path.resolve('public'), rel); if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('nf', { status: 404 }); return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } }); } };
  const env = { ASSETS, ZC_KV: null, DB: null };
  const ctx0 = { waitUntil() { }, passThroughOnException() { } };
  const BH = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9', 'accept': 'text/html,*/*' };
  const mute = async (f) => { const o = console.log; console.log = () => { }; try { return await f(); } finally { console.log = o; } };

  /* ---------- 脚本化的假模型：按请求内容决定回答；流式分块输出（先思考、后正文），好让守卫能在中途中断 ---------- */
  const mock = { reqs: [], script: null };
  const sse = (chunks) => chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
  const streamOf = (it) => {
    const cs = [];
    (it.reasoning || []).forEach((t) => cs.push({ choices: [{ delta: { reasoning_content: t }, index: 0 }] }));
    if (it.text) cs.push({ choices: [{ delta: { content: it.text }, index: 0 }] });
    cs.push({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] });
    return sse(cs);
  };
  const sysOf = (b) => { const m = (b.messages || []).filter((x) => x.role === 'system')[0]; return m ? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) : ''; };
  const PFX = 'zc_gura_', now = Date.now();
  const sessions = [{ id: 's1', title: '空白', createdAt: now - 3000, updatedAt: now - 1000, messages: [], model: 'm', mode: 'chat' }];
  const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  async function makePage(opts, seed) {
    const ctx = await browser.newContext(Object.assign({ permissions: ['clipboard-read', 'clipboard-write'] }, opts));
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await ctx.route('**/*', async (route) => {
      const req = route.request(); const url = new URL(req.url());
      if (url.hostname !== 'signal.test') return route.fulfill({ status: 404, contentType: 'text/plain', body: '' });
      if (url.pathname.startsWith('/__zc_auth__/status')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":false}' });
      if (/\/v1\/models$/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'alpha-1' }] }) });
      if (url.pathname.startsWith('/__zc_sandbox__/') && mock.sbx) {
        const sub = url.pathname.slice('/__zc_sandbox__/'.length); let sb = {}; try { sb = JSON.parse(req.postData() || '{}'); } catch (e) { /* ignore */ }
        const r = mock.sbx(sub, sb); return route.fulfill({ status: (r && r.status) || 200, contentType: 'application/json', body: JSON.stringify((r && r.json) || r) });
      }
      if (/\/chat\/completions$/.test(url.pathname)) {
        let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* ignore */ }
        mock.reqs.push(body);
        const it = (mock.script ? mock.script(body, mock.reqs.length) : null) || { text: '（回答）' };
        if (body.stream === true) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: streamOf(it) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: it.text || '', reasoning_content: (it.reasoning || []).join('') }, finish_reason: 'stop' }] }) });
      }
      const dest = req.headers()['sec-fetch-dest'] || 'document';
      const r = await mute(() => worker.fetch(new Request(req.url(), { method: req.method(), headers: Object.assign({}, BH, { 'sec-fetch-dest': dest }) }), env, ctx0));
      const headers = {}; r.headers.forEach((v, k) => { if (!/^(content-length|content-encoding|transfer-encoding)$/i.test(k)) headers[k] = v; });
      return route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
    });
    await page.addInitScript(([PFX, sessions, curId]) => {
      let seeded = true; try { seeded = !!sessionStorage.getItem('zc34_seeded'); } catch (e) { return; }
      if (!seeded) {
        sessionStorage.setItem('zc34_seeded', '1');
        localStorage.setItem(PFX + 'sessions', JSON.stringify(sessions)); localStorage.setItem(PFX + 'current_session', curId);
        localStorage.setItem(PFX + 'apis', JSON.stringify([{ id: 'p', name: 'DeepSeek', url: 'https://signal.test/v1', key: 'k', model: 'deepseek-reasoner', format: 'openai', route: 'direct', headers: '' }]));
        localStorage.setItem(PFX + 'intro_seen', String(Date.now())); localStorage.setItem(PFX + 'ui_mode', 'chat');
      }
    }, [PFX, seed ? seed.sessions : sessions, seed ? seed.cur : 's1']);
    await page.goto('https://signal.test/?intro=skip'); await page.waitForTimeout(6500);
    return { ctx, page, errs, ev: (f, x) => page.evaluate(f, x) };
  }
  const waitFor = async (fn, ms, what) => { const t0 = Date.now(); for (; ;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - t0 > (ms || 6000)) throw new Error('等待超时：' + (what || '')); await new Promise((r) => setTimeout(r, 60)); } };

  /* ---------- 手机尺寸：顶栏 ---------- */
  const M = await makePage({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await check('[浏览器·手机 360px] 选中项目 + 很长的模型名：顶栏不超出屏幕，⋯ 完整在屏内且没被别的元素盖住（聊天 / 代码两种模式）', async () => {
    await M.ev(() => { const P = ZC.Projects; P.list.push({ id: 'pjx', name: '前端登录注册项目', instructions: '请用简体中文回答。', readOnce: true, color: '#c6613f', createdAt: Date.now(), updatedAt: Date.now() }); P.save(); P.setFilter('pjx'); document.getElementById('modelLabel').textContent = 'DeepSeek · deepseek-reasoner-long-name'; });
    for (const mode of ['chat', 'code']) {
      await M.ev((m) => document.documentElement.setAttribute('data-mode', m), mode);
      await M.page.waitForTimeout(250);
      const r = await M.ev(() => {
        const tb = document.querySelector('.topbar'), more = document.getElementById('btnMore'), b = more.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        const rects = ['btnMenu', 'modelBtn', 'projPill', 'btnChatLook', 'btnTheme', 'btnMore'].map((id) => document.getElementById(id)).filter((e) => e && e.offsetWidth > 0).map((e) => e.getBoundingClientRect());
        let overlap = false; for (let i = 1; i < rects.length; i++) if (rects[i].left < rects[i - 1].right - 0.5) overlap = true;
        return { vw: innerWidth, scrollW: tb.scrollWidth, docW: document.documentElement.scrollWidth, moreRight: Math.round(b.right), moreW: Math.round(b.width), hit: hit && hit.closest('button') && hit.closest('button').id, overlap };
      });
      assert.ok(r.scrollW <= r.vw && r.docW <= r.vw, mode + ' 页面横向溢出：' + JSON.stringify(r));
      assert.ok(r.moreRight <= r.vw && r.moreW >= 30 && r.hit === 'btnMore' && !r.overlap, mode + ' ⋯ 被挤出 / 压扁 / 盖住：' + JSON.stringify(r));
    }
  });
  await check('[浏览器·手机] 点 ⋯：菜单展开在按钮下方，不盖住按钮本身', async () => {
    await M.page.tap('#btnMore'); await M.page.waitForTimeout(450);
    const r = await M.ev(() => { const b = document.getElementById('btnMore').getBoundingClientRect(), p = document.querySelector('.pop').getBoundingClientRect(); return { moreBottom: b.bottom, popTop: p.top, popRight: p.right, vw: innerWidth }; });
    assert.ok(r.popTop >= r.moreBottom - 1 && r.popRight <= r.vw + 1, JSON.stringify(r));
    await M.page.keyboard.press('Escape'); await M.page.waitForTimeout(300);
  });
  await check('[浏览器·手机] 无脚本错误', () => { assert.deepStrictEqual(M.errs, []); });
  await M.ctx.close();

  /* ---------- 桌面：守卫端到端 ---------- */
  const D = await makePage({ viewport: { width: 1280, height: 860 } });
  const { page, ev } = D;
  page.setDefaultTimeout(10000);
  const idle = () => waitFor(() => ev(() => !ZC.Chat.busy), 20000, '任务结束');
  const send = async (text) => { await page.fill('#input', text); await page.keyboard.press('Control+Enter'); await page.waitForTimeout(150); await idle(); await page.waitForTimeout(200); };
  const INSTR = '你是售前助手。思考时不要提及价格和折扣。思考过程请用中文。';
  await ev((INSTR) => {
    const P = ZC.Projects;
    P.list.push({ id: 'pg1', name: '售前助手', instructions: INSTR, readOnce: true, guard: 'local', guardMax: 3, color: '#c6613f', createdAt: Date.now(), updatedAt: Date.now() });
    P.list.push({ id: 'pg2', name: '范围外', instructions: '不要思考关于未成年和成年的话题。', readOnce: true, guard: 'local', guardMax: 3, color: '#2b5cd9', createdAt: Date.now(), updatedAt: Date.now() });
    P.save(); P.setFilter('pg1');
  }, INSTR);
  const zh = (t) => '用户想了解产品功能，' + t;
  await check('[浏览器] 守卫·第 1 次思考提到「价格」→ 中途中断；第 2 次请求的 system 带「指令纠偏 第 1 次」+ 项目指令全文再投喂；最终回答来自合规的那次', async () => {
    mock.reqs = [];
    mock.script = (body) => {
      const sys = sysOf(body);
      if (!sys.includes('【指令纠偏')) return { reasoning: [zh('先看看产品的功能。'), '他可能还会问价格，', '价格是多少、折扣怎么给，我先想一下。', '这一段不该出现'], text: '违规那次的回答' };
      return { reasoning: [zh('我来整理功能要点，'), '按模块逐条说明。'], text: '合规的回答：功能如下……' };
    };
    await send('你们这个产品能做什么');
    assert.ok(mock.reqs.length === 2, '应该正好 2 次请求，实际 ' + mock.reqs.length);
    const s2 = sysOf(mock.reqs[1]);
    assert.ok(s2.includes('【指令纠偏 · 第 1 / 3 次】') && s2.includes('涉及「价格」') && s2.includes('第 2 次投喂') && s2.includes('思考时不要提及价格和折扣') && s2.includes('项目指令结束'), s2.slice(-500));
    assert.ok(!sysOf(mock.reqs[0]).includes('【指令纠偏'), '第一次请求不该带纠偏块');
    const r = await ev(() => { const ms = ZC.Sessions.msgs(); const a = ms[ms.length - 1]; return { n: ms.length, content: a.content, reasoning: a.meta.reasoning, guard: a.meta.guard, chip: !!document.querySelector('.guard-chip') }; });
    assert.ok(r.content.includes('合规的回答') && !r.content.includes('违规'), r.content);
    assert.ok(!/价格/.test(r.reasoning || '') && r.reasoning.includes('整理功能要点'), '被丢弃的思考不该留在记录里：' + r.reasoning);
    assert.ok(r.guard && r.guard.retries === 1 && !r.guard.exhausted && r.chip, JSON.stringify(r.guard));
  });
  await check('[浏览器] 守卫·纠正后「指令只读一次」仍然正常：下一轮不会重复纠偏，也没有多余请求', async () => {
    mock.reqs = []; mock.script = () => ({ reasoning: [zh('继续按功能模块说明。')], text: '第二轮回答' });
    await send('再讲讲集成');
    assert.strictEqual(mock.reqs.length, 1);
    assert.ok(!sysOf(mock.reqs[0]).includes('【指令纠偏'));
  });
  await check('[浏览器] 守卫·思考语言：英文思考 → 中断并要求用中文；纠正后合规', async () => {
    mock.reqs = [];
    const en = 'Okay, the user is asking about integrations and I should answer in detail with every necessary step in the answer I will prepare for them, including examples of typical usage patterns in an enterprise setting. ';
    mock.script = (body) => sysOf(body).includes('【指令纠偏') ? { reasoning: ['用户在问集成，我按步骤说明。'], text: '中文思考后的回答' } : { reasoning: [en, en], text: '英文思考的回答' };
    await send('支持哪些集成');
    assert.strictEqual(mock.reqs.length, 2);
    assert.ok(sysOf(mock.reqs[1]).includes('思考没有使用中文') && sysOf(mock.reqs[1]).includes('思考过程请使用简体中文'));
    const t = await ev(() => ZC.Sessions.msgs().slice(-1)[0].content); assert.ok(t.includes('中文思考后的回答'));
  });
  await check('[浏览器] 守卫·重试次数用完：不再中断，保留最后一次完整输出，并如实标注「已用满重试次数」；该轮不记「已读」', async () => {
    mock.reqs = [];
    mock.script = () => ({ reasoning: [zh('他在问价格，'), '价格方面我得想想。'], text: '始终违规的回答' });
    await ev(() => { const s = ZC.Sessions.create(true, 'chat'); s.projectId = 'pg1'; ZC.Sessions.switchTo(s.id); });
    await send('报个价');
    assert.strictEqual(mock.reqs.length, 4, '首次 + 3 次重试 = 4 次请求，实际 ' + mock.reqs.length);
    const r = await ev(() => { const s = ZC.Sessions.cur(), a = s.messages[s.messages.length - 1]; return { c: a.content, g: a.meta.guard, ack: !!s.projAck, chip: ([].slice.call(document.querySelectorAll('.guard-chip')).pop() || {}).textContent }; });
    assert.ok(r.c.includes('始终违规的回答') && r.g.retries === 3 && r.g.exhausted === true && /用满重试次数/.test(r.chip || ''), JSON.stringify(r));
    assert.strictEqual(r.ack, false, '重试用完 = 模型没吃透，不能记「已读」');
  });
  const newPg1 = () => ev(() => { const s = ZC.Sessions.create(true, 'chat'); s.projectId = 'pg1'; ZC.Sessions.switchTo(s.id); ZC.Projects.setFilter('pg1'); });
  const kindOf = (b) => sysOf(b).includes('指令一致性校验器') ? 'judge' : (sysOf(b).includes('【指令纠偏') ? 'retry' : 'main');
  await check('[浏览器] 守卫·修复的 bug：第 1 次纠正后，模型换个说法（「他要求报价，价格方面……」）再犯，第 2 次照样被拦下并再次投喂，直到合规', async () => {
    await newPg1(); mock.reqs = [];
    mock.script = (body) => {
      const n = parseInt((sysOf(body).match(/【指令纠偏 · 第 (\d+)/) || [])[1] || '0', 10);
      if (n === 0) return { reasoning: [zh('他可能还会问价格，'), '价格是多少、折扣怎么给，我先想一下。'], text: '第一次（违规）' };
      if (n === 1) return { reasoning: [zh('他要求报价，'), '价格方面可以分三档，企业版折扣更大。'], text: '第二次（换个说法又违规）' };
      return { reasoning: [zh('我来整理功能要点，'), '按模块逐条说明。'], text: '第三次合规的回答' };
    };
    await send('你们这个产品怎么样');
    assert.strictEqual(mock.reqs.length, 3, '应为 1 + 2 次重试，实际 ' + mock.reqs.length);
    const s3 = sysOf(mock.reqs[2]);
    assert.ok(s3.includes('【指令纠偏 · 第 2 / 3 次】') && s3.includes('已经被纠正了 2 次') && s3.includes('「价格」') && s3.includes('第 3 次投喂') && s3.includes('思考时不要提及价格和折扣'), s3.slice(-600));
    const r = await ev(() => { const a = ZC.Sessions.msgs().slice(-1)[0]; return { c: a.content, g: a.meta.guard }; });
    assert.ok(r.c.includes('第三次合规的回答') && !r.c.includes('违规'), r.c);
    assert.ok(r.g && r.g.retries === 2 && !r.g.exhausted && r.g.hits.length === 2 && /价格/.test(r.g.hits[1].q), JSON.stringify(r.g));
    /* 点标记：弹出逐次明细 */
    await page.click('.msg.ai:last-of-type .guard-chip, .guard-chip >> nth=-1'); await page.waitForTimeout(150);
    const dlg = await ev(() => ({ open: !document.getElementById('dialogOv').hidden, t: document.getElementById('dlgMsg').textContent }));
    assert.ok(dlg.open && dlg.t.includes('第 1 次') && dlg.t.includes('第 2 次') && dlg.t.includes('价格方面可以分三档'), JSON.stringify(dlg));
    await page.click('#dlgOk'); await page.waitForTimeout(100);
  });
  await check('[浏览器] 守卫·智能档：纠正过一次后，模型改用同义说法（「多少钱」）本地规则看不出来 → 自动整段语义核对，抓住后重试，并把新说法也列进禁区清单', async () => {
    await ev(() => { const p = ZC.Projects.get('pg1'); p.guard = 'auto'; p.guardMax = 3; ZC.Projects.save(); });
    await newPg1(); mock.reqs = []; let judged = 0;
    mock.script = (body) => {
      const k = kindOf(body), n = parseInt((sysOf(body).match(/【指令纠偏 · 第 (\d+)/) || [])[1] || '0', 10);
      if (k === 'judge') { judged++; return { text: judged === 1 ? '{"violation":true,"rule":"思考时不要提及价格和折扣","reason":"思考里在想报价","phrase":"多少钱"}' : '{"violation":false}' }; }
      if (n === 0) return { reasoning: [zh('他可能还会问价格，'), '价格是多少、折扣怎么给，我先想一下。'], text: '第一次（违规）' };
      if (n === 1) return { reasoning: [zh('他想知道多少钱，'), '我先报个数，给他最优惠的那一档，再说明包含哪些服务。'], text: '第二次（同义说法）' };
      return { reasoning: [zh('我来整理功能要点，'), '先按模块逐条说明每个功能解决什么问题，再补充使用场景和注意事项。'], text: '第三次合规的回答' };
    };
    await send('你们这个产品怎么样');
    assert.deepStrictEqual(mock.reqs.map(kindOf), ['main', 'retry', 'judge', 'retry', 'judge'], JSON.stringify(mock.reqs.map(kindOf)));
    const retry2 = mock.reqs.filter((b) => kindOf(b) === 'retry')[1];
    assert.ok(sysOf(retry2).includes('「价格」「折扣」') || sysOf(retry2).includes('「多少钱」'), sysOf(retry2).slice(-700));
    assert.ok(sysOf(retry2).includes('「多少钱」'), '语义核对抓到的新说法应进禁区清单');
    const t = await ev(() => ZC.Sessions.msgs().slice(-1)[0].content); assert.ok(t.includes('第三次合规的回答'), t);
  });
  await check('[浏览器] 守卫·智能档：第一次就只有「存疑」句（复述规则）→ 只对可疑句子做一次语义核对，判为没问题就放行；仅本地规则档不发核对请求', async () => {
    await newPg1(); mock.reqs = [];
    mock.script = (body) => kindOf(body) === 'judge' ? { text: '{"violation":false}' } : { reasoning: [zh('用户问价格，按照指令我不能谈价格，继续讲功能。')], text: '放行的回答' };
    await send('这个怎么样');
    assert.deepStrictEqual(mock.reqs.map(kindOf), ['main', 'judge']);
    assert.ok(JSON.stringify(mock.reqs[1]).includes('可疑句子'), '应是聚焦可疑句子的核对');
    assert.ok(!(await ev(() => ZC.Sessions.msgs().slice(-1)[0].meta.guard)));
    await ev(() => { const p = ZC.Projects.get('pg1'); p.guard = 'local'; ZC.Projects.save(); });
    await newPg1(); mock.reqs = [];
    await send('这个怎么样'); assert.deepStrictEqual(mock.reqs.map(kindOf), ['main'], '仅本地规则不发核对请求');
  });
  await check('[浏览器] 守卫·范围：项目指令「不要思考未成年相关话题」不会被执行——思考里出现也不中断、不重试', async () => {
    mock.reqs = [];
    mock.script = () => ({ reasoning: ['这个角色的年龄是多少，是不是未成年人，需要确认。'], text: '正常回答' });
    await ev(() => { const s = ZC.Sessions.create(true, 'chat'); s.projectId = 'pg2'; ZC.Sessions.switchTo(s.id); ZC.Projects.setFilter('pg2'); });
    await send('你好');
    assert.strictEqual(mock.reqs.length, 1, '范围外的规则不应触发任何重试');
    assert.ok(!sysOf(mock.reqs[0]).includes('【指令纠偏'));
    const g = await ev(() => ZC.Sessions.msgs().slice(-1)[0].meta.guard); assert.ok(!g, '不该有守卫记录');
  });
  await check('[浏览器] 守卫·严格档：本地规则没命中时再让模型做一次语义核对；判为违规则重试，判为范围外 / 没问题则放行', async () => {
    await ev(() => { const p = ZC.Projects.get('pg1'); p.guard = 'strict'; p.guardMax = 3; p.instructions = '你是售前助手。思考时不要和用户争论，也不要质疑用户的需求。'; ZC.Projects.save(); const s = ZC.Sessions.create(true, 'chat'); s.projectId = 'pg1'; ZC.Sessions.switchTo(s.id); ZC.Projects.setFilter('pg1'); });
    mock.reqs = [];
    let judged = 0;
    mock.script = (body) => {
      const sys = sysOf(body);
      if (sys.includes('指令一致性校验器')) { judged++; return { text: judged === 1 ? '{"violation":true,"rule":"思考时不要质疑用户的需求","reason":"思考里在质疑用户"}' : '{"violation":false}' }; }
      if (sys.includes('【指令纠偏')) return { reasoning: ['用户有这个需求，我来帮他实现：先拆分模块，再逐个说明实现方式，最后给出需要注意的地方和验收标准。'], text: '重试后的回答' };
      return { reasoning: ['这个需求听起来不太合理，用户是不是搞错了。他想要的东西现在根本做不到，而且这样提需求也不太对劲，我得先确认一下他是不是真的想这样。'], text: '第一次的回答' };
    };
    await send('我想要一个能自动写完所有代码的功能');
    const kinds = mock.reqs.map((b) => sysOf(b).includes('指令一致性校验器') ? 'judge' : (sysOf(b).includes('【指令纠偏') ? 'retry' : 'main'));
    assert.deepStrictEqual(kinds, ['main', 'judge', 'retry', 'judge'], JSON.stringify(kinds));
    const t = await ev(() => ZC.Sessions.msgs().slice(-1)[0].content); assert.ok(t.includes('重试后的回答'), t);
    /* 核对请求里不含被排除的条目 */
    const jreq = mock.reqs.find((b) => sysOf(b).includes('指令一致性校验器'));
    assert.ok(JSON.stringify(jreq).includes('不要质疑用户的需求'));
  });
  await check('[浏览器] 项目设置：「试一试规则」——粘贴一段思考，显示会不会被拦下、原句、被放过的句子；核对方式有「智能 / 仅本地 / 严格」，重试次数有 2~10', async () => {
    await ev(() => ZC.Projects.openEditor('pg1'));
    const opts = await ev(() => ({ mode: [...document.querySelectorAll('#pjGuardMode option')].map((o) => o.value), max: [...document.querySelectorAll('#pjGuardMax option')].map((o) => o.value), cur: document.getElementById('pjGuardMode').value }));
    assert.deepStrictEqual(opts.mode, ['auto', 'local', 'strict']); assert.deepStrictEqual(opts.max, ['2', '3', '5', '8', '10']);
    await page.fill('#pjInstr', '思考时不要提及价格。'); await page.fill('#pjGuardTest', '他要求报价，价格方面可以分三档。'); await page.click('#pjGuardTestGo');
    let o = await ev(() => ({ t: document.getElementById('pjGuardTestOut').textContent, h: document.getElementById('pjGuardTestOut').hidden }));
    assert.ok(!o.h && o.t.includes('❌') && o.t.includes('价格方面可以分三档'), o.t);
    await page.fill('#pjGuardTest', '按指令我不谈价格，直接讲功能。'); await page.click('#pjGuardTestGo');
    o = await ev(() => document.getElementById('pjGuardTestOut').textContent); assert.ok(o.includes('✅') && o.includes('遵守规则'), o);
    await page.click('#pjCancel'); await page.waitForTimeout(100);
  });
  await check('[浏览器] 项目设置：守卫开关 / 核对方式 / 重试次数 / 思考禁区能保存；识别结果实时显示；范围外条目提示「已忽略」', async () => {
    await ev(() => ZC.Projects.openEditor('pg1'));
    await page.fill('#pjInstr', '思考时不要提及价格。不要思考关于未成年和成年的话题。');
    const info = await ev(() => document.getElementById('pjGuardInfo').textContent);
    assert.ok(info.includes('「价格」') && /已忽略 1 条/.test(info), info);
    await page.selectOption('#pjGuardMode', 'local'); await page.selectOption('#pjGuardMax', '8'); await page.fill('#pjGuardTerms', '内部代号');
    assert.ok((await ev(() => document.getElementById('pjGuardInfo').textContent)).includes('「内部代号」'));
    await page.click('#pjSave'); await page.waitForTimeout(200);
    const p = await ev(() => { const x = ZC.Projects.get('pg1'); return { guard: x.guard, max: x.guardMax, terms: x.guardTerms }; });
    assert.deepStrictEqual(p, { guard: 'local', max: 8, terms: '内部代号' });
    await ev(() => ZC.Projects.openEditor('pg1')); await page.uncheck('#pjGuard', { force: true });
    assert.ok(await ev(() => document.getElementById('pjGuardMore').hidden), '关闭后详细设置应收起');
    await page.click('#pjSave'); await page.waitForTimeout(150);
    assert.strictEqual(await ev(() => ZC.Projects.get('pg1').guard), 'off');
  });
  await check('[浏览器·桌面] 无脚本错误', () => { assert.deepStrictEqual(D.errs, []); });
  await D.ctx.close();

  /* ---------- 分支 / 归档整理：用「旧版留下的一团乱」数据启动，看自动整理 + 侧栏折叠 + 之后新建的行为 ---------- */
  const mkMsgs = (n, tag) => Array.from({ length: n }, (_, i) => ({ id: tag + 'm' + i, role: i % 2 ? 'assistant' : 'user', content: (i % 2 ? '回答' : '问题') + (i + 1) + '：' + tag, ts: now - 100000 + i }));
  const T0 = now - 900000;
  const legacy = [];
  const r1m = mkMsgs(6, 'r1');
  legacy.push({ id: 'r1', title: '项目周报', createdAt: T0, updatedAt: now - 1000, messages: r1m, model: 'm', mode: 'chat' });
  /* 旧版的备份：标题带「（编辑前）」「↳」前缀、被标成归档、打了「分支」标签；b1/b2 完全一样；b4 被用户接着聊过（更新时间远晚于创建时间） */
  const lb = (id, title, n, extra) => Object.assign({ id, title, titleLocked: true, createdAt: T0 + 1000 * (legacy.length), updatedAt: T0 + 1000 * (legacy.length), messages: JSON.parse(JSON.stringify(r1m.slice(0, n))), model: 'm', mode: 'chat', parentId: 'r1', forkAt: r1m[n - 1].id, tags: ['分支'], archived: true }, extra || {});
  legacy.push(lb('b1', '（编辑前）项目周报', 6)); legacy.push(lb('b2', '（编辑前）项目周报', 6)); legacy.push(lb('b3', '↳ （编辑前）项目周报', 4));
  legacy.push(lb('b4', '（编辑前）项目周报', 5, { updatedAt: T0 + 600000 }));
  legacy.push(lb('br1', '↳ ↳ 项目周报', 2, { archived: false }));
  legacy.push({ id: 'ar1', title: '旧笔记', createdAt: T0 - 5000, updatedAt: T0 - 4000, messages: mkMsgs(2, 'ar1'), model: 'm', mode: 'chat', archived: true });
  const r2m = mkMsgs(8, 'r2');
  legacy.push({ id: 'r2', title: '重构登录模块', createdAt: T0 + 50000, updatedAt: now - 2000, messages: r2m, model: 'm', mode: 'code' });
  for (let n = 2; n <= 7; n++) legacy.push({ id: 'c' + n, title: '（编辑前）重构登录模块', titleLocked: true, createdAt: T0 + 60000 + n * 1000, updatedAt: T0 + 60000 + n * 1000, messages: JSON.parse(JSON.stringify(r2m.slice(0, n))), model: 'm', mode: 'code', parentId: 'r2', forkAt: r2m[n - 1].id, tags: ['分支'], archived: true });
  const T = await makePage({ viewport: { width: 1280, height: 860 } }, { sessions: legacy, cur: 'r1' });
  const tev = T.ev; T.page.setDefaultTimeout(8000);
  const SHOTS = process.env.ZC_SHOTS || '';
  await check('[浏览器·整理] 旧数据启动时一次性自动整理：重复备份合并、超出的旧备份清理、被继续聊过的备份升格为分支且不丢、标题 / 标签 / 归档状态归位；手动归档的不动', async () => {
    const r = await tev(() => ZC.Sessions.list.map((s) => ({ id: s.id, kind: s.kind || '', title: s.title, tags: s.tags || null, arch: !!s.archived, n: s.messages.length })));
    const by = {}; r.forEach((x) => { by[x.id] = x; });
    const ids = r.map((x) => x.id).sort();
    /* r1：b1/b2 重复 → 只剩一份；b3 保留；b4 升格分支；br1 保留。r2：6 份备份 → 只留最新 4 份（c4..c7） */
    assert.strictEqual(ids.length, 11, '实际：' + ids.join(','));
    assert.ok(by.b3 && by.b4 && by.br1 && by.ar1 && !by.c2 && !by.c3, '该留的留、该清的清：' + ids.join(','));
    assert.strictEqual((by.b1 ? 1 : 0) + (by.b2 ? 1 : 0), 1, '重复备份只留一份');
    const dupKept = by.b1 || by.b2;
    assert.strictEqual(dupKept.kind, 'backup'); assert.strictEqual(dupKept.title, '项目周报'); assert.strictEqual(dupKept.arch, false); assert.strictEqual(dupKept.tags, null);
    assert.strictEqual(by.b3.title, '项目周报'); assert.strictEqual(by.b3.kind, 'backup');
    assert.strictEqual(by.b4.kind, 'branch'); assert.strictEqual(by.b4.arch, false); assert.strictEqual(by.b4.n, 5);
    assert.strictEqual(by.br1.kind, 'branch'); assert.strictEqual(by.br1.title, '项目周报'); assert.strictEqual(by.br1.tags, null);
    assert.strictEqual(by.ar1.arch, true, '手动归档的对话不能被动');
    return ids.join(',');
  });
  await check('[浏览器·整理] 侧栏：主对话只有 2 条（r1 / r2），分支 / 备份折叠在来源下；顶部「聊天 / 代码」数字不再虚高；「归档」只剩手动归档的 1 条；标签栏没有「#分支」', async () => {
    await T.page.waitForSelector('#sessionList .sess', { state: 'attached' });
    const r = await tev(() => {
      const box = document.getElementById('sessionList');
      const top = Array.from(box.children).filter((n) => n.classList.contains('sess') && n.style.display !== 'none').map((n) => n.getAttribute('data-id'));
      const kidsOf = {}; box.querySelectorAll('.sess-kids').forEach((w) => { kidsOf[w.getAttribute('data-for')] = Array.from(w.querySelectorAll('.sess')).map((n) => n.getAttribute('data-id')); });
      const seg = Array.from(box.querySelectorAll('.s-modeseg button')).map((b) => b.getAttribute('data-f') + ':' + b.lastChild.textContent);
      const chips = Array.from(box.querySelectorAll('.zx-chip')).map((c) => c.textContent);
      const fork = (id) => { const b = box.querySelector('.sess[data-id="' + id + '"] .s-fork'); return b ? b.textContent : null; };
      return { top, kidsOf, seg, chips, f1: fork('r1'), f2: fork('r2') };
    });
    assert.deepStrictEqual(r.top.sort(), ['r1', 'r2'], JSON.stringify(r));
    assert.strictEqual(r.f1, '4', 'r1 右侧「⑂ 4」（备份 2 + 分支 2）：' + JSON.stringify(r)); assert.strictEqual(r.f2, '4', JSON.stringify(r));
    assert.deepStrictEqual(r.seg, [':2', 'chat:1', 'code:1'], JSON.stringify(r.seg));
    assert.ok(r.chips.some((c) => /^归档 1$/.test(c)) && !r.chips.some((c) => c.indexOf('分支') >= 0), JSON.stringify(r.chips));
  });
  await check('[浏览器·整理] 当前对话 r1 本身不是分支 → 默认收起；点「⑂」展开 / 再点收起，状态记住；行内标「分支 N · 从「…」」「编辑前 · 时间」', async () => {
    assert.ok(await tev(() => document.querySelector('.sess-kids[data-for="r1"]').hidden), '默认应收起');
    await T.page.click('.sess[data-id="r1"] .s-fork'); await T.page.waitForTimeout(250);
    const r = await tev(() => { const w = document.querySelector('.sess-kids[data-for="r1"]'); return { hidden: w.hidden, rows: Array.from(w.querySelectorAll('.sess')).map((n) => ({ id: n.getAttribute('data-id'), t: n.querySelector('.t').textContent, kind: n.querySelector('.s-kind').textContent, vis: n.offsetHeight > 0 })) }; });
    assert.strictEqual(r.hidden, false); assert.ok(r.rows.length === 4 && r.rows.every((x) => x.vis), JSON.stringify(r));
    const br = r.rows.filter((x) => x.kind === '分支').map((x) => x.t).sort(), bk = r.rows.filter((x) => x.kind === '备份').map((x) => x.t);
    assert.ok(br.length === 2 && br.every((t) => /^分支 \d( · 从「.+」)?$/.test(t)), JSON.stringify(br)); assert.ok(bk.length === 2 && bk.every((t) => /^编辑前 · /.test(t)), JSON.stringify(bk));
    assert.ok(await tev(() => JSON.parse(localStorage.getItem('zc_gura_tidy_open') || '{}').r1 === true), '展开状态应记住');
    if (SHOTS) await T.page.screenshot({ path: path.join(SHOTS, 'v34_tidy_desktop.png') });
    await T.page.click('.sess[data-id="r1"] .s-fork'); await T.page.waitForTimeout(250);
    assert.ok(await tev(() => document.querySelector('.sess-kids[data-for="r1"]').hidden), '再点应收起');
  });
  await check('[浏览器·整理] 点开某条备份 / 分支：自动展开它所在的组（不会「看不见当前对话」）；在备份里继续聊 → 升格为分支', async () => {
    await T.page.click('.sess[data-id="r1"] .s-fork'); await T.page.waitForTimeout(150);
    const bid = await tev(() => document.querySelector('.sess-kids[data-for="r1"] .sess.k-backup').getAttribute('data-id'));
    await T.page.click('.sess[data-id="' + bid + '"]', { position: { x: 24, y: 12 } }); await T.page.waitForTimeout(400);
    assert.strictEqual(await tev(() => ZC.Sessions.curId), bid);
    assert.ok(await tev(() => !document.querySelector('.sess-kids[data-for="r1"]').hidden && document.querySelector('.sess.active') && document.querySelector('.sess.active').offsetHeight > 0), '当前对话要看得见');
    await tev((bid) => { const s = ZC.Sessions.list.filter((x) => x.id === bid)[0]; s.messages.push({ id: 'new1', role: 'user', content: '在备份里接着聊', ts: Date.now() }); s.messages.push({ id: 'new2', role: 'assistant', content: '好的', ts: Date.now() }); ZC.View.renderSessions(); }, bid);
    assert.strictEqual(await tev((bid) => ZC.Sessions.list.filter((x) => x.id === bid)[0].kind, bid), 'branch', '继续聊过的备份应升格为分支');
    const k = await tev((bid) => document.querySelector('.sess[data-id="' + bid + '"] .s-kind').textContent, bid); assert.strictEqual(k, '分支');
    /* 回到 r1 */
    await T.page.click('.sess[data-id="r1"]', { position: { x: 24, y: 12 } }); await T.page.waitForTimeout(300);
  });
  await check('[浏览器·整理] 之后新建：①「从这里创建分支」→ 分支（不归档、没有「#分支」标签、标题不叠「↳」）②「编辑前」备份 → 同一状态不重复存 ③ 备份最多留 4 份，被你手动改过名 / 置顶 / 打标签的不清', async () => {
    const r = await tev(() => {
      const S = ZC.Sessions, cur = S.cur(), ms = cur.messages;
      const br = ZC.ZX.forkSession(ms[3], {});
      const n0 = S.list.length;
      const bk1 = ZC.ZX.forkSession(ms[ms.length - 1], { prefix: '（编辑前）', archived: true });
      const n1 = S.list.length;
      const bk2 = ZC.ZX.forkSession(ms[ms.length - 1], { prefix: '（编辑前）', archived: true });   // 同一状态
      const n2 = S.list.length;
      /* 状态各不相同的备份：每次截短一条 */
      const keepNamed = ZC.ZX.forkSession(ms[0], { prefix: '（编辑前）', archived: true }); keepNamed.userTitle = true; keepNamed.title = '我命名的备份';
      for (let i = 1; i < ms.length; i++) ZC.ZX.forkSession(ms[i], { prefix: '（编辑前）', archived: true });
      const mine = S.list.filter((x) => x.parentId === cur.id && x.kind === 'backup' && !(x.userTitle));
      return { br: { kind: br.kind, arch: !!br.archived, tags: br.tags || null, title: br.title }, bk: { kind: bk1.kind, arch: !!bk1.archived, title: bk1.title }, n0, n1, n2, same: bk1 === bk2, keptNamed: S.list.some((x) => x.id === keepNamed.id), mine: mine.length };
    });
    assert.deepStrictEqual(r.br, { kind: 'branch', arch: false, tags: null, title: '项目周报' }, JSON.stringify(r.br));
    assert.deepStrictEqual(r.bk, { kind: 'backup', arch: false, title: '项目周报' }, JSON.stringify(r.bk));
    assert.ok(r.n1 >= r.n0 && r.n2 === r.n1 && r.same, '同一状态的备份不该重复：' + JSON.stringify(r));
    assert.ok(r.keptNamed, '手动命名的备份不能被清理'); assert.ok(r.mine <= 4, '没动过的备份最多 4 份：' + r.mine);
  });
  await check('[浏览器·整理] 搜索 / 点「归档」筛选时不折叠：命中的分支 / 备份直接平铺显示', async () => {
    await tev(() => { ZC.View.sessQuery = '回答2'; ZC.View.renderSessions(); });
    const r = await tev(() => ({ kids: document.querySelectorAll('#sessionList .sess-kids').length, rows: document.querySelectorAll('#sessionList .sess').length }));
    assert.ok(r.kids === 0 && r.rows >= 3, JSON.stringify(r));
    await tev(() => { ZC.View.sessQuery = ''; ZC.View.renderSessions(); });
    assert.ok(await tev(() => document.querySelectorAll('#sessionList .sess-kids').length > 0), '清空搜索后恢复折叠');
  });
  await check('[浏览器·整理] 重命名分支后保留你起的名字；分支树里同名的一排变成「分支 N · 从…」「编辑前 · 时间」；项目里的对话数不算备份', async () => {
    const id = await tev(() => ZC.Sessions.list.filter((x) => x.kind === 'branch' && x.parentId === 'r1')[0].id);
    await tev((id) => { ZC.Chat.sessionAction('rename', id); }, id);
    await T.page.waitForSelector('#dlgInput', { state: 'visible' }); await T.page.fill('#dlgInput', '方案 B 讨论'); await T.page.click('#dlgOk'); await T.page.waitForTimeout(300);
    const r = await tev((id) => { const s = ZC.Sessions.list.filter((x) => x.id === id)[0]; const d = ZC.ZX.branchTreeData(); const kids = (d.kids.r1 || []).map((x) => x.title); return { s: s.title, ut: !!s.userTitle, kids }; }, id);
    assert.strictEqual(r.s, '方案 B 讨论'); assert.ok(r.ut); assert.ok(r.kids.includes('方案 B 讨论') && r.kids.some((t) => /^分支 \d/.test(t)) && r.kids.some((t) => /^编辑前 · /.test(t)), JSON.stringify(r.kids));
    const c = await tev(() => { const P = ZC.Projects; P.list.push({ id: 'pt1', name: 'T', instructions: '', createdAt: Date.now(), updatedAt: Date.now() }); ZC.Sessions.list.forEach((s) => { if (s.id === 'r1' || s.parentId === 'r1') s.projectId = 'pt1'; }); return { n: P.count('pt1'), who: ZC.Sessions.list.filter((s) => s.projectId === 'pt1').map((s) => s.id + ':' + (s.kind || '-') + ':' + (s.pinned ? 'pin' : '') + ':' + (s.archived ? 'arch' : '') + ':' + s.parentId) }; });
    assert.strictEqual(c.n, 1, '项目里只算主对话：' + JSON.stringify(c));
    await tev(() => { ZC.Sessions.list.forEach((s) => { delete s.projectId; }); ZC.Projects.list = ZC.Projects.list.filter((p) => p.id !== 'pt1'); });
  });
  await check('[浏览器·整理] 手动整理：「⋯」菜单出现「整理分支与归档…」→ 弹出说明 → 开始整理 → 提示结果；新混进来的旧格式备份被收编；可选一键删光备份', async () => {
    await tev(() => {   // 模拟别的设备同步过来一批没升级的数据
      const S = ZC.Sessions, r2 = S.list.filter((x) => x.id === 'r2')[0];
      for (let n = 2; n <= 3; n++) S.list.push({ id: 'z' + n, title: '↳ （编辑前）重构登录模块', createdAt: Date.now() - 500000 + n, updatedAt: Date.now() - 500000 + n, messages: JSON.parse(JSON.stringify(r2.messages.slice(0, n))), model: 'm', mode: 'code', parentId: 'r2', forkAt: r2.messages[n - 1].id, tags: ['分支'], archived: true });
      S.save();
    });
    await T.page.click('#btnMore'); await T.page.waitForTimeout(300);
    const label = await tev(() => { const it = Array.from(document.querySelectorAll('.pop .it')).filter((x) => x.textContent.indexOf('整理分支与归档') >= 0)[0]; return it ? it.textContent : null; });
    assert.ok(label && /整理分支与归档…（\d+）/.test(label), String(label));
    await T.page.click('.pop .it:has-text("整理分支与归档")'); await T.page.waitForSelector('#dialogOv', { state: 'visible' });
    const msg = await tev(() => document.getElementById('dlgMsg').textContent); assert.ok(/个分支、\d+ 份「编辑前」备份/.test(msg) && msg.includes('不会删除任何分支'), msg);
    await T.page.click('#dlgOk'); await T.page.waitForTimeout(400);
    const toast = await tev(() => Array.from(document.querySelectorAll('.toast')).map((x) => x.textContent).join('|')); assert.ok(/已整理：/.test(toast), toast);
    const st = await tev(() => ZC.SessTidy.stats()); assert.ok(st.tagged === 0 && st.dirtyTitles === 0 && st.archivedBackups === 0, JSON.stringify(st));
    /* 第二个对话框：清空备份 → 先取消，什么都不删；再来一次选「全部删除」 */
    await T.page.waitForSelector('#dialogOv', { state: 'visible' }); const t2 = await tev(() => document.getElementById('dlgTitle').textContent); assert.ok(t2.includes('清空'), t2);
    const nb0 = await tev(() => ZC.Sessions.list.filter((x) => x.kind === 'backup').length);
    await T.page.click('#dlgCancel'); await T.page.waitForTimeout(250);
    assert.strictEqual(await tev(() => ZC.Sessions.list.filter((x) => x.kind === 'backup').length), nb0);
    await tev(() => { ZC.SessTidy.openPanel(); }); await T.page.waitForSelector('#dialogOv', { state: 'visible' }); await T.page.click('#dlgOk'); await T.page.waitForTimeout(300);
    await T.page.waitForSelector('#dialogOv', { state: 'visible' }); await T.page.click('#dlgOk'); await T.page.waitForTimeout(400);
    const left = await tev(() => ({ bk: ZC.Sessions.list.filter((x) => x.kind === 'backup' && x.id !== ZC.Sessions.curId).length, br: ZC.Sessions.list.filter((x) => x.kind === 'branch').length, ar: ZC.Sessions.list.some((x) => x.id === 'ar1') }));
    assert.ok(left.bk === 0 && left.br >= 3 && left.ar, JSON.stringify(left));
  });
  await check('[浏览器·整理] 没有分支 / 备份时：菜单里不出现整理入口', async () => {
    await tev(() => { ZC.Sessions.list = ZC.Sessions.list.filter((x) => !x.kind); ZC.Sessions.save(); });
    await T.page.click('#btnMore'); await T.page.waitForTimeout(300);
    assert.ok(await tev(() => !Array.from(document.querySelectorAll('.pop .it')).some((x) => x.textContent.indexOf('整理分支') >= 0)));
    await T.page.keyboard.press('Escape'); await T.page.waitForTimeout(200);
  });
  await check('[浏览器·整理] 无脚本错误', () => { assert.deepStrictEqual(T.errs, []); });
  await T.ctx.close();

  /* ---------- 沙箱防「半路重置」：前端保活 / 写入日志 / 重建后自动写回 / 告知模型 / 屏幕常亮 ---------- */
  const SB = await makePage({ viewport: { width: 1280, height: 860 } });
  const sev = SB.ev; SB.page.setDefaultTimeout(8000);
  const sbx = { id: 'sbxA', calls: [], pingExtra: {} };
  mock.sbx = (sub, body) => {
    sbx.calls.push({ sub, body });
    const base = { sandboxId: sbx.id };
    if (sub === 'write') return Object.assign({ ok: true, path: body.path, size: String(body.content || '').length }, base);
    if (sub === 'writemany') return Object.assign({ ok: true, results: (body.files || []).map((f) => ({ path: f.path, ok: true })) }, base);
    if (sub === 'read') return Object.assign({ content: 'content-of-' + body.path + '@' + sbx.id, size: 10 }, base);
    if (sub === 'exec') return Object.assign({ ok: true, stdout: 'ran', stderr: '', exitCode: 0 }, base);
    if (sub === 'ping') return Object.assign({ ok: true, warm: true }, base, sbx.pingExtra);
    return Object.assign({ ok: true, entries: [] }, base);
  };
  await sev(() => { ZC.Agent.backend = 'cloud'; ZC.CloudFS.available = true; ZC.CloudFS.root = true; ZC.CloudFS.ws = 'main'; });
  await check('[浏览器·沙箱] 云端模式下 Agent 写入 / 批量写入 / 删除都进「写入日志」（同一路径只留最新内容，删除的清掉）', async () => {
    await sev(async () => { const C = ZC.CloudFS; await C.createFile('src/a.js', 'A1'); await C.writeFile('src/a.js', 'A2'); await C.writeMany([{ path: 'b/c.txt', content: 'C' }, { path: 'b/d.txt', content: 'D' }]); await C.deleteFile('b/c.txt'); await C.writeFile('/workspace/e.txt', 'E'); });
    const j = await sev(() => Array.from(ZC.SbxGuard.journal.entries()).map((e) => e[0] + '=' + e[1].content).sort());
    assert.deepStrictEqual(j, ['b/d.txt=D', 'e.txt=E', 'src/a.js=A2'], JSON.stringify(j));
  });
  await check('[浏览器·沙箱] 沙箱被换掉（ID 变了）→ 自动把日志里的文件写回新沙箱，并且「触发重建的那条命令」返回前就已恢复完成', async () => {
    sbx.calls.length = 0; sbx.id = 'sbxB';
    const r = await sev(async () => { const j = await ZC.CloudFS.exec('ls', '', 5000); return { stdout: j.stdout, gate: !!ZC.SbxGuard.gate, notices: ZC.SbxGuard.notices.length, restores: ZC.SbxGuard.restores }; });
    assert.strictEqual(r.gate, false); assert.strictEqual(r.restores, 1); assert.strictEqual(r.notices, 1);
    const subs = sbx.calls.map((c) => c.sub); assert.deepStrictEqual(subs, ['exec', 'writemany'], JSON.stringify(subs));
    const wm = sbx.calls[1].body.files.map((f) => f.path + '=' + f.content).sort(); assert.deepStrictEqual(wm, ['b/d.txt=D', 'e.txt=E', 'src/a.js=A2']);
  });
  await check('[浏览器·沙箱] 告知模型：下一次请求前，提示附在最近一条工具结果后面（含恢复了几个文件、哪些没法恢复、上一条命令结果不可信），只发一次', async () => {
    const r = await sev(() => { const h = [{ role: 'user', text: '任务', content: '任务' }, { role: 'tool', text: '输出：ran' }]; const n = ZC.AgentPlus.drainSteer(h); const again = ZC.AgentPlus.drainSteer(h); return { n, t: h[1].text, again, left: ZC.SbxGuard.notices.length }; });
    assert.strictEqual(r.n, 1); assert.strictEqual(r.again, 0); assert.strictEqual(r.left, 0);
    ['输出：ran', '【系统提示·云端沙箱已被重建】', '自动恢复 3 个文件', 'node_modules', '上一条命令是在这个新环境里执行的', '先用 ls 确认'].forEach((k) => assert.ok(r.t.includes(k), '缺：' + k + ' ← ' + r.t));
    assert.ok(!r.t.includes('请核对'), '没有 shell 删除 / 移动过文件时不该吓模型');
  });
  await check('[浏览器·沙箱] 读文件撞上重建：等恢复完成后重读一次（先恢复、后重读），读到的是恢复后的内容', async () => {
    sbx.calls.length = 0; sbx.id = 'sbxC';
    const r = await sev(async () => { const j = await ZC.CloudFS.readFile('src/a.js'); return j.content; });
    const subs = sbx.calls.map((c) => c.sub); assert.deepStrictEqual(subs, ['read', 'writemany', 'read'], JSON.stringify(subs));
    assert.ok(r.endsWith('@sbxC'));
    await sev(() => { ZC.SbxGuard.notices.length = 0; });
  });
  await check('[浏览器·沙箱] 用 shell 删 / 移 / 改过文件后重建：提示里加「恢复的是编辑工具最后一次写入的版本，请核对」', async () => {
    await sev(async () => { await ZC.CloudFS.exec('rm -rf build && mv a b', '', 5000); });
    sbx.id = 'sbxD'; await sev(async () => { await ZC.CloudFS.exec('ls', '', 5000); });
    const t = await sev(() => ZC.SbxGuard.notices.join('')); assert.ok(t.includes('请核对'), t);
    await sev(() => { ZC.SbxGuard.notices.length = 0; ZC.SbxGuard.jStale = false; });
  });
  await check('[浏览器·沙箱] 混合模式：不记日志、不乱写；重建后提示「本地文件会自动重新同步」', async () => {
    await sev(() => { ZC.Agent.backend = 'mix'; ZC.SbxGuard.jClear(); });
    await sev(async () => { await ZC.CloudFS.writeFile('x.txt', 'X'); });
    assert.strictEqual(await sev(() => ZC.SbxGuard.journal.size), 0);
    sbx.calls.length = 0; sbx.id = 'sbxE'; await sev(async () => { await ZC.CloudFS.exec('ls', '', 5000); });
    assert.ok(!sbx.calls.some((c) => c.sub === 'writemany'), '混合模式不走日志恢复');
    const t = await sev(() => ZC.SbxGuard.notices.join('')); assert.ok(t.includes('混合模式') && t.includes('重新同步到云端'), t);
    await sev(() => { ZC.SbxGuard.notices.length = 0; ZC.Agent.backend = 'cloud'; });
  });
  await check('[浏览器·沙箱] 日志有上限：单文件 > 400KB 不记；总量 > 6MB 丢最旧的；断开云端时清空', async () => {
    const r = await sev(() => { const G = ZC.SbxGuard; G.jClear(); G.jPut('big.bin', 'x'.repeat(500 * 1024)); const skipped = G.jSkipped; for (let i = 0; i < 20; i++) G.jPut('f' + i + '.txt', 'y'.repeat(380 * 1024)); const keys = Array.from(G.journal.keys()); const out = { skipped, n: keys.length, hasBig: G.journal.has('big.bin'), hasOld: G.journal.has('f0.txt'), hasNew: G.journal.has('f19.txt'), total: G.jBytes, evicted: G.jEvicted }; ZC.CloudFS.disconnect(); out.afterDisc = G.journal.size; ZC.CloudFS.root = true; return out; });
    assert.ok(r.skipped === 1 && !r.hasBig && !r.hasOld && r.hasNew && r.total <= 6 * 1024 * 1024 && r.evicted > 0 && r.afterDisc === 0, JSON.stringify(r));
  });
  await check('[浏览器·沙箱] 保活：任务运行时页面在后台也心跳；空闲 + 后台不心跳；空闲 + 前台每 2 分钟一次；回到前台立刻心跳', async () => {
    const pings = () => sbx.calls.filter((c) => c.sub === 'ping').length;
    await sev(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); ZC.AgentPlus.running = false; });
    let n0 = pings(); await sev(() => ZC.SbxGuard.keepTick(2)); await SB.page.waitForTimeout(250); assert.strictEqual(pings(), n0, '空闲 + 后台不该心跳');
    await sev(() => { ZC.AgentPlus.running = true; ZC.Chat.busy = true; }); n0 = pings(); await sev(() => ZC.SbxGuard.keepTick(1)); await SB.page.waitForTimeout(250); assert.strictEqual(pings(), n0 + 1, '任务运行时后台也要心跳');
    await sev(() => { ZC.AgentPlus.running = false; ZC.Chat.busy = false; Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); });
    n0 = pings(); await sev(() => ZC.SbxGuard.keepTick(1)); await SB.page.waitForTimeout(200); assert.strictEqual(pings(), n0, '空闲 + 前台：奇数拍跳过');
    await sev(() => ZC.SbxGuard.keepTick(2)); await SB.page.waitForTimeout(250); assert.strictEqual(pings(), n0 + 1);
    n0 = pings(); await sev(() => document.dispatchEvent(new Event('visibilitychange'))); await SB.page.waitForTimeout(300); assert.strictEqual(pings(), n0 + 1, '回到前台立刻心跳');
  });
  await check('[浏览器·沙箱] 屏幕常亮：任务开始申请、结束释放；云端 / 混合以外的模式、或关掉开关时不申请', async () => {
    await sev(() => { window.__wl = []; Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async (t) => { window.__wl.push('req:' + t); return { release() { window.__wl.push('released'); }, addEventListener() { } }; } } }); });
    await sev(() => { ZC.AgentPlus.beginRun('长任务'); }); await SB.page.waitForTimeout(300);
    assert.deepStrictEqual(await sev(() => window.__wl), ['req:screen']);
    await sev(() => { ZC.AgentPlus.endRun(); }); await SB.page.waitForTimeout(100);
    assert.deepStrictEqual(await sev(() => window.__wl), ['req:screen', 'released']);
    await sev(() => { window.__wl = []; localStorage.setItem('zc_gura_sbx_wakelock', 'false'); ZC.AgentPlus.beginRun('x'); }); await SB.page.waitForTimeout(250); assert.deepStrictEqual(await sev(() => window.__wl), [], '关掉开关就不申请');
    await sev(() => { ZC.AgentPlus.endRun(); localStorage.removeItem('zc_gura_sbx_wakelock'); ZC.Agent.backend = 'local'; ZC.AgentPlus.beginRun('x'); }); await SB.page.waitForTimeout(250); assert.deepStrictEqual(await sev(() => window.__wl), [], '本地目录模式不申请');
    await sev(() => { ZC.AgentPlus.endRun(); ZC.Agent.backend = 'cloud'; });
  });
  await check('[浏览器·沙箱] 如实提示：从暂停中唤醒（文件都在）/ 账号不支持暂停（仍会被回收）', async () => {
    sbx.pingExtra = { resumed: true, sbxMode: 'kill' };
    await sev(async () => { ZC.SbxGuard.resumeToastAt = 0; ZC.SbxGuard.killWarned = false; await ZC.CloudFS.ping(true); });
    const t = await sev(() => Array.from(document.querySelectorAll('.toast')).map((x) => x.textContent).join('|'));
    assert.ok(t.includes('已自动唤醒') && t.includes('没有启用「到期暂停」'), t); sbx.pingExtra = {};
  });
  await check('[浏览器·沙箱] 无脚本错误', () => { assert.deepStrictEqual(SB.errs, []); });
  await SB.ctx.close();
  await browser.close();
} else results.push(['PASS', '（没有 Playwright / Chromium：浏览器部分跳过）', '']);

results.forEach((r) => console.log(r[0] + ' | ' + r[1] + (r[2] ? ' | ' + r[2] : '')));
const fail = results.filter((r) => r[0] === 'FAIL').length;
console.log('===== ' + (results.length - fail) + '/' + results.length + ' 通过 =====');
process.exit(fail ? 1 : 0);
