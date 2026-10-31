#!/usr/bin/env bash
set -euo pipefail

# paper-pipeline の Node (進行役 / worker) および Chrome プロセスのメモリを測定する
# macOS のアクティビティモニタと同じ物理メモリ使用量（phys_footprint）と RSS を表示します。

echo "=== paper-pipeline プロセス検出 ==="

# 関連プロセスの抽出:
# 1) node プロセス (orchestrate, cli, tsx)
# 2) Chrome プロセス (.chrome-profile または --headless=new)
PIDS=$(pgrep -f "paper-pipeline.*dist|paper-pipeline.*src|\.chrome-profile" || true)

if [ -z "$PIDS" ]; then
  echo "実行中の paper-pipeline 関連プロセスは見つかりませんでした。"
  echo "（npm start 実行中に別ターミナルからこのスクリプトを実行してください）"
  exit 0
fi

echo "検出 PID: $PIDS"
echo ""

echo "--- ps コマンドによる RSS (常駐メモリ) ---"
ps -o pid,rss,%cpu,%mem,command -p $PIDS | awk '
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
    CMD=$(ps -o command= -p "$PID" | head -n 1 | cut -c 1-80)
    echo ""
    echo "[PID $PID] $CMD"
    footprint -p "$PID" 2>/dev/null | grep -E "Footprint:|TOTAL" || footprint -p "$PID" 2>/dev/null | tail -n 5 || true
  done
fi
