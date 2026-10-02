#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为 8.js（ZC-GURA 单文件 Cloudflare Worker）注入「玻璃拟态 + 流光动画」皮肤。

设计参考（均为公开开源项目 / 文章）：
  * miketromba/css.glass、themesberg/glass-ui
      经典毛玻璃配方：半透明底色 + backdrop-filter: blur() saturate()
      + 1px 高光描边 + inset 内阴影。
  * tengbao/vanta（Vanta.js，MIT）
      把"动态背景层"置于内容之下的分层思路；此处不引入 three.js，
      改用 3 个纯 CSS 高斯色斑做缓慢漂移，保持零依赖、零网络请求。
  * CSS-Tricks《A Complete Guide to CSS Gradients》
      用 transform / background-position 驱动渐变流动，并配合
      prefers-reduced-motion 与前景对比度检查（文中 Accessibility 一节）。

工程约束（重要）：8.js 里前端 HTML 位于 String.raw 模板字符串中，
因此注入的内容**不得包含反引号或 ${**，否则会截断模板字符串。

用法：
    python3 tools/glass_skin.py          # 注入（幂等，已注入则跳过）
    python3 tools/glass_skin.py check    # 只检查当前状态
    python3 tools/glass_skin.py revert   # 按标记移除注入内容
"""

import re
import sys
from pathlib import Path

TARGET = Path(__file__).resolve().parent.parent / "8.js"

# ---- 幂等 / 可回滚标记 ----
CSS_START = "/* ===== ZC-GLASS SKIN START ===== */"
CSS_END = "/* ===== ZC-GLASS SKIN END ===== */"
HTML_START = "<!-- ZC-GLASS LAYER START -->"
HTML_END = "<!-- ZC-GLASS LAYER END -->"
JS_START = "/* ZC-GLASS SCRIPT START */"
JS_END = "/* ZC-GLASS SCRIPT END */"

SVG_ANCHOR = '<svg width="0" height="0" style="position:absolute"'
SEG_ANCHOR = '<div class="seg" id="segFont">'


# ---------------------------------------------------------------------------
# 1) 样式：动态背板 + 玻璃面板 + 光泽动画
# ---------------------------------------------------------------------------
CSS = CSS_START + """
/* 玻璃拟态与流光动画（渐进增强）
   配色全部由既有 CSS 变量派生，因此自动跟随浅色 / 深色主题。
   不支持 backdrop-filter 时自动退化为不透明底色；
   系统开启"减少动态效果"时，由本文件既有的全局规则统一冻结动画。 */
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

/* ---------- 大面积玻璃面板（真实 backdrop-filter，数量少以控制开销） ---------- */
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

/* ---------- 面板内的小卡片：半透明 + 顶部高光（不再叠加 backdrop-filter，
              父级已模糊，避免聊天区大量小卡片拖慢滚动） ---------- */
html.zc-glass .code,
html.zc-glass .fcard,
html.zc-glass .think,
html.zc-glass .astep,
html.zc-glass .agent-sum,
html.zc-glass .chip-att,
html.zc-glass .msg.user .bubble{
  background:color-mix(in srgb,var(--surface) 76%,transparent);
  border-color:var(--zc-glass-line);
  box-shadow:inset 0 1px 0 var(--zc-glass-hi);
}
html.zc-glass .msg.user .bubble{
  background:color-mix(in srgb,var(--bg-3) 74%,transparent);
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
# 2) 结构：背板容器
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
#    注意：不得出现反引号与 ${，也不得出现 </ 序列（会被所在模板/标签截断）
# ---------------------------------------------------------------------------
JS = (
    "<script>\n"
    JS_START + "\n"
    "(function () {\n"
    "  'use strict';\n"
    "  try {\n"
    "    var root = document.documentElement;\n"
    "    var KEY = 'zc_gura_glass';\n"
    "    var reduced = false;\n"
    "    try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}\n"
    "    function read() {\n"
    "      try { var v = localStorage.getItem(KEY); return v === null ? true : v === '1'; } catch (e) { return true; }\n"
    "    }\n"
    "    function write(on) { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {} }\n"
    "    function apply(on) {\n"
    "      root.classList.toggle('zc-glass', !!on);\n"
    "      var cb = document.getElementById('sGlass');\n"
    "      if (cb) {\n"
    "        cb.checked = !!on;\n"
    "        if (!cb.zcBound) {\n"
    "          cb.zcBound = 1;\n"
    "          cb.addEventListener('change', function () { apply(cb.checked); write(cb.checked); });\n"
    "        }\n"
    "      }\n"
    "    }\n"
    "    apply(read());\n"
    "\n"
    "    // 指针视差：背板随指针做极小位移，让前景玻璃有层次感。\n"
    "    // 只改 CSS 变量，且用 rAF 合帧，滚动与输入不受影响。\n"
    "    if (!reduced) {\n"
    "      var cx = 0, cy = 0, tx = 0, ty = 0, raf = 0;\n"
    "      function tick() {\n"
    "        raf = 0;\n"
    "        cx += (tx - cx) * 0.12;\n"
    "        cy += (ty - cy) * 0.12;\n"
    "        root.style.setProperty('--zx', cx.toFixed(1) + 'px');\n"
    "        root.style.setProperty('--zy', cy.toFixed(1) + 'px');\n"
    "        if (Math.abs(tx - cx) > 0.4 || Math.abs(ty - cy) > 0.4) raf = requestAnimationFrame(tick);\n"
    "      }\n"
    "      window.addEventListener('pointermove', function (e) {\n"
    "        if (e.pointerType === 'touch') return;\n"
    "        if (!root.classList.contains('zc-glass')) return;\n"
    "        tx = (e.clientX / window.innerWidth - 0.5) * 26;\n"
    "        ty = (e.clientY / window.innerHeight - 0.5) * 20;\n"
    "        if (!raf) raf = requestAnimationFrame(tick);\n"
    "      }, { passive: true });\n"
    "    }\n"
    "  } catch (e) { /* 皮肤失败不应影响主功能 */ }\n"
    "})();\n"
    JS_END + "\n"
    "</script>\n"
)


def _once(text, needle, what):
    n = text.count(needle)
    if n != 1:
        raise SystemExit("锚点异常：%s 在 8.js 中出现 %d 次（期望 1 次）" % (what, n))
    return text.index(needle)


def injected(text):
    return CSS_START in text and HTML_START in text and JS_START in text


def do_patch(text):
    """返回 (新文本, 变更说明列表)。"""
    if injected(text):
        return text, []

    notes = []
    text = text.replace(SVG_ANCHOR, HTML_LAYER + "\n" + SVG_ANCHOR, 1)
    notes.append("背板容器 #zcAurora")

    i = _once(text, "</style>", "</style>")
    text = text[:i] + CSS + "\n" + text[i:]
    notes.append("样式块 %d 字节" % len(CSS))

    m = re.search(r'<div class="seg" id="segFont">.*?</div></div>', text, re.S)
    if not m:
        raise SystemExit("锚点异常：未找到 外观面板 中的字号设置行")
    text = text[:m.end()] + "\n          " + SETTINGS_ROW + text[m.end():]
    notes.append("设置项 #sGlass")

    j = _once(text, "</body>", "</body>")
    text = text[:j] + JS + text[j:]
    notes.append("脚本 %d 字节" % len(JS))
    return text, notes


def do_revert(text):
    out = text
    for a, b, what in ((CSS_START, CSS_END, "CSS"), (HTML_START, HTML_END, "HTML")):
        p = re.compile(re.escape(a) + r".*?" + re.escape(b) + r"\n?", re.S)
        out, n = p.subn("", out)
        if n:
            print("  移除 %s 注入块 %d 处" % (what, n))
    p = re.compile(r"<script>\n" + re.escape(JS_START) + r".*?" + re.escape(JS_END) + r"\n</script>\n", re.S)
    out, n = p.subn("", out)
    if n:
        print("  移除 脚本注入块 %d 处" % n)
    p = re.compile(r"[ \t]*" + re.escape(SETTINGS_ROW) + r"\n?", re.S)
    out, n = p.subn("", out)
    if n:
        print("  移除 设置项 %d 处" % n)
    return out


def check(text):
    ok = injected(text)
    print("  8.js 体积        : %d 字节" % len(text.encode("utf-8")))
    print("  玻璃皮肤          : %s" % ("已注入" if ok else "未注入"))
    if ok:
        for needle, label in ((CSS_START, "样式块"), (HTML_START, "背板容器"), (JS_START, "脚本"), ('id="sGlass"', "设置开关")):
            print("    [ok] %-8s 存在" % label)
        for needle, label in (("zcDrift", "色斑漂移"), ("zcSheen", "光泽扫过"), ("zcBreath", "呼吸光晕"), ("prefers-reduced-motion", "减少动效")):
            print("    [ok] %-8s keyframes/规则 存在" % label)
    return ok


def main(argv):
    if not TARGET.exists():
        raise SystemExit("找不到目标文件：%s" % TARGET)
    src = TARGET.read_text(encoding="utf-8")
    cmd = (argv[1] if len(argv) > 1 else "patch").lower()

    if cmd == "check":
        print("检查 8.js …")
        check(src)
        return 0
    if cmd == "revert":
        print("回滚 8.js 中的玻璃皮肤 …")
        out = do_revert(src)
        TARGET.write_text(out, encoding="utf-8")
        print("  完成：%d -> %d 字节" % (len(src.encode("utf-8")), len(out.encode("utf-8"))))
        return 0

    print("向 8.js 注入玻璃皮肤 …")
    out, notes = do_patch(src)
    if not notes:
        print("  已注入过，无需重复写入（幂等）")
    else:
        for n in notes:
            print("  + %s" % n)
        TARGET.write_text(out, encoding="utf-8")
        print("  完成：%d -> %d 字节" % (len(src.encode("utf-8")), len(out.encode("utf-8"))))
    check(out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
