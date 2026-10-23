#!/usr/bin/env python3
"""IPA 字符串与 API 审计（零依赖）。

产出 $GITHUB_WORKSPACE/logs/audit/strings.json：
  - 每个 Mach-O 的 URL/域名/IP 分桶
  - 敏感 API 命中（窃取类、动态加载类、越狱检测类、远程下发类）
  - 二进制内嵌 plist（entitlements / 配置）
"""
import os, re, sys, json, struct, plistlib

LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
OUT = os.path.join(os.environ.get("GITHUB_WORKSPACE", "."), "logs", "audit")
PAY = os.path.join(LAB, "Payload")

MAGICS = (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf")

RE_ASCII = re.compile(rb"[\x20-\x7e\t]{6,400}")
RE_UTF16 = re.compile(rb"(?:[\x20-\x7e]\x00){6,400}")
RE_URL = re.compile(r"\b(?:https?|wss?|tcp|udp|ftp)://[^\s\"'<>\\]{4,200}")
RE_DOMAIN = re.compile(r"\b(?:[a-z0-9](?:[a-z0-9\-]{0,60}[a-z0-9])?\.){1,6}(?:com|net|org|cn|io|xyz|top|vip|cc|me|co|info|app|dev|club|site|online|shop|link|icu|buzz|live|fun|space|website|store|tech|pro|asia|hk|tw|ru|su|pw|tk|ml|ga|cf|gq|la|to|ws|tv|fm|be|in|eu|uk|de|fr|jp|kr|sg|us|ca|au|br|nl|se|fi|no|pl|cz|tr|ir|vn|th|id|my|ph|pk|bd|np|lk|kz|ua|by|am|az|ge|md|rs|bg|ro|hu|sk|si|hr|gr|pt|es|it|ch|at|dk|ie|nz|za|eg|sa|ae|il|mx|ar|cl|co|pe|ve|ec|uy|py|bo|do|gt|cr|pa|sv|hn|ni|cu|jm|tt|bb|bs|bz|gy|sr|ht|af|dz|ao|bw|cm|ci|gh|ke|ma|mu|mz|na|ng|re|rw|sc|sn|sd|sz|tn|tz|ug|zm|zw)\b", re.I)
RE_IPV4 = re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b")

# 敏感能力指纹（按“行为”分桶，命中即记录，不外泄判定结论）
SIG = {
    "file_theft_photos": ["PHAsset", "PHPhotoLibrary", "UIImagePickerController", "PHFetchResult",
                          "requestImageForAsset", "PHImageManager"],
    "file_theft_contacts": ["CNContactStore", "ABAddressBookCreate", "CNContactFetchRequest",
                            "unifiedContactsMatchingPredicate", "ABAddressBookCopyArrayOfAllPeople"],
    "file_theft_calendar": ["EKEventStore", "EKEventStoreRequestAccessToEntityType", "calendarItemsWithExternalIdentifier"],
    "file_theft_reminders": ["EKEntityTypeReminder"],
    "file_theft_clipboard": ["UIPasteboard", "generalPasteboard", "stringWithContentsOfPasteboard",
                             "UIPasteboardTypeListString"],
    "file_theft_keychain": ["SecItemCopyMatching", "SecItemAdd", "SecItemUpdate", "SecItemDelete",
                            "kSecClassGenericPassword", "kSecAttrService", "kSecReturnData"],
    "file_theft_filesystem": ["NSFileManager", "NSDirectoryEnumerator", "enumeratorAtPath",
                              "contentsOfDirectoryAtPath", "subpathsOfDirectoryAtPath",
                              "NSDocumentDirectory", "NSSearchPathForDirectoriesInDomains",
                              "NSHomeDirectory", "NSUserDomainMask"],
    "file_theft_sms_call": ["CTMessageCenter", "IMCore", "ChatKit", "CNContactPhoneNumbersKey",
                            "CTTelephonyNetworkInfo", "CTCarrier"],
    "file_theft_location": ["CLLocationManager", "startUpdatingLocation", "startMonitoringSignificantLocationChanges",
                            "requestAlwaysAuthorization", "CLLocationManagerDelegate"],
    "file_theft_audio_video": ["AVCaptureDevice", "AVCaptureSession", "AVAudioRecorder",
                               "startRunning", "AVMediaTypeAudio", "AVMediaTypeVideo"],
    "file_theft_screen": ["UIScreen.mainScreen", "drawViewHierarchyInRect", "UIGraphicsBeginImageContext",
                          "CGWindowListCreateImage", "IOHIDEvent"],
    "dynamic_code": ["dlopen", "dlsym", "NSClassFromString", "NSSelectorFromString", "objc_msgSend",
                     "NSBundle", "loadNibNamed", "NSCoding", "NSKeyedUnarchiver",
                     "unarchiveObjectWithData", "evalString", "JSContext", "JSValue"],
    "process_spawn": ["posix_spawn", "posix_spawnp", "execve", "execl", "system(", "fork",
                      "popen", "NSTask", "UIApplicationLaunchOptionsURLKey"],
    "remote_payload": ["NSURLSession", "NSURLConnection", "downloadTask", "dataTaskWithURL",
                       "writeToFile", "createFileAtPath", "synchronizeFile",
                       "applicationOctetStream", "getBytes", "malloc", "mmap", "mprotect"],
    "jailbreak_detect": ["/Applications/Cydia.app", "/bin/bash", "/usr/sbin/sshd",
                         "/etc/apt", "/private/var/lib/apt", "/usr/bin/ssh", "/Library/MobileSubstrate",
                         "/var/cache/apt", "/var/lib/cydia", "/usr/libexec/sftp-server",
                         "/private/var/mobile/Library/SMS", "/var/mobile/Library/Preferences",
                         "frida", "cycript", "substrate", "MobileSubstrate", "libhooker",
                         "jailbreak", "jailbroken", "isJailbroken", "Sileo", "Zebra", "unc0ver",
                         "palera1n", "Dopamine", "rootless", "jbroot", "bootstrap"],
    "anti_debug": ["ptrace", "PT_DENY_ATTACH", "sysctl", "kinfo_proc", "P_TRACED",
                   "getppid", "task_get_exception_ports", "AMFI", "csops", "syscall"],
    "kb_swipe_env": ["RESTORE", "kernel", "kfd", "IOSurface", "IOMobileFramebuffer",
                     "IOConnectCallStructMethod", "mach_port", "vm_map", "kernel_read",
                     "kernel_write", "tfp0", "proc_pid", "task_for_pid", "amfi_get_out_of_my_way",
                     "cs_enforcement", "sandbox_extension", "launchd_sim"],
    "license_auth": ["verifyReceipt", "appStoreReceiptURL", "receipt", "activation",
                     "license", "card_key", "cardkey", "carkey", "卡密", "激活", "授权",
                     "device_id", "udid", "idfa", "idfv", "register", "bind",
                     "expire", "vip", "member", "token", "sign", "nonce"],
    "obfuscation": ["\x00\x00\x00", "base64", "AES", "ChaCha", "RC4", "XOR", "obfuscat",
                    "encrypt", "decrypt", "cipher", "key_data", "iv_data"],
}

# 卡密/授权相关：只用于定位“服务器依赖点”，不产出绕过方案
RE_AUTH_PATH = re.compile(
    r"(?:/(?:api|v1|v2|v3|v4|user|auth|login|verify|check|card|key|licen[cs]e|active|activate|"
    r"device|bind|reg|register|order|pay|vip|member|sign|token|init|config|update|patch|script|js|h5)"
    r"(?:/[A-Za-z0-9_\-\.]{1,40}){0,4})", re.I)


def strings_of(buf):
    out = set()
    for m in RE_ASCII.finditer(buf):
        out.add(m.group().decode("latin-1"))
    for m in RE_UTF16.finditer(buf):
        try:
            out.add(m.group().decode("utf-16-le", "ignore"))
        except Exception:
            pass
    return out


def walk_macho():
    for r, _d, fs in os.walk(PAY):
        for f in fs:
            p = os.path.join(r, f)
            try:
                with open(p, "rb") as fh:
                    if fh.read(4) in MAGICS:
                        yield p
            except Exception:
                continue


def extract_plists(data):
    """从二进制里捞出完整 XML plist（entitlements / 配置）。"""
    res = []
    i = 0
    while len(res) < 12:
        i = data.find(b"<?xml", i)
        if i < 0:
            break
        j = data.find(b"</plist>", i)
        if j < 0:
            break
        blob = data[i:j + 8]
        if len(blob) < 4 << 20:
            try:
                plistlib.loads(blob)
                res.append(blob.decode("utf-8", "replace"))
            except Exception:
                pass
        i = j + 8
    return res


def main():
    os.makedirs(OUT, exist_ok=True)
    report = {"binaries": [], "union": {}, "auth_endpoints": [], "plists": {}}
    union = {k: set() for k in SIG}
    urls, domains, ips = set(), set(), set()
    auth_paths = set()

    for p in sorted(walk_macho()):
        rel = os.path.relpath(p, PAY)
        with open(p, "rb") as fh:
            data = fh.read()
        ss = strings_of(data)
        joined = "\n".join(ss)
        hit = {}
        for bucket, pats in SIG.items():
            got = sorted({pat for pat in pats if pat in joined})
            if got:
                hit[bucket] = got
                union[bucket].update(got)
        found_urls = sorted({u for s in ss for u in RE_URL.findall(s)})[:400]
        found_dom = sorted({d.lower() for s in ss for d in RE_DOMAIN.findall(s)})[:400]
        found_ip = sorted({i for s in ss for i in RE_IPV4.findall(s)
                           if not i.startswith(("0.", "127.", "255.", "1.0.0"))})[:200]
        found_auth = sorted({a for s in ss for a in RE_AUTH_PATH.findall(s)
                             if len(a) > 6})[:300]
        urls.update(found_urls)
        domains.update(found_dom)
        ips.update(found_ip)
        auth_paths.update(found_auth)

        pls = extract_plists(data)
        if pls:
            report["plists"][rel] = pls[:4]

        report["binaries"].append({
            "path": rel,
            "size": len(data),
            "string_count": len(ss),
            "urls": found_urls[:120],
            "domains": found_dom[:120],
            "ips": found_ip,
            "auth_like_paths": found_auth[:120],
            "signals": hit,
            "signal_buckets": sorted(hit.keys()),
            "plist_count": len(pls),
        })

    # 全包 App 级 plist
    for r, _d, fs in os.walk(PAY):
        for f in fs:
            if f == "Info.plist" or f.endswith(".plist"):
                p = os.path.join(r, f)
                try:
                    with open(p, "rb") as fh:
                        pl = plistlib.load(fh)
                    rel = os.path.relpath(p, PAY)
                    if rel.count("/") <= 2:
                        report["plists"].setdefault(rel, []).append(
                            json.dumps(pl, ensure_ascii=False, default=str)[:4000])
                except Exception:
                    continue

    report["union"] = {k: sorted(v) for k, v in union.items() if v}
    report["union_urls"] = sorted(urls)
    report["union_domains"] = sorted(domains)
    report["union_ips"] = sorted(ips)
    report["auth_endpoints"] = sorted(auth_paths)

    with open(os.path.join(OUT, "strings.json"), "w") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1, default=str)

    # 控制台摘要
    print("== binaries ==")
    for b in report["binaries"]:
        print("%-46s %9d strings=%6d buckets=%s" % (
            b["path"], b["size"], b["string_count"], ",".join(b["signal_buckets"])))
    print("\n== union domains (%d) ==" % len(domains))
    for d in sorted(domains)[:80]:
        print("  ", d)
    print("\n== union urls (%d) ==" % len(urls))
    for u in sorted(urls)[:60]:
        print("  ", u)
    print("\n== ips (%d) ==" % len(ips), sorted(ips)[:40])
    print("\n== auth-like paths (%d) ==" % len(auth_paths))
    for a in sorted(auth_paths)[:60]:
        print("  ", a)
    print("\n== plist targets ==", list(report["plists"].keys())[:12])


if __name__ == "__main__":
    main()
