#!/usr/bin/env python3
"""第四层：外联点全量清单 / 动态加载与远程下发 / 钥匙串导出链 / 授权与卡密面。

产出 logs/audit/deep4.txt
"""
import os, re, collections

LAB = os.environ.get("ZC_LAB", "/tmp/zc-lab")
WS = os.environ.get("GITHUB_WORKSPACE", ".")
OUT = os.path.join(WS, "logs", "audit")
PAY = os.path.join(LAB, "Payload")
APP = os.path.join(PAY, "Kimi.app")

MAG = (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf")


def load():
    d = {}
    for r, _x, fs in os.walk(PAY):
        for f in fs:
            p = os.path.join(r, f)
            try:
                if open(p, "rb").read(4) in MAG:
                    d[os.path.relpath(p, PAY)] = open(p, "rb").read()
            except Exception:
                pass
    return d


def ctx(buf, needle, rad=120, limit=3):
    out, i, nb = [], 0, needle if isinstance(needle, bytes) else needle.encode()
    while len(out) < limit:
        i = buf.find(nb, i)
        if i < 0:
            break
        lo, hi = max(0, i - rad), min(len(buf), i + len(nb) + rad)
        out.append("".join(chr(b) if 32 <= b < 127 else "." for b in buf[lo:hi]))
        i += len(nb)
    return out


URLRE = re.compile(rb"(?:https?|wss?|ftp)://[A-Za-z0-9_.\-]{2,80}(?::\d{2,5})?"
                   rb"(?:/[A-Za-z0-9_.\-/%?=&+~:;,@!$'()*\[\]]{0,120})?")


def main():
    os.makedirs(OUT, exist_ok=True)
    bufs = load()
    L = []
    A = L.append

    A("=" * 78)
    A("G. 全量外联 URL（去重，按二进制分组）")
    A("=" * 78)
    allurl = collections.Counter()
    for rel in sorted(bufs):
        urls = collections.Counter()
        for m in URLRE.findall(bufs[rel]):
            u = m.decode("latin-1").rstrip("./,;'\"")
            urls[u] += 1
            allurl[u] += 1
        A("")
        A("--- %s (%d 个唯一 URL) ---" % (rel, len(urls)))
        for u, c in urls.most_common(40):
            A("    x%-3d %s" % (c, u[:150]))
        if not urls:
            A("    （无）")

    A("")
    A("=" * 78)
    A("H. 主机名汇总（判定是否有第三方 C2 / 授权服务器）")
    A("=" * 78)
    host = collections.Counter()
    for u in allurl:
        m = re.match(r"^[a-z]+://([^/:]+)", u)
        if m:
            host[m.group(1).lower()] += allurl[u]
    for h, c in host.most_common(60):
        tag = ""
        h2 = h.lower()
        if "apple.com" in h2:
            tag = "  <- 苹果官方"
        elif "appledb" in h2 or "github" in h2:
            tag = "  <- 越狱生态公开基础设施"
        elif "moonshot" in h2 or "kimi" in h2:
            tag = "  <- Kimi 官方"
        else:
            tag = "  <<<< 需人工判定"
        A("    x%-3d %-52s%s" % (c, h, tag))

    A("")
    A("=" * 78)
    A("I. 远程下发可执行内容 / 动态加载能力")
    A("=" * 78)
    DYN = [b"dlopen", b"dlsym", b"dyld_load", b"NSBundle load", b"_dyld_register",
           b"posix_spawn", b"execve", b"NSTask", b"system(", b"popen",
           b"NSURLSession", b"downloadTaskWithURL", b"dataTaskWithURL",
           b"writeToFile", b"createFileAtPath", b"NSData dataWithContentsOfURL",
           b"initWithContentsOfURL", b"chmod", b"chown", b"setuid",
           b"loadInsertedDylib", b"libSandy", b"inject_cdhash", b"trustcache"]
    for rel in sorted(bufs):
        got = ["%s x%d" % (k.decode(), bufs[rel].count(k)) for k in DYN if k in bufs[rel]]
        if got:
            A("")
            A("  [%s]" % rel)
            A("      " + ", ".join(got))

    A("")
    A("  -- writeToFile / 下载落盘 上下文 --")
    for kw in [b"writeToFile", b"initWithContentsOfURL", b"downloadTaskWithURL", b"chmod"]:
        for rel in sorted(bufs):
            for line in ctx(bufs[rel], kw, 100, 2):
                A("    (%s|%s) %s" % (rel.split("/")[-1], kw.decode(), line[:180]))

    A("")
    A("=" * 78)
    A("J. 钥匙串 / 文件导出链（真正的『偷文件』判定）")
    A("=" * 78)
    main_b = bufs.get("Kimi.app/Kimi", b"")
    for kw in [b"SecItemCopyMatching", b"kSecClassGenericPassword", b"kSecReturnData",
               b"SecItemAdd", b"enumeratorAtPath", b"contentsOfDirectoryAtPath",
               b"NSHomeDirectory", b"Documents", b"Library/Caches"]:
        A("")
        A("  [%s] x%d" % (kw.decode(), main_b.count(kw)))
        for line in ctx(main_b, kw, 130, 3):
            A("      " + line[:200])
    A("")
    A("  -- 导出关键字（zip/tar/归档/base64 打包）--")
    for kw in [b"zipArchive", b"SSZipArchive", b"tar.gz", b"base64EncodedString",
               b"NSJSONSerialization", b"multipart/form-data", b"upload"]:
        tot = sum(bufs[r].count(kw) for r in bufs)
        if tot:
            A("    %-28s 全局 x%-4d  %s" % (kw.decode(), tot,
              ", ".join(r.split("/")[-1] for r in sorted(bufs) if kw in bufs[r])[:110]))

    A("")
    A("=" * 78)
    A("K. 授权 / 卡密 面（仅定性，不产出绕过方案）")
    A("=" * 78)
    AUTH = [b"licen", b"Licen", b"activ", b"Activ", b"serial", b"Serial", b"voucher",
            b"redeem", b"Redeem", b"auth", b"Auth", b"token", b"Token", b"card",
            b"Card", b"trial", b"Trial", b"expire", b"Expire", b"VIP", b"vip"]
    for rel in sorted(bufs):
        got = ["%s x%d" % (k.decode(), bufs[rel].count(k)) for k in AUTH if bufs[rel].count(k) > 3]
        if got:
            A("")
            A("  [%s]" % rel)
            A("      " + ", ".join(got[:20]))

    A("")
    A("  -- 主程序内授权相关可读串（截断展示）--")
    seen = set()
    for kw in [b"licen", b"Licen", b"activ", b"Activ", b"redeem", b"voucher", b"serial"]:
        for line in ctx(main_b, kw, 90, 4):
            if line not in seen:
                seen.add(line)
                A("      (%s) %s" % (kw.decode(), line[:190]))

    A("")
    A("=" * 78)
    A("L. UI 层真实身份：这到底是聊天 App 还是越狱/外挂工具")
    A("=" * 78)
    UI = [b"Boot Logo", b"boot logo", b"Live Mode", b"Cheat", b"cheat", b"Signature",
          b"签名", b"外挂", b"透视", b"自瞄", b"免越狱", b"越狱", b"内核", b"授权",
          b"卡密", b"设备码", b"激活", b"会员", b"启动器", b"注入"]
    for kw in UI:
        n = main_b.count(kw)
        if n:
            A("")
            A("  [%s] x%d" % (kw.decode("utf-8", "ignore"), n))
            for line in ctx(main_b, kw, 100, 3):
                A("      " + line[:200])

    with open(os.path.join(OUT, "deep4.txt"), "w") as fh:
        fh.write("\n".join(L) + "\n")
    print("deep4.txt lines=%d" % len(L))


if __name__ == "__main__":
    main()
