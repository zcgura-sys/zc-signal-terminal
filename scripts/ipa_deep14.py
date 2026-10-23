#!/usr/bin/env python3
"""第十四层：主二进制 load command 取证（注入链 / cryptid / RPATH / 签名）。
零依赖。读取 macho 头部字节，逐条打印 LC。"""
import os
import struct
import sys

LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
PAY = os.path.join(LAB, "Payload")
OUT = os.path.join(os.environ.get("GITHUB_WORKSPACE", "."), "logs", "audit", "deep14.txt")

LC = {
    0x1: "LC_SEGMENT", 0x2: "LC_SYMTAB", 0xB: "LC_DYSYMTAB",
    0xC: "LC_LOAD_DYLIB", 0xD: "LC_ID_DYLIB", 0xE: "LC_LOAD_DYLINKER",
    0x1D: "LC_CODE_SIGNATURE", 0x1E: "LC_SEGMENT_SPLIT_INFO",
    0x19: "LC_UUID", 0x1B: "LC_UUID?", 0x22: "LC_DYLD_INFO",
    0x80000022: "LC_DYLD_INFO_ONLY", 0x23: "LC_DYLD_INFO_ONLY?",
    0x26: "LC_FUNCTION_STARTS", 0x29: "LC_DATA_IN_CODE",
    0x2A: "LC_SOURCE_VERSION", 0x2B: "LC_DYLIB_CODE_SIGN_DRS",
    0x2C: "LC_ENCRYPTION_INFO", 0x2D: "LC_LINKER_OPTION",
    0x2E: "LC_ENCRYPTION_INFO_64", 0x2F: "LC_LINKER_OPTIMIZATION_HINT",
    0x33: "LC_BUILD_VERSION", 0x34: "LC_DYLD_EXPORTS_TRIE",
    0x35: "LC_DYLD_CHAINED_FIXUPS", 0x8000001C: "LC_RPATH",
    0x8000001F: "LC_REEXPORT_DYLIB", 0x80000023: "LC_LAZY_LOAD_DYLIB",
    0x80000028: "LC_MAIN", 0x80000033: "LC_DYLD_ENV",
    0x80000034: "LC_DYLD_ENVIRONMENT", 0x80000035: "LC_DYLD_ENV_PATH",
}

MAGICS = {
    b"\xcf\xfa\xed\xfe": (False, 64),   # MH_MAGIC_64 LE
    b"\xce\xfa\xed\xfe": (False, 32),   # MH_MAGIC LE
    b"\xca\xfe\xba\xbe": (True, 0),     # FAT
}


def slices(data):
    """返回 [(offset, size, label)]"""
    out = []
    if len(data) < 8:
        return out
    for magic, (is_fat, _) in MAGICS.items():
        if data[:4] == magic:
            if not is_fat:
                out.append((0, len(data), "thin"))
                return out
            n = struct.unpack_from(">I", data, 4)[0]
            if n > 32:
                return out
            for i in range(n):
                base = 8 + i * 20
                if base + 20 > len(data):
                    break
                cput, cpus, off, size, align = struct.unpack_from(">iiIII", data, base)
                arch = {12: "arm", 0x0100000C: "arm64", 0x0100000C | 0x1000000: "arm64e"}.get(
                    cput, hex(cput & 0xFFFFFFFF)
                )
                out.append((off, size, f"{arch}/sub{i}"))
            return out
    return out


def parse_slice(data, off, size, label, lines):
    body = data[off:off + size]
    if len(body) < 32:
        return
    magic = body[:4]
    if magic == b"\xcf\xfa\xed\xfe":
        hdr, is64 = 32, True
    elif magic == b"\xce\xfa\xed\xfe":
        hdr, is64 = 28, False
    else:
        return
    ncmds, sizeofcmds = struct.unpack_from("<II", body, 16)
    cpu = struct.unpack_from("<i", body, 4)[0]
    lines.append(f"  slice={label}  magic={magic.hex()}  is64={is64}  "
                 f"cputype={hex(cpu & 0xFFFFFFFF)}  ncmds={ncmds}")

    off_c = hdr
    dylibs, rpaths, enc, segs = [], [], [], []
    for _ in range(min(ncmds, 4096)):
        if off_c + 8 > len(body):
            break
        cmd, cmdsize = struct.unpack_from("<II", body, off_c)
        if cmdsize < 8 or off_c + cmdsize > len(body):
            break
        name = LC.get(cmd, hex(cmd))

        if cmd in (0xC, 0xD, 0x8000001F, 0x80000023, 0x8000001C):
            noff = struct.unpack_from("<I", body, off_c + 8)[0]
            s = body[off_c + noff: off_c + cmdsize].split(b"\x00")[0]
            txt = s.decode("utf-8", "replace")
            if cmd == 0x8000001C:
                rpaths.append(txt)
            else:
                dylibs.append((name, txt))

        elif cmd in (0x2C, 0x2E):
            if cmd == 0x2E:
                cryptoff, cryptsize, cryptid = struct.unpack_from("<III", body, off_c + 8)
            else:
                cryptoff, cryptsize, cryptid = struct.unpack_from("<III", body, off_c + 8)
            enc.append((cryptoff, cryptsize, cryptid))

        elif cmd in (0x1, 0x19) and cmd == 0x1:
            segname = body[off_c + 8: off_c + 24].split(b"\x00")[0].decode("ascii", "replace")
            segs.append(segname)

        off_c += cmdsize

    if enc:
        for co, cs, cid in enc:
            lines.append(f"    [加密] LC_ENCRYPTION_INFO  cryptoff={co} cryptsize={cs} "
                         f"cryptid={cid}  → {'已解密/明文' if cid == 0 else '仍然加密'}")
    else:
        lines.append("    [加密] 无 LC_ENCRYPTION_INFO（明文，未做 App Store 加密）")

    lines.append(f"    [段] {', '.join(segs)}")
    lines.append(f"    [RPATH] {rpaths if rpaths else '无'}")
    lines.append(f"    [依赖 dylib] {len(dylibs)} 条")
    for name, txt in dylibs:
        flag = "  ← 注入!" if any(k in txt for k in (
            "xpf", "jailbreak", "choma", "kfd", "ClearSword", "DarkSword")) else ""
        lines.append(f"      {name:<18} @ {txt}{flag}")
    lines.append("")


def main():
    if not os.path.isdir(PAY):
        print(f"[-] Payload 不存在：{PAY}")
        return 1

    apps = [d for d in os.listdir(PAY) if d.endswith(".app")]
    if not apps:
        print("[-] 未找到 .app")
        return 1
    app = os.path.join(PAY, apps[0])
    exe_name = apps[0][:-4]
    exe = os.path.join(app, exe_name)
    if not os.path.isfile(exe):
        cand = [f for f in os.listdir(app) if os.path.isfile(os.path.join(app, f))]
        exe = os.path.join(app, cand[0]) if cand else None

    lines = ["=" * 78,
             "第十四层：主二进制 load command 取证（注入链 / 加密 / RPATH）",
             "=" * 78, ""]

    if exe and os.path.isfile(exe):
        data = open(exe, "rb").read()
        lines.append(f"# A. 主可执行文件 {os.path.basename(exe)}  ({len(data)} B)")
        for o, s, lbl in slices(data):
            parse_slice(data, o, s, lbl, lines)
    else:
        lines.append("[-] 主可执行文件未定位")

    lines.append("# B. 注入组件自身是否加密")
    lines.append("=" * 78)
    fw = os.path.join(app, "Frameworks")
    targets = []
    for root, _dirs, files in os.walk(app):
        for f in files:
            p = os.path.join(root, f)
            if f.endswith(".dylib"):
                targets.append(p)
    for d in ("kfd", "ClearSword", "DarkSword"):
        p = os.path.join(fw, d + ".framework", d)
        if os.path.isfile(p):
            targets.append(p)
    for p in sorted(set(targets)):
        data = open(p, "rb").read()
        rel = os.path.relpath(p, app)
        got = False
        for o, s, lbl in slices(data):
            body = data[o:o + s]
            if len(body) < 32 or body[:4] not in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe"):
                continue
            is64 = body[:4] == b"\xcf\xfa\xed\xfe"
            hdr = 32 if is64 else 28
            ncmds = struct.unpack_from("<I", body, 16)[0]
            oc = hdr
            for _ in range(min(ncmds, 4096)):
                if oc + 8 > len(body):
                    break
                cmd, cs = struct.unpack_from("<II", body, oc)
                if cs < 8 or oc + cs > len(body):
                    break
                if cmd in (0x2C, 0x2E):
                    co, csz, cid = struct.unpack_from("<III", body, oc + 8)
                    lines.append(f"  {rel:<52} cryptid={cid}  ({lbl})")
                    got = True
                oc += cs
        if not got:
            lines.append(f"  {rel:<52} 无加密段（明文）")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    text = "\n".join(lines)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
