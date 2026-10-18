#!/usr/bin/env bash
# 云端真机探针：装一批工具 -> 建 venv -> 跑 probe_net.py -> 汇总日志到 logs/
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p logs
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="logs/probe-$STAMP.log"
echo "日志文件: $LOG"
exec > >(tee -a "$LOG") 2>&1

FAILED=0
declare -a SUMMARY=()

section() { echo; echo "=================== $* ==================="; }
record() { SUMMARY+=("$1"); [ "$2" = "0" ] || FAILED=$((FAILED + 1)); }

section "0. 机器与系统"
{
  echo "时间(UTC): $(date -u)"
  uname -a
  grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
  echo "CPU: $(nproc) 核 | 内存: $(free -m | awk '/^Mem:/{print $2" MB"}') | 磁盘: $(df -h / | awk 'NR==2{print $4" 可用"}')"
  echo "python3: $(python3 --version 2>&1) | pip: $(python3 -m pip --version 2>&1 | cut -d' ' -f1-2)"
  echo "node: $(node --version 2>&1) | git: $(git --version 2>&1)"
}
record "环境探测" $?

section "1. apt 安装命令行工具（需要一个 sudo，云端 Runner 免密）"
if command -v apt-get >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq jq ripgrep tree ncdu tmux 2>&1 | tail -5
  record "apt 安装 jq/ripgrep/tree/ncdu/tmux" $?
else
  echo "非 apt 系统，跳过"
  record "apt 安装（跳过）" 0
fi

echo "-- 工具版本 --"
for t in jq rg tree ncdu tmux curl wget; do
  if command -v "$t" >/dev/null; then
    printf '%-8s %s\n' "$t" "$(("$t" --version 2>/dev/null || "$t" -V 2>/dev/null) | head -1)"
  else
    printf '%-8s %s\n' "$t" "(未安装)"
  fi
done

section "2. 建 venv 并安装 Python 包"
python3 -m venv .venv 2>&1 | tail -3
.venv/bin/python -m pip install -q --upgrade pip 2>&1 | tail -3
.venv/bin/python -m pip install -q requests httpx rich psutil 2>&1 | tail -5
record "pip 安装 requests/httpx/rich/psutil" $?
.venv/bin/python -m pip list --format=freeze 2>/dev/null | grep -Ei '^(requests|httpx|rich|psutil|urllib3|certifi)=' || true

section "3. 跑 Python 探针脚本 scripts/probe_net.py"
.venv/bin/python scripts/probe_net.py
record "probe_net.py 执行" $?

section "4. 实测 js/文本工具链（jq 解析刚生成的 JSON）"
if command -v jq >/dev/null && [ -f logs/probe_result.json ]; then
  jq -r '"\(.runtime.env.python) | 失败步骤 \(.summary.failed_steps) 个 | 温度 \(.network.http.temp_C // "n/a")℃ \(.network.http.desc_zh // "")"' logs/probe_result.json 2>&1
  record "jq 解析 probe_result.json" $?
fi

section "5. 汇总"
for line in "${SUMMARY[@]}"; do echo "· $line"; done
echo
echo "失败项合计: $FAILED"
echo "产物: $LOG / logs/probe_result.json"
echo "DONE_EXIT=$FAILED"
exit 0
