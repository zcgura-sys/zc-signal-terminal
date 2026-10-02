#!/usr/bin/env python3
"""fetch_models —— 把 Haru / Shizuku 两套 Live2D 示例模型落到本地目录，并逐个校验。

用法:
    python3 tools/fetch_models.py                 # 下到 storage/emulated/0/工作区/models
    python3 tools/fetch_models.py --verify        # 只校验已有文件，不联网
    python3 tools/fetch_models.py --dry-run       # 只列出将要下载的文件
    python3 tools/fetch_models.py --only haru     # 只处理其中一个模型
    python3 tools/fetch_models.py --dest /sdcard/工作区/models
    python3 tools/fetch_models.py --selftest      # 内置自检，完全离线

校验三层:
    1) 字节数         必须与清单一致
    2) git blob sha1  sha1(b"blob <size>\\0" + content)，与上游 git 对象逐字节一致
    3) magic 文件头   png / moc3 / moc / mp3 再确认二进制头没被改坏

清单: storage/emulated/0/工作区/models/_manifest.json（66 文件 / 9,929,134 字节）。
只依赖 Python 标准库，Python 3.8+ 可运行。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

MANIFEST_NAME = "_manifest.json"
TIMEOUT = 30
RETRIES = 3
UA = "fetch-models/1.0 (+stdlib urllib)"

# 扩展名 -> 期望的文件头（按后缀长度优先匹配，.moc3 不会落到 .moc 上）
MAGIC = {
    ".png": b"\x89PNG\r\n\x1a\n",
    ".moc3": b"MOC3",
    ".moc": b"moc",
    ".mp3": b"ID3",
}

DEFAULT_DEST = (
    Path(__file__).resolve().parent.parent
    / "storage"
    / "emulated"
    / "0"
    / "工作区"
    / "models"
)


# --------------------------------------------------------------------------- #
# 校验基础件
# --------------------------------------------------------------------------- #
def git_blob_sha1(data: bytes) -> str:
    """计算 git blob 对象的 sha1，与 `git hash-object` 的输出一致。"""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def magic_of(path: Path) -> "bytes | None":
    """该文件需要检查的 magic；不需要检查（纯文本类）返回 None。"""
    name = path.name.lower()
    for ext in (".moc3", ".png", ".moc", ".mp3"):
        if name.endswith(ext):
            return MAGIC[ext]
    return None


def check_file(path: Path, size: int, sha1: str):
    """校验单个文件，返回 (是否通过, 说明)。"""
    if not path.is_file():
        return False, "缺失"
    actual = path.stat().st_size
    if actual != size:
        return False, f"字节数不符 期望 {size} 实得 {actual}"
    data = path.read_bytes()
    got = git_blob_sha1(data)
    if got != sha1:
        return False, f"sha1 不符 期望 {sha1[:12]}… 实得 {got[:12]}…"
    want = magic_of(path)
    if want is not None and not data.startswith(want):
        return False, f"magic 不符 期望 {want!r} 实得 {data[:8]!r}"
    return True, "ok"


# --------------------------------------------------------------------------- #
# 清单 / 网络
# --------------------------------------------------------------------------- #
def load_manifest(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data.get("models"), dict) or not data["models"]:
        raise ValueError("清单缺少 models 字段")
    if not str(data.get("raw_base", "")).startswith("http"):
        raise ValueError("清单缺少 raw_base")
    return data


def iter_entries(manifest: dict, model: str = ""):
    """产出 (模型名, 相对路径, 字节数, sha1, 完整 URL)。"""
    base = manifest["raw_base"].rstrip("/")
    for name, spec in manifest["models"].items():
        if model and name != model:
            continue
        for rel, size, sha1 in spec["files"]:
            yield name, rel, int(size), sha1, f"{base}/{name}/{rel}"


def fetch_bytes(url: str) -> bytes:
    """带重试的 GET，返回响应体；非 200 视为失败。"""
    last = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                if resp.status != 200:
                    raise urllib.error.HTTPError(
                        url, resp.status, "unexpected status", resp.headers, None
                    )
                return resp.read()
        except Exception as exc:  # 网络抖动 / 5xx / 半截响应，退避重试
            last = exc
            if attempt < RETRIES:
                time.sleep(1.5 * attempt)
    raise RuntimeError(f"{RETRIES} 次尝试均失败: {last}")


def download_one(dest: Path, model: str, rel: str, size: int, sha1: str, url: str):
    """下载并校验一个文件，返回 (模型, 相对路径, 状态, 说明)。"""
    target = dest / model / rel

    if target.is_file() and target.stat().st_size == size:
        ok, _detail = check_file(target, size, sha1)
        if ok:
            return model, rel, "skip", "已存在且校验通过"

    for attempt in (1, 2):
        try:
            data = fetch_bytes(url)
        except Exception as exc:
            return model, rel, "fail", f"下载失败: {exc}"

        got = git_blob_sha1(data)
        if len(data) != size or got != sha1:
            if attempt == 1:
                continue  # 可能是 CDN 半截响应，再试一次
            return model, rel, "fail", (
                f"内容校验不过 期望 {size}B/{sha1[:12]}… 实得 {len(data)}B/{got[:12]}…"
            )

        want = magic_of(Path(rel))
        if want is not None and not data.startswith(want):
            return model, rel, "fail", f"magic 不符 实得 {data[:8]!r}"

        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".part")
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, target)  # 原子落盘，中断不会留半成品
        return model, rel, "ok", f"{size} B"

    return model, rel, "fail", "未预期的分支"


# --------------------------------------------------------------------------- #
# 运行模式
# --------------------------------------------------------------------------- #
def run_download(dest: Path, manifest: dict, model: str, jobs: int, dry: bool) -> int:
    entries = list(iter_entries(manifest, model))
    if not entries:
        print(f"错误：清单里没有模型 {model!r}", file=sys.stderr)
        return 2

    total = sum(e[2] for e in entries)
    print(f"目标目录 : {dest}")
    print(f"待处理   : {len(entries)} 个文件 / {total} 字节")
    if dry:
        for name, rel, size, sha1, _url in entries:
            print(f"  {name}/{rel:<44} {size:>9} B  {sha1[:12]}…")
        print("（--dry-run，未下载任何文件）")
        return 0

    dest.mkdir(parents=True, exist_ok=True)
    counts = {"ok": 0, "skip": 0, "fail": 0}
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = [pool.submit(download_one, dest, *e) for e in entries]
        for done, fut in enumerate(concurrent.futures.as_completed(futures), 1):
            name, rel, status, detail = fut.result()
            counts[status] += 1
            if status == "fail":
                failures.append(f"{name}/{rel}: {detail}")
                print(f"  [{done:>2}/{len(entries)}] FAIL {name}/{rel} <- {detail}")
            elif status == "skip":
                print(f"  [{done:>2}/{len(entries)}] skip {name}/{rel}")
            else:
                print(f"  [{done:>2}/{len(entries)}] ok   {name}/{rel}  {detail}")

    print()
    print(f"完成: 新下载 {counts['ok']} / 已存在 {counts['skip']} / 失败 {counts['fail']}")
    if failures:
        print("失败明细:")
        for line in failures:
            print(f"  - {line}")
        return 1
    print("全部通过三层校验（字节数 + git blob sha1 + magic）✔")
    return 0


def run_verify(dest: Path, manifest: dict, model: str) -> int:
    entries = list(iter_entries(manifest, model))
    bad = []
    for name, rel, size, sha1, _url in entries:
        ok, detail = check_file(dest / name / rel, size, sha1)
        if not ok:
            bad.append(f"{name}/{rel}: {detail}")
    print(f"校验目录 : {dest}")
    print(f"通过     : {len(entries) - len(bad)} / {len(entries)}")
    for line in bad:
        print(f"  FAIL {line}")
    if bad:
        return 1
    print("全部通过 ✔")
    return 0


def selftest() -> int:
    """离线自检：验证 hash 算法与清单自洽。返回 0 表示全部通过。"""
    failures = []

    def check(name: str, ok: bool, extra="") -> None:
        print(f"  [{'ok' if ok else 'FAIL'}] {name}" + (f"  <- {extra}" if not ok else ""))
        if not ok:
            failures.append(name)

    print("运行内置自检 …")

    # 1) blob sha1 与 git 官方已知值对齐
    for label, data, expected in [
        ("空 blob", b"", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"),
        ("b'abc'", b"abc", "f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f"),
        ("b'hello world\\n'", b"hello world\n",
         "3b18e512dba79e4c8300dd08aeb37f8e728b8dad"),
    ]:
        got = git_blob_sha1(data)
        check(f"git blob sha1({label})", got == expected, got)

    # 2) magic 表与后缀判定
    check("magic: png", MAGIC[".png"] == b"\x89PNG\r\n\x1a\n")
    check("magic: moc3", MAGIC[".moc3"] == b"MOC3")
    check("magic: moc", MAGIC[".moc"] == b"moc")
    check("magic: mp3", MAGIC[".mp3"] == b"ID3")
    check("magic_of 后缀判定正确",
          magic_of(Path("a.moc3")) == MAGIC[".moc3"]
          and magic_of(Path("a.moc")) == MAGIC[".moc"]
          and magic_of(Path("a.png")) == MAGIC[".png"]
          and magic_of(Path("a.mp3")) == MAGIC[".mp3"]
          and magic_of(Path("a.json")) is None)

    # 3) check_file 在真实字节上的行为
    with tempfile.TemporaryDirectory() as tmp:
        fake = Path(tmp) / "x.moc3"
        payload = b"MOC3" + b"\x00" * 20
        fake.write_bytes(payload)
        want_sha = git_blob_sha1(payload)
        check("check_file 接受正确文件",
              check_file(fake, len(payload), want_sha)[0])
        check("check_file 检出 size 不符",
              not check_file(fake, len(payload) + 1, want_sha)[0])
        check("check_file 检出 sha 不符",
              not check_file(fake, len(payload), "0" * 40)[0])
        fake.write_bytes(b"XXXX" + b"\x00" * 20)
        check("check_file 检出 magic 不符",
              not check_file(fake, len(payload), git_blob_sha1(fake.read_bytes()))[0])
        check("check_file 检出缺失文件",
              not check_file(Path(tmp) / "nope.png", 1, "0" * 40)[0])

    # 4) 清单自洽
    mpath = DEFAULT_DEST / MANIFEST_NAME
    if not mpath.is_file():
        print(f"  [skip] 未找到清单 {mpath}，跳过清单校验")
    else:
        man = load_manifest(mpath)
        files = list(iter_entries(man))
        rels = [(f[0], f[1]) for f in files]
        check("清单 66 个文件", len(files) == 66, len(files))
        check("haru 19 个文件", len(list(iter_entries(man, "haru"))) == 19)
        check("shizuku 47 个文件", len(list(iter_entries(man, "shizuku"))) == 47)
        total = sum(f[2] for f in files)
        check("总字节 9929134", total == 9929134, total)
        check("清单声明与实算一致",
              man["total_files"] == len(files) and man["total_bytes"] == total)
        check("相对路径无重复", len(set(rels)) == len(rels))
        check("相对路径无越界(..)",
              all(".." not in r and not r.startswith("/") for _n, r in rels))
        check("sha1 均为 40 位十六进制",
              all(len(f[3]) == 40 and all(c in "0123456789abcdef" for c in f[3])
                  for f in files))
        check("每个文件大小 > 0", all(f[2] > 0 for f in files))
        check("haru 入口存在",
              any(f[1] == man["models"]["haru"]["entry"] for f in files))
        check("shizuku 入口存在",
              any(f[1] == man["models"]["shizuku"]["entry"] for f in files))
        check("两套运行时标注正确",
              man["models"]["haru"]["runtime"] == "cubism4"
              and man["models"]["shizuku"]["runtime"] == "cubism2")
        check("两个模型各含 moc/moc3",
              any(f[1].endswith(".moc3") for f in files if f[0] == "haru")
              and any(f[1].endswith(".moc") for f in files if f[0] == "shizuku"))

    if failures:
        print(f"自检失败 {len(failures)} 项：{failures}")
        return 1
    print("自检全部通过 ✔")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_models", description="抓取并校验 Haru / Shizuku Live2D 示例模型"
    )
    parser.add_argument("--dest", type=Path, default=DEFAULT_DEST,
                        help=f"目标目录（默认 {DEFAULT_DEST}）")
    parser.add_argument("--manifest", type=Path, default=None,
                        help="清单路径（默认 <dest>/_manifest.json）")
    parser.add_argument("--only", default="", choices=["", "haru", "shizuku"],
                        help="只处理指定模型")
    parser.add_argument("--jobs", type=int, default=6, help="并发下载数（默认 6）")
    parser.add_argument("--dry-run", action="store_true", help="只列出，不下载")
    parser.add_argument("--verify", action="store_true", help="只校验已有文件")
    parser.add_argument("--selftest", action="store_true", help="运行内置自检并退出")
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()

    mpath = args.manifest or (args.dest / MANIFEST_NAME)
    if not mpath.is_file():
        print(f"错误：找不到清单 {mpath}", file=sys.stderr)
        print("请在仓库根目录运行，或用 --manifest 指定清单路径。", file=sys.stderr)
        return 2

    try:
        manifest = load_manifest(mpath)
    except Exception as exc:
        print(f"错误：清单无法解析 ({exc})", file=sys.stderr)
        return 2

    if args.verify:
        return run_verify(args.dest, manifest, args.only)
    return run_download(args.dest, manifest, args.only, max(1, args.jobs),
                        args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
