#!/usr/bin/env python3
"""云端可用性探针：检查 Python 依赖 / 联网 / CPU，并输出结构化结果。

不依赖任何第三方包也能跑完（第三方包逐项 try 导入，缺了只记录不崩）。
"""
import hashlib
import json
import os
import platform
import socket
import sys
import time
import traceback
from datetime import datetime, timezone

RESULT = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "runtime": {},
    "deps": {},
    "network": {},
    "compute": {},
    "errors": [],
}


def guarded(name, fn):
    """执行一步，异常只记录不中断后续步骤。"""
    t0 = time.time()
    try:
        data = fn()
        data = {"ok": True, "cost_ms": round((time.time() - t0) * 1000), **data}
    except Exception as exc:  # noqa: BLE001
        data = {
            "ok": False,
            "cost_ms": round((time.time() - t0) * 1000),
            "error": f"{type(exc).__name__}: {exc}",
        }
        RESULT["errors"].append({"step": name, "trace": traceback.format_exc(limit=3)})
    RESULT.setdefault(name.split(".")[0], {})
    print(f"[{name}] {'OK' if data['ok'] else 'FAIL'} ({data['cost_ms']}ms)")
    return {name: data}


def step_runtime():
    return {
        "python": sys.version.split()[0],
        "impl": platform.python_implementation(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpu_count": os.cpu_count(),
        "cwd": os.getcwd(),
        "env_ci": os.getenv("GITHUB_ACTIONS", ""),
        "run_id": os.getenv("GITHUB_RUN_ID", ""),
    }


def step_deps():
    found, missing = {}, []
    for mod in ["requests", "httpx", "rich", "psutil", "yaml", "numpy", "pandas"]:
        try:
            m = __import__(mod)
            found[mod] = str(getattr(m, "__version__", "imported"))
        except Exception:  # noqa: BLE001
            missing.append(mod)
    return {"found": found, "missing": missing}


def step_dns():
    infos = socket.getaddrinfo("wttr.in", 443, proto=socket.IPPROTO_TCP)
    return {"wttr.in_resolved": sorted({i[4][0] for i in infos})[:4]}


def step_http():
    import requests  # 只有装了才走这条

    t0 = time.perf_counter()
    r = requests.get("https://wttr.in/Luoyang?format=j1&lang=zh", timeout=20,
                     headers={"User-Agent": "zc-probe/1.0"})
    ms = round((time.perf_counter() - t0) * 1000)
    body = r.json()
    cur = body["current_condition"][0]
    today = body["weather"][0]
    return {
        "status": r.status_code,
        "latency_ms": ms,
        "bytes": len(r.content),
        "city": body["nearest_area"][0]["areaName"][0]["value"],
        "temp_C": cur["temp_C"],
        "desc_zh": cur["lang_zh"][0]["value"] if cur.get("lang_zh") else cur["weatherDesc"][0]["value"],
        "humidity": cur["humidity"],
        "wind_kmph": cur["windspeedKmph"],
        "today_max_min_C": [today["maxtempC"], today["mintempC"]],
        "headers": {"server": r.headers.get("Server"), "via": r.headers.get("X-Served-By")},
    }


def step_compute():
    payload = b"zc-signal-terminal" * 200000  # ~6.8 MB
    t0 = time.perf_counter()
    for _ in range(4):
        digest = hashlib.sha256(payload).hexdigest()
    ms = (time.perf_counter() - t0) * 1000
    mb = len(payload) * 4 / (1024 * 1024)
    return {
        "sha256": digest[:16],
        "mb_hashed": round(mb, 1),
        "ms": round(ms, 1),
        "throughput_mbps": round(mb / (ms / 1000), 1),
    }


def step_stdlib_json_roundtrip():
    blob = {"a": list(range(1000)), "b": {"nested": True}}
    dumped = json.dumps(blob)
    return {"bytes": len(dumped), "equal": json.loads(dumped) == blob}


STEPS = [
    ("runtime.env", step_runtime),
    ("deps.import", step_deps),
    ("network.dns", step_dns),
    ("network.http", step_http),
    ("compute.sha256", step_compute),
    ("compute.json", step_stdlib_json_roundtrip),
]


def main():
    for name, fn in STEPS:
        result = guarded(name, fn)
        section = name.split(".")[0]
        RESULT[section].update({k.split(".")[-1]: v for k, v in result.items()})

    RESULT["summary"] = {
        "total_steps": len(STEPS),
        "failed_steps": len(RESULT["errors"]),
    }
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "probe_result.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(RESULT, fh, ensure_ascii=False, indent=2)
    print(f"\n结果已写入 {out_path}")
    print(json.dumps(RESULT["summary"], ensure_ascii=False))
    return 0 if RESULT["summary"]["failed_steps"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
