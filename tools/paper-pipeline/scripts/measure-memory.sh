#!/usr/bin/env bash
set -euo pipefail

# paper-pipeline の Node (進行役 / worker) および Chrome プロセスのメモリを測定する
# macOS のアクティビティモニタと同じ物理メモリ使用量（phys_footprint）と RSS を表示します。

echo "=== paper-pipeline プロセス検出 ==="

# 1. 進行役・worker の Node プロセスを検出
NODE_PIDS=$(pgrep -f "(dist|src)/(orchestrate|cli|fill-inbox-cli)\.(js|ts)" || true)

# 2. Chrome プロセス（.chrome-profile を含むもの）を検出
CHROME_PIDS=$(pgrep -f "\.chrome-profile" || true)

# 3. 検出したプロセスの子孫プロセスを再帰的に収集（Chrome 本体や GPU プロセス、レンダラーを含む）
collect_descendants() {
  local parent="$1"
  local children
  children=$(pgrep -P "$parent" 2>/dev/null || true)
  for child in $children; do
    echo "$child"
    collect_descendants "$child"
  done
}

RAW_PIDS=""
for p in $NODE_PIDS $CHROME_PIDS; do
  [ -z "$p" ] && continue
  RAW_PIDS="$RAW_PIDS $p $(collect_descendants "$p")"
done

# 重複を除去してソート
PIDS=$(echo "$RAW_PIDS" | tr ' ' '\n' | grep -v '^$' | sort -nu || true)

if [ -z "$PIDS" ]; then
  echo "実行中の paper-pipeline 関連プロセスは見つかりませんでした。"
  echo "（npm start 実行中に別ターミナルからこのスクリプトを実行してください）"
  exit 0
fi

# BSD ps 用にカンマ区切りの PID リストを作成
PID_LIST=$(echo "$PIDS" | tr '\n' ',' | sed 's/,$//')
echo "検出 PID: $PID_LIST"
echo ""

echo "--- ps コマンドによる RSS (常駐メモリ) ---"
ps -o pid,rss,%cpu,%mem,command -p "$PID_LIST" | awk '
NR==1 { print $0; next }
{
  rss_mb = $2 / 1024
  total_rss += rss_mb
  printf "%-7s %7.1f MB  %5s %5s  %s\n", $1, rss_mb, $3, $4, substr($0, index($0,$5))
}
END {
  printf "\n合計 RSS: %.1f MB\n", total_rss
}'

if command -v footprint >/dev/null 2>&1; then
  echo ""
  echo "--- macOS footprint (アクティビティモニタと同等の phys_footprint) ---"
  for PID in $PIDS; do
    CMD=$(ps -o command= -p "$PID" 2>/dev/null | head -n 1 | cut -c 1-90 || true)
    [ -z "$CMD" ] && continue
    echo ""
    echo "[PID $PID] $CMD"
    footprint -p "$PID" 2>/dev/null | grep -E "Footprint:|TOTAL" || footprint -p "$PID" 2>/dev/null | tail -n 5 || true
  done
fi
