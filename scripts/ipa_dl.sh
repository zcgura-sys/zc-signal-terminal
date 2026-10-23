#!/usr/bin/env bash
# 每轮重新拉取目标 IPA 到工作目录（runner 是全新的，不持久）
set -uo pipefail
WS="${GITHUB_WORKSPACE:-$(pwd)}"
LAB="$WS/logs/.lab"
mkdir -p "$LAB"
URL="https://file.upfile.live/uploads/20261022/693ddb9a924f37a7db699be77cd09b30.ipa"
if [ ! -s "$LAB/tri49.ipa" ]; then
  curl -sSL -A "Mozilla/5.0" --max-time 900 -o "$LAB/tri49.ipa" "$URL" || exit 1
fi
echo "ipa_size=$(stat -c%s "$LAB/tri49.ipa")"
echo "ipa_md5=$(md5sum "$LAB/tri49.ipa" | cut -d' ' -f1)"
if [ ! -d "$LAB/Payload" ]; then
  rm -rf "$LAB/raw" && mkdir -p "$LAB/raw"
  unzip -q -o "$LAB/tri49.ipa" -d "$LAB/raw" || exit 1
  mv "$LAB/raw/Payload" "$LAB/Payload" 2>/dev/null
  rm -rf "$LAB/raw"
fi
echo "payload_ok=$( [ -d "$LAB/Payload" ] && echo yes || echo no )"
