#!/usr/bin/env python3
# 把液态玻璃（Liquid Glass）样式与光照脚本注入 7.js（幂等：已注入则跳过）。
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, '7.js')
CSS_FILE = os.path.join(ROOT, 'tools', 'glass.css')
JS_FILE = os.path.join(ROOT, 'tools', 'glass.js')

STYLE_ANCHOR = '</style>'
JS_ANCHOR = '/* ---------- Toast ---------- */'
MARKER = '液态玻璃（Liquid Glass）· 参考的开源实现'


def read(p):
    with io.open(p, encoding='utf-8', newline='') as f:
        return f.read()


def write(p, s):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s)


def main():
    src = read(TARGET)
    css = read(CSS_FILE)
    js = read(JS_FILE)

    # 1) 注入内容不能破坏 String.raw`...` 模板与 HTML
    for name, block in (('glass.css', css), ('glass.js', js)):
        assert '`' not in block, '%s 含有反引号，会截断模板字符串' % name
        assert '${' not in block, '%s 含有 ${ ，会被模板字符串求值' % name
        assert '</script>' not in block.lower(), '%s 含有 </script>' % name

    # 2) 注入点必须唯一
    # 文件里有两处 </style>：管理页 ZC_ADMIN_HTML + 主页 ZC_HTML；只注入最后一处
    assert src.count(STYLE_ANCHOR) == 2, 'style 结束标签数量异常: %s' % src.count(STYLE_ANCHOR)
    assert src.count(JS_ANCHOR) == 1, 'Toast 锚点数量异常: %s' % src.count(JS_ANCHOR)

    if MARKER in src:
        print('[skip] 7.js 已包含液态玻璃代码，无需重复注入')
        return 0

    # 注入到 ZC_HTML 的样式块（最后一处 </style>）
    html_i = src.find('const ZC_HTML = String.raw')
    assert html_i > 0, '未定位到 ZC_HTML 模板'
    style_i = src.rfind(STYLE_ANCHOR)
    assert style_i > html_i, '最后一处 </style> 不在 ZC_HTML 内'
    assert STYLE_ANCHOR not in css and JS_ANCHOR not in css, 'glass.css 含有注入锚点'
    assert JS_ANCHOR not in js, 'glass.js 含有注入锚点'

    src = src[:style_i] + css.rstrip('\n') + '\n' + STYLE_ANCHOR + src[style_i + len(STYLE_ANCHOR):]
    src = src.replace(JS_ANCHOR, js.rstrip('\n') + '\n\n' + JS_ANCHOR, 1)

    assert MARKER in src and 'zcGlassLight' in src, '注入后校验失败'
    assert src.count(STYLE_ANCHOR) == 2 and src.count(JS_ANCHOR) == 1, '注入破坏了锚点'
    assert src.rfind(MARKER) < src.rfind(STYLE_ANCHOR), 'CSS 未注入到 ZC_HTML 样式块内'

    write(TARGET, src)
    print('[ok] 已把液态玻璃 CSS（%d 字符）与 JS（%d 字符）注入 7.js' % (len(css), len(js)))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except AssertionError as e:
        print('[FAIL] %s' % e, file=sys.stderr)
        sys.exit(1)
