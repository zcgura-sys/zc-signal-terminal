#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第十一层：section 级语义取证。

A. __objc_classname / __objc_methname 精确 dump：回答"注入组件到底是一层什么"
   —— HUD/外挂层（ESP/透视/自瞄）还是卡密层（activate/license）
B. NOBLEKEY / activate / activation / license 关键字上下文窗口（ASCII + UTF-16LE ±160B）
C. enumeratoratpath: 的宿主与邻接选择器：判定"文件遍历"是系统行为还是窃密行为
D. libxpf.dylib 导出符号 + AMFI / trust_cache / pmap 邻接面：白苹果风险定级依据
E. 风险定级（0-5 级）与判定矩阵

零依赖。产物 logs/audit/deep11.txt
"""
import os
import struct

LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
PAY = os.path.join(LAB, "Payload")
OUT = os.path.join(os.environ.get("GITHUB_WORKSPACE", "."), "logs", "audit")
os.makedirs(OUT, exist_ok=True)

THIN64 = b"\xcf\xfa\xed\xfe"
THIN32 = b"\xce\xfa\xed\xfe"
FAT32 = b"\xca\xfe\xba\xbe"
FAT64 = b"\xca\xfe\xba\xbf"

LC_SEGMENT = 0x1
LC_SEGMENT_64 = 0x19
LC_SYMTAB = 0x2

SEC_OBJC_CLASS = b"__objc_classname"
SEC_OBJC_METH = b"__objc_methname"
SEC_CSTRING = b"__cstring"
SEC_OBJC_DATA = b"__objc_data"
SEC_CONST = b"__const"


def cpu_name(t):
    return {0x0100000C: "arm64", 0x01000007: "x86_64",
            12: "arm", 7: "i386"}.get(t, "cpu%x" % t)


def cstr(data, off, limit=400):
    if off < 0 or off >= len(data):
        return ""
    end = data.find(b"\x00", off, min(off + limit, len(data)))
    if end < 0:
        end = min(off + limit, len(data))
    return data[off:end].decode("utf-8", "replace")


def load_commands(data):
    if len(data) < 32:
        return []
    is64 = data[:4] == THIN64
    ncmds = struct.unpack_from("<I", data, 16)[0]
    off = 32 if is64 else 28
    out = []
    for _ in range(min(ncmds, 8192)):
        if off + 8 > len(data):
            break
        cmd, cmdsize = struct.unpack_from("<II", data, off)
        if cmdsize < 8 or off + cmdsize > len(data):
            break
        out.append((cmd, off, cmdsize))
        off += cmdsize
    return out


def sections(data):
    """返回 [(sectname, segname, file_off, size)]，兼容 32/64 位。"""
    is64 = data[:4] == THIN64
    out = []
    for cmd, off, cmdsize in load_commands(data):
        if is64 and cmd == LC_SEGMENT_64:
            if off + 72 > len(data):
                continue
            nsects = struct.unpack_from("<I", data, off + 64)[0]
            base = off + 72
            ent, szo = 16, 80
        elif not is64 and cmd == LC_SEGMENT:
            if off + 56 > len(data):
                continue
            nsects = struct.unpack_from("<I", data, off + 48)[0]
            base = off + 56
            ent, szo = 16, 68
        else:
            continue
        for i in range(min(nsects, 512)):
            so = base + i * szo
            if so + szo > len(data):
                break
            sname = data[so:so + 16].rstrip(b"\x00")
            gname = data[so + 16:so + 32].rstrip(b"\x00")
            if is64:
                foff = struct.unpack_from("<I", data, so + 48)[0]
                size = struct.unpack_from("<Q", data, so + 40)[0]
            else:
                foff = struct.unpack_from("<I", data, so + 40)[0]
                size = struct.unpack_from("<I", data, so + 36)[0]
            out.append((sname, gname, foff, size))
    return out


def section_strings(data, target, minlen=3):
    """按 section 精确切 strings，避免全量 strings 的跨段碎片误判。"""
    res = []
    for sname, _g, foff, size in sections(data):
        if sname != target:
            continue
        if foff <= 0 or foff + size > len(data):
            continue
        blob = data[foff:foff + size]
        for chunk in blob.split(b"\x00"):
            if len(chunk) >= minlen:
                res.append(chunk.decode("utf-8", "replace"))
    return res


def symtab(data):
    is64 = data[:4] == THIN64
    for cmd, off, _ in load_commands(data):
        if cmd == LC_SYMTAB and off + 24 <= len(data):
            symoff, nsyms, stroff, strsize = struct.unpack_from("<IIII", data, off + 8)
            entsz = 16 if is64 else 12
            if symoff + nsyms * entsz > len(data) or stroff + strsize > len(data):
                return []
            names = []
            for i in range(min(nsyms, 400000)):
                base = symoff + i * entsz
                n_strx = struct.unpack_from("<I", data, base)[0]
                s = cstr(data, stroff + n_strx, 512)
                if s:
                    names.append(s)
            return names
    return []


def exports(data, all_syms):
    is64 = data[:4] == THIN64
    entsz = 16 if is64 else 12
    res = []
    for cmd, off, _ in load_commands(data):
        if cmd == LC_SYMTAB and off + 24 <= len(data):
            symoff, nsyms = struct.unpack_from("<II", data, off + 8)
            for i in range(min(nsyms, 400000)):
                base = symoff + i * entsz
                if base + entsz > len(data):
                    break
                n_type = data[base + 4]
                if n_type & 0x0E == 0x0E or n_type & 0x01 == 0:
                    continue
                idx = struct.unpack_from("<I", data, base)[0]
                stroff = struct.unpack_from("<IIII", data, off + 8)[2]
                s = cstr(data, stroff + idx, 512)
                if s:
                    res.append(s)
    return res


def slices_of(data):
    if data[:4] == THIN64:
        return [(cpu_name(struct.unpack_from("<I", data, 4)[0]), 0, len(data))]
    if data[:4] != FAT32:
        return []
    n = struct.unpack_from(">I", data, 4)[0]
    out = []
    for i in range(min(n, 32)):
        eo = 8 + i * 20
        if eo + 20 > len(data):
            break
        ct, _cs, of, sz, _al = struct.unpack_from(">IIIII", data, eo)
        out.append((cpu_name(ct), of, sz))
    return out


def ctx_windows(data, needle, radius=160, limit=6, wide=True):
    """命中位置 ±radius 的可打印上下文。返回 [(offset, kind, text)]"""
    hits = []
    pats = [(needle.encode(), "ascii")]
    if wide:
        pats.append((needle.encode("utf-16-le"), "utf16le"))
    for pat, kind in pats:
        start = 0
        while len(hits) < limit * 3:
            p = data.find(pat, start)
            if p < 0:
                break
            lo = max(0, p - radius)
            hi = min(len(data), p + len(pat) + radius)
            win = data[lo:hi]
            txt = "".join(chr(b) if 32 <= b < 127 else "." for b in win)
            hits.append((p, kind, txt))
            start = p + 1
            if len(hits) >= limit * 3:
                break
    return hits[:limit]


def main():
    buf = []
    W = buf.append
    W("=" * 78)
    W("第十一层：section 级语义取证（类名 / 卡密上下文 / 文件遍历宿主 / AMFI 面）")
    W("=" * 78)

    targets = []
    for dirpath, _d, files in os.walk(PAY):
        for fn in files:
            p = os.path.join(dirpath, fn)
            try:
                with open(p, "rb") as f:
                    h = f.read(4)
            except OSError:
                continue
            if h in (THIN64, THIN32, FAT32, FAT64):
                targets.append((os.path.relpath(p, os.path.dirname(PAY)), p))
    targets.sort()

    # 只要 arm64 主切片，避免重复
    blob = {}
    for rel, p in targets:
        with open(p, "rb") as f:
            data = f.read()
        sl = slices_of(data)
        pick = None
        for cpu, of, sz in sl:
            if cpu == "arm64" and of + sz <= len(data):
                pick = data[of:of + sz]
                break
        if pick is None and data[:4] == THIN64:
            pick = data
        if pick:
            blob[rel] = pick

    # ---------------------------------------------- A. ObjC 类名精确 dump
    W("")
    W("# A. __objc_classname 精确 dump（判定注入组件的行为层归属）")
    W("=" * 78)
    class_owner = {}
    for rel in sorted(blob):
        names = section_strings(blob[rel], SEC_OBJC_CLASS)
        if not names:
            continue
        uniq = sorted(set(names))
        W("")
        W("  [%s] 类名 %d 个" % (rel.split("/")[-1], len(uniq)))
        for n in uniq[:120]:
            W("     %s" % n)
            class_owner.setdefault(n, set()).add(rel.split("/")[-1])
        if len(uniq) > 120:
            W("     ... 另有 %d 个" % (len(uniq) - 120))

    # ---------------------------------------------- B. 卡密上下文窗口
    W("")
    W("=" * 78)
    W("# B. 卡密/授权关键字上下文窗口（±160B，ASCII + UTF-16LE）")
    W("=" * 78)
    KEYS = ["NOBLEKEY", "activate", "activation", "license", "machineCode",
            "deviceCode", "expire", "trial"]
    found_any = False
    for key in KEYS:
        for rel in sorted(blob):
            wins = ctx_windows(blob[rel], key, radius=160, limit=4)
            for off, kind, txt in wins:
                found_any = True
                W("")
                W("  -- %s @ %s +0x%x [%s]" % (key, rel.split("/")[-1], off, kind))
                W("     %s" % txt)
    if not found_any:
        W("  未命中")

    # ---------------------------------------------- C. 文件遍历宿主
    W("")
    W("=" * 78)
    W("# C. 文件系统遍历（enumeratoratpath:）宿主与邻接面")
    W("=" * 78)
    for rel in sorted(blob):
        syms = symtab(blob[rel])
        sels = [s for s in syms if "enumerator" in s.lower()
                or "contentsOfDirectory" in s or "subpathsOfDirectory" in s]
        if not sels:
            continue
        W("")
        W("  [%s]" % rel.split("/")[-1])
        for s in sorted(set(sels)):
            W("     sel %s" % s)
        near = [s for s in syms if any(k in s.lower() for k in
                ("upload", "zip", "compress", "httpbody", "headerfield", "archive"))]
        W("     邻接能力符号 %d 个：" % len(set(near)))
        for s in sorted(set(near))[:20]:
            W("        %s" % s)
        # 该类所在的类名（methname 里找宿主类）
        owners = [c for c in class_owner if "file" in c.lower()
                  or "path" in c.lower() or "zip" in c.lower()]
        if owners:
            W("     相关类名：%s" % ", ".join(sorted(owners)[:12]))

    # ---------------------------------------------- D. libxpf AMFI 面
    W("")
    W("=" * 78)
    W("# D. libxpf.dylib / libjailbreak.dylib 导出符号与内核面")
    W("=" * 78)
    for rel in sorted(blob):
        base = rel.split("/")[-1]
        if not base.startswith(("libxpf", "libjailbreak", "libchoma")):
            continue
        data = blob[rel]
        exp = exports(data, None)
        W("")
        W("  [%s] 导出符号 %d 个" % (base, len(exp)))
        hi = [s for s in exp if any(k in s.lower() for k in
              ("amfi", "trust", "pmap", "kread", "kwrite", "patch", "hook",
               "inject", "sign", "cs_", "entitle"))]
        for s in sorted(set(hi))[:40]:
            W("     %s" % s)
        if len(set(hi)) > 40:
            W("     ... 另有 %d 个" % (len(set(hi)) - 40))

    # ---------------------------------------------- E. 定级
    W("")
    W("=" * 78)
    W("# E. 风险定级")
    W("=" * 78)
    W("  说明：定级基于「能力存在」而非「已执行」。静态证据只能证明代码可达，")
    W("        不能证明运行时被调用；但白苹果（boot 失败）风险来自内核写能力本身。")
    W("")
    W("  L5 灾难级：内核读写 + AMFI patch + 启动链写入")
    W("  L4 高危  ：内核读写 或 签名绕过（可 Lead 到 L5）")
    W("  L3 中危  ：动态注入 / 代码签名篡改 / 无障碍级 HUD 覆盖")
    W("  L2 低危  ：第三方外联域名 / 遥测")
    W("  L1 提示  ：仅字符串残留")

    path = os.path.join(OUT, "deep11.txt")
    text = "\n".join(buf) + "\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("deep11.txt lines=%d chars=%d" % (len(buf), len(text)))


if __name__ == "__main__":
    main()
