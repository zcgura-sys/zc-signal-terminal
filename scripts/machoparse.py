#!/usr/bin/env python3
"""纯 Python Mach-O 解析器（零依赖）。解析 fat/thin、加密信息、链接库、段节、签名、entitlements。"""
import os, sys, struct, json

MH_MAGIC = 0xFEEDFACE
MH_MAGIC_64 = 0xFEEDFACF
FAT_MAGIC = 0xCAFEBABE
FAT_MAGIC_64 = 0xCAFEBABF

LC = {
    0x1: "LC_SEGMENT", 0x19: "LC_SEGMENT_64", 0x2: "LC_SYMTAB", 0x3: "LC_SYMSEG",
    0x4: "LC_THREAD", 0x5: "LC_UNIXTHREAD", 0x6: "LC_LOADFVMLIB", 0xB: "LC_DYSYMTAB",
    0xC: "LC_LOAD_DYLIB", 0xD: "LC_ID_DYLIB", 0xE: "LC_LOAD_DYLINKER", 0xF: "LC_ID_DYLINKER",
    0x1D: "LC_CODE_SIGNATURE", 0x1E: "LC_SEGMENT_SPLIT_INFO", 0x1B: "LC_UUID",
    0x1C: "LC_RPATH", 0x1F: "LC_LAZY_LOAD_DYLIB", 0x20: "LC_ENCRYPTION_INFO",
    0x21: "LC_DYLD_INFO", 0x22: "LC_DYLD_INFO_ONLY", 0x23: "LC_LOADUPWARD_DYLIB",
    0x24: "LC_VERSION_MIN_MACOSX", 0x25: "LC_VERSION_MIN_IPHONEOS", 0x26: "LC_FUNCTION_STARTS",
    0x27: "LC_DYLD_ENVIRONMENT", 0x28: "LC_MAIN", 0x29: "LC_DATA_IN_CODE",
    0x2A: "LC_SOURCE_VERSION", 0x2B: "LC_DYLIB_CODE_SIGN_DRS", 0x2C: "LC_ENCRYPTION_INFO_64",
    0x2D: "LC_LINKER_OPTION", 0x2E: "LC_LINKER_OPTIMIZATION_HINT", 0x2F: "LC_VERSION_MIN_TVOS",
    0x30: "LC_VERSION_MIN_WATCHOS", 0x31: "LC_NOTE", 0x32: "LC_BUILD_VERSION",
    0x80000018: "LC_LOAD_WEAK_DYLIB", 0x8000001C: "LC_RPATH_R", 0x8000001F: "LC_REEXPORT_DYLIB",
    0x80000022: "LC_DYLD_INFO_ONLY_R", 0x80000023: "LC_LOADUPWARD_DYLIB_R",
    0x80000028: "LC_MAIN_R", 0x80000033: "LC_DYLD_EXPORTS_TRIE", 0x80000034: "LC_DYLD_CHAINED_FIXUPS",
}
CPU = {7: "x86", 0x01000007: "x86_64", 12: "arm", 0x0100000C: "arm64", 0x0200000C: "arm64_32"}
FILETYPE = {1: "OBJECT", 2: "EXECUTE", 3: "FVMLIB", 4: "CORE", 5: "PRELOAD", 6: "DYLIB",
            7: "DYLINKER", 8: "BUNDLE", 9: "DYLIB_STUB", 10: "DSYM", 11: "KEXT_BUNDLE"}


def parse_slice(data, off, size):
    """解析单个 Mach-O slice，返回规则化 dict。"""
    d = {}
    magic32 = struct.unpack_from("<I", data, off)[0]
    is64 = magic32 == MH_MAGIC_64
    d["magic"] = hex(magic32)
    d["is64"] = is64
    hsize = 32 if is64 else 28
    if is64:
        _, cpu, sub, ftype, ncmds, sizeofcmds, flags, _res = struct.unpack_from("<IiIIIIII", data, off)
    else:
        cpu, sub, ftype, ncmds, sizeofcmds, flags = struct.unpack_from("<iIIIII", data, off)
    d.update(cpu=CPU.get(cpu & 0xFFFFFFFF, str(cpu)), cpu_raw=cpu, subtype=sub,
             filetype=FILETYPE.get(ftype, str(ftype)), ncmds=ncmds, sizeofcmds=sizeofcmds,
             flags=hex(flags), slice_offset=off, slice_size=size)

    libs, rpaths, segs, cmds, sect_count = [], [], {}, [], 0
    p = off + hsize
    end = p + sizeofcmds
    for _ in range(ncmds):
        if p + 8 > end:
            break
        cmd, csize = struct.unpack_from("<II", data, p)
        if csize < 8:
            break
        name = LC.get(cmd, hex(cmd))
        body = p + 8
        if cmd in (0xC, 0xD, 0x1F, 0x80000018, 0x80000023, 0x8000001F):
            noff = struct.unpack_from("<I", data, body)[0]
            libs.append(data[body + noff:p + csize].split(b"\0")[0].decode("utf-8", "replace"))
        elif cmd in (0x1C, 0x8000001C):
            noff = struct.unpack_from("<I", data, body)[0]
            rpaths.append(data[body + noff:p + csize].split(b"\0")[0].decode("utf-8", "replace"))
        elif cmd == 0x2C:  # LC_ENCRYPTION_INFO_64
            c_off, c_size, c_id, _pad = struct.unpack_from("<IIIi", data, body)
            d.update(crypt_offset=c_off, crypt_size=c_size, crypt_id=c_id, encrypted=(c_id != 0))
        elif cmd == 0x20:  # LC_ENCRYPTION_INFO (32)
            c_off, c_size, c_id = struct.unpack_from("<III", data, body)
            d.update(crypt_offset=c_off, crypt_size=c_size, crypt_id=c_id, encrypted=(c_id != 0))
        elif cmd == 0x1D:  # LC_CODE_SIGNATURE
            doff, dsize = struct.unpack_from("<II", data, body)
            d.update(cs_offset=doff, cs_size=dsize)
        elif cmd in (0x19, 0x1):
            seg64 = cmd == 0x19
            if seg64:
                segname = data[body:body + 16].split(b"\0")[0].decode("utf-8", "replace")
                vmaddr, vmsize, fileoff, filesize = struct.unpack_from("<QQQQ", data, body + 16)
                nsects = struct.unpack_from("<I", data, body + 64)[0]
                sp = body + 72
            else:
                segname = data[body:body + 16].split(b"\0")[0].decode("utf-8", "replace")
                vmaddr, vmsize, fileoff, filesize = struct.unpack_from("<IIII", data, body + 16)
                nsects = struct.unpack_from("<I", data, body + 48)[0]
                sp = body + 56
            secs = []
            for _i in range(nsects):
                sname = data[sp:sp + 16].split(b"\0")[0].decode("utf-8", "replace")
                if seg64:
                    s_off, s_size = struct.unpack_from("<QQ", data, sp + 40)
                else:
                    s_off, s_size = struct.unpack_from("<II", data, sp + 32)
                secs.append([sname, s_size])
                sp += 80 if seg64 else 68
            sect_count += nsects
            segs[segname] = {"vmaddr": vmaddr, "vmsize": vmsize, "fileoff": fileoff,
                             "filesize": filesize, "sections": [[a, b] for a, b in secs]}
        elif cmd == 0x2:  # SYMTAB
            symoff, nsyms, stroff, strsize = struct.unpack_from("<IIII", data, body)
            d.update(symtab={"symoff": symoff, "nsyms": nsyms, "strsize": strsize})
        elif cmd == 0x28:  # LC_MAIN
            eoff, ssize = struct.unpack_from("<QQ", data, body)
            d.update(entryoff=eoff, stacksize=ssize)
        elif cmd == 0x32:  # LC_BUILD_VERSION
            platform, minos = struct.unpack_from("<II", data, body)
            d.update(platform=platform, minos=minos)
        elif cmd in (0x25,):
            ver, sdk = struct.unpack_from("<II", data, body)
            d.update(version_min=ver, sdk=sdk)
        elif cmd == 0x1B:
            d["uuid"] = data[body:body + 16].hex()
        cmds.append(name)
        p += csize

    d.update(libraries=libs, rpaths=rpaths, segments=segs, n_sections=sect_count,
             cmd_set=sorted(set(cmds)), cmd_total=len(cmds))
    return d


def find_plist_blobs(data, off, size):
    """在 code signature / 二进制内嗅探 XML plist 片段（entitlements 常见）。"""
    blobs = []
    win = data[off:off + size]
    i = 0
    while True:
        i = win.find(b"<?xml", i)
        if i < 0:
            break
        j = win.find(b"</plist>", i)
        if j < 0:
            break
        blobs.append(win[i:j + 8].decode("utf-8", "replace"))
        i = j + 8
        if len(blobs) > 8:
            break
    return blobs


def parse_file(path):
    with open(path, "rb") as f:
        data = f.read()
    res = {"path": path, "size": len(data), "slices": []}
    if len(data) < 8:
        res["error"] = "too small"
        return res
    magic = struct.unpack_from(">I", data, 0)[0]
    if magic in (FAT_MAGIC, FAT_MAGIC_64):
        nfat = struct.unpack_from(">I", data, 4)[0]
        is64 = magic == FAT_MAGIC_64
        ents = []
        p = 8
        for _ in range(min(nfat, 30)):
            if is64:
                cpu, sub, off, size, _al, _r = struct.unpack_from(">iIQQII", data, p)
                p += 32
            else:
                cpu, sub, off, size, _al = struct.unpack_from(">iIIII", data, p)
                p += 20
            ents.append((cpu, off, size))
        res["fat_archs"] = [CPU.get(c & 0xFFFFFFFF, str(c)) for c, _, _ in ents]
        for cpu, off, size in ents:
            try:
                res["slices"].append(parse_slice(data, off, size))
            except Exception as e:
                res["slices"].append({"error": repr(e), "offs": off})
    else:
        try:
            res["slices"].append(parse_slice(data, 0, len(data)))
        except Exception as e:
            res["error"] = repr(e)
            return res
    # entitlements 嗅探
    all_ent = []
    for s in res["slices"]:
        if s.get("cs_offset") and s.get("cs_size"):
            all_ent += find_plist_blobs(data, s["cs_offset"], s["cs_size"])
        if s.get("segments", {}).get("__TEXT"):
            t = s["segments"]["__TEXT"]
            all_ent += find_plist_blobs(data, t["fileoff"], min(t["filesize"], 4 << 20))
    uniq = []
    for e in all_ent:
        if e not in uniq:
            uniq.append(e)
    res["plist_blobs"] = uniq[:5]
    return res


if __name__ == "__main__":
    out = [parse_file(p) for p in sys.argv[1:]]
    print(json.dumps(out, ensure_ascii=False, indent=1, default=str))
