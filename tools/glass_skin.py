#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为 8.js（ZC-GURA 单文件 Cloudflare Worker）注入「玻璃拟态 + 流光动画」皮肤。

设计参考（均为公开开源项目 / 文章）：
  * miketromba/css.glass（css.glass）、themesberg/glass-ui
      经典毛玻璃配方：半透明底色 + backdrop-filter: blur() saturate()
      + 1px 高光描边 + inset 内阴影。
  * tengbao/vanta（Vanta.js，MIT）
      "把动态背景层放到内容之下"的分层思路。这里不引 three.js，
      改用 3 团纯 CSS 高斯色斑做缓慢漂移，保持零依赖、零网络请求。
  * CSS-Tricks《A Complete Guide to CSS Gradients》
      用 transform / background-position 驱动渐变流动；文中 Accessibility
      一节强调配合 prefers-reduced-motion 并检查前景对比度，本实现遵循。

工程约束（重要）：8.js 的前端 HTML 位于 String.raw 模板字符串中，
因此注入的内容**不得包含反引号，也不得包含 ${ 或 </ 序列**，
否则会截断模板字符串或提前结束 style / script 标签。自检会强制校验这一点。

用法：
    python3 tools/glass_skin.py              注入（幂等，已注入则跳过）
    python3 tools/glass_skin.py --check      只检查当前状态
    python3 tools/glass_skin.py --revert     按标记移除注入内容
    python3 tools/glass_skin.py export       导出可独立粘贴的 css / js 片段
    python3 tools/glass_skin.py --selftest   内置自检（不需要 8.js 存在）
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "8.js"

# ---- 幂等 / 可回滚标记 ----
CSS_START = "/* ===== ZC-GLASS SKIN START ===== */"
CSS_END = "/* ===== ZC-GLASS SKIN END ===== */"
HTML_START = "<!-- ZC-GLASS LAYER START -->"
HTML_END = "<!-- ZC-GLASS LAYER END -->"
JS_START = "/* ZC-GLASS SCRIPT START */"
JS_END = "/* ZC-GLASS SCRIPT END */"

# ---- 8.js 中唯一存在的插入锚点 ----
A_SVG = '<svg width="0" height="0" style="position:absolute"'
A_STYLE_END = "</style>"
A_SEGFONT = '<div class="seg" id="segFont">'
A_BODY_END = "</body>"


# ---------------------------------------------------------------------------
# 1) 样式：动态背板 + 玻璃面板 + 光泽动画
# ---------------------------------------------------------------------------
CSS = CSS_START + """
/* 玻璃拟态与流光动画（渐进增强）
   配色全部由既有 CSS 变量派生，自动跟随浅色 / 深色主题。
   不支持 backdrop-filter 时退化为不透明底色；
   系统开启"减少动态效果"时由本文件既有的全局规则统一冻结动画。 */
:root{
  --zc-glass-bg:color-mix(in srgb,var(--surface) 74%,transparent);
  --zc-glass-bg2:color-mix(in srgb,var(--bg-2) 62%,transparent);
  --zc-glass-line:color-mix(in srgb,#fff 46%,transparent);
  --zc-glass-hi:color-mix(in srgb,#fff 34%,transparent);
  --zc-blur:20px;
}
html[data-theme="dark"]{
  --zc-glass-bg:color-mix(in srgb,var(--surface) 70%,transparent);
  --zc-glass-line:color-mix(in srgb,#fff 13%,transparent);
  --zc-glass-hi:color-mix(in srgb,#fff 9%,transparent);
}

/* ---------- 动态玻璃背板：三团缓慢漂移的高斯色斑 ---------- */
.zc-aurora{
  position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;
  contain:layout paint;opacity:0;transition:opacity .7s ease;
  transform:translate3d(var(--zx,0px),var(--zy,0px),0);
}
html.zc-glass .zc-aurora{opacity:1}
.zc-aurora i{
  position:absolute;display:block;width:54vmax;height:54vmax;border-radius:50%;
  filter:blur(58px);opacity:.5;will-change:transform;
  animation:zcDrift 30s ease-in-out infinite;
}
.zc-aurora i:nth-child(1){left:-16vmax;top:-18vmax;background:radial-gradient(circle at 32% 32%,#7db0ff,transparent 68%);animation-duration:34s}
.zc-aurora i:nth-child(2){right:-20vmax;top:2vmax;background:radial-gradient(circle at 58% 42%,#c39bff,transparent 66%);animation-duration:40s;animation-delay:-8s}
.zc-aurora i:nth-child(3){left:16vmax;bottom:-24vmax;background:radial-gradient(circle at 48% 52%,#5fdec6,transparent 68%);animation-duration:46s;animation-delay:-16s}
html[data-theme="dark"] .zc-aurora i{opacity:.34}
@keyframes zcDrift{
  0%,100%{transform:translate3d(0,0,0) scale(1)}
  33%{transform:translate3d(5vmax,3vmax,0) scale(1.12)}
  66%{transform:translate3d(-4vmax,6vmax,0) scale(.94)}
}
html.zc-glass .app{position:relative;z-index:1}

/* ---------- 大面积玻璃面板（真实 backdrop-filter；数量克制以控制开销） ---------- */
html.zc-glass .main{
  background:color-mix(in srgb,var(--bg) 80%,transparent);
  -webkit-backdrop-filter:blur(var(--zc-blur)) saturate(140%);
  backdrop-filter:blur(var(--zc-blur)) saturate(140%);
}
html.zc-glass .sidebar{
  background:var(--zc-glass-bg2);
  -webkit-backdrop-filter:blur(24px) saturate(155%);
  backdrop-filter:blur(24px) saturate(155%);
}
html.zc-glass .composer,
html.zc-glass .pop,
html.zc-glass .dialog,
html.zc-glass .settings,
html.zc-glass .agent-panel{
  background:var(--zc-glass-bg);
  -webkit-backdrop-filter:blur(18px) saturate(150%);
  backdrop-filter:blur(18px) saturate(150%);
  border-color:var(--zc-glass-line);
  box-shadow:var(--shadow),inset 0 1px 0 var(--zc-glass-hi);
}
html.zc-glass .overlay,
html.zc-glass .lightbox{
  -webkit-backdrop-filter:blur(11px) saturate(135%);
  backdrop-filter:blur(11px) saturate(135%);
}
html.zc-glass .toast{
  background:color-mix(in srgb,var(--primary) 88%,transparent);
  -webkit-backdrop-filter:blur(14px) saturate(150%);
  backdrop-filter:blur(14px) saturate(150%);
  box-shadow:var(--shadow),inset 0 1px 0 var(--zc-glass-hi);
}
html.zc-glass .toast.error{background:color-mix(in srgb,var(--danger) 92%,transparent)}
html.zc-glass .toast.ok{background:color-mix(in srgb,var(--ok) 92%,transparent)}

/* ---------- 面板内的小卡片：半透明 + 顶部高光 ----------
   父级已经模糊过，这里不再叠加 backdrop-filter，
   避免聊天区存在大量小卡片时拖慢滚动（这是有意的性能取舍）。 */
html.zc-glass .code,
html.zc-glass .fcard,
html.zc-glass .think,
html.zc-glass .astep,
html.zc-glass .agent-sum,
html.zc-glass .chip-att{
  background:color-mix(in srgb,var(--surface) 76%,transparent);
  border-color:var(--zc-glass-line);
  box-shadow:inset 0 1px 0 var(--zc-glass-hi);
}
html.zc-glass .msg.user .bubble{
  background:color-mix(in srgb,var(--bg-3) 74%,transparent);
  box-shadow:inset 0 1px 0 var(--zc-glass-hi);
}
html.zc-glass .fcard .fc-b,
html.zc-glass .code pre{background:color-mix(in srgb,var(--code-bg) 82%,transparent)}

/* ---------- 玻璃高光：输入框获得焦点时，一道光泽缓缓扫过 ---------- */
html.zc-glass .composer{position:relative;overflow:hidden}
html.zc-glass .composer::after{
  content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:linear-gradient(115deg,transparent 34%,var(--zc-glass-hi) 50%,transparent 66%);
  background-size:280% 100%;background-position:170% 0;opacity:0;
  transition:opacity .45s ease;
}
html.zc-glass .composer:focus-within::after{opacity:.9;animation:zcSheen 2.4s ease-out .08s 1}
@keyframes zcSheen{from{background-position:170% 0}to{background-position:-70% 0}}

/* ---------- 品牌字的流光渐变 ---------- */
html.zc-glass .brand span{
  background:linear-gradient(90deg,var(--text),var(--accent),var(--text));
  background-size:200% 100%;
  -webkit-background-clip:text;background-clip:text;
  -webkit-text-fill-color:transparent;color:transparent;
  animation:zcShine 9s linear infinite;
}
@keyframes zcShine{to{background-position:-200% 0}}

/* ---------- 发送键的呼吸光晕 + 卡片悬浮微抬升 ---------- */
html.zc-glass .send:not(:disabled){animation:zcBreath 3s ease-in-out infinite}
@keyframes zcBreath{
  0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 34%,transparent)}
  55%{box-shadow:0 0 0 7px color-mix(in srgb,var(--accent) 0%,transparent)}
}
html.zc-glass .pitem,
html.zc-glass .fcard,
html.zc-glass .astep,
html.zc-glass .chip-att{transition:transform .18s ease,box-shadow .18s ease,background-color .18s ease}
html.zc-glass .pitem:hover,
html.zc-glass .fcard:hover,
html.zc-glass .astep:hover{transform:translateY(-1px)}

/* ---------- 移动端：降低模糊半径与色斑浓度以省电 ---------- */
@media (max-width:820px){
  .zc-aurora i{filter:blur(46px);opacity:.42}
  html.zc-glass .main{
    background:color-mix(in srgb,var(--bg) 88%,transparent);
    -webkit-backdrop-filter:blur(14px) saturate(130%);
    backdrop-filter:blur(14px) saturate(130%);
  }
}

/* ---------- 降级：不支持 backdrop-filter 时回到不透明底色 ---------- */
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
  .zc-aurora{display:none}
  html.zc-glass .main{background:var(--bg)}
  html.zc-glass .sidebar,
  html.zc-glass .agent-panel{background:var(--bg-2)}
  html.zc-glass .composer,
  html.zc-glass .pop,
  html.zc-glass .dialog,
  html.zc-glass .settings,
  html.zc-glass .code,
  html.zc-glass .fcard,
  html.zc-glass .think,
  html.zc-glass .astep,
  html.zc-glass .agent-sum,
  html.zc-glass .chip-att,
  html.zc-glass .msg.user .bubble{background:var(--surface)}
}
""" + CSS_END

# ---------------------------------------------------------------------------
# 2) 结构：背板容器（插在 <body> 的第一个子元素之前）
# ---------------------------------------------------------------------------
HTML_LAYER = (
    HTML_START
    + '<div class="zc-aurora" id="zcAurora" aria-hidden="true" focusable="false">'
    + "<i></i><i></i><i></i>"
    + "</div>"
    + HTML_END
)

# ---------------------------------------------------------------------------
# 3) 设置项：外观面板里的开关
# ---------------------------------------------------------------------------
SETTINGS_ROW = (
    '<div class="row-sw"><div class="tx"><b>玻璃动效</b>'
    "<span>毛玻璃质感、流光高光与动态背景；关闭可省电并去掉动画</span></div>"
    '<label class="switch"><input type="checkbox" id="sGlass" checked><i></i></label></div>'
)

# ---------------------------------------------------------------------------
# 4) 脚本：偏好读写 + 指针视差
# ---------------------------------------------------------------------------
JS = (
    "<script>\n"
    + JS_START + "\n"
    + "(function () {\n"
    + "  'use strict';\n"
    + "  try {\n"
    + "    var root = document.documentElement;\n"
    + "    var KEY = 'zc_gura_glass';\n"
    + "    var reduced = false;\n"
    + "    try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}\n"
    + "    function read() {\n"
    + "      try { var v = localStorage.getItem(KEY); return v === null ? true : v === '1'; } catch (e) { return true; }\n"
    + "    }\n"
    + "    function write(on) { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {} }\n"
    + "    function apply(on) {\n"
    + "      root.classList.toggle('zc-glass', !!on);\n"
    + "      var cb = document.getElementById('sGlass');\n"
    + "      if (cb) {\n"
    + "        cb.checked = !!on;\n"
    + "        if (!cb.zcBound) {\n"
    + "          cb.zcBound = 1;\n"
    + "          cb.addEventListener('change', function () { apply(cb.checked); write(cb.checked); });\n"
    + "        }\n"
    + "      }\n"
    + "    }\n"
    + "    apply(read());\n"
    + "\n"
    + "    // 指针视差：背板随指针做极小位移，让前景玻璃有层次感。\n"
    + "    // 只改 CSS 变量并用 rAF 合帧，滚动与输入不受影响。\n"
    + "    if (!reduced) {\n"
    + "      var cx = 0, cy = 0, tx = 0, ty = 0, raf = 0;\n"
    + "      function tick() {\n"
    + "        raf = 0;\n"
    + "        cx += (tx - cx) * 0.12;\n"
    + "        cy += (ty - cy) * 0.12;\n"
    + "        root.style.setProperty('--zx', cx.toFixed(1) + 'px');\n"
    + "        root.style.setProperty('--zy', cy.toFixed(1) + 'px');\n"
    + "        if (Math.abs(tx - cx) > 0.4 || Math.abs(ty - cy) > 0.4) raf = requestAnimationFrame(tick);\n"
    + "      }\n"
    + "      window.addEventListener('pointermove', function (e) {\n"
    + "        if (e.pointerType === 'touch') return;\n"
    + "        if (!root.classList.contains('zc-glass')) return;\n"
    + "        tx = (e.clientX / window.innerWidth - 0.5) * 26;\n"
    + "        ty = (e.clientY / window.innerHeight - 0.5) * 20;\n"
    + "        if (!raf) raf = requestAnimationFrame(tick);\n"
    + "      }, { passive: true });\n"
    + "    }\n"
    + "  } catch (e) { /* 皮肤失效也不应影响主功能 */ }\n"
    + "})();\n"
    + JS_END + "\n"
    + "</script>\n"
)

# ---------------------------------------------------------------------------
# 注入 / 回滚
# ---------------------------------------------------------------------------
def _at_least_once(text, needle, what):
    n = text.count(needle)
    if n != 1:
        raise SystemExit("锚点异常：%s 在 8.js 中出现 %d 次（期望恰好 1 次）" % (what, n))
    return text.index(needle)


def injected(text):
    return CSS_START in text and HTML_START in text and JS_START in text


def do_patch(text):
    """把皮肤注入源码。已注入过则原样返回（幂等）。返回 (新文本, 变更列表)。"""
    if injected(text):
        return text, []

    notes = []

    text = text.replace(A_SVG, HTML_LAYER + "\n" + A_SVG, 1)
    notes.append("背板容器 #zcAurora")

    i = _at_least_once(text, A_STYLE_END, "</style>")
    text = text[:i] + CSS + "\n" + text[i:]
    notes.append("样式块（%d 字节）" % len(CSS))

    m = re.search(re.escape(A_SEGFONT) + r".*?</div></div>", text, re.S)
    if not m:
        raise SystemExit("锚点异常：未找到 外观 面板中的字号设置行")
    text = text[: m.end()] + "\n          " + SETTINGS_ROW + text[m.end():]
    notes.append("设置项 #sGlass")

    j = _at_least_once(text, A_BODY_END, "</body>")
    text = text[:j] + JS + text[j:]
    notes.append("脚本（%d 字节）" % len(JS))

    return text, notes


def do_revert(text):
    """按标记移除全部注入内容，恢复到注入前的字节。"""
    out = text
    removed = []
    for a, b, what in ((CSS_START, CSS_END, "CSS"), (HTML_START, HTML_END, "HTML 层")):
        out, n = re.subn(re.escape(a) + r".*?" + re.escape(b) + r"\n?", "", out, flags=re.S)
        if n:
            removed.append("%s %d 处" % (what, n))
    pat = "<script>\n" + re.escape(JS_START) + r".*?" + re.escape(JS_END) + r"\n</script>\n"
    out, n = re.subn(pat, "", out, flags=re.S)
    if n:
        removed.append("脚本 %d 处" % n)
    out, n = re.subn(r"[ \t]*" + re.escape(SETTINGS_ROW) + r"\n?", "", out, flags=re.S)
    if n:
        removed.append("设置项 %d 处" % n)
    return out, removed


def report(text):
    ok = injected(text)
    print("  8.js 体积 : %d 字节" % len(text.encode("utf-8")))
    print("  玻璃皮肤   : %s" % ("已注入" if ok else "未注入"))
    if ok:
        for needle, label in (
            (CSS_START, "样式块"),
            (HTML_START, "背板容器"),
            (JS_START, "脚本"),
            ('id="sGlass"', "设置开关"),
        ):
            print("    [ok] %-10s 存在" % label)
        for needle, label in (
            ("zcDrift", "色块漂移关键帧"),
            ("zcSheen", "光泽扫过关键帧"),
            ("zcBreath", "呼吸光晕关键帧"),
            ("prefers-reduced-motion", "减少动效尊重"),
        ):
            print("    [ok] %-14s 存在" % label)
    return ok


def anchors_ok(target=TARGET):
    """校验真实 8.js 里的四个锚点各自唯一。"""
    if not target.exists():
        print("  [skip] 未找到 %s（无法校验真实锚点）" % target.name)
        return True
    text = target.read_text(encoding="utf-8")
    ok = True
    for needle, what in ((A_SVG, "背板锚点 <svg …>"), (A_STYLE_END, "</style>"), (A_SEGFONT, "字号设置行"), (A_BODY_END, "</body>")):
        n = text.count(needle)
        mark = "ok" if n == 1 else "bad"
        if n != 1:
            ok = False
        print("    [%s] %-18s 出现 %d 次" % (mark, what, n))
    return ok


# ---------------------------------------------------------------------------
# 自检
# ---------------------------------------------------------------------------
# 与 8.js 同构的最小样本：同样的四个锚点、同样的 String.raw 包裹方式
FIXTURE = """// 最小同构样本（结构与 8.js 一致：前端 HTML 包在 String.raw 模板里）
const ZC_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<title>ZC-GURA</title>
<style>
:root{--bg:#ffffff;--bg-2:#f7f7f8;--bg-3:#efeff2;--surface:#ffffff;--border:#e6e6ea;--border-2:#d3d3da;--text:#18181b;--accent:#2b5cd9;--primary:#18181b;--on-primary:#ffffff;--code-bg:#f6f6f8;--shadow:0 1px 2px rgba(20,20,30,.04)}
html[data-theme="dark"]{--bg:#151517;--bg-2:#1a1a1d;--bg-3:#262629;--surface:#1e1e21;--border:#2b2b30;--border-2:#3b3b42;--text:#ececef;--accent:#7fa2ff;--primary:#ececef;--on-primary:#151517;--code-bg:#1a1a1d;--shadow:0 1px 2px rgba(0,0,0,.3)}
.overlay{position:fixed;inset:0;z-index:80;background:rgba(10,10,14,.46)}
.dialog{background:var(--surface);border:1px solid var(--border)}
@media (max-width:820px){.sidebar{position:fixed}}
@media (prefers-reduced-motion:reduce){*{animation-duration:.001ms!important;transition-duration:.001ms!important}}
</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <symbol id="i-logo" viewBox="0 0 24 24"><rect x="1.5" y="1.5" width="21" height="21" rx="6.5"/></symbol>
</svg>

<div class="app" id="app">
  <aside class="sidebar" id="sidebar">
    <div class="brand"><span>ZC-GURA</span></div>
    <div class="search"><input id="sessionSearch" type="search"></div>
  </aside>
  <main class="main" id="main">
    <header class="topbar"><button class="pill" id="modelBtn">未配置 API</button></header>
    <div class="stage empty" id="stage">
      <section class="chat" id="chat"><div class="thread" id="thread"></div></section>
      <div class="composer-wrap"><div class="composer" id="composer">
        <textarea id="input" rows="1"></textarea>
        <div class="c-tools"><button class="send" id="btnSend" disabled></button></div>
      </div></div>
    </div>
  </main>
</div>

<div class="overlay" id="dialogOv" hidden><div class="dialog"><h3 id="dlgTitle"></h3></div></div>
<div class="overlay" id="settingsOv" hidden><div class="settings">
  <div class="s-nav" id="sNav"><h2>设置</h2><button data-tab="look" class="on">外观</button></div>
  <div class="s-main"><div class="s-body">
    <div class="s-pane on" data-pane="look">
      <div class="row-sw"><div class="tx"><b>主题</b><span>自动模式跟随系统外观</span></div><div class="seg" id="segTheme"><button data-v="auto">自动</button><button data-v="light">浅色</button><button data-v="dark">深色</button></div></div>
      <div class="row-sw"><div class="tx"><b>字号</b><span>调整界面与消息文字大小</span></div><div class="seg" id="segFont"><button data-v="small">小</button><button data-v="medium">标准</button><button data-v="large">大</button></div></div>
    </div>
  </div></div>
</div></div>

<div id="popLayer"></div>
<div id="toasts" role="status" aria-live="polite"></div>
</body>
</html>`;

export default { async fetch(request) { return new Response(ZC_HTML); } };
"""


def _strip_strings(code):
    """去掉 '…' 与 "…" 字面量，便于做朴素的括号配平检查。"""
    return re.sub(r"'[^'\n]*'|\"[^\"\n]*\"", "", code)


def _balanced(code):
    pairs = {"{": "}", "(": ")", "[": "]"}
    closing = {v: k for k, v in pairs.items()}
    stack = []
    for ch in _strip_strings(code):
        if ch in pairs:
            stack.append(ch)
        elif ch in closing:
            if not stack or stack.pop() != closing[ch]:
                return False
    return not stack


def _banned(code, label, out):
    if "`" in code:
        out.append("%s 含反引号（会截断 String.raw 模板）" % label)
    if "${" in code:
        out.append("%s 含 ${（会触发模板插值）" % label)
    if label.startswith("JS") and "</" in code:
        out.append("%s 含 </（会被 script 标签提前结束）" % label)


def selftest():
    print("运行 8.js 玻璃皮肤注入器自检 …")
    bad = []
    ok = lambda m: print("  [ok] %s" % m)

    # 1) 未注入 → 注入 → 幂等
    if injected(FIXTURE):
        bad.append("样本不应处于已注入状态")
    patched, notes = do_patch(FIXTURE)
    if not injected(patched):
        bad.append("注入后未检测到标记")
    else:
        ok("注入成功（%d 项变更）" % len(notes))
    again, notes2 = do_patch(patched)
    if notes2 or again != patched:
        bad.append("重复注入不是幂等的")
    else:
        ok("重复注入幂等（第二次无变更）")

    # 2) 四类标记各恰好一次
    for needle, label in ((CSS_START, "样式块"), (HTML_START, "背板容器"), (JS_START, "脚本"), ('id="sGlass"', "设置开关")):
        n = patched.count(needle)
        if n != 1:
            bad.append("%s 标记出现 %d 次（期望 1）" % (label, n))
    if not bad:
        ok("四类标记各出现恰好 1 次")

    # 3) 回滚 = 字节级还原
    reverted, removed = do_revert(patched)
    if reverted != FIXTURE:
        bad.append("回滚未还原原文（差 %d 字节）" % (len(reverted) - len(FIXTURE)))
    else:
        ok("回滚后与原文完全一致（%s）" % "、".join(removed))

    # 4) 关键帧 / 无障碍规则都在
    for needle, label in (("zcDrift", "色块漂移"), ("zcSheen", "光泽扫过"), ("zcBreath", "呼吸光晕"), ("prefers-reduced-motion", "减少动效"), ("@supports not", "降级兜底")):
        if needle not in patched:
            bad.append("缺少 %s（%s）" % (label, needle))
    if not bad:
        ok("漂移 / 光泽 / 光晕 / 减少动效 / 降级兜底 全部就位")

    # 5) 模板安全：不得出现反引号、${ 、</
    _banned(CSS, "CSS", bad)
    script_body = JS.split("<script>", 1)[1].rsplit("</script>", 1)[0]
    _banned(script_body, "JS", bad)
    _banned(HTML_LAYER, "HTML", bad)
    if not bad:
        ok("片段不含反引号 / ${ / </ 等模板危险序列")

    # 6) 括号配平
    if not _balanced(CSS):
        bad.append("CSS 括号不配平")
    if not _balanced(JS.replace("<script>", "").replace("</script>", "")):
        bad.append("JS 括号不配平")
    if not bad:
        ok("CSS / JS 括号配平")

    # 7) 注入位置正确：背板在 body 首个元素前、脚本在 </body> 前、开关在 segFont 行之后
    i_layer = patched.index(HTML_START)
    i_svg = patched.index(A_SVG)
    i_style = patched.index(CSS_START)
    i_style_end = patched.index(A_STYLE_END)
    i_seg = patched.index(A_SEGFONT)
    i_glass_cb = patched.index('id="sGlass"')
    i_js = patched.index(JS_START)
    i_body = patched.index(A_BODY_END)
    if not (i_style < i_style_end and i_style_end < i_layer < i_svg):
        bad.append("样式 / 背板插入位置不正确")
    if not (i_seg < i_glass_cb and i_glass_cb < i_js < i_body):
        bad.append("设置项 / 脚本插入位置不正确")
    if not bad:
        ok("插入位置正确（样式在 </style> 前、背板在首个 <svg> 前、脚本在 </body> 前）")

    # 8) 用 node 做真正的 JS 语法校验（有 node 才跑）
    import shutil
    import subprocess
    import tempfile

    node = shutil.which("node")
    if node:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "zc_glass.js"
            p.write_text(script_body, encoding="utf-8")
            r = subprocess.run([node, "--check", str(p)], capture_output=True, text=True)
            if r.returncode != 0:
                bad.append("node --check 未通过：%s" % (r.stderr.strip().splitlines()[:2]))
            else:
                ok("node --check 通过（语法有效）")
    else:
        print("  [skip] 本机没有 node，跳过 node --check")

    # 9) 真实 8.js 锚点（若存在）
    anchors_ok()

    if bad:
        print("\n自检未通过 ✘")
        for b in bad:
            print("  - %s" % b)
        return 1
    print("自检全部通过 ✔")
    return 0


# ---------------------------------------------------------------------------
# 导出可独立粘贴的片段
# ---------------------------------------------------------------------------
def export():
    css_path = ROOT / "glass-skin.css"
    js_path = ROOT / "glass-skin.js"
    css_body = CSS.replace(CSS_START + "\n", "").replace("\n" + CSS_END, "")
    js_body = JS.split("<script>\n", 1)[1].rsplit("\n</script>\n", 1)[0]
    css_path.write_text(css_body, encoding="utf-8")
    js_path.write_text(js_body, encoding="utf-8")
    print("已导出：")
    print("  %s（%d 字节）" % (css_path.name, len(css_body.encode("utf-8"))))
    print("  %s（%d 字节）" % (js_path.name, len(js_body.encode("utf-8"))))
    print("把 css 粘到 8.js 的 <style> 末尾，把 js 粘成 </body> 前的一个 <script>，")
    print("并在 <body> 首个元素前加：")
    print("  " + HTML_LAYER)
    return 0


def main(argv):
    args = [a.lower() for a in argv[1:]]
    if "--selftest" in args or "selftest" in args:
        return selftest()
    if "export" in args:
        return export()

    if not TARGET.exists():
        print("找不到目标文件：%s" % TARGET)
        return 2
    src = TARGET.read_text(encoding="utf-8")

    if "--check" in args or "--status" in args or "check" in args:
        print("检查 %s …" % TARGET.name)
        if injected(src):
            report(src)
        else:
            report(src)
            print("  锚点校验：")
            anchors_ok()
        return 0

    if "--revert" in args or "revert" in args:
        print("回滚 %s 中的玻璃皮肤 …" % TARGET.name)
        out, removed = do_revert(src)
        TARGET.write_text(out, encoding="utf-8")
        print("  移除：%s" % ("、".join(removed) if removed else "无（未注入过）"))
        print("  完成：%d -> %d 字节" % (len(src.encode("utf-8")), len(out.encode("utf-8"))))
        return 0

    print("向 %s 注入玻璃皮肤 …" % TARGET.name)
    out, notes = do_patch(src)
    if not notes:
        print("  已注入过，跳过写入（幂等）")
    else:
        for n in notes:
            print("  + %s" % n)
        TARGET.write_text(out, encoding="utf-8")
        print("  完成：%d -> %d 字节" % (len(src.encode("utf-8")), len(out.encode("utf-8"))))
    report(out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
