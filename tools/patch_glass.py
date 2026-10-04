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
    assert src.count(STYLE_ANCHOR) == 1, 'style 结束标签数量异常: %s' % src.count(STYLE_ANCHOR)
    assert src.count(JS_ANCHOR) == 1, 'Toast 锚点数量异常: %s' % src.count(JS_ANCHOR)

    if MARKER in src:
        print('[skip] 7.js 已包含液态玻璃代码，无需重复注入')
        return 0

    src = src.replace(STYLE_ANCHOR, css.rstrip('\n') + '\n' + STYLE_ANCHOR, 1)
    src = src.replace(JS_ANCHOR, js.rstrip('\n') + '\n\n' + JS_ANCHOR, 1)

    assert MARKER in src and 'zcGlassLight' in src, '注入后校验失败'
    assert src.count(STYLE_ANCHOR) == 1 and src.count(JS_ANCHOR) == 1, '注入破坏了锚点'

    write(TARGET, src)
    print('[ok] 已把液态玻璃 CSS（%d 字符）与 JS（%d 字符）注入 7.js' % (len(css), len(js)))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except AssertionError as e:
        print('[FAIL] %s' % e, file=sys.stderr)
        sys.exit(1)
