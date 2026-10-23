#!/usr/bin/env python3
"""Mach-O 深度解析：加密状态(cryptid)、架构、链接库、段/节、符号、entitlements、签名字节范围。"""
import os, sys, json, collections

LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
APP = None
for n in sorted(os.listdir(os.path.join(LAB, "Payload"))):
    if n.endswith(".app"):
        APP = os.path.join(LAB, "Payload", n)
PAY = APP

TARGETS = [
    "Kimi",
    "libjailbreak.dylib",
    "libxpf.dylib",
    "libchoma.dylib",
    "Frameworks/kfd.framework/kfd",
    "Frameworks/DarkSword.framework/DarkSword",
    "Frameworks/ClearSword.framework/ClearSword",
]

try:
    import lief
except Exception as e:
    print(json.dumps({"error": f"lief import: {e}"})); sys.exit(1)


def analyze(rel):
    p = os.path.join(PAY, rel)
    if not os.path.exists(p):
        return {"path": rel, "missing": True}
    r = {"path": rel, "size": os.path.getsize(p)}
    try:
        fat = lief.MachO.parse(p)
    except Exception as e:
        r["parse_error"] = repr(e); return r
    if fat is None:
        r["parse_error"] = "lief returned None"; return r
    r["is_fat"] = type(fat).__name__.lower().startswith("fat")
    bins = []
    try:
        it = list(fat)
    except Exception:
        it = [fat]
    for b in it:
        d = {}
        try:
            d["cpu"] = str(b.header.cpu_type)
            d["file_type"] = str(b.header.file_type)
            d["ncmds"] = b.header.nb_cmd
        except Exception as e:
            d["hdr_err"] = repr(e)
        # 加密
        try:
            enc = b.has_encryption_info
            d["has_encryption_info"] = bool(enc)
            if enc:
                d["cryptid"] = int(b.encryption_info.crypt_id)
                d["cryptoff"] = int(b.encryption_info.crypt_offset)
                d["cryptsize"] = int(b.encryption_info.crypt_size)
        except Exception as e:
            d["enc_err"] = repr(e)
        # 链接库
        try:
            d["libraries"] = [l.name for l in b.libraries]
        except Exception as e:
            d["lib_err"] = repr(e)
        # rpaths
        try:
            d["rpaths"] = [c.path for c in b.commands if isinstance(c, lief.MachO.RPathCommand)]
        except Exception:
            pass
        # 段/节
        try:
            segs = {}
            for s in b.segments:
                segs[s.name] = {"vm": s.virtual_size, "file": s.file_size,
                                "sections": [x.name for x in s.sections]}
            d["segments"] = segs
        except Exception as e:
            d["seg_err"] = repr(e)
        # 符号
        try:
            imported = sorted({s.name for s in b.imported_symbols if s.name}) if hasattr(b, "imported_symbols") else []
            d["n_imported"] = len(imported)
            d["imported_sample"] = imported[:8]
            exported = sorted({s.name for s in b.exported_symbols if s.name}) if hasattr(b, "exported_symbols") else []
            d["n_exported"] = len(exported)
            d["exported_sample"] = exported[:8]
        except Exception as e:
            d["sym_err"] = repr(e)
        # 签名
        try:
            cd = b.code_signature
            d["signed"] = bool(cd) if cd is not None else False
            if cd is not None:
                d["cs_data_offset"] = int(cd.data_offset) if getattr(cd, "data_offset", None) is not None else None
                d["cs_data_size"] = int(cd.data_size) if getattr(cd, "data_size", None) is not None else None
        except Exception as e:
            d["cs_err"] = repr(e)
        bins.append(d)
    r["slices"] = bins
    return r


out = {"app": os.path.basename(PAY), "targets": [analyze(t) for t in TARGETS]}

# 全 app 里所有 Mach-O 的 cryptid 汇总
enc_summary = []
for dp, dn, fn in os.walk(PAY):
    for f in fn:
        p = os.path.join(dp, f)
        try:
            with open(p, "rb") as h:
                m = h.read(4)
        except OSError:
            continue
        if m not in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe"):
            continue
        try:
            fat = lief.MachO.parse(p)
            for b in list(fat):
                try:
                    cid = int(b.encryption_info.crypt_id) if b.has_encryption_info else 0
                except Exception:
                    cid = -1
                enc_summary.append([os.path.relpath(p, PAY), str(b.header.cpu_type), cid])
        except Exception as e:
            enc_summary.append([os.path.relpath(p, PAY), "parse_fail", repr(e)[:60]])
out["all_macho_cryptid"] = enc_summary

print(json.dumps(out, ensure_ascii=False, indent=1, default=str))
