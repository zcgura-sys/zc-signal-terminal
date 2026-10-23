#!/usr/bin/env python3
"""第三层：身份真伪 / 内核写入面 / 文件窃取面 / 签名与描述文件。

产出 logs/audit/deep3.txt
"""
import os, re, plistlib, json, collections

LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
WS = os.environ.get("GITHUB_WORKSPACE", ".")
OUT = os.path.join(WS, "logs", "audit")
PAY = os.path.join(LAB, "Payload")
APP = os.path.join(PAY, "Kimi.app")


def strings(buf, n=4):
    out = []
    for m in re.finditer(rb"[\x20-\x7e\t]{%d,400}" % n, buf):
        out.append(m.group().decode("latin-1"))
    for m in re.finditer(rb"(?:[\x20-\x7e]\x00){%d,400}" % n, buf):
        out.append(m.group().decode("utf-16-le", "ignore"))
    return out


def ctx(buf, needle, rad=140, limit=4):
    out, i, nb = [], 0, needle if isinstance(needle, bytes) else needle.encode()
    while len(out) < limit:
        i = buf.find(nb, i)
        if i < 0:
            break
        lo, hi = max(0, i - rad), min(len(buf), i + len(nb) + rad)
        out.append("".join(chr(b) if 32 <= b < 127 else "." for b in buf[lo:hi]))
        i += len(nb)
    return out


GROUPS = {
    "内核写入 / 提权": ["kernel_write", "kwrite", "kread", "physrw", "pmap", "ttbr", "PAC",
                        "krw_", "task_for_pid", "host_priv", "IOMMU", "pte"],
    "NVRAM / 引导链（白苹果直接相关）": ["nvram", "NVRAM", "boot-logo", "bootlogo", "boot_logo",
                                       "iBoot", "iboot", "kernelcache", "Img4", "img4",
                                       "apfs", "AMFI", "trustcache", "SSV", "seal", "bootx"],
    "绕过签名 / 注入": ["amfi", "AMFI", "inject", "dylib", "resign", "codesign", "cs_blob",
                        "setuid", "unsandbox", "sandbox_extension", "debugserver"],
    "文件窃取": ["CNContact", "ABAddressBook", "PHAsset", "PHPhotoLibrary", "UIPasteboard",
                 "SecItemCopyMatching", "kSecClass", "MFMailCompose", "EKEvent",
                 "NSFileManager", "enumeratorAtPath", "contentsOfDirectoryAtPath",
                 "NSHomeDirectory", "Library/Caches", "Documents", "sms.db", "CallHistory",
                 "WeChat", "ChatStorage", "keychain", "Keychain", "cookie", "Cookie"],
    "设备指纹 / 追踪": ["identifierForVendor", "advertisingIdentifier", "deviceName",
                        "IOPlatformUUID", "serialNumber", "uniqueDeviceIdentifier",
                        "sysctlbyname", "hw.machine", "boot_uuid", "bootSession"],
    "Kimi 正品特征（真伪判定）": ["moonshot", "Moonshot", "kimi.moonshot.cn", "kimi.com",
                                "chat completions", "openai", "bearer", "Bearer ",
                                "conversation", "message", "upload"],
}


def main():
    os.makedirs(OUT, exist_ok=True)
    L = []
    A = L.append

    macho = []
    for r, _d, fs in os.walk(PAY):
        for f in fs:
            p = os.path.join(r, f)
            try:
                if open(p, "rb").read(4) in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe",
                                             b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
                    macho.append((os.path.relpath(p, PAY), p))
            except Exception:
                pass
    bufs = {}
    for rel, p in macho:
        bufs[rel] = open(p, "rb").read()

    A("=" * 78)
    A("A. 打包身份真伪：这些 dylib 到底属于谁")
    A("=" * 78)
    for sub in ["Frameworks/kfd.framework/Info.plist",
                "Frameworks/ClearSword.framework/Info.plist",
                "Frameworks/DarkSword.framework/Info.plist"]:
        p = os.path.join(APP, sub)
        if not os.path.exists(p):
            continue
        pl = plistlib.load(open(p, "rb"))
        A("")
        A("--- %s ---" % sub)
        for k in sorted(pl):
            v = pl[k]
            if isinstance(v, (str, int, bool, float)):
                A("    %-30s %s" % (k, str(v)[:110]))

    A("")
    A("--- 代码签名 / 描述文件 ---")
    for rel in ["_CodeSignature/CodeResources", "embedded.mobileprovision",
                "SC_Info", "CodeResources"]:
        p = os.path.join(APP, rel)
        A("    %-46s %s" % (rel, "存在 (%d B)" % os.path.getsize(p) if os.path.exists(p)
                            else "缺失"))
    for r, _d, fs in os.walk(APP):
        for f in fs:
            if f == "embedded.mobileprovision":
                A("    发现描述文件: %s" % os.path.relpath(os.path.join(r, f), APP))
    prov = os.path.join(APP, "embedded.mobileprovision")
    if os.path.exists(prov):
        raw = open(prov, "rb").read()
        for pat in [rb"<key>Name</key>\s*<string>([^<]{1,80})</string>",
                    rb"<key>TeamIdentifier</key>.*?<string>([^<]{2,40})</string>",
                    rb"<key>application-identifier</key>\s*<string>([^<]{1,120})</string>",
                    rb"<key>Platform</key>\s*<array>\s*<string>([^<]{1,30})</string>",
                    rb"<key>ExpirationDate</key>\s*<date>([^<]{1,40})</date>"]:
            m = re.search(pat, raw, re.S)
            A("    %-30s %s" % (pat.decode()[:28],
                                m.group(1).decode("utf-8", "ignore") if m else "-"))

    A("")
    A("=" * 78)
    A("B. 主程序是不是「真的 Kimi」")
    A("=" * 78)
    main = bufs.get("Kimi.app/Kimi")
    if main is None:
        main = bufs.get([k for k in bufs if k.endswith("/Kimi")][0])
    SA = strings(main)
    n_all = len(SA)
    hits = {k: 0 for k in ["moonshot", "kimi", "Kimi", "openai", "chat", "bootlogo",
                           "boot-logo", "jailbreak", "exploit", "Sileo", "Cydia",
                           "TrollStore", "Dopamine", "choma", "xpf", "kfd"]}
    for s in SA:
        low = s.lower()
        for k in hits:
            if k.lower() in low:
                hits[k] += 1
    A("  主程序可打印字符串总量: %d" % n_all)
    for k, v in sorted(hits.items(), key=lambda x: -x[1]):
        A("    %-16s %d" % (k, v))
    A("")
    A("  -- moonshot / kimi 域名与接口 --")
    for pat in [rb"https?://[A-Za-z0-9_.\-]*moonshot[A-Za-z0-9_./%\-?=&]*",
                rb"https?://[A-Za-z0-9_.\-]*kimi[A-Za-z0-9_./%\-?=&]*",
                rb"https?://[A-Za-z0-9_.\-]{4,60}\.(?:cn|com|net|io|ai)[A-Za-z0-9_./%\-?=&]{0,60}"]:
        for m in set(re.findall(pat, main, re.I)):
            A("      " + m.decode("latin-1")[:130])
    A("")
    A("  -- 界面/业务痕迹（判断是聊天 App 还是越狱工具）--")
    for kw in [b"boot logo", b"Boot Logo", b"live mode", b"Live Mode", b"HUD",
               b"selectedKernelExploit", b"cheatSignatures", b"matchSignatureCountInText"]:
        c = ctx(main, kw, 110, 2)
        if c:
            A("    [%s] %s" % (kw.decode(), c[0][:190]))

    A("")
    A("=" * 78)
    A("C. 危险能力分组命中（逐二进制）")
    A("=" * 78)
    for rel in sorted(bufs):
        buf = bufs[rel]
        A("")
        A("--- %s ---" % rel)
        for g, kws in GROUPS.items():
            got = []
            for k in kws:
                n = buf.count(k.encode()) if not isinstance(k, bytes) else buf.count(k)
                if n:
                    got.append("%s x%d" % (k, n))
            if got:
                A("    %-22s %s" % (g + ":", ", ".join(got[:14])))

    A("")
    A("=" * 78)
    A("D. 白苹果风险点：NVRAM / 引导链写入证据")
    A("=" * 78)
    NV = [b"nvram", b"boot-logo", b"bootlogo", b"iBoot", b"kernelcache", b"Img4",
          b"img4", b"apfs", b"trustcache", b"bootx", b"ramdisk", b"Shsh", b"SHSH"]
    for rel in sorted(bufs):
        buf = bufs[rel]
        found = [k.decode() for k in NV if k in buf]
        if found:
            A("  [%s] %s" % (rel, ", ".join(found)))
    A("")
    A("  -- 关键上下文 --")
    for kw in [b"boot-logo", b"bootlogo", b"nvram", b"iBoot", b"Img4"]:
        for rel in sorted(bufs):
            c = ctx(bufs[rel], kw, 150, 2)
            if c:
                A("  (%s) %s" % (rel, kw.decode()))
                for line in c:
                    A("      " + line[:230])

    A("")
    A("=" * 78)
    A("E. 文件窃取面：敏感容器 / 通讯录 / 相册 / 剪贴板 / 钥匙串")
    A("=" * 78)
    THEFT = {
        "通讯录": [b"CNContactStore", b"ABAddressBook", b"CNContactFetchRequest"],
        "相册": [b"PHPhotoLibrary", b"PHAsset", b"PHFetchResult", b"requestImageData"],
        "剪贴板": [b"UIPasteboard", b"generalPasteboard", b"stringForType"],
        "钥匙串": [b"SecItemCopyMatching", b"kSecClassGenericPassword",
                   b"kSecReturnData", b"SecItemAdd"],
        "文件遍历": [b"enumeratorAtPath", b"contentsOfDirectoryAtPath",
                     b"subpathsAtPath", b"NSDirectoryEnumerator"],
        "聊天库/第三方App": [b"WeChat", b"ChatStorage.sqlite", b"sms.db", b"CallHistory",
                             b"Library/SMS", b"MobileSMS", b"com.tencent"],
        "地理位置": [b"CLLocationManager", b"requestAlwaysAuthorization"],
        "麦克风/摄像头": [b"AVCaptureDevice", b"AVAudioRecorder", b"requestRecordPermission"],
    }
    for name, kws in THEFT.items():
        A("")
        A("  [%s]" % name)
        any_hit = False
        for rel in sorted(bufs):
            got = ["%s x%d" % (k.decode(), bufs[rel].count(k)) for k in kws if k in bufs[rel]]
            if got:
                any_hit = True
                A("      %-48s %s" % (rel, ", ".join(got)))
        if not any_hit:
            A("      （无命中）")

    A("")
    A("=" * 78)
    A("F. 唯一真实外联点核对（api.appledb.dev 上下游）")
    A("=" * 78)
    for rel in sorted(bufs):
        buf = bufs[rel]
        if b"appledb" in buf or b"libgrabkernel" in buf:
            A("  [%s]" % rel)
            for kw in [b"libgrabkernel", b"appledb", b"kernelcache", b"ipsw"]:
                for line in ctx(buf, kw, 110, 2):
                    A("    (%s) %s" % (kw.decode(), line[:200]))

    with open(os.path.join(OUT, "deep3.txt"), "w") as fh:
        fh.write("\n".join(L) + "\n")
    print("deep3.txt lines=%d" % len(L))


if __name__ == "__main__":
    main()
