#!/usr/bin/env python3
"""IPA 全域扫描：Mach-O 结构 + 字符串分桶 + 敏感 API 审计。零依赖。

产物统一写到 $GITHUB_WORKSPACE/logs/audit/ 下（runner 每轮全新，只有 logs/ 会回写）。
"""
import os, sys, re, json, subprocess, collections

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import machoparse

WS = os.environ.get("GITHUB_WORKSPACE", os.getcwd())
LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
PAY = os.path.join(LAB, "Payload")
OUT = os.path.join(WS, "logs", "audit")
os.makedirs(OUT, exist_ok=True)

MACHO_MAGICS = {b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"}


def is_macho(path):
    try:
        with open(path, "rb") as f:
            return f.read(4) in MACHO_MAGICS
    except Exception:
        return False


def walk_payload():
    ents = []
    for root, dirs, files in os.walk(PAY):
        for fn in files:
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, PAY)
            ents.append((rel, full, os.path.getsize(full)))
    return sorted(ents, key=lambda x: -x[2])


def find_app():
    for root, dirs, files in os.walk(PAY):
        for d in dirs:
            if d.endswith(".app"):
                return os.path.join(root, d)
    return None


def fat_binary(app):
    """主可执行文件名来自 Info.plist 的 CFBundleExecutable；这里退化为与 .app 同名。"""
    if not app:
        return None
    base = os.path.basename(app)[:-4]
    cand = os.path.join(app, base)
    if os.path.isfile(cand):
        return cand
    for fn in os.listdir(app):
        p = os.path.join(app, fn)
        if os.path.isfile(p) and is_macho(p):
            return p
    return None


def strings_of(path, minlen=5):
    """提取所有长度 >= minlen 的可打印 ASCII 串。"""
    with open(path, "rb") as f:
        raw = f.read()
    return [m.group().decode("ascii", "replace")
            for m in re.finditer(rb"[ -~]{%d,}" % minlen, raw)]


RE_URL = re.compile(r"(?:https?|wss?|ftp)://[^\s\"'<>\\)\]]{4,200}", re.I)
RE_DOMAIN = re.compile(r"\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,4}"
                       r"(?:com|cn|net|org|io|xyz|top|vip|cc|me|co|info|club|site|live|app|dev|cloud|shop|pro|link|online|tech|store|fun|icu|buzz|wang|ink|work|ltd|asia|mobi)\b", re.I)
RE_IP = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")

# 隐私 / 窃取面 API
PRIVACY_APIS = {
    "camera": ["AVCaptureDevice", "AVCaptureSession", "UIImagePickerController"],
    "photos": ["PHPhotoLibrary", "PHAsset", "ALAssetsLibrary", "UIImageWriteToSavedPhotosAlbum"],
    "contacts": ["CNContactStore", "ABAddressBook", "CNContactFetchRequest"],
    "calendar": ["EKEventStore"],
    "location": ["CLLocationManager", "requestWhenInUseAuthorization", "startUpdatingLocation"],
    "microphone": ["AVAudioRecorder", "AVAudioSession", "requestRecordPermission"],
    "clipboard": ["UIPasteboard", "generalPasteboard"],
    "keychain": ["SecItemCopyMatching", "SecItemAdd", "SecItemUpdate", "kSecClassGenericPassword"],
    "identifier": ["identifierForVendor", "advertisingIdentifier", "ASIdentifierManager", "IDFA"],
    "sms_call": ["MFMessageComposeViewController", "MFMailComposeViewController", "openURL"],
    "bluetooth": ["CBCentralManager", "CBPeripheralManager"],
    "motion": ["CMMotionManager"],
    "health": ["HKHealthStore"],
}
# 越狱检测 / 反调试 / 环境探测
JB_STRINGS = ["/Applications/Cydia.app", "/Library/MobileSubstrate", "/bin/bash", "/usr/sbin/sshd",
              "/etc/apt", "/private/var/lib/apt", "cydia://", "substrate", "frida", "cycript",
              "Sileo", "Taurine", "unc0ver", "checkra1n", "palera1n", "Dopamine",
              "ptrace", "PT_DENY_ATTACH", "sysctl", "dyld_get_image_name"]
# 远程下发 / 可执行内容
DL_STRINGS = ["NSURLSessionDownloadTask", "downloadTaskWithURL", "dataTaskWithURL",
              "dlopen", "dlsym", "NSBundle load", "loadNibNamed",
              "javascript", "evaluateJavaScript", "WKUserScript", "WKWebView",
              "JSContext", "NSClassFromString(", "performSelector", "NSSelectorFromString",
              "objc_msgSend", "class_addMethod", "method_exchangeImplementations",
              "NSInvocation", "libffi", "ffi_call", "vm_protect", "mprotect",
              "mmap", "pthread_create", "syscall(", "task_for_pid", "mach_vm_",
              "UIWebView", "WKWebViewConfiguration", "addScriptMessageHandler"]
# 卡密/授权关键词（中英）
AUTH_KEYS = ["卡密", "卡密", "激活码", "授权", "登录", "试用", "到期", "会员", "vip", "VIP",
             "license", "License", "activate", "activation", "auth", "Auth", "token", "Token",
             "device_id", "deviceId", "udid", "UDID", "imei", "serial", "expire", "expired",
             "余额", "充值", "付费", "购买", "订单", "验证", "校验", "绑定", "机器码",
             "api/", "/api", "register", "sign", "signature", "nonce", "timestamp",
             "app_key", "appkey", "app_secret", "secret", "key=", "expires_at"]

results = {"app": None, "macho": [], "files": [], "strings_buckets": {}, "api_hits": {},
           "suspicious_summary": {}}

app = find_app()
results["app"] = os.path.relpath(app, PAY) if app else None

# ---- 1. Mach-O 解析 ----
macho_paths = []
for rel, full, size in walk_payload():
    if is_macho(full):
        macho_paths.append((rel, full, size))

for rel, full, size in macho_paths:
    try:
        info = machoparse.parse_file(full)
    except Exception as e:
        info = {"path": rel, "error": repr(e)}
    info["rel"] = rel
    info["size"] = size
    results["macho"].append(info)

# ---- 2. 文件清单（按大小 Top 与可疑扩展名）----
allfiles = walk_payload()
results["files"] = [{"rel": r, "size": s} for r, _f, s in allfiles[:120]]
ext_count = collections.Counter()
for r, _f, s in allfiles:
    ext = os.path.splitext(r)[1].lower() or "(none)"
    ext_count[ext] += 1
results["ext_stats"] = dict(ext_count.most_common(30))
results["total_files"] = len(allfiles)
results["total_bytes"] = sum(s for _r, _f, s in allfiles)

# ---- 3. 字符串分桶（只对 Mach-O + 主要 js/json/plist 资源）----
buckets = {"url": collections.Counter(), "domain": collections.Counter(), "ip": collections.Counter(),
           "auth": collections.Counter(), "suspicious": collections.Counter()}
scan_targets = [(r, f, s) for r, f, s in allfiles
                if is_macho(f) or os.path.splitext(r)[1].lower() in (".js", ".json", ".plist", ".html", ".lua", ".txt")]

api_hits = collections.defaultdict(list)
for rel, full, size in scan_targets:
    if size > 40 << 20:
        continue
    try:
        ss = strings_of(full, 5)
    except Exception:
        continue
    joined = "\n".join(ss)
    for u in RE_URL.findall(joined):
        buckets["url"][u[:200]] += 1
    for dm in RE_DOMAIN.findall(joined):
        dm = dm.lower()
        if dm.count(".") and not dm.endswith((".framework", ".dylib", ".bundle")):
            buckets["domain"][dm] += 1
    for ip in RE_IP.findall(joined):
        if not ip.startswith(("0.", "127.", "255.", "192.168.", "10.")):
            buckets["ip"][ip] += 1
    low = joined.lower()
    for k in AUTH_KEYS:
        if k.lower() in low:
            buckets["auth"][k] += 1
    for k in JB_STRINGS:
        if k in joined:
            buckets["suspicious"]["JB:" + k] += 1
    for k in DL_STRINGS:
        if k in joined:
            buckets["suspicious"]["DYN:" + k] += 1
    for cat, apis in PRIVACY_APIS.items():
        for a in apis:
            if a in joined:
                api_hits[cat].append({"api": a, "file": rel})

results["strings_buckets"] = {k: dict(v.most_common(150)) for k, v in buckets.items()}
results["api_hits"] = {k: v[:25] for k, v in api_hits.items()}

susp = {}
susp["cryptid_any"] = any(s.get("slices") and any(x.get("encrypted") for x in s["slices"] if isinstance(x, dict))
                          for s in results["macho"])
susp["n_macho"] = len(macho_paths)
susp["n_url"] = len(buckets["url"])
susp["n_domain"] = len(buckets["domain"])
susp["n_ip"] = len(buckets["ip"])
susp["privacy_cats"] = sorted(api_hits.keys())
susp["jb_markers"] = sorted(k for k in buckets["suspicious"] if k.startswith("JB:"))
susp["dyn_markers"] = sorted(k for k in buckets["suspicious"] if k.startswith("DYN:"))
results["suspicious_summary"] = susp

with open(os.path.join(OUT, "scan.json"), "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=1, default=str)

print("== summary ==")
print("app:", results["app"])
print("files:", results["total_files"], "bytes:", results["total_bytes"])
print("macho:", len(macho_paths))
for m in results["macho"]:
    tag = m.get("rel")
    if not m.get("slices"):
        print(" ", tag, "ERR", m.get("error"))
        continue
    for s in m["slices"]:
        print(" ", tag, "|", s.get("cpu"), s.get("filetype"), "| enc:", s.get("encrypted"),
              "| libs:", len(s.get("libraries", [])), "| sects:", s.get("n_sections"))
print("cryptid_any:", susp["cryptid_any"])
print("urls:", susp["n_url"], "domains:", susp["n_domain"], "ips:", susp["n_ip"])
print("privacy:", susp["privacy_cats"])
print("jb:", susp["jb_markers"][:12])
print("dyn:", susp["dyn_markers"][:20])
print("scan.json ->", os.path.join(OUT, "scan.json"))
