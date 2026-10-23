#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第九层：真实导入符号(nlist) + 加载链 + 权限面 + 动态执行链 + 内核利用面。

A. 每个 Mach-O 的真实链接库 / rpath / install_name（加载链）
B. 导入符号表（N_UNDF external）按危险类别分桶 —— 回答"是否偷文件/Keychain/相册"
C. 动态执行与反射能力（dlopen/dlsym/NSClassFromString/method_*）—— 回答"能否被下发代码"
D. Info.plist 权限面 + ATS 配置 —— 回答"服务器能否把明文流量引到外部"
E. 签名与 provisioning entitlements
F. C++ mangled 符号（c++filt 解混淆）—— 判定外挂层真实功能结构
G. 内核原语面（kfd：漏洞利用被内置到哪一步）

零依赖（c++filt 缺失时自动降级）。产物 logs/audit/deep9.txt
"""
import os
import re
import plistlib
import shutil
import struct
import subprocess

LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
PAY = os.path.join(LAB, "Payload")
APP = os.path.join(PAY, "Kimi.app")
OUT = os.path.join(os.environ.get("GITHUB_WORKSPACE", "."), "logs", "audit")
os.makedirs(OUT, exist_ok=True)

THIN = {b"\xcf\xfa\xed\xfe": 64, b"\xce\xfa\xed\xfe": 32}
FAT = (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf")

LC_SYMTAB = 0x2
LC_LOAD_DYLIB = 0xC
LC_ID_DYLIB = 0xD
LC_LOAD_WEAK_DYLIB = 0x8000001C
LC_REEXPORT_DYLIB = 0x8000001F
LC_LOAD_UPWARD_DYLIB = 0x80000023
LC_RPATH = 0x8000001C | 0x1  # 占位，实际用下面表判定
DYLIB_CMD = {
    LC_LOAD_DYLIB: "LOAD",
    LC_ID_DYLIB: "ID",
    LC_LOAD_WEAK_DYLIB: "WEAK",
    LC_REEXPORT_DYLIB: "REEXPORT",
    LC_LOAD_UPWARD_DYLIB: "UPWARD",
}
RPATH_CMDS = (0x8000001C, 0x80000023, 0x1C)  # 由 cmd 名二次确认


def is_macho(head):
    return head in THIN or head in FAT


def machos(root):
    for dirpath, _d, files in os.walk(root):
        for fn in files:
            p = os.path.join(dirpath, fn)
            try:
                with open(p, "rb") as f:
                    head = f.read(4)
            except OSError:
                continue
            if is_macho(head):
                yield os.path.relpath(p, os.path.dirname(root)), p


def load_commands(data, is64):
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


def sections_of(data, is64):
    out = []
    segcmd = 0x19 if is64 else 0x1
    for cmd, off, _ in load_commands(data, is64):
        if cmd != segcmd:
            continue
        nsects = struct.unpack_from("<I", data, off + (64 if is64 else 48))[0]
        base = off + (72 if is64 else 56)
        for i in range(min(nsects, 512)):
            so = base + i * (80 if is64 else 68)
            if so + 56 > len(data):
                break
            sname = data[so:so + 16].split(b"\x00")[0].decode("utf-8", "replace")
            seg = data[so + 16:so + 32].split(b"\x00")[0].decode("utf-8", "replace")
            if is64:
                sz = struct.unpack_from("<Q", data, so + 40)[0]
                fo = struct.unpack_from("<I", data, so + 48)[0]
            else:
                sz = struct.unpack_from("<I", data, so + 36)[0]
                fo = struct.unpack_from("<I", data, so + 40)[0]
            out.append((sname, seg, fo, sz))
    return out


def read_str(data, off):
    end = data.find(b"\x00", off)
    if end < 0:
        return ""
    return data[off:end].decode("utf-8", "replace")


def dylibs_and_rpaths(data, is64):
    """返回 ([(kind, path)], [rpath])"""
    libs, rpaths = [], []
    base = 32 if is64 else 28
    for cmd, off, cmdsize in load_commands(data, is64):
        if cmd in DYLIB_CMD:
            name_off = struct.unpack_from("<I", data, off + 8)[0]
            if off + name_off < off + cmdsize and off + name_off < len(data):
                libs.append((DYLIB_CMD[cmd], read_str(data, off + name_off)))
        elif cmd in (0x8000001C, 0x1C, 0x80000023):
            # LC_RPATH 与 LC_LOAD_WEAK_DYLIB 同值 0x8000001C，用内容判别
            if off + 12 <= len(data):
                path_off = struct.unpack_from("<I", data, off + 8)[0]
                s = read_str(data, off + path_off) if off + path_off < len(data) else ""
                if s.startswith("@") or s.startswith("/"):
                    rpaths.append(s)
    # 去重，LC_RPATH 已被上面的弱链接判定污染，交给调用方过滤
    return libs, sorted(set(rpaths))


def symtab(data, is64):
    for cmd, off, _ in load_commands(data, is64):
        if cmd != LC_SYMTAB:
            continue
        if off + 24 > len(data):
            return None
        symoff, nsyms, stroff, strsize = struct.unpack_from("<IIII", data, off + 8)
        return symoff, nsyms, stroff, strsize
    return None


def imported_symbols(data, is64):
    """N_UNDF external -> 该二进制从外部（系统库）借用的能力清单"""
    st = symtab(data, is64)
    if not st:
        return []
    symoff, nsyms, stroff, strsize = st
    entsz = 16 if is64 else 12
    if symoff + nsyms * entsz > len(data) or stroff + strsize > len(data):
        return []
    names = set()
    for i in range(nsyms):
        base = symoff + i * entsz
        n_strx = struct.unpack_from("<I", data, base)[0]
        n_type = data[base + 4]
        if n_type & 0x0E != 0x0E:      # 非 N_UNDF|N_EXT
            continue
        s = read_str(data, stroff + n_strx)
        if s:
            names.add(s)
    return sorted(names)


def export_symbols(data, is64):
    st = symtab(data, is64)
    if not st:
        return []
    symoff, nsyms, stroff, strsize = st
    entsz = 16 if is64 else 12
    if symoff + nsyms * entsz > len(data):
        return []
    names = set()
    for i in range(nsyms):
        base = symoff + i * entsz
        n_strx = struct.unpack_from("<I", data, base)[0]
        n_type = data[base + 4]
        if n_type & 0x0E == 0x0E:
            continue
        if n_type & 0x01 == 0:          # 非 external
            continue
        s = read_str(data, stroff + n_strx)
        if s:
            names.add(s)
    return sorted(names)


CATS = {
    "A1 文件遍历/枚举": ["NSFileManager", "contentsOfDirectory", "enumeratorAtPath",
                    "NSDirectoryEnumerator", "subpathsOfDirectory", "fts_", "opendir",
                    "readdir", "scandir", "glob", "nftw", "getdirentries"],
    "A2 文件读写": ["fopen", "fwrite", "fread", "_open", "_read", "_write", "mmap",
                 "unlink", "_rename", "_stat", "lstat", "realpath", "truncate", "fsync",
                 "NSData", "writeToFile", "dataWithContentsOfFile"],
    "A3 Keychain/凭据": ["SecItem", "SecKeychain", "kSecClass", "SecKey"],
    "A4 相册/相机/麦克风": ["PHPhoto", "PHAsset", "UIImagePicker", "AVCapture",
                     "ALAsset", "AVAudio", "AVFoundation"],
    "A5 通讯录/日历/健康": ["CNContact", "ABAddress", "EKEvent", "HKHealth"],
    "A6 剪贴板": ["UIPasteboard", "pasteboard", "Pasteboard"],
    "A7 定位": ["CLLocation", "CoreLocation"],
    "A8 网络外联": ["NSURLSession", "NSURLConnection", "NSURLRequest", "CFHTTP",
                "CFSocket", "getaddrinfo", "_connect", "socket", "SecTrust", "SSLHandshake",
                "CFReadStream", "CFWriteStream"],
    "A9 动态执行/反射": ["dlopen", "dlsym", "dlerror", "NSClassFromString",
                   "NSSelectorFromString", "class_getInstanceMethod",
                   "method_exchangeImplementations", "method_setImplementation",
                   "class_replaceMethod", "imp_implementationWithBlock",
                   "performSelector", "objc_msgSend", "objc_getClass",
                   "objc_getClassList", "NSBundle", "loadNibNamed"],
    "A10 进程/特权": ["fork", "posix_spawn", "execve", "_exit", "ptrace", "task_for_pid",
                  "sysctl", "getppid", "setuid", "setgid", "kill"],
    "A11 内核/内存原语": ["mach_vm_", "vm_allocate", "vm_deallocate", "vm_read",
                    "vm_write", "IOSurface", "IOConnect", "mach_port", "host_",
                    "thread_create", "thread_switch", "mach_msg", "proc_pidinfo"],
    "A12 加密/哈希": ["CCCrypt", "CC_MD5", "CC_SHA", "CCCryptor", "AES", "CommonCrypto",
                  "SecRandomCopyBytes"],
    "A13 越狱/环境检测": ["jailbreak", "cydia", "substrate", "frida", "cycript",
                    "libhooker", "/var/jb", "MobileSubstrate"],
    "A14 持久化/偏好": ["NSUserDefaults", "CFPreferences", "synchronize",
                   "LSApplicationWorkspace", "UIApplicationOpenURL"],
}

MOONSHOT = ["moonshot", "月之暗面", "kimi.moonshot", "KimiChat", "chat.kimi",
            "kimi.com", "kimi-", "moonshot.cn"]

DANGER_PATH_PAT = re.compile(
    r"(/var/mobile/[A-Za-z0-9_\-/.]{2,80}"
    r"|/var/jb[A-Za-z0-9_\-/.]{0,60}"
    r"|/Library/MobileSubstrate[A-Za-z0-9_\-/.]{0,40}"
    r"|/private/var/[A-Za-z0-9_\-/.]{2,80}"
    r"|/tmp/[A-Za-z0-9_\-.]{2,40}\.dylib"
    r"|@executable_path/[A-Za-z0-9_\-./]{2,60}"
    r"|@rpath/[A-Za-z0-9_\-./]{2,60})"
)

MANGLE_PAT = re.compile(rb"__Z[A-Za-z0-9_$.]{6,120}")


def cxx_demangle(names):
    if not names:
        return {}
    tool = shutil.which("c++filt") or shutil.which("llvm-cxxfilt")
    if not tool:
        return {}
    try:
        p = subprocess.run([tool], input="\n".join(names), capture_output=True,
                           text=True, timeout=90)
    except Exception:
        return {}
    out = p.stdout.splitlines()
    return dict(zip(names, out))


def main():
    buf = []
    W = buf.append
    W("=" * 78)
    W("第九层：导入符号真实能力面 + 加载链 + 权限面 + 内核利用面")
    W("=" * 78)

    # ---------- 包结构 ----------
    W("")
    W("# 0. 包内可执行体与扩展分布")
    apps = sorted(os.listdir(PAY)) if os.path.isdir(PAY) else []
    W("  Payload 顶层: " + ", ".join(apps))
    for a in apps:
        ap = os.path.join(PAY, a)
        if not os.path.isdir(ap):
            W("    [文件] %s (%d B)" % (a, os.path.getsize(ap)))
            continue
        W("    [app] %s" % a)
        for entry in sorted(os.listdir(ap)):
            ep = os.path.join(ap, entry)
            kind = "dir" if os.path.isdir(ep) else "file"
            sz = "" if kind == "dir" else " (%d B)" % os.path.getsize(ep)
            W("      - %s%s %s" % (entry, sz, kind))
        for sub in ("PlugIns", "Watch", "AppExtensions", "Frameworks"):
            sp = os.path.join(ap, sub)
            if os.path.isdir(sp):
                W("      [%s] %s" % (sub, ", ".join(sorted(os.listdir(sp)))))

    dep_pool = {}

    for rel, p in sorted(machos(PAY)):
        with open(p, "rb") as f:
            data = f.read()
        head = data[:4]
        if head in FAT:
            W("")
            W("-" * 78)
            W("### %s  -> FAT 多架构，跳过深度解析 (%d B)" % (rel, len(data)))
            continue
        is64 = THIN[head] == 64
        lcs = load_commands(data, is64)
        secs = sections_of(data, is64)
        imp = imported_symbols(data, is64)
        exp = export_symbols(data, is64)
        libs, rpaths = dylibs_and_rpaths(data, is64)

        W("")
        W("-" * 78)
        W("### %s   (%d B, %s)" % (rel, len(data), "arm64" if is64 else "armv7"))
        W("  导入符号 %d | 导出符号 %d | 链接库 %d | 段数 %d"
          % (len(imp), len(exp), len(libs), len(secs)))

        # 加载链
        for kind, path in libs:
            if kind == "ID":
                W("  install_name: " + path)
            else:
                W("  link[%s]: %s" % (kind, path))
                if path.startswith("/") and "/usr/lib" not in path and "/System/" not in path:
                    W("    !! 非系统路径链接库（可疑）")
                if path.startswith("@executable_path") or path.startswith("@rpath"):
                    dep_pool.setdefault(path, []).append(rel)
        if rpaths:
            W("  rpath: " + ", ".join(rpaths))

        # 明文敏感路径
        txt = data.decode("latin-1")
        paths = sorted(set(m.group(0) for m in DANGER_PATH_PAT.finditer(txt)))
        if paths:
            W("  [路径字面量 %d 条]" % len(paths))
            for q in paths[:25]:
                W("    " + q[:110])

        # 能力分桶
        bucket_hit = {}
        for cat, keys in CATS.items():
            hits = sorted({s for s in imp if any(k in s for k in keys)})
            if hits:
                bucket_hit[cat] = hits
        if bucket_hit:
            W("  [导入能力面]")
            for cat in sorted(bucket_hit):
                v = bucket_hit[cat]
                W("    %s (%d): %s" % (cat, len(v), ", ".join(v[:14])))
                if len(v) > 14:
                    W("        ...")

        # C++ 层
        mangled = sorted({m.decode("latin-1")[2:] for m in MANGLE_PAT.findall(data)})
        if mangled:
            dem = cxx_demangle(mangled[:400])
            names = [dem.get(m, m) for m in mangled[:400]]
            img = [n for n in names if "ImGui" in n or "imgui" in n]
            fun = [n for n in names if any(k in n.lower() for k in
                    ("aim", "esp", "hud", "wall", "magic", "speed", "fly", "esp", "cheat",
                     "menu", "draw", "render", "hook", "patch", "memory", "skin", "box",
                     "crosshair", "no_recoil", "spread", "radar", "bone", "world"))]
            W("  [C++ mangled 符号 %d]  含 ImGui %d 条 | 功能相关 %d 条"
              % (len(mangled), len(img), len(fun)))
            for n in (img[:4] + fun[:18]):
                W("    " + n[:130])

        # Moonshot 痕迹
        m_hit = {k: txt.count(k) for k in MOONSHOT if txt.count(k)}
        W("  Moonshot 原厂痕迹: " + (str(m_hit) if m_hit else "无"))

    # ---------- Info.plist ----------
    W("")
    W("=" * 78)
    W("# D. Info.plist 权限面 / ATS / URL Scheme")
    W("=" * 78)
    ip = os.path.join(APP, "Info.plist")
    pl = {}
    if os.path.isfile(ip):
        with open(ip, "rb") as f:
            raw = f.read()
        try:
            pl = plistlib.loads(raw)
        except Exception as e:
            W("  !! Info.plist 解析失败: %s" % e)
    if pl:
        keys = ["CFBundleIdentifier", "CFBundleExecutable", "CFBundleShortVersionString",
                "CFBundleVersion", "MinimumOSVersion", "CFBundleDisplayName",
                "UIFileSharingEnabled", "LSSupportsOpeningDocumentsInPlace",
                "NSAppTransportSecurity", "LSApplicationQueriesSchemes",
                "UIRequiredDeviceCapabilities", "UIBackgroundModes",
                "ITSAppUsesNonExemptEncryption", "NSAppleMusicUsageDescription"]
        for k in keys:
            if k in pl:
                W("  %s = %s" % (k, pl[k]))
        usage = {k: v for k, v in pl.items() if k.endswith("UsageDescription")}
        W("  [隐私权限用途描述 %d 条]" % len(usage))
        for k, v in sorted(usage.items()):
            W("    %s: %s" % (k, str(v)[:80]))
        schemes = pl.get("CFBundleURLTypes") or []
        for s in schemes:
            W("  URLScheme: %s" % s.get("CFBundleURLSchemes"))
        aps = pl.get("NSAppTransportSecurity")
        if isinstance(aps, dict):
            W("  ATS 允许明文: %s | 允许任意加载: %s"
              % (aps.get("NSAllowsArbitraryLoads"),
                 aps.get("NSAllowsArbitraryLoadsInWebContent")))

    # ---------- 签名 / entitlements ----------
    W("")
    W("=" * 78)
    W("# E. 签名与 provisioning")
    W("=" * 78)
    for cand in ("embedded.mobileprovision", "_CodeSignature/CodeResources",
                 "SC_Info", "CodeResources", "PkgInfo"):
        cp = os.path.join(APP, cand)
        W("  %-38s %s" % (cand, "存在" if os.path.exists(cp) else "缺失"))
    mp = os.path.join(APP, "embedded.mobileprovision")
    if os.path.isfile(mp):
        with open(mp, "rb") as f:
            mraw = f.read()
        W("  mobileprovision %d B" % len(mraw))
        i = mraw.find(b"<?xml")
        j = mraw.rfind(b"</plist>")
        if i >= 0 and j > i:
            try:
                mp_pl = plistlib.loads(mraw[i:j + 8])
                W("  Name: %s" % mp_pl.get("Name"))
                W("  AppIDName: %s" % mp_pl.get("AppIDName"))
                W("  TeamIdentifier: %s" % mp_pl.get("TeamIdentifier"))
                W("  ExpirationDate: %s" % mp_pl.get("ExpirationDate"))
                ent = mp_pl.get("Entitlements") or {}
                for k in ("application-identifier", "get-task-allow",
                          "com.apple.developer.team-identifier",
                          "keychain-access-groups",
                          "com.apple.security.application-groups"):
                    if k in ent:
                        W("  entitlement %s = %s" % (k, ent[k]))
                if ent.get("get-task-allow"):
                    W("  !! get-task-allow = true -> 开发签名，可被调试/重签")
            except Exception as e:
                W("  !! provisioning 解析失败: %s" % e)
        for sig in ("Developer", "Distribution", "iPhone Developer", "iPhone Distribution"):
            if sig.encode() in mraw:
                W("  provisioning 签名类型: " + sig)

    # ---------- 汇总判定 ----------
    W("")
    W("=" * 78)
    W("# F. 汇总判定")
    W("=" * 78)
    W("  共享依赖路径: " + (str(dep_pool) if dep_pool else "无 @executable_path/@rpath 依赖"))

    out_path = os.path.join(OUT, "deep9.txt")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(buf) + "\n")
    print("deep9.txt lines=%d chars=%d" % (len(buf), sum(len(x) for x in buf)))


if __name__ == "__main__":
    main()
