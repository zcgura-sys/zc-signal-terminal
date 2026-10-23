#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第八层：ObjC 类名/方法名全量 dump + UTF-16 串 + 硬编码外联点 + 卡密语义定位。

目标：
  A. 全量 __objc_classname / __objc_methname 导出（含中文 selector）
  B. UTF-16LE 字符串还原（iOS 里 NSBundle 常以 UTF-16 存中文）
  C. 硬编码 http/https/ip:port 外联点全集（ASCII + UTF-16）
  D. 卡密/授权语义真实定位：谁在验、验什么、验完写哪
  E. Moonshot / Kimi 原厂痕迹残留判定

零依赖。产物 logs/audit/deep8.txt
"""
import os
import re
import sys
import struct
import json

LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
PAY = os.path.join(LAB, "Payload")
OUT = os.path.join(os.environ.get("GITHUB_WORKSPACE", "."), "logs", "audit")
os.makedirs(OUT, exist_ok=True)

MAGICS = {
    b"\xcf\xfa\xed\xfe": ("\xcf\xfa\xed\xfe", 64),
    b"\xce\xfa\xed\xfe": ("\xce\xfa\xed\xfe", 32),
    b"\xca\xfe\xba\xbe": ("\xca\xfe\xba\xbe", 0),
    b"\xca\xfe\xba\xbf": ("\xca\xfe\xba\xbf", 0),
}
LC_SEGMENT_64 = 0x19
LC_SEGMENT = 0x1


def iterate_macho(root):
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            p = os.path.join(dirpath, fn)
            try:
                with open(p, "rb") as f:
                    head = f.read(4)
            except OSError:
                continue
            if head in MAGICS:
                yield os.path.relpath(p, os.path.dirname(root)), p


def sections(path):
    """返回 [(sectname, segname, offset, size)]"""
    out = []
    with open(path, "rb") as f:
        data = f.read()
    magic = data[:4]
    if magic not in MAGICS:
        return out, data
    is64 = magic in (b"\xcf\xfa\xed\xfe",)
    ncmds = struct.unpack_from("<I", data, 16)[0]
    off = 32 if is64 else 28
    segcmd = LC_SEGMENT_64 if is64 else LC_SEGMENT
    for _ in range(min(ncmds, 4096)):
        if off + 8 > len(data):
            break
        cmd, cmdsize = struct.unpack_from("<II", data, off)
        if cmdsize < 8:
            break
        if cmd == segcmd:
            nsects = struct.unpack_from("<I", data, off + (64 if is64 else 48))[0]
            base = off + (72 if is64 else 56)
            for i in range(min(nsects, 512)):
                so = base + i * (80 if is64 else 68)
                if so + 32 > len(data):
                    break
                sname = data[so:so + 16].split(b"\x00")[0].decode("utf-8", "replace")
                segname = data[so + 16:so + 32].split(b"\x00")[0].decode("utf-8", "replace")
                if is64:
                    sz = struct.unpack_from("<Q", data, so + 40)[0]
                    fo = struct.unpack_from("<I", data, so + 48)[0]
                else:
                    sz = struct.unpack_from("<I", data, so + 36)[0]
                    fo = struct.unpack_from("<I", data, so + 40)[0]
                out.append((sname, segname, fo, sz))
        off += cmdsize
    return out, data


def cstr_list(blob):
    return [s.decode("utf-8", "replace") for s in blob.split(b"\x00") if len(s) > 1]


U16_PAT = re.compile(
    rb"(?:[\x20-\x7e]\x00"          # ASCII 可打印 (UTF-16LE 低字节)
    rb"|[\x00-\xff][\x4e-\x9f]"      # CJK 统一汉字 U+4E00-U+9FFF
    rb"|[\x00-\x3f]\x30"              # CJK 标点 U+3000-U+303F
    rb"|[\x00-\xff]\xff){3,}"          # 全角字符 U+FF00-U+FFFF
)


def utf16_list(data):
    """扫 UTF-16LE 串（ASCII + 中文），长度 >= 3 字符"""
    res = []
    if len(data) % 2:
        data = data[:-1]
    for m in U16_PAT.finditer(data):
        raw = m.group(0)
        if len(raw) % 2:
            raw = raw[:-1]
        try:
            s = raw.decode("utf-16-le", "ignore").strip()
        except Exception:
            continue
        if len(s) >= 3:
            res.append(s)
    return res


URL_RE = re.compile(
    r"(?:https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]{4,200}"
    r"|(?:\d{1,3}\.){3}\d{1,3}:\d{2,5})"
)

CARD_KEYS = ["卡密", "激活码", "授权码", "验证码", "到期", "剩余", "天数",
             "授权", "激活", "序列号", "绑定", "机器码", "设备码", "解绑",
             "试用", "会员", "续费", "购买", "客服", "代理", "登录"]

AUTH_KEYS = ["verifyLicense", "checkLicense", "licenseKey", "activateCode",
             "serialNumber", "deviceId", "machineCode", "udid", "expireDate",
             "trialExpire", "vipExpire", "authToken", "validUntil"]

MOONSHOT = ["moonshot", "Moonshot", "月之暗面", "kimi.moonshot", "KimiChat",
            "kimi-", "chat.kimi", "kimi.com"]


def main():
    buf = []
    W = buf.append
    W("=" * 78)
    W("第八层：ObjC 全量符号 + UTF-16 中文字面量 + 硬编码外联 + 卡密语义定位")
    W("=" * 78)

    all_urls = {}
    all_utf16 = {}

    for rel, p in sorted(iterate_macho(PAY)):
        secs, data = sections(p)
        classes, meths = [], []
        for sname, segname, fo, sz in secs:
            if fo == 0 or sz == 0 or fo >= len(data):
                continue
            blob = data[fo:fo + sz]
            if sname == "__objc_classname":
                classes = cstr_list(blob)
            elif sname == "__objc_methname" or sname == "__objc_methtype":
                meths = cstr_list(blob)

        # 中文 selector / 类名（ObjC 允许 UTF-8 selector）
        cn_meth = [m for m in meths if any("\u4e00" <= c <= "\u9fff" for c in m)]
        cn_cls = [c for c in classes if any("\u4e00" <= c <= "\u9fff" for c in c)]
        u16 = utf16_list(data)
        all_utf16[rel] = u16
        urls = sorted({m.group(0) for m in URL_RE.finditer(
            data.decode("latin-1"))})
        all_urls[rel] = urls

        W("")
        W("-" * 78)
        W("### %s  (%d B)" % (rel, len(data)))
        W("  ObjC 类 %d / 方法 %d" % (len(classes), len(meths)))
        if cn_cls:
            W("  [中文类名] " + " | ".join(cn_cls[:40]))
        if cn_meth:
            W("  [中文方法] " + " | ".join(cn_meth[:40]))
        W("  硬编码外联 %d 条:" % len(urls))
        for u in urls[:40]:
            W("    " + u)

    W("")
    W("=" * 78)
    W("B. UTF-16 字面量里的中文（卡密/授权语义）")
    W("=" * 78)
    for rel, lst in all_utf16.items():
        hits = []
        for s in lst:
            if any("\u4e00" <= c <= "\u9fff" for c in s):
                hits.append(s)
        hits = list(dict.fromkeys(hits))
        if not hits:
            continue
        W("")
        W("### " + rel + "  中文 UTF-16 串 %d 条" % len(hits))
        card = [h for h in hits if any(k in h for k in CARD_KEYS)]
        W("  含卡密关键字的 %d 条:" % len(card))
        for h in card[:60]:
            W("    * " + h[:160])
        other = [h for h in hits if h not in card]
        if other:
            W("  其它中文串（前 40）:")
            for h in other[:40]:
                W("    - " + h[:120])

    W("")
    W("=" * 78)
    W("C. 全量外联点汇总（去重，跨文件）")
    W("=" * 78)
    flat = {}
    for rel, urls in all_urls.items():
        for u in urls:
            flat.setdefault(u, []).append(rel)
    W("共 %d 个唯一外联串" % len(flat))
    for u in sorted(flat):
        W("  %-70s <- %s" % (u[:70], ",".join(sorted(set(flat[u])))[:120]))

    W("")
    W("=" * 78)
    W("D. 卡密/授权 API 语义命中（ASCII 符号层）")
    W("=" * 78)
    for rel, p in sorted(iterate_macho(PAY)):
        with open(p, "rb") as f:
            raw = f.read()
        secs, _ = sections(p)
        pool = set()
        for sname, segname, fo, sz in secs:
            if sname.startswith("__objc_meth") and sz and fo:
                pool |= set(cstr_list(raw[fo:fo + sz]))
        hit = sorted({m for m in pool if any(k.lower() in m.lower() for k in AUTH_KEYS)})
        if hit:
            W("")
            W("### " + rel)
            for h in hit:
                W("    " + h)

    W("")
    W("=" * 78)
    W("E. Moonshot / Kimi 原厂痕迹残留")
    W("=" * 78)
    for rel, p in sorted(iterate_macho(PAY)):
        with open(p, "rb") as f:
            raw = f.read()
        txt = raw.decode("latin-1")
        found = {}
        for k in MOONSHOT:
            n = txt.count(k)
            if n:
                found[k] = n
        W("")
        W("### " + rel + " -> " + (json.dumps(found, ensure_ascii=False) if found else "无 Moonshot 痕迹"))

    out = os.path.join(OUT, "deep8.txt")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(buf) + "\n")
    print("deep8.txt lines=%d chars=%d" % (len(buf), sum(len(x) for x in buf)))


if __name__ == "__main__":
    main()
