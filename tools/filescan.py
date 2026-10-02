#!/usr/bin/env python3
"""filescan —— 零依赖的目录扫描 / 重复文件查找小工具。

用法:
    python3 tools/filescan.py [目录] [选项]

功能:
    * 统计文件数量、总体积、按扩展名分布
    * 按内容 sha256 找出重复文件，并给出可回收空间
    * 支持 --json 输出，方便被其它程序调用
    * 自带 --selftest 自检，不需要外部测试数据

只用 Python 标准库，Python 3.8+ 即可运行，无需安装任何依赖。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from collections import Counter, defaultdict

CHUNK = 1 << 20  # 读取分块 1 MiB，避免大文件撑爆内存


def human(n: int) -> str:
    """把字节数格式化成人类可读的字符串。"""
    if n < 1024:
        return f"{int(n)} B"
    f = float(n)
    for unit in ("KB", "MB", "GB", "TB", "PB"):
        f /= 1024
        if f < 1024:
            return f"{f:.2f} {unit}"
    return f"{f:.2f} PB"


def iter_files(root: str, ignore_hidden: bool = False, min_size: int = 0):
    """遍历目录，产出 (路径, 字节数)。不跟随符号链接指向的目录。"""
    for dirpath, dirnames, filenames in os.walk(root):
        if ignore_hidden:
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            filenames = [f for f in filenames if not f.startswith(".")]
        for name in filenames:
            path = os.path.join(dirpath, name)
            try:
                if not os.path.isfile(path):
                    continue
                size = os.path.getsize(path)
            except OSError:
                continue  # 权限不足 / 文件刚刚消失，跳过即可
            if size < min_size:
                continue
            yield path, size


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(CHUNK)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def scan(root: str, ignore_hidden: bool = False, min_size: int = 0) -> dict:
    files = list(iter_files(root, ignore_hidden, min_size))
    total = sum(size for _, size in files)

    by_ext: Counter = Counter()
    for path, size in files:
        ext = os.path.splitext(path)[1].lower() or "<无扩展名>"
        by_ext[ext] += size

    # 体积不同的文件内容必然不同，只对同体积的候选做哈希
    by_size = defaultdict(list)
    for path, size in files:
        if size > 0:
            by_size[size].append(path)

    hashed = 0
    groups = []
    for size, paths in by_size.items():
        if len(paths) < 2:
            continue
        by_hash = defaultdict(list)
        for path in paths:
            try:
                by_hash[sha256_of(path)].append(path)
                hashed += 1
            except OSError:
                continue
        for digest, same in by_hash.items():
            if len(same) > 1:
                groups.append({"size": size, "sha256": digest, "paths": sorted(same)})

    # 按可回收空间从大到小排序
    groups.sort(key=lambda g: g["size"] * (len(g["paths"]) - 1), reverse=True)

    return {
        "root": os.path.abspath(root),
        "file_count": len(files),
        "total_bytes": total,
        "hashed_files": hashed,
        "duplicate_groups": groups,
        "duplicate_files": sum(len(g["paths"]) for g in groups),
        "reclaimable_bytes": sum(g["size"] * (len(g["paths"]) - 1) for g in groups),
        "by_extension": dict(by_ext.most_common()),
    }


def render(report: dict, top: int = 10) -> str:
    out = [
        f"扫描目录 : {report['root']}",
        f"文件数量 : {report['file_count']}",
        f"总体积   : {human(report['total_bytes'])}",
        f"哈希校验 : {report['hashed_files']} 个文件（同体积候选）",
        f"重复分组 : {len(report['duplicate_groups'])} 组 / "
        f"{report['duplicate_files']} 个文件",
        f"可回收   : {human(report['reclaimable_bytes'])}",
    ]
    ext_items = list(report["by_extension"].items())[:top]
    if ext_items:
        out.append("")
        out.append(f"体积占比 Top {len(ext_items)}:")
        for ext, size in ext_items:
            pct = size / report["total_bytes"] * 100 if report["total_bytes"] else 0.0
            out.append(f"  {ext:<14}{human(size):>10}  {pct:5.1f}%")

    for g in report["duplicate_groups"][:top]:
        out.append("")
        out.append(
            f"* {len(g['paths'])} 份 × {human(g['size'])}"
            f" (sha256 {g['sha256'][:12]}…)"
        )
        for path in g["paths"]:
            out.append(f"    {path}")
    return "\n".join(out)


def selftest() -> int:
    """在临时目录里造数据，验证核心逻辑。返回 0 表示全部通过。"""
    failures = []

    def check(name: str, ok: bool, extra="") -> None:
        print(f"  [{'ok' if ok else 'FAIL'}] {name}" + (f"  <- {extra}" if not ok else ""))
        if not ok:
            failures.append(name)

    print("运行内置自检 …")
    with tempfile.TemporaryDirectory() as tmp:
        os.makedirs(os.path.join(tmp, "sub", ".hidden"))

        def write(rel: str, data: bytes) -> str:
            path = os.path.join(tmp, rel)
            with open(path, "wb") as fh:
                fh.write(data)
            return path

        a = write("a.txt", b"hello" * 100)            # 500 B
        a_copy = write("sub/a_copy.txt", b"hello" * 100)  # 500 B，与 a 内容相同
        write("sub/b.bin", b"\x00\x01" * 5000)        # 10000 B，唯一
        write("sub/.hidden/secret.txt", b"secret")    # 隐藏目录
        write("empty1.txt", b"")
        write("empty2.txt", b"")                      # 空文件：不算重复
        write("uniq.log", b"unique")

        rep = scan(tmp)
        check("扫描到 7 个文件", rep["file_count"] == 7, rep["file_count"])
        check("总体积 11012 B", rep["total_bytes"] == 11012, rep["total_bytes"])
        check("识别出 1 组重复", len(rep["duplicate_groups"]) == 1,
              rep["duplicate_groups"])
        if rep["duplicate_groups"]:
            g = rep["duplicate_groups"][0]
            check("重复组正是 a.txt 与其副本",
                  set(g["paths"]) == {a, a_copy}, g["paths"])
        check("空文件不参与重复判定", rep["duplicate_files"] == 2,
              rep["duplicate_files"])
        check("可回收空间 = 500 B", rep["reclaimable_bytes"] == 500,
              rep["reclaimable_bytes"])

        hidden = scan(tmp, ignore_hidden=True)
        check("--ignore-hidden 后只剩 6 个文件", hidden["file_count"] == 6,
              hidden["file_count"])

        big = scan(tmp, min_size=1000)
        check("--min-size 1000 只剩 1 个文件", big["file_count"] == 1,
              big["file_count"])
        check("过滤后无重复", big["duplicate_groups"] == [])

        check("human(0) == '0 B'", human(0) == "0 B", human(0))
        check("human(1024) == '1.00 KB'", human(1024) == "1.00 KB", human(1024))
        check("human(11012) == '10.75 KB'", human(11012) == "10.75 KB",
              human(11012))

        json.loads(json.dumps(rep, ensure_ascii=False))
        check("报告可被 JSON 序列化/反序列化", True)

        rendered = render(rep)
        check("文本报告包含重复文件路径", a in rendered and a_copy in rendered)

    if failures:
        print(f"自检失败 {len(failures)} 项：{failures}")
        return 1
    print("自检全部通过 ✔")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="filescan", description="零依赖目录扫描 / 重复文件查找工具"
    )
    parser.add_argument("path", nargs="?", default=".", help="要扫描的目录（默认当前目录）")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出完整报告")
    parser.add_argument("--min-size", type=int, default=0, metavar="N",
                        help="忽略小于 N 字节的文件")
    parser.add_argument("--ignore-hidden", action="store_true",
                        help="跳过以 . 开头的文件和目录")
    parser.add_argument("--top", type=int, default=10,
                        help="每类最多显示多少条（默认 10）")
    parser.add_argument("--selftest", action="store_true", help="运行内置自检并退出")
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()

    if not os.path.isdir(args.path):
        print(f"错误：{args.path} 不是目录", file=sys.stderr)
        return 2

    report = scan(args.path, ignore_hidden=args.ignore_hidden,
                  min_size=args.min_size)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(render(report, top=args.top))
    return 0


if __name__ == "__main__":
    sys.exit(main())
