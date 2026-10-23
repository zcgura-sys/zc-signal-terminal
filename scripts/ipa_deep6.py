#!/usr/bin/env python3
"""第六层：签名 / 权限 / 加载链 / 授权（卡密）关键字 / 回连证据。

目标：
  1. Info.plist 关键字段（BundleId / Executable / 权限用途描述）
  2. entitlements 与 mobileprovision（是否申请了越权能力）
  3. 每个 Mach-O 的 LC_LOAD_DYLIB / LC_RPATH / Mach-O flags
  4. 卡密/授权/到期 关键字（中英）定位授权系统真实存在与否
  5. 疑似服务器地址（含被混淆分隔的写法、IP 字面量）
产出 logs/audit/deep6.txt
"""
import os
import plistlib
import re
import struct
import sys

WS = os.environ.get("GITHUB_WORKSPACE", os.getcwd())
LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
OUT = os.path.join(WS, "logs", "audit", "deep6.txt")

MAG = {
    b"\xcf\xfa\xed\xfe": ("MH_MAGIC_64", 64),
    b"\xce\xfa\xed\xfe": ("MH_MAGIC", 32),
    b"\xca\xfe\xba\xbe": ("FAT_MAGIC", 0),
    b"\xca\xfe\xba\xbf": ("FAT_MAGIC_64", 0),
}

LC_LOAD_DYLIB = 0xC
LC_ID_DYLIB = 0xD
LC_RPATH = 0x8000001C
LC_LOAD_WEAK = 0x80000018
LC_REEXPORT = 0x8000001F


def find_machos(root):
    hits = []
    for dirpath, _d, files in os.walk(root):
        for fn in files:
            p = os.path.join(dirpath, fn)
            try:
                if os.path.getsize(p) < 4096:
                    continue
                with open(p, "rb") as f:
                    head = f.read(4)
            except OSError:
                continue
            if head in MAG:
                hits.append((p, head))
    return sorted(hits)


def parse_thin(data, off=0):
    """返回 (cputype, filetype, flags, [(cmd, strvalue)])"""
    info = {"dylibs": [], "rpaths": [], "flags": None, "filetype": None}
    try:
        magic, cputype, _sub, filetype, ncmds, sizeofcmds, flags = \
            struct.unpack_from("<IiiIIII", data, off)
    except struct.error:
        return info
    info["filetype"] = filetype
    info["flags"] = flags
    p = off + 32
    for _ in range(ncmds):
        if p + 8 > len(data):
            break
        cmd, cmdsize = struct.unpack_from("<II", data, p)
        if cmdsize < 8 or p + cmdsize > len(data):
            break
        if cmd in (LC_LOAD_DYLIB, LC_ID_DYLIB, LC_LOAD_WEAK, LC_REEXPORT):
            nameoff = struct.unpack_from("<I", data, p + 8)[0]
            raw = data[p + nameoff:p + cmdsize]
            s = raw.split(b"\x00")[0].decode("utf-8", "replace")
            info["dylibs"].append(s)
        elif cmd == LC_RPATH:
            nameoff = struct.unpack_from("<I", data, p + 8)[0]
            raw = data[p + nameoff:p + cmdsize]
            s = raw.split(b"\x00")[0].decode("utf-8", "replace")
            info["rpaths"].append(s)
        p += cmdsize
    return info


def walk_slices(data):
    """对 fat 二进制逐切片解析，返回 [info]"""
    out = []
    if data[:4] in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
        is64 = data[:4] == b"\xca\xfe\xba\xbf"
        nfat = struct.unpack_from(">I", data, 4)[0]
        step = 32 if is64 else 20
        for i in range(min(nfat, 8)):
            base = 8 + i * step
            if is64:
                off = struct.unpack_from(">Q", data, base + 8)[0]
            else:
                off = struct.unpack_from(">I", data, base + 8)[0]
            out.append(parse_thin(data, off))
    else:
        out.append(parse_thin(data, 0))
    return out


KEY_KAMI = [
    "卡密", "授权", "激活", "到期", "剩余天数", "试用", "续费", "会员",
    "登陆", "登录", "注册码", "验证码", "机器码", "设备码", "解绑", "换绑",
    "license", "licence", "activate", "activation", "trial", "expire",
    "expiry", "expires", "serial", "cardkey", "card_key", "authcode",
    "deviceid", "udid", "machinecode", "vip", "premium", "renew",
]

IP_RE = re.compile(rb"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")
HOST_RE = re.compile(
    rb"(?<![A-Za-z0-9_.-])(?:[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?\.)+"
    rb"(?:com|cn|net|org|io|xyz|top|vip|cc|co|me|app|shop|club|site|fun|"
    rb"live|online|tech|dev|link|work|pw|tk|ru|hk|tw|jp|us|info|biz)(?![A-Za-z0-9_-])",
    re.I,
)

# 白名单：系统/Apple 域，不算 C2
BENIGN = ("apple.com", "icloud.com", "mzstatic.com", "apple-dns.net",
          "appledb.dev", "w3.org", "gnu.org", "opensource.org",
          "llvm.org", "swift.org", "google.com", "gstatic.com")


def main():
    payload = os.path.join(LAB, "Payload")
    if not os.path.isdir(payload):
        print("未解包", file=sys.stderr)
        return 1

    lines = []

    def w(s=""):
        lines.append(s)

    app = None
    for d in os.listdir(payload):
        if d.endswith(".app"):
            app = os.path.join(payload, d)
            break
    w("=" * 78)
    w("R. 包体身份（Info.plist 关键字段）")
    w("=" * 78)
    w("app bundle: %s" % os.path.basename(app or "?"))
    pl = os.path.join(app, "Info.plist") if app else None
    plist = {}
    if pl and os.path.isfile(pl):
        try:
            with open(pl, "rb") as f:
                plist = plistlib.load(f)
        except Exception as e:  # noqa: BLE001
            w("  Info.plist 解析失败: %s" % e)
    KEYS = ["CFBundleIdentifier", "CFBundleName", "CFBundleDisplayName",
            "CFBundleExecutable", "CFBundleShortVersionString",
            "CFBundleVersion", "MinimumOSVersion", "CFBundlePackageType",
            "UIFileSharingEnabled", "UIApplicationExitsOnSuspend",
            "NSPhotoLibraryUsageDescription", "NSContactsUsageDescription",
            "NSCameraUsageDescription", "NSMicrophoneUsageDescription",
            "NSLocationWhenInUseUsageDescription", "NSAppleMusicUsageDescription",
            "LSApplicationQueriesSchemes", "UIBackgroundModes",
            "NSAppTransportSecurity", "PlatformArchitectures",
            "DTPlatformName", "DTXcode", "CFBundleSupportedPlatforms"]
    for k in KEYS:
        if k in plist:
            v = plist[k]
            if isinstance(v, (list, dict)):
                v = str(v)[:300]
            w("  %-38s = %s" % (k, v))
    other = [k for k in plist if k not in KEYS]
    w("  其余键 %d 个: %s" % (len(other), ", ".join(sorted(other)[:40])))

    # 权限用途描述全部列出（这些直接说明它想碰什么）
    w("")
    w("  --- 所有 *UsageDescription（申请的系统权限）---")
    anyu = False
    for k in sorted(plist):
        if k.endswith("UsageDescription"):
            anyu = True
            w("    %s = %s" % (k, str(plist[k])[:200]))
    if not anyu:
        w("    （无，未申请任何隐私权限）")

    w("")
    w("=" * 78)
    w("S. 签名材料（entitlements / provisioning / _CodeSignature）")
    w("=" * 78)
    for name in ("embedded.mobileprovision", "embedded.provisionprofile"):
        p = os.path.join(app, name) if app else None
        if p and os.path.isfile(p):
            w("  找到 %s  size=%d" % (name, os.path.getsize(p)))
            with open(p, "rb") as f:
                blob = f.read()
            # mobileprovision 是 CMS 包裹的 plist，直接搜可读字段
            for kw in (b"application-identifier", b"TeamIdentifier",
                       b"ExpirationDate", b"Name", b"get-task-allow",
                       b"platform", b"ProvisionsAllDevices"):
                i = blob.find(kw)
                if i >= 0:
                    seg = blob[i:i + 90]
                    w("    %s -> %s" % (kw.decode(),
                                        re.sub(rb"[^\x20-\x7e]", b".",
                                               seg).decode()))
    else:
        pass
    ent = os.path.join(app, "Kimi") if app else None
    sigdir = os.path.join(app, "_CodeSignature") if app else None
    w("  _CodeSignature 目录: %s" % ("存在" if sigdir and os.path.isdir(sigdir) else "缺失"))
    if sigdir and os.path.isdir(sigdir):
        for fn in sorted(os.listdir(sigdir)):
            fp = os.path.join(sigdir, fn)
            w("    %s  %d B" % (fn, os.path.getsize(fp)))

    w("")
    w("=" * 78)
    w("T. 加载链（LC_LOAD_DYLIB / LC_RPATH / Mach-O flags）")
    w("=" * 78)
    FLAGNAMES = [(0x1, "NOUNDEFS"), (0x2, "DYLDLINK"), (0x4, "BINDATLOAD"),
                 (0x8, "PREBOUND"), (0x10, "SPLIT_SEGS"), (0x20, "LAZY_INIT"),
                 (0x80, "TWOLEVEL"), (0x100, "FORCE_FLAT"), (0x200, "NOMULTIDEFS"),
                 (0x400, "NOFIXPREBINDING"), (0x800, "PREBINDABLE"),
                 (0x1000, "ALLMODSBOUND"), (0x2000, "SUBSECTIONS_VIA_SYMBOLS"),
                 (0x10000, "WEAK_DEFINES"), (0x20000, "BINDS_TO_WEAK"),
                 (0x40000, "ALLOW_STACK_EXECUTION"), (0x80000, "ROOT_SAFE"),
                 (0x100000, "SETUID_SAFE"), (0x200000, "NO_REEXPORTED_DYLIBS"),
                 (0x400000, "PIE"), (0x800000, "DEAD_STRIPPABLE_DYLIB"),
                 (0x1000000, "HAS_TLV_DESCRIPTORS"), (0x2000000, "NO_HEAP_EXECUTION")]
    for p, head in find_machos(payload):
        rel = os.path.relpath(p, payload)
        with open(p, "rb") as f:
            data = f.read()
        w("")
        w("--- %s (%s) ---" % (rel, MAG[head][0]))
        for info in walk_slices(data):
            fl = info["flags"] or 0
            names = [n for bit, n in FLAGNAMES if fl & bit]
            w("  flags=0x%x [%s]" % (fl, ", ".join(names) or "-"))
            if info["filetype"] is not None:
                w("  filetype=%d %s" % (info["filetype"],
                                        {2: "MH_EXECUTE", 6: "MH_DYLIB",
                                         8: "MH_BUNDLE"}.get(info["filetype"], "")))
            if info["rpaths"]:
                w("  RPATH: %s" % ", ".join(info["rpaths"]))
            if info["dylibs"]:
                w("  LOAD_DYLIB (%d):" % len(info["dylibs"]))
                for d in info["dylibs"]:
                    mark = ""
                    if d.startswith("@executable_path") or d.startswith("@loader_path"):
                        mark = "  <== 相对路径注入"
                    if "jailbreak" in d or "kfd" in d or "Sword" in d or "xpf" in d:
                        mark += "  <== 越狱组件"
                    w("      %s%s" % (d, mark))

    w("")
    w("=" * 78)
    w("U. 授权（卡密）系统关键字分布")
    w("=" * 78)
    for p, _h in find_machos(payload):
        rel = os.path.relpath(p, payload)
        with open(p, "rb") as f:
            data = f.read()
        found = {}
        for kw in KEY_KAMI:
            enc = kw.encode("utf-8")
            n = data.count(enc)
            if n:
                found[kw] = n
        w("")
        w("--- %s ---" % rel)
        if not found:
            w("    （无授权相关字符串）")
            continue
        for kw, n in sorted(found.items(), key=lambda x: -x[1]):
            w("    %-16s x%d" % (kw, n))

    w("")
    w("=" * 78)
    w("V. 服务器 / 回连证据（域名 + IP 字面量，已排除 Apple 及通用域名）")
    w("=" * 78)
    for p, _h in find_machos(payload):
        rel = os.path.relpath(p, payload)
        with open(p, "rb") as f:
            data = f.read()
        hosts = {}
        for m in HOST_RE.finditer(data):
            h = m.group(0).decode("latin-1").lower()
            base = h
            if any(base == b or base.endswith("." + b) for b in BENIGN):
                continue
            hosts[h] = hosts.get(h, 0) + 1
        ips = {}
        for m in IP_RE.finditer(data):
            s = m.group(0).decode("latin-1")
            octs = [int(x) for x in s.split(".")]
            if any(o > 255 for o in octs):
                continue
            if s.startswith(("0.", "127.", "255.", "224.")):
                continue
            ips[s] = ips.get(s, 0) + 1
        w("")
        w("--- %s ---" % rel)
        if not hosts and not ips:
            w("    （无外部主机 / IP）")
        for h, n in sorted(hosts.items(), key=lambda x: -x[1])[:30]:
            w("    host  %-50s x%d" % (h, n))
        for s, n in sorted(ips.items(), key=lambda x: -x[1])[:20]:
            w("    ip    %-50s x%d" % (s, n))

    text = "\n".join(lines) + "\n"
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print("deep6.txt lines=%d chars=%d" % (len(lines), len(text)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
