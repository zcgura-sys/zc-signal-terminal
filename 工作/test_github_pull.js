/* v2.30.4：github_to_local（GitHub 源码包 → 本地目录）、保留 mtime 的写入也能被自动拉回（ctime）、拉回熔断。 */
const fs = require('fs');
const assert = require('assert');
const vm = require('vm');

const html = fs.readFileSync(require('path').join(__dirname, 'public', 'index.html'), 'utf8');
const all = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length);
let app = all[0];
const EXPOSE = 'window.__T = { AgentFS, AgentMix, CloudFS, Agent, AgentTools, GitHubPull, Approvals, Audit, Chat };\n';
const tail = "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootApp); else bootApp();";
assert.ok(app.indexOf(tail) >= 0, 'tail not found');
app = app.replace(tail, EXPOSE + tail);

function stubEl() {
  return {
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [], childNodes: [], textContent: '', innerHTML: '', hidden: false, value: '', checked: false, type: '',
    appendChild(c) { this.children.push(c); return c; }, removeChild() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    querySelector() { return stubEl(); }, querySelectorAll() { return []; },
    focus() {}, click() {}, closest() { return null; }, insertBefore() {}, replaceChildren() {}, scrollIntoView() {}
  };
}
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }, clear: () => { for (const k in store) delete store[k]; },
  key: (i) => Object.keys(store)[i] || null, get length() { return Object.keys(store).length; }
};
const documentStub = {
  readyState: 'loading', addEventListener() {}, removeEventListener() {},
  querySelector() { return stubEl(); }, querySelectorAll() { return []; },
  createElement() { return stubEl(); }, createTextNode() { return {}; },
  documentElement: stubEl(), head: stubEl(), body: stubEl(), visibilityState: 'visible', hidden: false
};
const webs = require('stream/web');
const sandbox = {
  DecompressionStream: webs.DecompressionStream, ReadableStream: webs.ReadableStream, Uint8Array, ArrayBuffer,
  console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Math, Date, Object, Array,
  String, Number, Boolean, RegExp, Error, Map, Set, Symbol, AbortController, TextEncoder, TextDecoder, URL, URLSearchParams,
  fetch: () => Promise.reject(new Error('no net')),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  localStorage, sessionStorage: localStorage,
  navigator: { userAgent: 'node', language: 'zh-CN', clipboard: {} },
  location: { href: 'https://x/', origin: 'https://x', pathname: '/', search: '', hash: '' },
  document: documentStub, crypto: { subtle: {}, randomUUID: () => 'x' },
  requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }), addEventListener() {}, removeEventListener() {}
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.runInContext(app, vm.createContext(sandbox), { filename: 'app.js' });
const T = sandbox.window.__T;
assert.ok(T, 'expose failed');
const { AgentFS, AgentMix, CloudFS, Agent, AgentTools, GitHubPull, Approvals, Audit, Chat } = T;



const cp = require('child_process');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const results = [];
function t(name, ok, extra) { results.push(!!ok); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? '  → ' + extra : '')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 造一个和 GitHub 源码包同格式的 tar.gz（git archive：pax 全局头 + 顶层目录 owner-repo-sha/） ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghp-'));
const repoDir = path.join(tmp, 'repo');
fs.mkdirSync(repoDir);
const longDir = 'src/agent/' + 'very_long_directory_name_'.repeat(5) + '/deep';
const files = {
  'README.md': '# demo agent\n',
  'docs/architecture.md': '# arch\n' + 'x'.repeat(5000),
  'docs/中文说明.md': '你好，世界\n',
  'src/agent/loop.py': 'def loop():\n    pass\n',
  'src/agent/runner.py': 'class Runner: ...\n',
  [longDir + '/very_long_file_name_' + 'y'.repeat(60) + '.py']: 'print("long path")\n',
  'pyproject.toml': '[project]\nname="demo"\n',
  'empty.txt': '',
  'node_modules/foo/index.js': 'module.exports = 1',
  'dist/bundle.js': 'bundle',
  '.env': 'SECRET=1\n',
  'src/util.ts': 'export const a = 1;\n'
};
Object.keys(files).forEach((p) => { const f = path.join(repoDir, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, files[p]); });
const bin = crypto.randomBytes(40000); fs.writeFileSync(path.join(repoDir, 'images/logo.png'.replace('images/', '')), bin);
fs.mkdirSync(path.join(repoDir, 'images')); fs.writeFileSync(path.join(repoDir, 'images/pic.bin'), bin);
fs.symlinkSync('README.md', path.join(repoDir, 'link.md'));
const sh = (c, o) => cp.execSync(c, Object.assign({ cwd: repoDir, stdio: 'pipe' }, o || {}));
sh('git init -q && git add -A -f && git -c user.email=a@b -c user.name=n commit -qm init');
const tgzPath = path.join(tmp, 'nb.tar.gz');
sh('git archive --format=tar.gz --prefix=HKUDS-nanobot-abc1234/ -o ' + JSON.stringify(tgzPath) + ' HEAD');
const tgz = fs.readFileSync(tgzPath);

/* ---------- 假的本站 Worker：/__zc_web__/ghtar 返回 tgz（可指定分块大小，测试跨块边界） ---------- */
let fetchLog = [], chunkSize = 16384, failStatus = 0;
sandbox.fetch = async (url, init) => {
  fetchLog.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
  if (failStatus) return { ok: false, status: failStatus, json: async () => ({ error: '找不到仓库或分支：x/y@HEAD' }) };
  let off = 0;
  const rs = new webs.ReadableStream({ pull(ctl) { if (off >= tgz.length) { ctl.close(); return; } ctl.enqueue(new Uint8Array(tgz.subarray(off, off + chunkSize))); off += chunkSize; } });
  return { ok: true, status: 200, body: rs };
};
const repo = GitHubPull.parseRepo('https://github.com/HKUDS/nanobot');
const bytesOf = (u8) => Buffer.from(u8);

(async () => {
  /* 1) 解析仓库写法 */
  t('parseRepo：支持 owner/name、完整链接、.git 后缀、带路径的链接', GitHubPull.parseRepo('HKUDS/nanobot').full === 'HKUDS/nanobot' && GitHubPull.parseRepo('https://github.com/a/b.git').full === 'a/b' && GitHubPull.parseRepo('https://github.com/a/b/tree/main/src').full === 'a/b' && GitHubPull.parseRepo('not a repo') === null && GitHubPull.parseRepo('../etc/passwd') === null && GitHubPull.parseRepo('a/..') === null);

  /* 2) 完整解包：pax 全局头 / 长路径 / 中文名 / 空文件 / 二进制 逐字节一致；符号链接不出现；node_modules、dist 默认排除 */
  let c = await GitHubPull.collect(repo, '', { maxFiles: 500 });
  const got = {}; c.got.forEach((f) => { got[f.path] = bytesOf(f.data); });
  const expectPaths = Object.keys(files).filter((p) => !/^(node_modules|dist)\//.test(p)).concat(['images/pic.bin', 'logo.png']);
  t('解出所有预期文件（含 40 字符以上长路径、中文文件名、空文件、.env），内容逐字节一致', expectPaths.every((p) => got[p] && (p in files ? got[p].toString() === files[p] : got[p].equals(bin))), 'got=' + Object.keys(got).length + '/' + expectPaths.length);
  t('二进制文件字节一致、请求体带 repo/ref', got['images/pic.bin'] && got['images/pic.bin'].equals(bin) && fetchLog[0].url.indexOf('/__zc_web__/ghtar') >= 0 && fetchLog[0].body.repo === 'HKUDS/nanobot');
  t('node_modules/ dist/ 默认排除；符号链接不当成文件', !got['node_modules/foo/index.js'] && !got['dist/bundle.js'] && !got['link.md'], 'total=' + c.total);

  /* 3) 极端分块（每块 37 字节）结果完全一致 —— 验证跨块边界的缓冲逻辑 */
  chunkSize = 37;
  const c2 = await GitHubPull.collect(repo, '', { maxFiles: 500 });
  t('每块仅 37 字节的流式输入，解析结果与整块一致', c2.got.length === c.got.length && c2.got.every((f) => got[f.path] && got[f.path].equals(bytesOf(f.data))));
  chunkSize = 16384;

  /* 4) include / exclude / glob / list_only / 上限 */
  c = await GitHubPull.collect(repo, '', { include: ['docs/'] });
  t('include 目录前缀 docs/', c.got.map((f) => f.path).sort().join() === 'docs/architecture.md,docs/中文说明.md', c.got.map((f) => f.path).join());
  c = await GitHubPull.collect(repo, '', { include: ['*.md'] });
  t('include *.md（任意目录下的文件名通配）', c.got.map((f) => f.path).sort().join() === 'README.md,docs/architecture.md,docs/中文说明.md', c.got.map((f) => f.path).join());
  c = await GitHubPull.collect(repo, '', { include: ['src/**/*.py'] });
  t('include src/**/*.py（跨目录通配，含超长路径）', c.got.length === 3 && c.got.some((f) => f.path.length > 150), c.got.length + ' 个');
  c = await GitHubPull.collect(repo, '', { include: ['src/'], exclude: ['src/util.ts', '*.py'] });
  t('exclude 精确路径与通配', c.got.length === 0 && c.matched.length === 0);
  c = await GitHubPull.collect(repo, '', { include: ['pyproject.toml'] });
  t('include 精确路径', c.got.length === 1 && c.got[0].path === 'pyproject.toml');
  c = await GitHubPull.collect(repo, '', { listOnly: true, include: ['docs/'] });
  t('list_only：只列清单，不读取内容', c.got.length === 0 && c.matched.length === 2 && c.total >= 10);
  c = await GitHubPull.collect(repo, '', { maxFiles: 2 });
  t('max_files 上限：只下载 2 个，其余计入 overflow', c.got.length === 2 && c.overflow > 0 && c.matched.length > 2, 'overflow=' + c.overflow);

  /* 5) Worker 报错（404 仓库不存在）→ 抛出带原因的错误 */
  failStatus = 404;
  let err = ''; try { await GitHubPull.collect(repo, 'nope', {}); } catch (e) { err = e.message; }
  t('仓库 / 分支不存在：错误信息原样透出', /找不到仓库或分支/.test(err), err);
  failStatus = 0;

  /* 6) 工具可用性：本地 / 混合模式有 github_to_local，纯云端没有；混合模式也有 fetch_to_local */
  const names = (b) => { Agent.backend = b; return AgentTools.available().map((x) => x.name); };
  const savedRoot = AgentFS.root; AgentFS.root = {};
  t('混合模式与本地模式提供 github_to_local，云端模式不提供', names('mix').indexOf('github_to_local') >= 0 && names('local').indexOf('github_to_local') >= 0 && names('cloud').indexOf('github_to_local') < 0);
  t('混合模式也能用 fetch_to_local（旧版它只在本地模式可见，混合模式只能绕云端）', names('mix').indexOf('fetch_to_local') >= 0);

  /* 7) 端到端：模型调用 github_to_local（list_only → include 挑选 → 用户确认 → 写入本地）。UI / 审批全部打桩 */
  Agent.backend = 'mix';
  const local = {}; let confirms = [], writes = 0, approve = true;
  AgentFS.root = {}; AgentFS.rootName = 'myproj';
  AgentMix.localBytes = async (p) => (p in local ? new Uint8Array(local[p]) : null);
  AgentFS.createFile = async (p, d) => { if (p in local) throw new Error('exists'); writes++; local[p] = Buffer.from(d); };
  AgentFS.writeFile = async (p, d) => { if (!(p in local)) throw new Error('missing'); writes++; local[p] = Buffer.from(d); };
  Agent.runSteps = []; Agent.renderStep = () => {}; Agent.renderTree = () => {}; Agent.taskId = 'T1';
  Agent.confirmChange = async (pv) => { confirms.push(pv); return approve; };
  Approvals.create = async () => null; Approvals.decide = async () => {}; Audit.log = () => {};
  Chat.ctrl = { signal: { aborted: false, addEventListener() {}, removeEventListener() {} } };
  const run = (args) => Agent.runOneTool({ name: 'github_to_local', args: args });

  let out = await run({ repo: 'HKUDS/nanobot', list_only: true });
  t('list_only：返回目录概览与文件清单，没有弹确认框、没有写文件', /目录概览/.test(out) && /docs\//.test(out) && confirms.length === 0 && writes === 0, out.split('\n')[0]);

  out = await run({ repo: 'HKUDS/nanobot', include: ['docs/', 'src/agent/', '*.md', '.env'], reason: '收集 agent 相关文件' });
  const paths = Object.keys(local).sort();
  t('确认后写入本地：默认放进以仓库名命名的子目录 nanobot/', paths.length > 0 && paths.every((p) => p.indexOf('nanobot/') === 0) && local['nanobot/docs/architecture.md'] && local['nanobot/README.md'], paths.length + ' 个');
  t('确认框内容：来源 GitHub、文件数、目标子目录', confirms.length === 1 && /GitHub HKUDS\/nanobot/.test(confirms[0].from) && confirms[0].dest === 'nanobot' && confirms[0].count === paths.length && confirms[0].kind === 'pull');
  t('敏感文件 .env 即使被 include 也不会写入本地', !local['nanobot/.env'] && /敏感/.test(out));
  t('写入内容逐字节一致（含中文文件名与超长路径）', local['nanobot/docs/中文说明.md'].toString() === files['docs/中文说明.md'] && paths.some((p) => p.length > 150));

  /* 再来一次：本地已有且一致 → 不再弹确认框、不重复写入 */
  const w1 = writes, cf1 = confirms.length;
  out = await run({ repo: 'HKUDS/nanobot', include: ['docs/', 'src/agent/', '*.md'] });
  t('再次调用：本地已存在且一致 → 不弹确认框、不重复写', writes === w1 && confirms.length === cf1 && /无需重复下载/.test(out));

  /* 指定 dest + 内容不同 → 覆盖并在确认框里提示覆盖数 */
  local['agent-src/nanobot/README.md'] = Buffer.from('old');
  confirms = [];
  out = await run({ repo: 'HKUDS/nanobot', include: ['README.md', 'pyproject.toml'], dest: 'agent-src/nanobot' });
  t('指定 dest；本地已有但内容不同的文件会被覆盖，并在确认框里提示', local['agent-src/nanobot/README.md'].toString() === files['README.md'] && confirms[0].overwrite === 1 && confirms[0].dest === 'agent-src/nanobot');

  /* 用户拒绝 → 一个文件都不写，并明确告诉模型不要重复申请 */
  approve = false; const w2 = writes;
  out = await run({ repo: 'HKUDS/nanobot', include: ['src/util.ts'], dest: 'other' });
  t('用户拒绝：不写任何文件，提示模型调整方案', writes === w2 && !local['other/src/util.ts'] && /用户拒绝/.test(out));
  approve = true;

  /* 收窄提示：include 为空且文件数超过 max_files → 不下载，返回目录概览让模型收窄 */
  const w3 = writes, cf3 = confirms.length, keys3 = Object.keys(local).length;
  out = await run({ repo: 'HKUDS/nanobot', max_files: 2 });
  t('符合条件的文件超过 max_files：不下载任意子集、不弹确认框、不写文件，返回概览让模型收窄 include', writes === w3 && confirms.length === cf3 && Object.keys(local).length === keys3 && /太多/.test(out) && /目录概览/.test(out), out.split('\n').slice(-1)[0].slice(0, 60));

  /* 参数错误与目录未授权 */
  out = await run({ repo: '???' });
  t('repo 写法不对：明确提示', /owner\/name/.test(out));
  AgentFS.root = false;
  out = await run({ repo: 'HKUDS/nanobot' });
  t('没有授权本地目录：明确提示先选目录', /本地项目目录/.test(out));
  AgentFS.root = {};

  /* 8) 保留 mtime 的写入（tar -x / cp -a / unzip）能被自动拉回的变更检测发现 —— 用真实 find 验证生成的命令 */
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const srcd = path.join(tmp, 'oldsrc'); fs.mkdirSync(srcd + '/nanobot/agent', { recursive: true });
  fs.writeFileSync(srcd + '/nanobot/agent/loop.py', 'old file'); fs.writeFileSync(srcd + '/README.md', 'readme');
  cp.execSync("touch -d '2020-01-01 00:00:00' " + srcd + '/nanobot/agent/loop.py ' + srcd + '/README.md');   // 克隆下来的文件：时间戳很久以前
  cp.execSync('sleep 1.2');
  const ts = Math.floor(Date.now() / 1000) - 1;                       // 「本次命令开始时间」
  cp.execSync('cd ' + srcd + ' && tar -cf - . | tar -xf - -C ' + ws);  // 模型的做法：tar 合并，保留 mtime
  let cmd = '';
  CloudFS.exec = async (c) => { cmd = c; return { stdout: cp.execSync(c, { cwd: ws, shell: '/bin/bash' }).toString(), exitCode: 0 }; };
  const listed = await AgentMix.listChanged(ts);
  t('tar -x 保留旧 mtime 的文件，自动拉回现在也能发现（旧版 -newermt 一个都找不到）', listed.length === 2 && listed.some((x) => x.path === 'nanobot/agent/loop.py'), JSON.stringify(listed.map((x) => x.path)));
  const oldOnly = cp.execSync(cmd.replace(/-o -newerct '@\d+' /, '').replace(/\\\( (-newermt '@\d+') \\\)/, '$1'), { cwd: ws, shell: '/bin/bash' }).toString().trim();
  t('对照：只用 mtime 判断（旧逻辑）确实是空的', oldOnly === '', JSON.stringify(oldOnly));

  /* 9) 熔断：连续整批失败（沙箱被重置，文件都不存在）→ 3 批后中止，不再空等 */
  CloudFS.norm = (p) => String(p);
  let manyCalls = 0;
  CloudFS.api = async (sub, body) => { manyCalls++; if (sub === 'readmany') return { ok: true, results: body.paths.map((p) => ({ path: p, st: 'missing' })) }; throw new Error('unexpected ' + sub); };
  AgentMix.reset();
  const list = []; for (let i = 0; i < 600; i++) list.push({ path: 'g/f' + i + '.py', size: 3000 });
  const r = await AgentMix.pullList(list, { allowBig: false });
  t('沙箱被重置（文件全不存在）：连续 3 批失败后熔断，剩余记 deferred，不是白等', !!r.aborted && manyCalls <= 6 && r.deferred > 0, 'calls=' + manyCalls + ' deferred=' + r.deferred);
  t('熔断说明写进给模型的提示里', /拉回已中止/.test(AgentMix.describe(r)) && /沙箱/.test(r.aborted));

  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true });
  const ok = results.filter(Boolean).length;
  console.log('\n===== ' + ok + '/' + results.length + ' 通过 =====');
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
