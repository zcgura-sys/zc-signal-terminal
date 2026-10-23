#!/usr/bin/env python3
"""第二层取证：非 Mach-O 资源 + URL/host 全量聚合 + 远程下发面 + Info.plist。

产出 logs/audit/deep2.txt
"""
import os, re, plistlib, json, collections

LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
WS = os.environ.get("GITHUB_WORKSPACE", ".")
OUT = os.path.join(WS, "logs", "audit")
PAY = os.path.join(LAB, "Payload")
MAG = (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf")

APPLE_OK = ("apple.com", "icloud.com", "mzstatic.com", "cdn-apple.com", "apple-cloudkit.com",
            "aaplimg.com", "gstatic.com", "googleapis.com", "google.com", "github.com",
            "githubusercontent.com", "swift.org", "llvm.org")

RE_HOST = re.compile(rb"(?<![A-Za-z0-9_.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,4}"
                     rb"(?:com|net|org|io|cn|pk|cc|to|me|dev|live|xyz|top|vip|club|app|site|"
                     rb"shop|store|fun|online|tech|link|pro|info|biz|tv|fm|gg|sh|la|ly|rs|fi|"
                     rb"pl|br|ru|hk|tw|jp|kr|sg|vn|th|id|my|ph|in|tr|ae|sa|es|it|fr|de|nl|"
                     rb"uk|us|ca|au|nz|za|mx|ar|cl|co|pe|pt|se|no|dk|fi|cz|at|ch|be|ie|il)"
                     rb")(?![A-Za-z0-9-])")


def strings(buf):
    out = []
    for m in re.finditer(rb"[\x20-\x7e\t]{4,400}", buf):
        out.append(m.group().decode("latin-1"))
    for m in re.finditer(rb"(?:[\x20-\x7e]\x00){4,400}", buf):
        out.append(m.group().decode("utf-16-le", "ignore"))
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    L = []
    A = L.append

    all_files = []
    for r, _d, fs in os.walk(PAY):
        for f in fs:
            p = os.path.join(r, f)
            all_files.append((os.path.relpath(p, LAB), p))

    def is_macho(p):
        try:
            with open(p, "rb") as fh:
                return fh.read(4) in MAG
        except Exception:
            return False

    A("=" * 78)
    A("A. 非 Mach-O 资源清单（资源/配置/脚本才是下发与卡密高发区）")
    A("=" * 78)
    nonm = []
    for rel, p in sorted(all_files):
        if is_macho(p):
            continue
        sz = os.path.getsize(p)
        nonm.append((rel, p, sz))
        if sz > 0:
            A("  %-72s %9d B" % (rel.replace("Payload/", ""), sz))

    # ---------- B. host 聚合 ----------
    A("")
    A("=" * 78)
    A("B. 全部 host 聚合（排除已知大厂域名，按出现次数排序）")
    A("=" * 78)
    host_hits = collections.Counter()
    host_where = collections.defaultdict(set)
    targets = [(rel, p) for rel, p in all_files if os.path.getsize(p) < 120 * 1024 * 1024]
    for rel, p in targets:
        try:
            buf = open(p, "rb").read()
        except Exception:
            continue
        seen = set()
        for m in RE_HOST.finditer(buf.lower()):
            h = m.group(1).decode("latin-1")
            if any(h == d or h.endswith("." + d) for d in APPLE_OK):
                continue
            if len(h) < 5 or h.count(".") > 4:
                continue
            seen.add(h)
        for h in seen:
            host_hits[h] += 1
            host_where[h].add(rel.replace("Payload/", ""))

    A("  %-42s %-6s %s" % ("host", "files", "出现在"))
    for h, c in host_hits.most_common(80):
        A("  %-42s %-6d %s" % (h, c, ", ".join(sorted(host_where[h]))[:110]))

    # ---------- C. 非 Apple host 的上下文 ----------
    A("")
    A("=" * 78)
    A("C. 非大厂 host 的原始上下文（判断是 SDK 噪声还是真 endpoint）")
    A("=" * 78)
    noise = ("schema.org", "w3.org", "example.com", "localhost", "json-schema.org",
             "apache.org", "openssl.org", "unicode.org", "ietf.org", "sqlite.org",
             "zlib.net", "libpng.org", "gnu.org", "purl.org", "xmlsoap.org", "ns.adobe.com")
    for h, c in host_hits.most_common(60):
        if any(h == n or h.endswith("." + n) for n in noise):
            continue
        A("")
        A("--- %s (%d file) ---" % (h, c))
        shown = 0
        for rel, p in targets:
            if rel.replace("Payload/", "") not in host_where[h]:
                continue
            buf = open(p, "rb").read()
            nb = h.encode("latin-1")
            i = 0
            while shown < 3:
                i = buf.lower().find(nb, i)
                if i < 0:
                    break
                lo, hi = max(0, i - 130), min(len(buf), i + len(nb) + 130)
                chunk = buf[lo:hi]
                A("  [%s] %s" % (os.path.basename(rel),
                                 "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)))
                shown += 1
                i += len(nb)
            if shown >= 3:
                break

    # ---------- D. 远程下发可执行内容 ----------
    A("")
    A("=" * 78)
    A("D. 远程下发可执行内容面（dlopen / 写入可执行 / 下载后加载）")
    A("=" * 78)
    DL = [b"dlopen", b"NSData dataWithContentsOfURL", b"dataWithContentsOfURL",
          b"writeToFile:atomically:", b"createFileAtPath", b"chmod", b"execve",
          b"posix_spawn", b"NSBundle bundleWithPath", b"initWithContentsOfFile",
          b"NSURLSessionDownloadTask", b"downloadTaskWithURL", b"resumeData"]
    for rel, p in targets:
        if not is_macho(p):
            continue
        buf = open(p, "rb").read()
        hits = [k.decode() for k in DL if k in buf]
        if hits:
            A("  %-52s %s" % (rel.replace("Payload/", ""), ", ".join(hits)))
    A("")
    A("  -- 关键：是否存在「下载 dylib/ipa 后 dlopen」的可疑组合 --")
    for rel, p in targets:
        if not is_macho(p):
            continue
        buf = open(p, "rb").read()
        if b"https://" in buf or b"http://" in buf:
            has_dl = b"dlopen" in buf
            urls = set(re.findall(rb"https?://[A-Za-z0-9_./%\-:?=&@]{4,150}", buf))
            urls = [u for u in urls if not any(d in u.lower() for d in
                    [b"apple.com", b"w3.org", b"schema.org", b"openssl.org", b"github.com",
                     b"swift.org", b"llvm.org", b"unicode.org", b"ietf.org", b"zlib.net",
                     b"apache.org", b"gnu.org", b"mzstatic.com", b"icloud.com"])]
            if urls:
                A("  [%s] dlopen=%s" % (rel.replace("Payload/", ""), has_dl))
                for u in sorted(urls)[:14]:
                    A("      " + u.decode("latin-1"))

    # ---------- E. Info.plist ----------
    A("")
    A("=" * 78)
    A("E. Info.plist 关键字段")
    A("=" * 78)
    ip = os.path.join(PAY, "Kimi.app", "Info.plist")
    if os.path.exists(ip):
        pl = plistlib.load(open(ip, "rb"))
        for k in ["CFBundleIdentifier", "CFBundleName", "CFBundleDisplayName",
                  "CFBundleShortVersionString", "CFBundleVersion", "CFBundleExecutable",
                  "MinimumOSVersion", "UIDeviceFamily", "LSMinimumSystemVersion"]:
            if k in pl:
                A("  %-32s %s" % (k, pl[k]))
        A("")
        A("  -- URL Schemes --")
        for s in (pl.get("CFBundleURLTypes") or []):
            A("    %s -> %s" % (s.get("CFBundleURLName"), s.get("CFBundleURLSchemes")))
        A("")
        A("  -- ATS --")
        A("    %s" % json.dumps(pl.get("NSAppTransportSecurity"), ensure_ascii=False))
        A("")
        A("  -- 权限用途说明 --")
        for k, v in pl.items():
            if k.startswith("NS") and ("UsageDescription" in k or "Bonjour" in k):
                A("    %-46s %s" % (k, str(v)[:100]))
        A("")
        A("  -- 后台模式 --")
        A("    %s" % pl.get("UIBackgroundModes"))
        A("")
        A("  -- 其他可疑键 --")
        for k in pl:
            if any(x in k for x in ["Jailbreak", "jailbreak", "JB", "Exploit", "Patch",
                                    "Update", "Remote", "Dynamic"]):
                A("    %-46s %s" % (k, str(pl[k])[:120]))

    # ---------- F. 非 Mach-O 里带敏感词的文本 ----------
    A("")
    A("=" * 78)
    A("F. 非 Mach-O 文件中的敏感行（授权 / 下发 / 设备信息）")
    A("=" * 78)
    SEN = ["卡密", "卡", "授权", "激活", "会员", "到期", "设备", "绑定", "验证", "试用",
           "购买", "licen", "card", "activat", "member", "expire", "bind", "udid",
           "deviceid", "token", "apikey", "download", "dlopen", "http"]
    for rel, p, sz in nonm:
        if sz <= 0 or sz > 8 * 1024 * 1024:
            continue
        try:
            raw = open(p, "rb").read()
        except Exception:
            continue
        txt = "\n".join(strings(raw))
        lines = [ln for ln in txt.splitlines() if len(ln) > 3]
        got = []
        for ln in lines:
            low = ln.lower()
            if any(k.lower() in low for k in SEN):
                got.append(ln[:200])
        if got:
            A("")
            A("--- %s (%d 行) ---" % (rel.replace("Payload/", ""), len(got)))
            for g in got[:50]:
                A("    " + g)

    with open(os.path.join(OUT, "deep2.txt"), "w") as fh:
        fh.write("\n".join(L) + "\n")
    with open(os.path.join(OUT, "hosts.json"), "w") as fh:
        json.dump({"hosts": dict(host_hits), "where": {k: sorted(v) for k, v in host_where.items()}},
                  fh, ensure_ascii=False, indent=1)
    print("deep2.txt lines=%d hosts=%d nonmacho=%d" % (len(L), len(host_hits), len(nonm)))


if __name__ == "__main__":
    main()
