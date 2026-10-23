#!/usr/bin/env python3
"""第十三层：Info.plist 真实解析 + 越狱工具链组件定性 + 卡密/窃密指标。

要点：
  A. 用 plistlib 正确解析（binary / xml 双兼容）
  B. 三个注入 framework 的字符串与 ObjC 类名定性
  C. 卡密 / 授权 / 激活 / 校验 语义定位（中英文 + UTF-16）
  D. 窃密指标：通讯录/相册/剪贴板/keychain/文件遍历/上传
  E. 内核利用面：kfd / XPF / ChOma / AMFI / PPL 关键字
"""
import os
import plistlib
import re
import sys

LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
PAY = os.path.join(LAB, "Payload")
WS = os.environ.get("GITHUB_WORKSPACE", ".")
OUT = os.path.join(WS, "logs", "audit", "deep13.txt")

L = []


def w(s=""):
    L.append(str(s))


def ascii_strings(data, minlen=6):
    out = set()
    for m in re.finditer(rb"[\x20-\x7e]{%d,}" % minlen, data):
        out.add(m.group(0).decode("ascii", "replace"))
    return out


def utf16_strings(data, minlen=4):
    """UTF-16LE 可打印串（含中文）。"""
    out = set()
    pat = re.compile(rb"(?:[\x20-\x7e]\x00|[\x00-\xff][\x4e-\x9f]){%d,}" % minlen)
    for m in pat.finditer(data):
        raw = m.group(0)
        if len(raw) % 2:
            raw = raw[:-1]
        try:
            s = raw.decode("utf-16-le", "ignore")
        except Exception:
            continue
        s = s.strip()
        if len(s) >= minlen and any(c.isprintable() for c in s):
            out.add(s)
    return out


def main():
    if not os.path.isdir(PAY):
        w("[FATAL] Payload 缺失")
        write_out()
        return 2

    app = None
    for root, dirs, _f in os.walk(PAY):
        for d in dirs:
            if d.endswith(".app"):
                app = os.path.join(root, d)
                break
        if app:
            break
    if not app:
        w("[FATAL] 未找到 .app")
        write_out()
        return 2

    w("=" * 78)
    w("第十三层：Info.plist 解析 + 越狱工具链定性 + 卡密/窃密指标")
    w("=" * 78)

    # ---------- A. Info.plist ----------
    w("\n# A. Info.plist（plistlib 真实解析）")
    w("=" * 78)
    pi = os.path.join(app, "Info.plist")
    raw = open(pi, "rb").read()
    w("  文件 %d B   magic=%r" % (len(raw), raw[:8]))
    try:
        pl = plistlib.loads(raw)
    except Exception as e:
        pl = {}
        w("  [ERROR] plistlib 解析失败: %s" % e)

    if pl:
        keys = [
            "CFBundleIdentifier", "CFBundleExecutable", "CFBundleName",
            "CFBundleDisplayName", "CFBundleShortVersionString",
            "CFBundleVersion", "MinimumOSVersion", "SDKVersion",
            "DTPlatformName", "DTSDKName", "CFBundlePackageType",
            "UIDeviceFamily", "UIFileSharingEnabled", "LSSupportsOpeningDocumentsInPlace",
            "ITSAppUsesNonExemptEncryption", "UIRequiredDeviceCapabilities",
            "CFBundleDevelopmentRegion", "BuildMachineOSBuild",
        ]
        for k in keys:
            if k in pl:
                v = pl[k]
                if isinstance(v, (list, tuple)):
                    v = ", ".join(str(x) for x in v[:8])
                w("    %-32s = %s" % (k, v))

        w("\n    -- URL Scheme --")
        for t in (pl.get("CFBundleURLTypes") or []):
            w("      %s : %s" % (t.get("CFBundleURLName"), t.get("CFBundleURLSchemes")))

        w("\n    -- 隐私权限用途（能力面直接证据） --")
        usage = {k: v for k, v in pl.items() if k.endswith("UsageDescription")}
        if usage:
            for k in sorted(usage):
                w("      %-38s %s" % (k, str(usage[k])[:70]))
        else:
            w("      无（未声明任何隐私权限）")

        w("\n    -- 后台 / 其他 --")
        for k in ("UIBackgroundModes", "NSAppTransportSecurity",
                  "NSAllowsArbitraryLoads", "NSExceptionDomains",
                  "NSLocalNetworkUsageDescription", "NSBonjourServices",
                  "LSApplicationQueriesSchemes"):
            if k in pl:
                w("      %-32s %s" % (k, str(pl[k])[:160]))

        w("\n    -- 全部键（%d 个） --" % len(pl))
        w("      " + ", ".join(sorted(pl.keys())))

    # ---------- B/C/D/E: 逐组件定性 ----------
    targets = []
    for root, _d, files in os.walk(app):
        for f in files:
            p = os.path.join(root, f)
            if f.endswith(".dylib") or "/Frameworks/" in p:
                targets.append(p)
    main_bin = os.path.join(app, pl.get("CFBundleExecutable", "Kimi"))
    if os.path.isfile(main_bin):
        targets.append(main_bin)

    K_LICENSE = [
        "card_key", "cardkey", "license", "activate", "activation", "activate_code",
        "serial", "regcode", "reg_code", "auth_code", "verify_code", "voucher",
        "redeem", "trial", "expire", "expiry", "subscription", "device_id",
        "udid", "idfa", "bind", "unbind", "machine_code", "hwid",
        "卡密", "授权", "激活", "注册码", "校验", "到期", "试用", "绑定", "解绑",
        "设备码", "机器码", "密钥", "验证", "会员", "续费", "购买",
    ]
    K_STEAL = [
        "CNContactStore", "ABAddressBook", "PHPhotoLibrary", "PHAsset",
        "UIPasteboard", "SecItemCopyMatching", "kSecClassGenericPassword",
        "NSFileManager", "enumeratorAtPath", "contentsOfDirectoryAtPath",
        "SMSSupport", "MFMessageCompose", "CTTelephonyNetworkInfo",
        "identifierForVendor", "UIDevice", "getifaddrs",
        "NSUserDefaults suiteName", "keychain", "sskeychain", "SAMKeychain",
        "uploadFile", "multipart/form-data", "PUT", "POST ",
    ]
    K_KERNEL = [
        "kfd", "xpf", "choma", "amfi", "ppl", "kpp", "sandbox_escape",
        "kernel_read", "kernel_write", "physpuppet", "landa", "weightBufs",
        "IOSurface", "IOConnectTrap", "task_for_pid", "thread_create_running",
        "mach_vm_write", "vm_allocate", "PAC", "arm64e", "trollstore",
        "dopamine", "palera1n", "jbclient", "jailbreakd", "launchd_sim",
        "dyld_patch", "LC_CODE_SIGNATURE", "codesign",
    ]

    w("\n# B. 组件清单与体量")
    w("=" * 78)
    seen = set()
    comps = []
    for p in targets:
        if p in seen:
            continue
        seen.add(p)
        if not os.path.isfile(p):
            continue
        comps.append(p)
        w("  %-56s %8.2f MB" % (os.path.relpath(p, app), os.path.getsize(p) / 1048576.0))

    w("\n# C. 卡密 / 授权语义定位（按组件）")
    w("=" * 78)
    w("\n# D. 窃密 / 外发指标（按组件）")
    w("=" * 78)
    w("\n# E. 内核利用 / 越狱框架面（按组件）")
    w("=" * 78)

    # 先收集，再分区打印
    res = {}
    for p in comps:
        data = open(p, "rb").read()
        asc = ascii_strings(data, 6)
        u16 = utf16_strings(data, 4)
        pool = asc | u16
        low_pool = {}
        for s in pool:
            low_pool.setdefault(s.lower(), s)

        def hit(kws):
            out = {}
            for kw in kws:
                k = kw.lower()
                if k in low_pool:
                    out[kw] = low_pool[k]
                    continue
                # 子串扫描（针对 "POST " 这类）
                c = 0
                for s in pool:
                    if k in s.lower():
                        c += 1
                        if c > 3:
                            break
                if c:
                    out[kw] = "<子串命中 x%d>" % c
            return out

        res[p] = {
            "lic": hit(K_LICENSE),
            "steal": hit(K_STEAL),
            "kern": hit(K_KERNEL),
            "asc_n": len(asc),
            "u16_n": len(u16),
        }

    for p in comps:
        r = res[p]
        rel = os.path.relpath(p, app)
        w("\n  ┌─ %s   (ASCII串 %d / UTF16串 %d)" % (rel, r["asc_n"], r["u16_n"]))
        for label, key in (("卡密/授权", "lic"), ("窃密/外发", "steal"), ("内核/越狱", "kern")):
            if r[key]:
                w("  │  [%s] %d 命中" % (label, len(r[key])))
                for k in sorted(r[key])[:26]:
                    w("  │      %-26s → %s" % (k, str(r[key][k])[:56]))
            else:
                w("  │  [%s] 无命中" % label)
        w("  └─")

    # ---------- F. 三方域名全量（含 UTF 串） ----------
    w("\n# F. 所有组件中的三方端点（含 UTF-16 串）")
    w("=" * 78)
    dom = re.compile(
        rb"(?:https?://)?(?:[a-z0-9](?:[a-z0-9\-]{0,40}[a-z0-9])?\.){1,4}"
        rb"(?:com|cn|net|org|io|dev|app|xyz|top|cc|me|tv|info|vip|club|site"
        rb"|online|shop|link|pro|live|fun|space|store|tech|icu|buzz|work|art"
        rb"|ai|co|us|uk|jp|kr|hk|tw|sg|ru|to|ws|bz|gl|la|gd|tk|ml|ga|cf|gq)"
        rb"(?![A-Za-z0-9._\-])"
    )
    NOISE = ("apple.com", "icloud.com", "mzstatic.com", "w3.org", "gnu.org",
             "opensource.org", "llvm.org", "example.com", "localhost",
             "apple.co", "swift.org", "json.org", "sqlite.org", "zlib.net",
             "kimi.com", "moonshot.cn", "moonshot.ai")
    found = {}
    for p in comps:
        data = open(p, "rb").read()
        for m in dom.finditer(data):
            d = m.group(0).decode("ascii", "replace")
            if any(n in d for n in NOISE):
                continue
            found.setdefault(d, set()).add(os.path.basename(p))
    if found:
        w("  非 Apple / 非官方端点：")
        for d in sorted(found):
            w("    %-44s ← %s" % (d, ", ".join(sorted(found[d]))[:70]))
    else:
        w("  零命中")

    # ---------- G. kfd / XPF 版本指纹 ----------
    w("\n# G. 越狱组件版本指纹（判断风险等级）")
    w("=" * 78)
    VER = re.compile(rb"(?:kfd|choma|xpf|libjailbreak|dopamine|palera1n|"
                     rb"ClearSword|DarkSword)[ -]?v?[0-9]+\.[0-9]+(?:\.[0-9]+)?", re.I)
    for p in comps:
        data = open(p, "rb").read()
        vs = sorted({m.group(0).decode("ascii", "replace") for m in VER.finditer(data)})
        if vs:
            w("  %s" % os.path.relpath(p, app))
            for v in vs[:12]:
                w("      %s" % v)

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
