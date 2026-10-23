#!/usr/bin/env python3
"""IPA 结构侦察：Info.plist / 可执行文件 / 加密状态 / Framework / 插件 / 资源统计。"""
import os, sys, json, plistlib, subprocess, collections

LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
PAY = os.path.join(LAB, "Payload")


def find_app():
    for n in sorted(os.listdir(PAY)):
        if n.endswith(".app"):
            return os.path.join(PAY, n)
    return None


def macho_magic(path):
    try:
        with open(path, "rb") as f:
            h = f.read(8)
    except OSError:
        return None
    if h[:4] in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe"):
        return "thin"
    if h[:4] in (b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"):
        return "fat"
    if h[:8] == b"!<arch>\n":
        return "staticlib"
    return None


def walk(root):
    for dp, dn, fn in os.walk(root):
        for f in fn:
            yield os.path.join(dp, f)


def main():
    app = find_app()
    if not app:
        print("NO APP FOUND"); return 1
    out = collections.OrderedDict()
    out["app"] = os.path.basename(app)

    ip = os.path.join(app, "Info.plist")
    info = {}
    if os.path.exists(ip):
        try:
            with open(ip, "rb") as f:
                info = plistlib.load(f)
        except Exception:
            # 可能是二进制 plist 的变体
            try:
                raw = subprocess.run(["plutil", "-convert", "xml1", "-o", "-", ip],
                                     capture_output=True).stdout
                info = plistlib.loads(raw)
            except Exception as e:
                info = {"_error": str(e)}
    keep = ["CFBundleIdentifier", "CFBundleName", "CFBundleDisplayName", "CFBundleShortVersionString",
            "CFBundleVersion", "CFBundleExecutable", "MinimumOSVersion", "CFBundleURLTypes",
            "UIBackgroundModes", "NSAppTransportSecurity", "NSFaceIDUsageDescription",
            "NSPhotoLibraryUsageDescription", "NSCameraUsageDescription", "NSMicrophoneUsageDescription",
            "NSContactsUsageDescription", "NSLocationWhenInUseUsageDescription",
            "UIFileSharingEnabled", "LSApplicationQueriesSchemes", "CFBundleDocumentTypes",
            "NSAppleMusicUsageDescription", "NSCalendarsUsageDescription", "NSRemindersUsageDescription",
            "NSBluetoothAlwaysUsageDescription", "NSLocalNetworkUsageDescription"]
    out["info"] = {k: info.get(k) for k in keep if k in info}
    out["info_keys"] = sorted(info.keys())

    exe = info.get("CFBundleExecutable") or os.path.splitext(os.path.basename(app))[0]
    exep = os.path.join(app, exe)
    out["exe"] = exe
    out["exe_exists"] = os.path.exists(exep)
    if os.path.exists(exep):
        out["exe_size"] = os.path.getsize(exep)
        out["exe_magic"] = macho_magic(exep)
        out["exe_sha256"] = subprocess.run(["sha256sum", exep], capture_output=True, text=True).stdout.split()[0]

    # 资源统计
    ext_count = collections.Counter()
    total = 0
    big = []
    for p in walk(app):
        total += os.path.getsize(p)
        e = os.path.splitext(p)[1].lower() or "<none>"
        ext_count[e] += 1
        if os.path.getsize(p) > 1_500_000:
            big.append((os.path.relpath(p, app), os.path.getsize(p)))
    out["file_count"] = sum(ext_count.values())
    out["total_unpacked_bytes"] = total
    out["top_ext"] = ext_count.most_common(25)
    out["big_files"] = sorted(big, key=lambda x: -x[1])[:25]

    # 内嵌 Mach-O（framework / dylib / appex / 静态库）
    machos, dylibs, appex, bundles = [], [], [], []
    for p in walk(app):
        m = macho_magic(p)
        if m in ("thin", "fat"):
            rel = os.path.relpath(p, app)
            machos.append((rel, os.path.getsize(p), m))
            if rel.endswith(".dylib"):
                dylibs.append(rel)
        if ".appex/" in p or p.endswith(".appex"):
            appex.append(os.path.relpath(p, app))
    out["macho_count"] = len(machos)
    out["machos"] = sorted(machos, key=lambda x: -x[1])[:40]
    out["dylibs"] = dylibs
    out["appex_sample"] = appex[:20]

    # 目录概览
    dirs = []
    for dp, dn, fn in os.walk(app):
        rel = os.path.relpath(dp, app)
        if rel.count(os.sep) <= 1:
            dirs.append((rel, len(fn)))
    out["dirs"] = sorted(dirs)[:40]

    print(json.dumps(out, ensure_ascii=False, indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
