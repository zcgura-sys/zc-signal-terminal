#!/usr/bin/env python3
"""第十二层：启动链 / 持久化 / 依赖注入取证（零依赖）。

取证项：
  1. Payload 顶层与 app 目录树规模
  2. Info.plist 关键字段（BundleId / Executable / MinimumOS / URL types / 私有 URL scheme）
  3. 全部 Mach-O 的 LC_LOAD_DYLIB / LC_LOAD_WEAK_DYLIB / LC_RPATH / LC_LOAD_UPWARD
  4. 是否存在 launchd plist / 后台保活 / 开机自启
  5. 注入 dylib 的 cryptid 与架构切片
  6. 硬编码外联端点二次确认
"""
import os
import re
import struct
import sys

LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
PAY = os.path.join(LAB, "Payload")
WS = os.environ.get("GITHUB_WORKSPACE", ".")
OUT = os.path.join(WS, "logs", "audit", "deep12.txt")

MH_MAGIC = b"\xcf\xfa\xed\xfe"
MH_MAGIC_64 = b"\xcf\xfa\xed\xfe"
MH_CIGAM = b"\xce\xfa\xed\xfe"
MH_MAGIC_32 = b"\xce\xfa\xed\xfe"
FAT_MAGIC = b"\xca\xfe\xba\xbe"
FAT_MAGIC_64 = b"\xca\xfe\xba\xbf"

LC_NAMES = {
    0xC: "LC_LOAD_DYLIB",
    0x18 | 0x80000000: "LC_LOAD_WEAK_DYLIB",
    0x1F | 0x80000000: "LC_REEXPORT_DYLIB",
    0x20 | 0x80000000: "LC_LAZY_LOAD_DYLIB",
    0x23 | 0x80000000: "LC_LOAD_UPWARD_DYLIB",
    0x8000001C: "LC_RPATH",
    0xE: "LC_LOAD_DYLINKER",
}

L = []


def w(s=""):
    L.append(str(s))


def slices(data):
    """返回 (offset, size, cputype) 列表；非 FAT 视为单切片。"""
    if data[:4] in (FAT_MAGIC, FAT_MAGIC_64):
        n = struct.unpack_from(">I", data, 4)[0]
        wide = data[:4] == FAT_MAGIC_64
        out = []
        for i in range(min(n, 32)):
            base = 8 + i * (32 if wide else 20)
            if wide:
                cpu, _sub, off, size = struct.unpack_from(">IIQQ", data, base)
            else:
                cpu, _sub, off, size = struct.unpack_from(">IIII", data, base)
            out.append((off, size, cpu))
        return out
    return [(0, len(data), None)]


def is_macho(data):
    return data[:4] in (MH_MAGIC, MH_CIGAM, FAT_MAGIC, FAT_MAGIC_64)


def parse_lcs(data):
    """解析单切片 load commands，返回 (dylibs, rpaths, dylinker, cryptid, ncmds)。"""
    magic = data[:4]
    if magic == MH_MAGIC_64:
        hdr = 32
        cputype = struct.unpack_from("<I", data, 4)[0]
    elif magic == MH_MAGIC_32:
        hdr = 28
        cputype = struct.unpack_from("<I", data, 4)[0]
    else:
        return None
    if len(data) < hdr:
        return None
    ncmds, sizeofcmds = struct.unpack_from("<II", data, 16)
    if ncmds > 5000 or sizeofcmds > len(data):
        return None
    off = hdr
    dylibs, rpaths, dylinker = [], [], []
    cryptid = None
    for _ in range(ncmds):
        if off + 8 > len(data):
            break
        cmd, cmdsize = struct.unpack_from("<II", data, off)
        if cmdsize < 8 or off + cmdsize > len(data):
            break
        if cmd in LC_NAMES:
            name_off = struct.unpack_from("<I", data, off + 8)[0]
            if 0 < name_off < cmdsize:
                raw = data[off + name_off: off + cmdsize]
                name = raw.split(b"\x00")[0].decode("utf-8", "replace")
                tag = LC_NAMES[cmd]
                if tag == "LC_RPATH":
                    rpaths.append(name)
                elif tag == "LC_LOAD_DYLINKER":
                    dylinker.append(name)
                else:
                    dylibs.append((tag, name))
        elif cmd == 0x1D:  # LC_CODE_SIGNATURE
            pass
        elif cmd == 0x2C:  # LC_ENCRYPTION_INFO
            if cmdsize >= 20:
                cryptid = struct.unpack_from("<I", data, off + 16)[0]
        elif cmd == 0x2D:  # LC_ENCRYPTION_INFO_64
            if cmdsize >= 20:
                cryptid = struct.unpack_from("<I", data, off + 16)[0]
        off += cmdsize
    return {
        "cputype": cputype,
        "dylibs": dylibs,
        "rpaths": rpaths,
        "dylinker": dylinker,
        "cryptid": cryptid,
        "ncmds": ncmds,
    }


def plist_str(data, key):
    """在 Info.plist 里粗略取 <key>K</key><string>V</string>。"""
    m = re.search(
        rb"<key>" + key.encode() + rb"</key>\s*<(string|integer)>([^<]{0,200})<",
        data,
    )
    return m.group(2).decode("utf-8", "replace") if m else None


def main():
    if not os.path.isdir(PAY):
        w("[FATAL] Payload 不存在，需先跑 ipa_dl.sh")
        write_out()
        return 2

    w("=" * 78)
    w("第十二层：启动链 / 持久化 / 依赖注入取证")
    w("=" * 78)

    # ---------- 1. 目录规模 ----------
    w("\n# A. Payload 结构与规模")
    w("=" * 78)
    apps = []
    for root, dirs, files in os.walk(PAY):
        for d in list(dirs):
            if d.endswith(".app"):
                apps.append(os.path.join(root, d))
    n_files = n_macho = 0
    total = 0
    for root, _dirs, files in os.walk(PAY):
        for f in files:
            p = os.path.join(root, f)
            n_files += 1
            try:
                total += os.path.getsize(p)
            except OSError:
                pass
    w("  .app 数量        : %d" % len(apps))
    w("  文件总数         : %d" % n_files)
    w("  解包总字节       : %d (%.2f MB)" % (total, total / 1048576.0))

    for a in apps:
        w("\n  [app] %s" % os.path.relpath(a, PAY))
        try:
            top = sorted(os.listdir(a))
        except OSError:
            continue
        w("    顶层条目 %d 个: %s" % (len(top), ", ".join(top[:24])))

    # ---------- 2. Info.plist ----------
    w("\n# B. Info.plist 关键字段")
    w("=" * 78)
    for a in apps:
        pi = os.path.join(a, "Info.plist")
        if not os.path.isfile(pi):
            continue
        data = open(pi, "rb").read()
        w("\n  [%s]  %d B" % (os.path.basename(a), len(data)))
        for k in ("CFBundleIdentifier", "CFBundleExecutable", "CFBundleName",
                  "CFBundleShortVersionString", "CFBundleVersion",
                  "MinimumOSVersion", "UIFileSharingEnabled",
                  "NSAppTransportSecurity", "UIBackgroundModes"):
            v = plist_str(data, k)
            if v:
                w("    %-28s = %s" % (k, v))
        schemes = re.findall(rb"<key>CFBundleURLSchemes</key>\s*<array>(.*?)</array>",
                             data, re.S)
        for s in schemes:
            found = re.findall(rb"<string>([^<]{1,80})</string>", s)
            w("    URLSchemes                   = %s"
              % ", ".join(x.decode("utf-8", "replace") for x in found))
        # 权限用途描述（隐私权限面向用户暴露的能力）
        usage = re.findall(rb"<key>(NS[A-Za-z]*(?:UsageDescription|Purpose))</key>", data)
        if usage:
            w("    隐私权限用途键 %d 个:" % len(usage))
            for u in usage[:20]:
                w("      · %s" % u.decode())
        # 后台模式具体值
        bg = re.search(rb"<key>UIBackgroundModes</key>\s*<array>(.*?)</array>", data, re.S)
        if bg:
            w("    后台模式 = %s"
              % ", ".join(x.decode() for x in re.findall(rb"<string>([^<]+)</string>", bg.group(1))))

    # ---------- 3. Mach-O 与加载链 ----------
    w("\n# C. Mach-O 清单 + 依赖注入链")
    w("=" * 78)
    machos = []
    for root, _dirs, files in os.walk(PAY):
        for f in files:
            p = os.path.join(root, f)
            try:
                if os.path.getsize(p) > 400 * 1048576:
                    continue
                with open(p, "rb") as fh:
                    head = fh.read(8)
            except OSError:
                continue
            if is_macho(head):
                machos.append(p)
    w("  检出 Mach-O  %d 个\n" % len(machos))

    injected = []
    for p in sorted(machos):
        rel = os.path.relpath(p, PAY)
        data = open(p, "rb").read()
        sl = slices(data)
        w("  ---- %s  (%.2f MB, %d 切片)" % (rel, len(data) / 1048576.0, len(sl)))
        for (off, size, cpu) in sl[:2]:
            chunk = data[off:off + size]
            info = parse_lcs(chunk)
            if not info:
                continue
            w("       cpu=0x%x cryptid=%s ncmds=%d"
              % (info["cputype"], info["cryptid"], info["ncmds"]))
            for tag, name in info["dylibs"]:
                if "/System/Library/" in name or "/usr/lib/" in name:
                    continue
                w("         %-22s %s" % (tag.replace("LC_", ""), name))
                if name.startswith("@executable_path") or name.startswith("@loader_path") \
                        or name.startswith("@rpath"):
                    injected.append((rel, name))
            for r in info["rpaths"]:
                w("         RPATH                  %s" % r)
            for d in info["dylinker"]:
                w("         DYLINKER               %s" % d)

    # ---------- 4. 持久化面 ----------
    w("\n# D. 持久化 / 自启 / 注入配置面")
    w("=" * 78)
    hits = 0
    pat = re.compile(rb"launchd|LaunchDaemon|LaunchAgent|SMJobBless|"
                     rb"installd|mobile_installation|DYLD_INSERT_LIBRARIES|"
                     rb"amfi_get_out_of_my_way|dynamic-codesigning|"
                     rb"task_for_pid|vm_write|kernel_read|kernel_write|"
                     rb"IOConnectCallMethod|IOServiceOpen", re.I)
    for p in sorted(machos):
        data = open(p, "rb").read()
        found = {}
        for m in pat.finditer(data):
            k = m.group(0).decode("ascii", "replace").lower()
            found[k] = found.get(k, 0) + 1
        if found:
            hits += 1
            w("  [%s]" % os.path.relpath(p, PAY))
            for k in sorted(found):
                w("      %-32s x%d" % (k, found[k]))
    if not hits:
        w("  无命中")

    # 物理存在 launchd plist？
    lp = []
    for root, _dirs, files in os.walk(PAY):
        for f in files:
            if "launch" in f.lower() and f.lower().endswith(".plist"):
                lp.append(os.path.relpath(os.path.join(root, f), PAY))
    w("\n  launchd 类 plist 实体: %s" % (", ".join(lp) if lp else "无（不含开机自启配置）"))

    # ---------- 5. 注入清单汇总 ----------
    w("\n# E. 注入组件汇总（@executable_path / @rpath 依赖）")
    w("=" * 78)
    if injected:
        for host, name in injected:
            w("  %s  →  %s" % (host, name))
    else:
        w("  无局部依赖注入")

    # ---------- 6. 外联端点二次确认 ----------
    w("\n# F. 外联端点二次确认（排除 Apple 白名单）")
    w("=" * 78)
    dom = re.compile(
        rb"(?:[a-z0-9](?:[a-z0-9\-]{0,40}[a-z0-9])?\.){1,4}"
        rb"(?:com|cn|net|org|io|dev|app|xyz|top|cc|me|tv|info|vip|club|site"
        rb"|online|shop|link|pro|live|fun|space|store|tech|icu|buzz|work|art"
        rb"|ai|co|us|uk|jp|kr|hk|tw|sg|ru|to|ws|bz|gl|la|gd|tk|ml|ga|cf|gq)"
        rb"(?![A-Za-z0-9._\-])"
    )
    NOISE = ("apple.com", "icloud.com", "mzstatic.com", "w3.org", "gnu.org",
             "opensource.org", "llvm.org", "example.com", "localhost",
             "apple.co", "swift.org", "json.org", "sqlite.org", "zlib.net")
    all_dom = {}
    for p in sorted(machos):
        data = open(p, "rb").read()
        for m in dom.finditer(data):
            d = m.group(0).decode("ascii", "replace")
            if any(n in d for n in NOISE):
                continue
            all_dom.setdefault(d, set()).add(os.path.basename(p))
    if all_dom:
        for d in sorted(all_dom, key=lambda x: -len(x)):
            w("  %-42s ← %s" % (d, ", ".join(sorted(all_dom[d]))[:80]))
    else:
        w("  无第三方域名（除 Apple 白名单外零命中）")

    write_out()
    return 0


def write_out():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    txt = "\n".join(L)
    with open(OUT, "w") as f:
        f.write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    sys.exit(main())
