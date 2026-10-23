#!/usr/bin/env python3
"""第七层：行为审计 —— 文件窃取 / 剪贴板 / Keychain / 网络请求 / 远程下发可执行。

同时校验第六层报出的域名是否为字符串表碎片误报（打印前后 64 字节上下文）。

产出 logs/audit/deep7.txt
"""
import os
import re
import sys

WS = os.environ.get("GITHUB_WORKSPACE", os.getcwd())
LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
OUT = os.path.join(WS, "logs", "audit", "deep7.txt")

MAG = (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe",
       b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf")


def machos(root):
    out = []
    for dp, _d, fs in os.walk(root):
        for fn in fs:
            p = os.path.join(dp, fn)
            try:
                if os.path.getsize(p) < 4096:
                    continue
                with open(p, "rb") as f:
                    if f.read(4) in MAG:
                        out.append(p)
            except OSError:
                continue
    return sorted(out)


# ---- 行为能力探针：Objective-C selector / 类名 / C 符号 / 字符串 关键字 ----
PROBES = [
    # 相册 / 照片
    ("相册读取", ["PHAsset", "PHFetchResult", "PHPhotoLibrary", "PHImageManager",
                  "UIImagePickerController", "requestImageForAsset",
                  "fetchAssets", "PHAssetResourceManager"]),
    # 通讯录
    ("通讯录", ["CNContactStore", "ABAddressBook", "CNContactFetchRequest",
                "unifiedContactsMatchingPredicate", "ABAddressBookCopyArrayOfAllPeople"]),
    # 剪贴板
    ("剪贴板", ["UIPasteboard", "generalPasteboard", "setString:",
                "stringForType:", "pasteboardWithName"]),
    # keychain / 凭据
    ("Keychain", ["SecItemAdd", "SecItemCopyMatching", "SecItemDelete",
                  "kSecClassGenericPassword", "keychain"]),
    # 文件系统外溢
    ("文件遍历外发", ["NSFileManager", "contentsOfDirectoryAtPath",
                      "enumeratorAtPath", "NSDocumentDirectory",
                      "NSHomeDirectory", "unarchiveObjectWithFile",
                      "subpathsOfDirectoryAtPath"]),
    # 远程下发 / 动态执行
    ("远程代码执行", ["dlopen", "dlsym", "NSBundle pathForResource",
                      "loadFromDisk", "loadFromURL", "JIT", "memorystatus",
                      "NSClassFromString", "performSelector",
                      "respondsToSelector", "NSInvocation",
                      "evalJavaScript", "evaluateJavaScript"]),
    # 下载
    ("下载", ["NSURLSession", "NSURLSessionDownloadTask", "dataTaskWithURL",
              "downloadTaskWithURL", "NSURLConnection", "CFHTTPMessage",
              "curl_easy", "fileURLWithPath"]),
    # 解压 / 落盘
    ("解压落地", ["archive_read", "unzip", "inflate", "writeToFile",
                  "createFileAtPath", "gunzip"]),
    # 越狱面
    ("越狱面", ["fork", "posix_spawn", "execve", "ptrace", "task_for_pid",
                "vm_read", "vm_write", "mach_vm_read", "mach_vm_write",
                "IOSurface", "IOConnectCallMethod", "IOConnectTrap",
                "pmap", "kread", "kwrite", "trustcache", "amfi",
                "CS_OPS_STATUS", "csops"]),
    # 反调试 / 反分析
    ("反调试", ["PT_DENY_ATTACH", "sysctl", "ptrace", "getppid",
                "isatty", "sysctl.name"]),
    # 上传 / 遥测
    ("上传遥测", ["multipart/form-data", "uploadTask", "POST", "content-type",
                  "application/json", "User-Agent", "deviceToken"]),
    # 权限 / 越权
    ("越权", ["MobileContainerManager", "BackBoardServices",
              "SpringBoardServices", "AssertionServices", "Preferences"]),
    # 内购 / 卡密替代
    ("支付/内购", ["SKPaymentQueue", "SKProduct", "StoreKit", "receipt"]),
]

KEY_KAMI_CTX = ["activate", "激活", "授权", "expiry", "vip", "serial",
                "license", "licence", "cardkey", "卡密", "机器码", "设备码",
                "expire", "trial", "unbind", "解绑", "renew"]


def ctx_dump(data, needle, radius=72, limit=6):
    """打印关键字周围的可见字符串，判断真实语义。"""
    out = []
    start = 0
    n = 0
    while n < limit:
        i = data.find(needle, start)
        if i < 0:
            break
        lo = max(0, i - radius)
        hi = min(len(data), i + len(needle) + radius)
        seg = data[lo:hi]
        seg = re.sub(rb"[^\x20-\x7e]", b".", seg).decode("latin-1")
        out.append("      ...%s..." % seg)
        start = i + len(needle)
        n += 1
    return out


def main():
    payload = os.path.join(LAB, "Payload")
    if not os.path.isdir(payload):
        print("未解包", file=sys.stderr)
        return 1
    L = []
    w = L.append

    targets = machos(payload)

    w("=" * 78)
    w("W. 行为能力面（ObjC/符号/字面量 关键字命中）")
    w("=" * 78)
    for p in targets:
        rel = os.path.relpath(p, payload)
        with open(p, "rb") as f:
            data = f.read()
        w("")
        w("--- %s  (%d B) ---" % (rel, len(data)))
        for label, keys in PROBES:
            hits = [(k, data.count(k.encode())) for k in keys]
            hits = [(k, c) for k, c in hits if c]
            if not hits:
                continue
            total = sum(c for _k, c in hits)
            w("  [%s] 命中 %d 项 / 共 %d 次" % (label, len(hits), total))
            for k, c in sorted(hits, key=lambda x: -x[1])[:10]:
                w("      %-34s x%d" % (k, c))

    w("")
    w("=" * 78)
    w("X. 卡密（授权）系统真实语义 —— 关键字上下文")
    w("=" * 78)
    for p in targets:
        rel = os.path.relpath(p, payload)
        with open(p, "rb") as f:
            data = f.read()
        blob = [k for k in KEY_KAMI_CTX if data.count(k.encode())]
        if not blob:
            continue
        w("")
        w("--- %s ---" % rel)
        for k in blob:
            lines = ctx_dump(data, k.encode(), radius=80, limit=4)
            if not lines:
                continue
            w("  «%s»" % k)
            for ln in lines:
                w(ln)

    w("")
    w("=" * 78)
    w("Y. 第六层域名复核（上下文校验，排除字符串表碎片误报）")
    w("=" * 78)
    SUSPECT = [b"subject.cn", b"g.io", b"4.io", b"glv.io", b"perf.dev",
               b"research.com"]
    for p in targets:
        rel = os.path.relpath(p, payload)
        with open(p, "rb") as f:
            data = f.read()
        found = [s for s in SUSPECT if s in data]
        if not found:
            continue
        w("")
        w("--- %s ---" % rel)
        for s in found:
            w("  «%s»" % s.decode())
            for ln in ctx_dump(data, s, radius=90, limit=3):
                w(ln)

    w("")
    w("=" * 78)
    w("Z. 可疑可执行落盘路径 / 已知越狱工件路径")
    w("=" * 78)
    PATHS = ["/var/jb", "/var/mobile/", "/private/var/", "/tmp/",
             "/var/tmp/", "/Library/MobileSubstrate", "/usr/lib/libsubstrate",
             "jbroot", "bootstrap", "JB_ROOT", "dopamine", "Dopamine",
             "palera1n", "unc0ver", "taurine", "Sileo", "Zebra"]
    for p in targets:
        rel = os.path.relpath(p, payload)
        with open(p, "rb") as f:
            data = f.read()
        hits = [(s, data.count(s.encode())) for s in PATHS]
        hits = [(s, c) for s, c in hits if c]
        w("")
        w("--- %s ---" % rel)
        if not hits:
            w("    （无）")
        for s, c in sorted(hits, key=lambda x: -x[1]):
            w("    %-40s x%d" % (s, c))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    text = "\n".join(L) + "\n"
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print("deep7.txt lines=%d chars=%d" % (len(L), len(text)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
