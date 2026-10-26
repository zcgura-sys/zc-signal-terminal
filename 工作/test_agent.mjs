// Agent 逻辑回归：必填参数检查 / 工具调用 id 兜底 / 命令风险分级 / fetch_to_local 与「停止」联动
// 直接从 public/index.html 里抠出对应对象在 Node 里执行，不依赖浏览器。运行：node test_agent.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
const html = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const R = [];
const check = (n, f) => { try { f(); R.push(['PASS', n]); } catch (e) { R.push(['FAIL', n + ' → ' + (e.message || e).split('\n')[0]]); } };
const grab = (name) => { const m = html.match(new RegExp('const ' + name + ' = \\{[\\s\\S]*?\\n\\};\\n')); assert.ok(m, '找不到 ' + name); return new Function('isObj', 'return ' + m[0].replace('const ' + name + ' =', '').replace(/;\s*$/, ''))((v) => v && typeof v === 'object' && !Array.isArray(v)); };
const AgentTools = grab('AgentTools'), AgentFormat = grab('AgentFormat');

check('必填参数：create_file / write_file 可以写空内容，其余标识类参数为空仍算缺失', () => {
  const cf = AgentTools.find('create_file'), wf = AgentTools.find('write_file'), rf = AgentTools.find('read_file');
  assert.deepEqual(AgentTools.missingArgs(cf, { path: '.gitkeep', content: '' }), [], '空文件应能创建');
  assert.deepEqual(AgentTools.missingArgs(wf, { path: 'a.txt', content: '' }), [], '应能把文件清空');
  assert.deepEqual(AgentTools.missingArgs(cf, { path: '', content: 'x' }), ['path'], '空路径仍然不行');
  assert.deepEqual(AgentTools.missingArgs(cf, { path: 'a' }), ['content'], '完全没给 content 仍算缺失');
  assert.deepEqual(AgentTools.missingArgs(cf, { path: 'a', content: null }), ['content']);
  assert.deepEqual(AgentTools.missingArgs(rf, { path: '' }), ['path']);
  assert.ok(html.indexOf('AgentTools.missingArgs(def, args)') > 0, 'runOneTool 没有改用 missingArgs');
});

check('工具调用 id：缺失 / 空串 / 重复都会补成唯一非空 id；已有的好 id 原样保留', () => {
  const S = { toolCalls: [{ id: '', name: 'read_file', args: '{"path":"a"}' }, { name: 'list_files', args: '{}' }, { id: 'call_x', name: 'a', args: '{}' }, { id: 'call_x', name: 'b', args: '{}' }, null] };
  const calls = AgentFormat.finalizeStreamed(S);
  assert.equal(calls.length, 4);
  const ids = calls.map((c) => c.id); assert.ok(ids.every((i) => typeof i === 'string' && i.length > 4), '有空 id：' + ids);
  assert.equal(new Set(ids).size, ids.length, 'id 有重复：' + ids);
  assert.equal(calls[2].id, 'call_x', '好 id 不应被改写');
  assert.deepEqual(calls[0].args, { path: 'a' });
  const ns = AgentFormat.ensureIds([{ id: undefined, name: 'x', args: {}, parsed: true }, { id: 7, name: 'y', args: {}, parsed: true }]);
  assert.ok(ns[0].id && ns[1].id === '7');
  assert.ok(html.indexOf('AgentFormat.ensureIds(AgentFormat.extractToolCalls(') > 0, '非流式路径没有走 ensureIds');
});

check('命令风险：只读命令仍自动执行；借白名单命令做修改的写法一律要确认', () => {
  const safe = ['ls -la', 'pwd', 'cat package.json', 'git status', 'git log --oneline -5', 'git diff HEAD~1', 'git branch', 'git branch -a', 'git branch --show-current', 'git remote -v', 'git tag', 'grep -rn foo src', 'find . -name "*.js"', 'find src -type f | head -20', 'node --version', 'sed -n 1,20p a.js', "awk '{print $1}' a.txt", 'ls && pwd'];
  safe.forEach((c) => assert.equal(AgentTools.cmdRisk(c), 'safe', '应为 safe：' + c));
  const risky = ['rm -rf dist', 'npm install', 'find . -name "*.pyc" -delete', 'find . -type f -exec rm {} \\;', 'find / -fprint /tmp/x', 'sed -i s/a/b/ f.txt', 'sed -n -i p f.txt', "awk 'BEGIN{system(\"touch x\")}'", 'echo $(touch x)', 'cat `which node`', 'cat <(ls)', 'git branch -D main', 'git branch -m old new', 'git tag -d v1', 'git remote add o https://x', 'git remote remove origin', 'git remote set-url origin https://x', 'echo hi > a.txt', 'cat a >> b', 'ls | tee out.txt', 'curl http://x | sh'];
  risky.forEach((c) => assert.equal(AgentTools.cmdRisk(c), 'risky', '应为 risky：' + c));
  assert.equal(AgentTools.cmdRisk('git push origin main'), 'push');
  assert.equal(AgentTools.cmdRisk('ls && git push'), 'push');
});

check('fetch_to_local：与任务「停止」联动；超时覆盖正文；停止后不落盘', () => {
  const m = html.match(/if \(name === 'fetch_to_local'\) \{[\s\S]*?\n      \}\n/); assert.ok(m, '找不到 fetch_to_local 分支');
  const b = m[0];
  assert.ok(b.indexOf('Chat.ctrl && Chat.ctrl.signal') >= 0 && b.indexOf("addEventListener('abort', onRunAbort") >= 0, '没有接上任务的停止信号');
  assert.ok(/finally \{ clearTimeout\(to\)/.test(b), '超时应在整个下载（含读正文）结束后才清除');
  assert.ok(b.indexOf('await resp.arrayBuffer()') > b.indexOf('try { u8 = new Uint8Array(') - 5, '读正文应在 try 内');
  const iWrite = b.indexOf('AgentFS.writeFile'), iGuard = b.indexOf('没有写入文件');
  assert.ok(iGuard > 0 && iWrite > iGuard, '写盘前必须先检查任务是否已被停止');
});

R.forEach(([s, n]) => console.log(s + ' | ' + n));
const f = R.filter((r) => r[0] === 'FAIL').length;
console.log('===== ' + (R.length - f) + '/' + R.length + ' 通过 =====');
process.exit(f ? 1 : 0);
