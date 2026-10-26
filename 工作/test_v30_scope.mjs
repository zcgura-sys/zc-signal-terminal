// v2.30 范围校验：已移除的功能不再出现；并入的聊天模式齐全；备用路径不再被服务端接管
import fs from 'node:fs';
import assert from 'node:assert/strict';
const html = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('./_worker.js', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8');
const R = [];
const check = (n, f) => { try { f(); R.push(['PASS', n]); } catch (e) { R.push(['FAIL', n + ' → ' + e.message.split('\n')[0]]); } };

check('已移除：语音 / 套餐 / 账号安全 / 跑分的接口路径与入口', () => {
  for (const k of ['/__zc_voice__', '/__zc_billing__', '/__zc_quota__', '/__zc_push__', 'tab_billing', 'tab_voice', 'tab_compare', 'totpFlow', 'speechChunks'])
    assert.ok(html.indexOf(k) < 0 && worker.indexOf(k) < 0, '仍残留 ' + k);
});
check('已移除：后端不再有 TOTP / 配额 / Stripe / VAPID / 语音实现', () => {
  for (const k of ['zcHandleVoice', 'zcHandleBilling', 'zcQuotaPre', 'zcTotp', 'zcPushNotify', 'zcRbacNeed', 'STRIPE_PLANS', "zcV(env, 'VOICE_", "zcV(env, 'STRIPE_", "zcV(env, 'VAPID_"])
    assert.ok(worker.indexOf(k) < 0, '仍残留 ' + k);
});
check('麦克风权限保持关闭；Service Worker 不含推送', () => {
  assert.ok(worker.indexOf('microphone=()') >= 0 && worker.indexOf('microphone=(self)') < 0);
  assert.ok(sw.indexOf("'push'") < 0 && sw.indexOf('notificationclick') < 0);
});
check('扩展中心只剩 通用 / MCP / 知识库 / 团队 / 分支树 五个标签', () => {
  const m = html.match(/const ZX_TABS = \[([\s\S]*?)\n\];/); assert.ok(m);
  assert.deepEqual([...m[1].matchAll(/id: '(\w+)'/g)].map((x) => x[1]), ['overview', 'mcp', 'kb', 'team', 'branch']);
});
check('并入：聊天 / 代码模式的入口、背景、设置页、扩展口都在', () => {
  for (const k of ['id="modeSeg"', 'id="btnChatLook"', 'data-pane="cmode"', 'const Mode', 'const ChatBg', 'const ChatMode', 'ChatMode.register', 'modeOf(', 'ChatBg.init(); ChatMode.init(); ChatMode.initUI(); Mode.init();', 'zc_gura_ui_mode'])
    assert.ok(html.indexOf(k) >= 0, '缺少 ' + k);
});
check('并入：对话按模式隔离（列表过滤 + 新建带模式 + 删除只在本模式内选下一个）', () => {
  assert.ok(/create\(silent, mode\)/.test(html));
  assert.ok(/Sessions\.sorted\(\)\.filter\(/.test(html) || /modeOf\(s\) === /.test(html));
});
check('已移除：通用页的「安装到桌面」与「导出审计」（按钮、事件捕获、后端导出接口都不在了）；离线缓存保留', () => {
  for (const k of ['_installEv', 'beforeinstallprompt', "zxT('安装', 'Install')", '安装到桌面', '导出审计（哈希链', '/__zc_ops__/audit-export'])
    assert.ok(html.indexOf(k) < 0, '前端仍残留 ' + k);
  for (const k of ['zcAuditExport', "sub === 'audit-export'"]) assert.ok(worker.indexOf(k) < 0, '后端仍残留 ' + k);
  assert.ok(html.indexOf("serviceWorker.register('/sw.js')") >= 0, '离线缓存的 Service Worker 注册不应被一起删掉');
});
check('团队空间：owner 有「删除团队」入口，且走 disband 接口', () => {
  assert.ok(html.indexOf("'/__zc_team__/disband'") >= 0 && html.indexOf("zxT('删除团队'") >= 0, '前端缺少删除团队入口');
  assert.ok(worker.indexOf("sub === 'disband'") >= 0, '后端缺少 disband');
});
check('保留：MCP / 知识库 / 团队 / Google·Microsoft 登录 / SIEM / 分支树', () => {
  for (const k of ['zcHandleMcp', 'zcHandleTeam', 'zcHandleRag', 'zcOidc', 'zcSiemPushMaybe']) assert.ok(worker.indexOf(k) >= 0, '缺少 ' + k);
  for (const k of ['tab_mcp', 'tab_kb', 'tab_team', 'tab_branch', 'btnGoogle', 'btnMicrosoft']) assert.ok(html.indexOf(k) >= 0, '缺少 ' + k);
});
R.forEach(([s, n]) => console.log(s + ' | ' + n));
const f = R.filter((r) => r[0] === 'FAIL').length;
console.log('===== ' + (R.length - f) + '/' + R.length + ' 通过 =====');
process.exit(f ? 1 : 0);
