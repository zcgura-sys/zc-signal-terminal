#!/usr/bin/env node
// 7.js 语法与结构自检：
//   1) Worker 模块本身（ESM）通过 node --check
//   2) 模板字符串里的前端 HTML 中，每一段内联 <script> 都单独通过 node --check
//   3) <style> 花括号配平、液态玻璃注入标记存在
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const FILE = path.join(ROOT, '7.js');
const src = fs.readFileSync(FILE, 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zc7-'));
let failed = 0;
const ok = (m) => console.log('[ok] ' + m);
const bad = (m) => { failed++; console.error('[FAIL] ' + m); };

function checkJs(code, name) {
  const f = path.join(tmp, name.replace(/[^\w.-]/g, '_') + '.mjs');
  fs.writeFileSync(f, code);
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe', encoding: 'utf8' });
    ok(name + '：语法正确');
  } catch (e) {
    bad(name + '：语法错误\n' + String(e.stderr || e.stdout || e.message));
  }
}

// ---- 1) Worker 模块 ----
checkJs(src, '7.js（Worker 模块）');

// ---- 2) 从 String.raw 模板中取出前端 HTML ----
function extractRawTemplate(s, anchor) {
  const a = s.indexOf(anchor);
  if (a < 0) return null;
  const open = s.indexOf('`', a + anchor.length);
  if (open < 0) return null;
  let i = open + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return s.slice(open + 1, i);
    i++;
  }
  return null;
}

const html = extractRawTemplate(src, 'const ZC_HTML = String.raw');
if (!html) bad('未能定位 ZC_HTML 模板字符串（可能被截断或含意外反引号）');
else {
  ok('ZC_HTML 模板字符串提取成功（' + html.length + ' 字符）');

  // 模板里不允许再出现裸反引号 / ${ }，否则说明模板被截断
  if (html.indexOf('${') >= 0) bad('ZC_HTML 中出现了 ${ ，模板可能被截断');

  const re = /<script>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  while ((m = re.exec(html))) { n++; checkJs(m[1], '内联脚本 #' + n); }
  if (n < 2) bad('内联脚本数量异常：' + n);

  const st = /<style>([\s\S]*?)<\/style>/i.exec(html);
  if (!st) bad('未找到 <style> 块');
  else {
    const css = st[1].replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ''); // 去掉字符串，避免误计
    const open = (css.match(/\{/g) || []).length;
    const close = (css.match(/\}/g) || []).length;
    if (open !== close) bad('CSS 花括号不配平：{ ' + open + ' 个，} ' + close + ' 个');
    else ok('CSS 花括号配平（' + open + ' 组）');
  }
}

// ---- 3) 液态玻璃注入标记 ----
const marks = ['液态玻璃（Liquid Glass）', 'zcGlassLight', 'zcAurora', 'zcEdge', '--zc-lx'];
marks.forEach((k) => { if (src.indexOf(k) < 0) bad('缺少标记：' + k); });
if (!failed) ok('液态玻璃注入标记齐全');

console.log(failed ? '\n共 ' + failed + ' 项失败' : '\n全部检查通过');
process.exit(failed ? 1 : 0);
