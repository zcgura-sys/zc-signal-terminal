#!/usr/bin/env python3
"""定向取证：注入组件归属 + 可疑域名的归属定位 + 卡密/授权面测绘。

产出 $GITHUB_WORKSPACE/logs/audit/deep.txt（供 read_file 分页阅读）
零依赖。
"""
import os, re, json, plistlib

LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
OUT = os.path.join(os.environ.get("GITHUB_WORKSPACE", "."), "logs", "audit")
PAY = os.path.join(LAB, "Payload")
MAG = (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf")

SUSPECT_DOMAINS = ["woqbefiz.pk", "notification.hud.live", "glv.io", "b.rs", "d.fi",
                   "g.io", "y.to", "ip.ph", "perf.dev", "research.com", "subject.cn",
                   "api.appledb.dev"]

AUTH_KW = ["卡", "密", "授权", "激活", "会员", "到期", "设备", "绑定", "注册", "验证",
           "购买", "订单", "付费", "试用", "登", "licen", "card", "active", "vip",
           "member", "expire", "device", "bind", "regist", "token", "sign", "verify",
           "order", "pay", "trial", "config", "udid", "receipt", "auth"]

EXFIL_KW = ["NSURLSession", "NSURLConnection", "uploadTask", "multipart", "base64Encoded",
            "SecItemCopyMatching", "kSecReturnData", "PHAsset", "CNContactStore",
            "UIPasteboard", "generalPasteboard", "enumeratorAtPath", "subpathsOfDirectory",
            "NSHomeDirectory", "writeToFile", "createFileAtPath", "sqlite3_open",
            "zipArchive", "SSZipArchive", "MBProgressHUD", "UIAlertController"]


def strings(buf):
    out = []
    for m in re.finditer(rb"[\x20-\x7e\t]{5,400}", buf):
        out.append(m.group().decode("latin-1"))
    for m in re.finditer(rb"(?:[\x20-\x7e]\x00){5,400}", buf):
        out.append(m.group().decode("utf-16-le", "ignore"))
    return out


def mosaic(buf, needle, pad=140, limit=6):
    """打印 needle 前后的十六进制/文本上下文，看清它长什么样。"""
    res = []
    for enc in ("latin-1", "utf-16-le"):
        nb = needle.encode(enc, "ignore")
        start = 0
        while len(res) < limit:
            i = buf.find(nb, start)
            if i < 0:
                break
            lo = max(0, i - pad)
            hi = min(len(buf), i + len(nb) + pad)
            chunk = buf[lo:hi]
            txt = "".join(chr(c) if 32 <= c < 127 else "." for c in chunk)
            res.append("@0x%x [%s] %s" % (i, enc, txt))
            start = i + len(nb)
    return res


def main():
    os.makedirs(OUT, exist_ok=True)
    L = []
    A = L.append

    machos = []
    for r, _d, fs in os.walk(PAY):
        for f in sorted(fs):
            p = os.path.join(r, f)
            try:
                with open(p, "rb") as fh:
                    if fh.read(4) in MAG:
                        machos.append((os.path.relpath(p, PAY), p))
            except Exception:
                continue

    A("=" * 78)
    A("A. Mach-O 清单")
    A("=" * 78)
    for rel, p in machos:
        A("  %-52s %10d B" % (rel, os.path.getsize(p)))

    # ---- B. 可疑域名归属 ----
    A("")
    A("=" * 78)
    A("B. 可疑字符串归属定位（哪个二进制、什么上下文）")
    A("=" * 78)
    for d in SUSPECT_DOMAINS:
        A("")
        A("--- %s ---" % d)
        found_any = False
        for rel, p in machos:
            buf = open(p, "rb").read()
            ctx = mosaic(buf, d, pad=110, limit=3)
            if ctx:
                found_any = True
                A("  [%s]" % rel)
                for c in ctx:
                    A("    " + c)
        if not found_any:
            A("  (仅在文件系统路径/plist 中出现，二进制内未直接命中)")

    # ---- C. 每个注入组件的能力面 ----
    A("")
    A("=" * 78)
    A("C. 注入组件能力面（关键字命中计数）")
    A("=" * 78)
    for rel, p in machos:
        if rel.endswith("/Kimi"):
            continue
        buf = open(p, "rb").read()
        ss = strings(buf)
        A("")
        A("--- %s ---" % rel)
        low = "\n".join(ss).lower()
        for kw in ["dlopen", "dlsym", "posix_spawn", "execve", "fork", "system(",
                   "task_for_pid", "mach_port", "mprotect", "mmap",
                   "IOSurface", "IOConnectCallStructMethod", "kernel_read", "kernel_write",
                   "tfp0", "amfi", "csops", "ptrace", "sysctl", "getppid",
                   "NSURLSession", "NSURLConnection", "writeToFile", "SecItemCopyMatching",
                   "UIPasteboard", "NSHomeDirectory", "enumeratorAtPath",
                   "sqlite3", "unzip", "inflate", "dzip", "lzma", "zstd",
                   "Dopamine", "kfd", "libjailbreak", "xpf", "choma", "substrate",
                   "config", "license", "卡密", "授权", "device", "udid"]:
            c = low.count(kw.lower())
            if c:
                A("    %-28s x%d" % (kw, c))

    # ---- D. 主程序注入点 & entitlements ----
    A("")
    A("=" * 78)
    A("D. 主程序 Kimi：LC_LOAD_DYLIB / entitlements / Info.plist")
    A("=" * 78)
    kimi = None
    for rel, p in machos:
        if rel.endswith("/Kimi"):
            kimi = p
            break
    if kimi:
        buf = open(kimi, "rb").read()
        A("")
        A("-- 内嵌 dylib 加载路径（@rpath / @executable_path / 绝对路径）--")
        for m in sorted(set(re.findall(rb"@rpath/[A-Za-z0-9_.%/\-]{2,120}", buf))):
            A("    " + m.decode("latin-1"))
        for m in sorted(set(re.findall(rb"@executable_path/[A-Za-z0-9_.%/\-]{2,120}", buf))):
            A("    " + m.decode("latin-1"))
        A("")
        A("-- entitlements 关键项 --")
        for key in [b"com.apple.accessibility.api", b"backboard.client",
                    b"get-task-allow", b"platform-application",
                    b"com.apple.private.security.no-sandbox",
                    b"com.apple.private.security.container-required",
                    b"dynamic-codesigning", b"com.apple.private.cs.debugger",
                    b"com.apple.private.amfi", b"kernel", b"task_for_pid"]:
            if key in buf:
                A("    HIT  " + key.decode("latin-1"))

        A("")
        A("-- 内嵌 plist（entitlements 原文片段）--")
        i = 0
        n = 0
        while n < 3:
            i = buf.find(b"<?xml", i)
            if i < 0:
                break
            j = buf.find(b"</plist>", i)
            if j < 0:
                break
            blob = buf[i:j + 8]
            try:
                pl = plistlib.loads(blob)
                A("    [plist %d] keys=%s" % (n, list(pl.keys())[:24]))
                n += 1
            except Exception:
                pass
            i = j + 8

    # ---- E. 授权/卡密面测绘（只描述结构，不含绕过方案）----
    A("")
    A("=" * 78)
    A("E. 授权/卡密相关字符串（全组件，按组件分组）")
    A("=" * 78)
    auth_report = {}
    for rel, p in machos:
        buf = open(p, "rb").read()
        ss = strings(buf)
        hits = []
        for s in dict.fromkeys(ss):
            ls = s.lower()
            if any(k.lower() in ls for k in AUTH_KW) and 3 < len(s) < 160:
                hits.append(s)
        if hits:
            auth_report[rel] = hits
            A("")
            A("--- %s (%d hits, 显示前 70) ---" % (rel, len(hits)))
            for h in hits[:70]:
                A("    " + h.replace("\x00", ""))

    # ---- F. 数据外传面 ----
    A("")
    A("=" * 78)
    A("F. 数据外传能力分布（按二进制）")
    A("=" * 78)
    exfil = {}
    for rel, p in machos:
        buf = open(p, "rb").read()
        ss = strings(buf)
        low = "\n".join(ss)
        got = [k for k in EXFIL_KW if k in low]
        exfil[rel] = got
        A("  %-52s %s" % (rel, ", ".join(got) if got else "-"))

    with open(os.path.join(OUT, "deep.txt"), "w") as fh:
        fh.write("\n".join(L) + "\n")

    with open(os.path.join(OUT, "auth_map.json"), "w") as fh:
        json.dump({"auth_strings": auth_report, "exfil": exfil},
                  fh, ensure_ascii=False, indent=1, default=str)

    print("\n".join(L[:1]))
    print("deep.txt lines=%d  auth_map groups=%d" % (len(L), len(auth_report)))


if __name__ == "__main__":
    main()
