#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第十层：FAT 切片解析 + 选择器级能力审计 + 端点全量重扫 + 窃密外发指标。

A. FAT 架构清单：把 libxpf / libchoma / libjailbreak 的每个架构切片拆出来单独解析
   （第九层跳过了 FAT，这三个注入库才是真正干活的部分）
B. 选择器级能力审计：把全部 _objc_msgSend$<selector> 按敏感域分桶
   —— 回答"有没有真的去读剪贴板 / Keychain / 通讯录 / 相册 / 设备指纹"
C. 端点全量重扫：http(s)/ws/域名 逐二进制归属，含切片内部
D. 窃密外发指标：敏感源读取 + 序列化 + 上传 三者是否同时存在（组合判定，不是单词命中）
E. 卡密/授权系统归属定位：授权关键字落在哪个二进制
F. 白苹果风险面：内核写 / 快照 / 引导 / 签名绕过 相关字面量
G. 判定汇总

零依赖。产物 logs/audit/deep10.txt
"""
import os
import re
import struct

LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
PAY = os.path.join(LAB, "Payload")
OUT = os.path.join(os.environ.get("GITHUB_WORKSPACE", "."), "logs", "audit")
os.makedirs(OUT, exist_ok=True)

THIN64 = b"\xcf\xfa\xed\xfe"
THIN32 = b"\xce\xfa\xed\xfe"
FAT32 = b"\xca\xfe\xba\xbe"
FAT64 = b"\xca\xfe\xba\xbf"

LC_SYMTAB = 0x2
LC_ENCRYPTION_INFO = 0x21
LC_ENCRYPTION_INFO_64 = 0x2C
LC_SEGMENT_64 = 0x19
LC_SEGMENT = 0x1
LC_LOAD_DYLIB = 0xC
LC_ID_DYLIB = 0xD
LC_LAZY_LOAD_DYLIB = 0x20
LC_LOAD_WEAK_DYLIB = 0x80000018
LC_REEXPORT_DYLIB = 0x8000001F
LC_RPATH = 0x8000001C
DYLIB_CMD = {
    LC_LOAD_DYLIB: "LOAD", LC_ID_DYLIB: "ID", LC_LAZY_LOAD_DYLIB: "LAZY",
    LC_LOAD_WEAK_DYLIB: "WEAK", LC_REEXPORT_DYLIB: "REEXPORT",
}

CPU = {0xC: "arm64", 0x7: "x86", 0xC * 0 + 12: "arm", 0x01000007: "x86_64"}


def cpu_name(t):
    if t == 0x0100000C:
        return "arm64"
    if t == 0x01000007:
        return "x86_64"
    if t == 12:
        return "arm"
    if t == 7:
        return "i386"
    return "cpu0x%x" % t


def read_str(data, off):
    if off < 0 or off >= len(data):
        return ""
    end = data.find(b"\x00", off)
    if end < 0:
        end = min(off + 300, len(data))
    return data[off:end].decode("utf-8", "replace")


def load_commands(data, is64):
    if len(data) < 32:
        return []
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


def symtab_of(data, is64):
    for cmd, off, _ in load_commands(data, is64):
        if cmd == LC_SYMTAB and off + 24 <= len(data):
            return struct.unpack_from("<IIII", data, off + 8)
    return None


def imports_of(data, is64):
    st = symtab_of(data, is64)
    if not st:
        return []
    symoff, nsyms, stroff, strsize = st
    entsz = 16 if is64 else 12
    if symoff + nsyms * entsz > len(data) or stroff + strsize > len(data):
        return []
    names = set()
    for i in range(min(nsyms, 400000)):
        base = symoff + i * entsz
        n_strx = struct.unpack_from("<I", data, base)[0]
        if data[base + 4] & 0x0E != 0x0E:
            continue
        s = read_str(data, stroff + n_strx)
        if s:
            names.add(s)
    return sorted(names)


def exports_of(data, is64):
    st = symtab_of(data, is64)
    if not st:
        return []
    symoff, nsyms, stroff, strsize = st
    entsz = 16 if is64 else 12
    if off_ok(symoff, nsyms, entsz, len(data)) is False:
        return []
    names = set()
    for i in range(min(nsyms, 400000)):
        base = symoff + i * entsz
        n_strx = struct.unpack_from("<I", data, base)[0]
        n_type = data[base + 4]
        if n_type & 0x0E == 0x0E or n_type & 0x01 == 0:
            continue
        s = read_str(data, stroff + n_strx)
        if s:
            names.add(s)
    return sorted(names)


def off_ok(a, b, c, limit):
    return a + b * c <= limit


def cryptid_of(data, is64):
    for cmd, off, cmdsize in load_commands(data, is64):
        if cmd in (LC_ENCRYPTION_INFO, LC_ENCRYPTION_INFO_64) and off + 16 <= len(data):
            cryptoff, cryptsize, cryptid = struct.unpack_from("<III", data, off + 8)
            return cryptid, cryptsize
    return -1, 0


def dylibs_rpaths(data, is64):
    libs, rps = [], []
    for cmd, off, cmdsize in load_commands(data, is64):
        if cmd in DYLIB_CMD and off + 12 <= len(data):
            no = struct.unpack_from("<I", data, off + 8)[0]
            if no < cmdsize:
                libs.append((DYLIB_CMD[cmd], read_str(data, off + no)))
        elif cmd == LC_RPATH and off + 12 <= len(data):
            no = struct.unpack_from("<I", data, off + 8)[0]
            if no < cmdsize:
                s = read_str(data, off + no)
                if s:
                    rps.append(s)
    return libs, sorted(set(rps))


def slices_of(data):
    """返回 [(cpu, subtype, offset, size, is64)]；thin 返回自身。"""
    if data[:4] in (THIN64, THIN32):
        is64 = data[:4] == THIN64
        cputype = struct.unpack_from("<I", data, 4)[0]
        return [(cpu_name(cputype), 0, 0, len(data), is64)]
    if data[:4] not in (FAT32, FAT64):
        return []
    be = ">" if data[:4] in (FAT32, FAT64) else "<"
    n = struct.unpack_from(be + "I", data, 4)[0]
    out = []
    if data[:4] == FAT64:
        base = 8
        for i in range(min(n, 32)):
            eo = base + i * 32
            if eo + 32 > len(data):
                break
            ct, cs, of, sz, _al, _r = struct.unpack_from(be + "IIQQII", data, eo)
            out.append((cpu_name(ct), cs, of, sz, True))
    else:
        base = 8
        for i in range(min(n, 32)):
            eo = base + i * 20
            if eo + 20 > len(data):
                break
            ct, cs, of, sz, _al = struct.unpack_from(be + "IIIII", data, eo)
            out.append((cpu_name(ct), cs, of, sz, sz and True))
    return out


# ---------------------------------------------------------------- 敏感域
DOMAINS = {
    "剪贴板": ["pasteboard", "UIPasteboard"],
    "Keychain/凭据": ["SecItemAdd", "SecItemCopyMatching", "SecItemUpdate", "SecItemDelete",
                  "SecKeyChain", "SecTrustEvaluate"],
    "通讯录/日历": ["CNContactStore", "CNContactFetchRequest", "ABAddressBook",
               "EKEventStore", "EKEvent"],
    "相册/相机": ["PHPhotoLibrary", "PHAsset", "PHImageManager", "PHFetchResult",
              "UIImagePickerController", "AVCaptureSession", "AVCaptureDevice"],
    "定位": ["CLLocationManager", "startUpdatingLocation"],
    "设备指纹": ["identifierForVendor", "advertisingIdentifier", "IDFA", "IDFV",
             "openUDID", "deviceToken", "uniqueIdentifier", "systemVersion",
             "machineName", "MobileGestalt"],
    "WebView/JS注入": ["WKWebView", "evaluateJavaScript", "loadHTMLString",
                    "loadRequest:", "addUserScript", "WKUserScript",
                    "stringByEvaluatingJavaScript"],
    "上传/表单外发": ["uploadTaskWithRequest", "multipartFormRequestWithBlock",
                "dataTaskWithRequest", "setHTTPBody", "setValue:forHTTPHeaderField",
                "fileURLWithPath"],
    "动态执行": ["dlopen", "dlsym", "NSClassFromString", "NSSelectorFromString",
             "performSelector", "method_setImplementation",
             "class_replaceMethod", "objc_msgSend", "NSCreateObjectFileImageFromMemory"],
    "内核/内存": ["IOSurface", "IOConnectCallStructMethod", "mach_vm_read_overwrite",
             "mach_vm_write", "task_for_pid", "mach_port_insert_right"],
    "越狱/反调试": ["jailbreak", "cydia", "substrate", "frida", "cycript", "ptrace",
               "PT_DENY_ATTACH", "sysctl"],
}

# ---------------------------------------------------------------- 卡密语义
LICENSE_KEYS = ["NOBLEKEY", "noblekey", "卡密", "激活码", "授权码", "续费", "到期",
                "激活", "授权", "未登录", "验证失败", "试用", "天卡", "月卡", "年卡",
                "永久卡", "机器码", "设备码", "代理", "在线验证", "登录失败",
                "license", "License", "activate", "activation", "trial",
                "expire", "expired", "machineCode", "deviceCode"]

WHITE_APPLE = ["/System/Library", "launchctl", "SpringBoard", "MobileSubstrate",
               "amfi", "AMFI", "csr_active_config", "APFS", "snapshot",
               "nvram", "boot-args", "iokit_darwin", "kernel", "kern_",
               "NXSupervisorCall", "pmap", "phys_write", "kwrite", "kread",
               "IOHIDSystem", "IOSurfaceRoot", "trust_cache", "bootloader",
               "dyld_cache", "jailbreakd", "TrollStore", "kfd"]

URL_PAT = re.compile(rb"(?:https?|wss?|tcp)://"
                     rb"[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]{4,160}")
DOM_PAT = re.compile(
    rb"(?<![A-Za-z0-9._\-])"
    rb"(?:[a-z0-9](?:[a-z0-9\-]{0,40}[a-z0-9])?\.){1,4}"
    rb"(?:com|cn|net|org|io|dev|app|xyz|top|cc|me|tv|info|vip|club|site"
    rb"|online|shop|link|pro|live|fun|space|store|tech|icu|buzz|work|art"
    rb"|ai|co|us|uk|jp|kr|hk|tw|sg|ru|to|ws|bz|gl|la|gd|tk|ml|ga|cf|gq)"
    rb"(?![A-Za-z0-9._\-])")

DOM_NOISE = ("apple.com", "icloud.com", "mzstatic.com", "w3.org", "gnu.org",
             "opensource.org", "llvm.org", "example.com", "localhost",
             "schemas.android.com", "xml.org", "json.org", "python.org",
             "khronos.org", "unicode.org", "gstatic.com", "googleapis.com")

UTF16_ASCII = re.compile((rb"(?:[\x20-\x7e]\x00){3,}" ))


def ascii_runs(data, minlen=4):
    return re.findall(rb"[\x20-\x7e]{%d,200}" % minlen, data)


def wide_runs(data):
    out = []
    for m in re.finditer(rb"(?:[\x20-\x7e]\x00){4,}[\x20-\x7e]", data):
        try:
            s = m.group(0).decode("utf-16-le", "replace")
        except Exception:
            continue
        out.append(s)
    return out


def main():
    buf = []
    W = buf.append
    W("=" * 78)
    W("第十层：FAT 切片 + 选择器级能力审计 + 端点重扫 + 窃密外发指标")
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

    sel_all = {}
    urls_all = {}
    doms_all = {}
    lic_hits = {}
    wa_hits = {}
    slice_rows = []

    # -------------------------------------------------- A. FAT 切片
    W("")
    W("# A. FAT 架构清单与逐切片解析")
    payloads = {}
    for rel, p in targets:
        with open(p, "rb") as f:
            data = f.read()
        sl = slices_of(data)
        W("")
        W("  %s  (%d B, %d 个架构切片)" % (rel, len(data), len(sl)))
        for cpu, sub, of, sz, is64 in sl:
            if of + sz > len(data) or sz <= 0:
                W("     - %-8s 切片越界，跳过" % cpu)
                continue
            chunk = data[of:of + sz]
            head = chunk[:4]
            is64 = head == THIN64
            mag = struct.unpack_from("<I", chunk, 12)[0] if len(chunk) > 16 else 0
            cid, csz = cryptid_of(chunk, is64)
            imp = imports_of(chunk, is64)
            exp = exports_of(chunk, is64)
            libs, rps = dylibs_rpaths(chunk, is64)
            ncm = len(load_commands(chunk, is64))
            slice_rows.append((rel, cpu, sz, cid, len(imp), len(exp), ncm))
            if rel not in payloads:
                payloads[rel] = chunk if len(sl) == 1 else b""
            W("     - %-8s off=%-9d size=%-8d filetype=0x%x cryptid=%d lc=%d imp=%d exp=%d"
              % (cpu, of, sz, mag, cid, ncm, len(imp), len(exp)))
            for kind, path in libs:
                if kind in ("LOAD", "WEAK", "REEXPORT"):
                    W("         link[%s] %s" % (kind, path))
            for r in rps:
                W("         rpath   %s" % r)

            # 敏感选择器（含切片）
            for s in imp:
                if s.startswith("_objc_msgSend$"):
                    sel = s[len("_objc_msgSend$"):]
                    sel_all.setdefault(sel, set()).add(rel)
            for pat in URL_PAT.finditer(chunk):
                u = pat.group(0).decode("utf-8", "replace")
                urls_all.setdefault(u, set()).add(rel)
            for pat in DOM_PAT.finditer(chunk):
                d = pat.group(0).decode("utf-8", "replace").lower()
                doms_all.setdefault(d, set()).add(rel)

            # 关键字：ASCII + UTF-16
            txt = chunk.decode("latin-1", "ignore")
            wide = wide_runs(chunk)
            widestr = "\n".join(wide)
            for k in LICENSE_KEYS:
                if k in txt or k in widestr:
                    lic_hits.setdefault(k, set()).add(rel + ":" + cpu)
            for k in WHITE_APPLE:
                if k in txt or k in widestr:
                    wa_hits.setdefault(k, set()).add(rel + ":" + cpu)

    # -------------------------------------------------- B. 选择器级审计
    W("")
    W("=" * 78)
    W("# B. 选择器级能力审计（_objc_msgSend$<selector>，全架构合计 %d 个唯一选择器）"
      % len(sel_all))
    W("=" * 78)
    for dom, keys in DOMAINS.items():
        hits = []
        for sel, owners in sel_all.items():
            low = sel
            for k in keys:
                kk = k.rstrip(":")
                if kk.lower() in low.lower():
                    hits.append((sel, sorted(owners)))
                    break
        W("")
        W("  [%s] 命中 %d 个选择器" % (dom, len(hits)))
        for sel, owners in sorted(hits)[:40]:
            W("     %-46s <- %s" % (sel, ", ".join(o.split("/")[-1] for o in owners)))
        if len(hits) > 40:
            W("     ... 另有 %d 个" % (len(hits) - 40))

    # -------------------------------------------------- C. 端点重扫
    W("")
    W("=" * 78)
    W("# C. 端点全量重扫（含 FAT 切片内部）")
    W("=" * 78)
    W("  URL 字面量 %d 条 / 域名字面量 %d 条" % (len(urls_all), len(doms_all)))
    W("")
    W("  -- URL --")
    for u in sorted(urls_all)[:120]:
        W("     %-72s <- %s" % (u[:72], ", ".join(sorted(o.split("/")[-1] for o in urls_all[u]))))
    W("")
    W("  -- 域名（已剔除系统/无关）--")
    shown = 0
    for d in sorted(doms_all):
        if any(n in d for n in DOM_NOISE):
            continue
        W("     %-46s <- %s" % (d, ", ".join(sorted(o.split("/")[-1] for o in doms_all[d]))))
        shown += 1
    if not shown:
        W("     （无第三方域名）")

    # -------------------------------------------------- D. 窃密外发指标
    W("")
    W("=" * 78)
    W("# D. 窃密外发指标（组合判定：读取敏感源 + 序列化 + 上传）")
    W("=" * 78)
    sel_low = [s.lower() for s in sel_all]

    def has(*needles):
        for s in sel_low:
            for n in needles:
                if n.lower() in s:
                    return True
        return False

    src_keys = {
        "相册/照片": ("phasset", "phphotolibrary", "phimagemanager", "phfetchresult"),
        "剪贴板": ("pasteboard",),
        "Keychain": ("secitem", "seckeychain"),
        "通讯录": ("cncontact", "abaddressbook"),
        "日历": ("ekevent",),
        "定位": ("cllocationmanager",),
        "设备指纹": ("identifierforvendor", "advertisingidentifier", "openudid"),
        "文件系统遍历": ("contentsofdirectory", "enumeratoratpath", "subpathsofdirectory",
                  "datacontentsofdirectory"),
        "应用清单": ("lsapplicationworkspace", "allinstalledapplications",
                 "applicationslist"),
    }
    mid_keys = {
        "序列化": ("jsonobjectwithdata", "jsonserialization", "propertylistserialization",
                "archiveddatawithrootobject", "datataskwithrequest"),
        "压缩打包": ("ziparchive", "createzipfile", "compressionstream", "decompressfile"),
        "编码": ("base64encoded", "base64encodestring", "hexstring", "aesencrypt"),
    }
    out_keys = {
        "HTTP 上传": ("uploadtaskwithrequest", "multipartformrequestwithblock",
                   "datataskwithrequest", "sethttpbody", "setvalueforhttpheaderfield"),
        "URL 请求构造": ("urlwithstring", "initwithurl", "requestwithurl"),
    }

    found_src = {}
    for name, keys in src_keys.items():
        hit = [s for s in sel_low if any(k in s for k in keys)]
        found_src[name] = hit
        W("  [源] %-12s %s" % (name, ("命中 %d 个选择器" % len(hit)) if hit else "未命中"))
        for h in sorted(set(hit))[:6]:
            W("        - %s" % h)
    found_mid = {}
    for name, keys in mid_keys.items():
        hit = [s for s in sel_low if any(k in s for k in keys)]
        found_mid[name] = hit
        W("  [中] %-12s %s" % (name, ("命中 %d" % len(hit)) if hit else "未命中"))
    found_out = {}
    for name, keys in out_keys.items():
        hit = [s for s in sel_low if any(k in s for k in keys)]
        found_out[name] = hit
        W("  [出] %-12s %s" % (name, ("命中 %d" % len(hit)) if hit else "未命中"))

    W("")
    W("  >> 组合判定：")
    sens = [k for k, v in found_src.items() if v]
    W("     敏感数据源可达： %s" % (", ".join(sens) if sens else "无"))
    W("     序列化/打包链： %s" % (", ".join(k for k, v in found_mid.items() if v) or "无"))
    W("     外发通道：     %s" % (", ".join(k for k, v in found_out.items() if v) or "无"))

    # -------------------------------------------------- E. 卡密归属
    W("")
    W("=" * 78)
    W("# E. 卡密/授权系统归属定位")
    W("=" * 78)
    if not lic_hits:
        W("  未命中任何授权语义关键字（ASCII / UTF-16 双通道）")
    for k in sorted(lic_hits, key=lambda x: -len(lic_hits[x])):
        owners = sorted(lic_hits[k])
        W("  %-14s 命中 %d 处 <- %s" % (k, len(owners), ", ".join(owners[:8])))
        if len(owners) > 8:
            W("                  ... 另有 %d 处" % (len(owners) - 8))

    # -------------------------------------------------- F. 白苹果
    W("")
    W("=" * 78)
    W("# F. 白苹果 / 系统完整性风险面")
    W("=" * 78)
    for k in sorted(wa_hits, key=lambda x: -len(wa_hits[x])):
        owners = sorted(wa_hits[k])
        W("  %-18s %d 处 <- %s" % (k, len(owners), ", ".join(owners[:6])))
        if len(owners) > 6:
            W("                     ... 另有 %d 处" % (len(owners) - 6))

    # -------------------------------------------------- G. 汇总
    W("")
    W("=" * 78)
    W("# G. 判定汇总")
    W("=" * 78)
    W("  二进制总数（含 FAT 切片展开）：%d" % len(slice_rows))
    enc = [r for r in slice_rows if r[3] not in (-1, 0)]
    W("  加密切片：%d / %d（cryptid != 0）" % (len(enc), len(slice_rows)))
    for rel, cpu, sz, cid, ni, ne, ncm in slice_rows:
        W("    %-34s %-7s cryptid=%-3d imp=%-5d exp=%-4d lc=%d"
          % (rel.split("/")[-1][:34], cpu, cid, ni, ne, ncm))

    path = os.path.join(OUT, "deep10.txt")
    text = "\n".join(buf) + "\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("deep10.txt lines=%d chars=%d" % (len(buf), len(text)))


if __name__ == "__main__":
    main()
