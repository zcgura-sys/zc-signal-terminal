/* v2.30.4：Worker 侧 —— ① /__zc_web__/ghtar（GitHub 源码包流式透传） ② 沙箱「状态不明」时绝不新建空沙箱（防文件丢失） */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '_worker.js'), 'utf8');
const results = [];
function t(name, ok, extra) { results.push(!!ok); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? '  → ' + extra : '')); }
function slice(from, to) { const a = src.indexOf(from); const b = src.indexOf(to, a); if (a < 0 || b < 0) throw new Error('slice fail ' + from); return src.slice(a, b); }
const zcJson = (o, st, h) => new Response(JSON.stringify(o), { status: st || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}) });
const zcCorsHeaders = () => ({ 'Access-Control-Allow-Origin': '*' });

(async () => {
  /* ---------- ① ghtar ---------- */
  const ghSrc = slice('const ZC_GH_TAR_MAX', 'async function zcHandleWeb').replace('80 * 1024 * 1024', '64 * 1024');
  const mk = new Function('zcJson', 'zcCorsHeaders', 'fetch', ghSrc + '\nreturn zcWebGhTar;');
  let calls = [], upstream = null;
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return upstream(url, init); };
  const route = mk(zcJson, zcCorsHeaders, fakeFetch);
  const req = (body, method) => new Request('https://site/__zc_web__/ghtar', { method: method || 'POST', body: method === 'GET' ? undefined : JSON.stringify(body) });
  const payload = new Uint8Array(40000).map((_, i) => i % 251);

  upstream = async () => new Response(payload, { status: 200, headers: { 'content-type': 'application/x-gzip' } });
  let r = await route(req({ repo: 'https://github.com/HKUDS/nanobot.git' }), { GITHUB_TOKEN: 'ghp_secret' });
  const got = new Uint8Array(await r.arrayBuffer());
  t('流式透传源码包，字节一致；URL 指向 codeload tar.gz/HEAD', r.status === 200 && Buffer.from(got).equals(Buffer.from(payload)) && calls[0].url === 'https://codeload.github.com/HKUDS/nanobot/tar.gz/HEAD', calls[0].url);
  t('不会把部署者的 GITHUB_TOKEN 带给 GitHub（避免经由本站读私有仓库）', !JSON.stringify(calls[0].init.headers).match(/ghp_secret|authorization/i));

  r = await route(req({ repo: 'a/b', ref: 'feature/x-1' }), {});
  t('分支名含斜杠：路径分段编码', calls[calls.length - 1].url === 'https://codeload.github.com/a/b/tar.gz/feature/x-1');

  upstream = async () => new Response('nf', { status: 404 });
  r = await route(req({ repo: 'a/b', ref: 'nope' }), {});
  const j404 = await r.json();
  t('仓库 / 分支不存在 → 404，说明是公开仓库限制', r.status === 404 && /公开仓库/.test(j404.error), j404.error.slice(0, 40));

  upstream = async () => new Response('x', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } });
  r = await route(req({ repo: 'a/b' }), {});
  t('源码包过大（content-length 超上限）→ 413', r.status === 413);

  upstream = async () => new Response(new Uint8Array(200 * 1024), { status: 200 });   // 无 content-length 的流，实际超过上限
  r = await route(req({ repo: 'a/b' }), {});
  let streamErr = false; try { await r.arrayBuffer(); } catch (e) { streamErr = true; }
  t('没有 content-length 的超大流：传输途中被截断报错（不会无限转发）', streamErr);

  r = await route(req({ repo: '../etc/passwd' }), {}); const bad1 = r.status;
  r = await route(req({ repo: 'a/b', ref: 'main/../../x' }), {}); const bad2 = r.status;
  r = await route(req({}, 'GET'), {}); const bad3 = r.status;
  t('非法 repo / ref、非 POST 请求被拒（400 / 400 / 405）', bad1 === 400 && bad2 === 400 && bad3 === 405, [bad1, bad2, bad3].join('/'));

  upstream = async () => { throw new Error('boom'); };
  r = await route(req({ repo: 'a/b' }), {});
  t('连接 GitHub 失败 → 502 带原因', r.status === 502 && /boom/.test((await r.json()).error));

  /* ---------- ② 沙箱状态不明时不重建 ---------- */
  const infoSrc = slice('async function zcE2bConnect', '// Cache API：同机房强一致');   // v2.34：InfoEx 遇到暂停 / 404 会走 connect 唤醒，一并取出来测
  let apiMode = 'ok', apiHits = 0;
  const mkInfo = new Function('zcE2bApi', 'zcSleep', 'zcE2bTtl', 'zcE2bApiMsg', 'ZC_E2B_STAT', 'zcE2bNote', infoSrc + '\nreturn zcE2bInfoEx;');
  let connects = 0, busyLeft = 0;
  const fakeApi = async (env, path, method) => {
    const isConn = /\/connect$|\/resume$/.test(path);
    if (!isConn) apiHits++;
    if (isConn) {
      connects++;
      if (apiMode === 'paused' || apiMode === 'paused404') return /\/v2\//.test(path) ? { ok: true, status: 201, json: { sandboxID: 'sb1', envdAccessToken: 'tk2' } } : { ok: false, status: 404, json: null };
      if (apiMode === 'busy409') { if (busyLeft-- > 0) return { ok: false, status: 409, json: { message: 'changing state' } }; return { ok: true, status: 201, json: { sandboxID: 'sb1', envdAccessToken: 'tk3' } }; }
      if (apiMode === '404') return { ok: false, status: 404, json: null };
      return { ok: true, status: 200, json: { sandboxID: 'sb1' } };
    }
    if (apiMode === 'ok') return { ok: true, status: 200, json: { sandboxID: 'sb1', envdAccessToken: 't', state: 'running' } };
    if (apiMode === 'paused' || apiMode === 'busy409') return { ok: true, status: 200, json: { sandboxID: 'sb1', state: 'paused' } };
    if (apiMode === '404' || apiMode === 'paused404') return { ok: false, status: 404, json: null };
    if (apiMode === '429') return { ok: false, status: 429, json: null };
    throw new Error('network down');
  };
  const infoEx = mkInfo(fakeApi, async () => {}, () => 1800, (r) => 'msg', { resumed: 0 }, () => {});
  let x = await infoEx({}, 'sb1'); const s1 = x.state;
  apiMode = '404'; x = await infoEx({}, 'sb1'); const s2 = x.state; const h404 = apiHits;
  apiMode = '429'; apiHits = 0; x = await infoEx({}, 'sb1'); const s3 = x.state; const h429 = apiHits;
  apiMode = 'throw'; x = await infoEx({}, 'sb1'); const s4 = x.state;
  t('状态三态：200=alive、404=gone（立即判定）、429 / 网络错误=unknown（重试 4 次后才放弃）', s1 === 'alive' && s2 === 'gone' && s3 === 'unknown' && h429 === 4 && s4 === 'unknown', [s1, s2, s3, s4].join('/') + ' hits429=' + h429);

  apiMode = 'paused'; connects = 0; x = await infoEx({}, 'sb1');
  t('v2.34：沙箱在暂停态 → 先 connect 唤醒（201），返回 alive + resumed，不当成「已丢失」', x.state === 'alive' && x.resumed === true && connects >= 1 && x.info && x.info.envdAccessToken === 'tk2', JSON.stringify({ st: x.state, resumed: x.resumed, connects }));
  apiMode = 'paused404'; connects = 0; x = await infoEx({}, 'sb1');
  t('v2.34：GET 对暂停的沙箱返回 404（部分接口版本如此）→ 仍用 connect 唤醒，不新建空沙箱', x.state === 'alive' && x.resumed === true, JSON.stringify({ st: x.state, resumed: x.resumed }));
  apiMode = 'busy409'; busyLeft = 2; connects = 0; x = await infoEx({}, 'sb1');
  t('v2.34：connect 遇到 409（正在暂停 / 恢复中）→ 等一下再试，最终唤醒成功', x.state === 'alive' && connects >= 3, JSON.stringify({ st: x.state, connects }));
  apiMode = '404'; x = await infoEx({}, 'sb1');
  t('v2.34：GET 与 connect / resume 都说不存在 → 才判定 gone（新建）', x.state === 'gone', x.state);

  const runSrc = slice('async function zcE2bRun(env, ws, command, opts)', '\n}\n') + '\n}\n';
  function mkRun(state) {
    const log = { created: 0, starts: 0, notes: [] };
    const sess0 = { id: 'old-box', token: 'tk', root: '/workspace' };
    const fn = new Function('zcE2bSessionGet', 'zcE2bRoot', 'zcE2bExtend', 'zcE2bStart', 'zcE2bInfoEx', 'zcE2bNote', 'ZC_E2B_STAT', 'ZC_E2B_SESS', 'zcSleep', 'zcE2bInfo', 'zcE2bMaybeCycle', runSrc + '\nreturn zcE2bRun;');
    const run = fn(async (env, ws, forceNew) => { if (forceNew) { log.created++; return { id: 'new-box', token: 'n', root: '/workspace' }; } return sess0; },
      async () => '/workspace', async () => {},
      async (env, sess) => { log.starts++; if (log.starts === 1) throw new Error('网络错误：fetch failed'); return { exitCode: 0, stdout: 'ok on ' + sess.id, stderr: '' }; },
      async () => (state === 'alive' ? { state, info: { envdAccessToken: 'z' } } : { state }), (k, m) => log.notes.push(k), { retries: 0 }, new Map(), async () => {}, async () => null, async () => {});
    return { run, log };
  }
  let m = mkRun('unknown'); let rr = await m.run({}, 'main', 'git clone ...', { timeoutMs: 1000 });
  t('命令执行遇到网络抖动、沙箱状态不明：原地重试，不新建空沙箱（旧版会新建 → /workspace 清空）', m.log.created === 0 && /old-box/.test(rr.stdout) && m.log.notes.indexOf('rebuild-skip') >= 0, 'created=' + m.log.created + ' ' + rr.stdout);
  m = mkRun('gone'); rr = await m.run({}, 'main', 'ls', { timeoutMs: 1000 });
  t('E2B 明确说沙箱不存在（404）：才新建', m.log.created === 1 && /new-box/.test(rr.stdout));
  m = mkRun('alive'); rr = await m.run({}, 'main', 'ls', { timeoutMs: 1000 });
  t('沙箱还活着：原地重试，不新建', m.log.created === 0 && /old-box/.test(rr.stdout));

  const ok = results.filter(Boolean).length;
  console.log('\n===== ' + ok + '/' + results.length + ' 通过 =====');
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
