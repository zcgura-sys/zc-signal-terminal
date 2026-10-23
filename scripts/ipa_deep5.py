#!/usr/bin/env python3
"""第五层：UTF-8 感知字符串 + ObjC 真实能力面 + 外联域名原文。

之前几层用 ASCII 过滤，中文串被替换成 '.'，导致 UI 层与域名看不清。
本层做三件事：
  1. 正确解码 UTF-8（含中文），把 UI / 提示语还原出来
  2. 打印可疑 URL 的原始字节上下文，确认完整域名
  3. 枚举 ObjC 类名与 selector，映射真实功能面（文件窃取 / 内核 / 白苹果）

产出 logs/audit/deep5.txt，零依赖。
"""
import os
import re
import sys

WS = os.environ.get("GITHUB_WORKSPACE", os.getcwd())
LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
OUT = os.path.join(WS, "logs", "audit", "deep5.txt")

MAG = (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe",
       b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf")

# ASCII 可打印 + UTF-8 多字节序列
STR_RE = re.compile(
    rb"(?:[\x20-\x7e\t]|[\xc2-\xf4][\x80-\xbf]+){4,}"
)


def ustrings(data, minlen=4):
    """返回 [(offset, text)]，按 offset 升序。"""
    out = []
    for m in STR_RE.finditer(data):
        raw = m.group(0)
        if len(raw) < minlen:
            continue
        try:
            t = raw.decode("utf-8")
        except UnicodeDecodeError:
            t = raw.decode("utf-8", "replace")
        t = t.strip()
        if len(t) < minlen:
            continue
        out.append((m.start(), t))
    return out


def find_machos(root):
    hits = []
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            p = os.path.join(dirpath, fn)
            try:
                if os.path.getsize(p) < 4096:
                    continue
                with open(p, "rb") as f:
                    head = f.read(4)
            except OSError:
                continue
            if head in MAG:
                hits.append(p)
    return sorted(hits)


def rel(p):
    return os.path.relpath(p, os.path.join(LAB, "Payload"))


def main():
    payload = os.path.join(LAB, "Payload")
    if not os.path.isdir(payload):
        print("未解包，先跑 ipa_dl.sh", file=sys.stderr)
        return 1

    machos = find_machos(payload)
    lines = []

    def w(s=""):
        lines.append(s)

    w("=" * 78)
    w("M. 中文 / UTF-8 可读串（UI 层真实身份还原）")
    w("=" * 78)

    CJK = re.compile(r"[\u4e00-\u9fff]")
    for p in machos:
        with open(p, "rb") as f:
            data = f.read()
        got = [(o, t) for o, t in ustrings(data, 2) if CJK.search(t)]
        # 去重，保留顺序
        seen = set()
        uniq = []
        for o, t in got:
            if t in seen:
                continue
            seen.add(t)
            uniq.append((o, t))
        w("")
        w("--- %s  (中文串 %d 条 / 去重 %d) ---" % (rel(p), len(got), len(uniq)))
        if not uniq:
            w("    （无）")
            continue
        for o, t in uniq[:120]:
            t = t.replace("\n", "\\n").replace("\r", "\\r")
            w("    @0x%08x  %s" % (o, t[:200]))
        if len(uniq) > 120:
            w("    ... 其余 %d 条省略" % (len(uniq) - 120))

    w("")
    w("=" * 78)
    w("N. 外联地址原文（含非 ASCII 上下文，防被点号掩盖）")
    w("=" * 78)
    URL_RE = re.compile(rb"https?://[^\x00-\x20\x7f-\xff\"'<>\\]{4,200}")
    for p in machos:
        with open(p, "rb") as f:
            data = f.read()
        found = URL_RE.findall(data)
        w("")
        w("--- %s (%d) ---" % (rel(p), len(found)))
        if not found:
            w("    （无）")
            continue
        seen = set()
        for u in found:
            s = u.decode("utf-8", "replace")
            if s in seen:
                continue
            seen.add(s)
            w("    %s" % s)

    w("")
    w("=" * 78)
    w("O. ObjC 类名（真实功能面清单）")
    w("=" * 78)
    CLS_RE = re.compile(rb"_OBJC_CLASS_\$_\w+")
    META_RE = re.compile(rb"_OBJC_METACLASS_\$_\w+")
    for p in machos:
        with open(p, "rb") as f:
            data = f.read()
        cls = sorted({m.group(0)[len(b"_OBJC_CLASS_$_"):].decode("ascii", "replace")
                      for m in CLS_RE.finditer(data)})
        if not cls:
            continue
        # 只列非系统类（过滤 UI/Foundation 常见前缀）
        SYS = ("NS", "UI", "CA", "CG", "CI", "CF", "AV", "SK", "MK", "WK",
               "MTL", "PH", "CL", "CN", "EK", "MP", "GK", "VN", "QL", "AR",
               "SC", "RP", "AS", "LA", "IN", "PK", "SF", "WC", "AC", "HK")
        own = [c for c in cls
               if not (len(c) > 2 and c.startswith(SYS) and c[2].isupper())]
        w("")
        w("--- %s  类总数 %d / 自有类 %d ---" % (rel(p), len(cls), len(own)))
        for c in own:
            w("    %s" % c)
        if not own:
            w("    （无自有类名，可能是 C/C++ 组件）")

    w("")
    w("=" * 78)
    w("P. ObjC selector 中的『敏感能力』(偷文件 / 剪贴板 / 通讯录 / 相册)")
    w("=" * 78)
    SEL_RE = re.compile(rb"[\x20-\x7e]{3,120}")
    SENS = {
        "相册": ["PHAsset", "PHPhotoLibrary", "PHFetch", "UIImagePicker",
                 "ALAsset", "AVCapturePhoto"],
        "通讯录": ["CNContact", "ABAddressBook", "CNPhoneNumber"],
        "剪贴板": ["UIPasteboard", "generalPasteboard"],
        "定位": ["CLLocationManager", "startUpdatingLocation", "requestWhenInUse"],
        "麦克风/相机": ["AVAudioRecorder", "AVCaptureDevice", "AVCaptureSession"],
        "钥匙串": ["SecItemCopyMatching", "SecItemAdd", "kSecClassGenericPassword"],
        "通讯/短信": ["MFMessageCompose", "CNContactStore", "MessageUI"],
        "文件遍历": ["enumeratorAtPath", "contentsOfDirectoryAtPath",
                 "NSFileManager.defaultManager", "subpathsOfDirectoryAtPath"],
        "上传": ["upload", "multipart", "dataTaskWithURL", "uploadTask"],
        "越狱检测": ["isJailbroken", "jailbreak", "Cydia", "Substrate",
                 "cydia://", "/Applications/Cydia"],
        "反调试": ["ptrace", "PT_DENY_ATTACH", "sysctl", "sysctlByName"],
        "内核": ["kread", "kwrite", "kalloc", "kfd", "trustcache",
                 "pe_mach_header", "boot_manifest"],
    }
    for p in machos:
        with open(p, "rb") as f:
            data = f.read()
        hits = {k: [] for k in SENS}
        for m in SEL_RE.finditer(data):
            s = m.group(0).decode("latin-1")
            for cat, kws in SENS.items():
                for kw in kws:
                    if kw in s:
                        if s not in hits[cat]:
                            hits[cat].append(s)
        any_hit = any(v for v in hits.values())
        w("")
        w("--- %s ---" % rel(p))
        if not any_hit:
            w("    （无）")
            continue
        for cat in SENS:
            v = hits[cat]
            if not v:
                continue
            w("  [%s] %d" % (cat, len(v)))
            for s in v[:6]:
                w("      %s" % s[:150])

    w("")
    w("=" * 78)
    w("Q. 高危行判定汇总")
    w("=" * 78)
    w("  见 P 段：是否有上传 + 剪贴板/通讯录/相册 的组合，即「偷文件」的判定依据。")

    text = "\n".join(lines) + "\n"
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print("deep5.txt lines=%d chars=%d" % (len(lines), len(text)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
