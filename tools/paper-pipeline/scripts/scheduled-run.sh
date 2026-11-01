#!/usr/bin/env bash
set -euo pipefail

# macOS launchd または cron 用 paper-pipeline 定期実行スクリプト
#
# 処理順序:
# 1. 二重起動防止（ロック取得）
# 2. 定期実行の判断（npm run scheduled-decide）
#    - プロセス確認（パイプラインまたは .chrome-profile Chrome）
#    - Notebook 利用枠確認（npm run quota-check 相当）
#    - inbox 未処理論文数としきい値確認
# 3. 判断結果に基づき、必要なら補充（npm run fill-inbox）
# 4. パイプライン実行（npm start -- --headless --exit-on-quota）

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PIPELINE_ROOT"

# launchd 環境で PATH が最小限の場合に備え、一般的な Node のパスを追加
for EXTRA_PATH in /opt/homebrew/bin /usr/local/bin "$HOME/.nvm/current/bin"; do
  if [ -d "$EXTRA_PATH" ] && [[ ":$PATH:" != *":$EXTRA_PATH:"* ]]; then
    export PATH="$EXTRA_PATH:$PATH"
  fi
done

# .nvm がある場合のフォールバック
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NODE=$(ls -1d "$HOME/.nvm/versions/node"/v* 2>/dev/null | tail -n 1 || true)
  if [ -n "$LATEST_NODE" ] && [ -d "$LATEST_NODE/bin" ]; then
    export PATH="$LATEST_NODE/bin:$PATH"
  fi
fi

LOG_DIR="$PIPELINE_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${SCHEDULED_LOG_FILE:-$LOG_DIR/scheduled-run.log}"

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    --help|-h)
      echo "使い方: $0 [--dry-run]"
      echo "  --dry-run: 判断のみ行い、補充やパイプラインの実行をスキップします"
      exit 0
      ;;
  esac
done

log "=== 定期実行チェックを開始します (PID: $$) ==="

# -------------------------------------------------------------
# 1. ロック取得（二重起動防止）
# -------------------------------------------------------------
LOCK_DIR="${SCHEDULED_LOCK_DIR:-/tmp/paper-pipeline-scheduled-run.lock}"

cleanup_lock() {
  rm -rf "$LOCK_DIR"
}

on_term() {
  log "SIGTERM を受信しました。安全に終了します"
  cleanup_lock
  exit 143
}

on_int() {
  log "SIGINT を受信しました。安全に終了します"
  cleanup_lock
  exit 130
}

trap cleanup_lock EXIT
trap on_int INT
trap on_term TERM

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$LOCK_DIR/pid"
    return 0
  fi

  local existing_pid=""
  if [ -f "$LOCK_DIR/pid" ]; then
    existing_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  fi

  # pid ファイルがまだ書き込まれていない場合は、作成直後のためスキップ
  if [ -z "$existing_pid" ]; then
    log "スキップ: 他の定期実行プロセスがロックを作成中です"
    exit 0
  fi

  # 保持プロセスが稼働中の場合はスキップ
  if kill -0 "$existing_pid" 2>/dev/null; then
    log "スキップ: 別の定期実行スクリプトが動作中です (PID: $existing_pid)"
    exit 0
  fi

  log "警告: 古いロックファイルを検出しました (PID: $existing_pid は停止中)。原子的退避を試みます"
  local stale_dir="$LOCK_DIR.stale.$$"
  if mv "$LOCK_DIR" "$stale_dir" 2>/dev/null; then
    rm -rf "$stale_dir"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "$$" > "$LOCK_DIR/pid"
      return 0
    fi
  fi

  log "スキップ: ロック競合のため今回の定期実行を見送ります"
  exit 0
}

acquire_lock

# -------------------------------------------------------------
# 2. 定期実行の判断（TypeScript CLI を実行）
# -------------------------------------------------------------
log "定期実行の判断を実行します (npm run scheduled-decide)"

DECISION_JSON=""
DECISION_EXIT=0
DECISION_JSON=$(npm run --silent scheduled-decide -- --json 2>> "$LOG_FILE") || DECISION_EXIT=$?

if [ "$DECISION_EXIT" -ne 0 ]; then
  # 終了コード別のスキップ判定
  case "$DECISION_EXIT" in
    10)
      log "スキップ: すでにパイプラインまたは専用プロファイルの Chrome が実行中です"
      ;;
    11)
      log "スキップ: Notebook 利用枠が止める値に達しています (終了コード 11: EXIT_QUOTA)"
      ;;
    12)
      log "スキップ: Notebook 利用量を読めませんでした (終了コード 12: EXIT_QUOTA_UNAVAILABLE)。安全のため動かしません"
      ;;
    13)
      log "スキップ: inbox ディレクトリが設定されていないか読み込めません。安全のため動かしません"
      ;;
    *)
      log "スキップ: 判断処理で予期せぬ終了コード ($DECISION_EXIT) が返されました。安全のため動かしません"
      ;;
  esac
  exit 0
fi

log "判断結果: 実行可能です"

# 判定 JSON から fillInbox の要否を抽出
NEEDS_FILL=false
if echo "$DECISION_JSON" | grep -q '"fillInbox": true'; then
  NEEDS_FILL=true
fi

# -------------------------------------------------------------
# 3. inbox 未処理論文の補充判定
# -------------------------------------------------------------
if [ "$NEEDS_FILL" = true ]; then
  log "inbox の未処理論文が不足しているため、npm run fill-inbox で補充します"
  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] npm run fill-inbox をスキップします"
  else
    FILL_EXIT=0
    FILL_OUTPUT=$(npm run fill-inbox 2>&1) || FILL_EXIT=$?
    echo "$FILL_OUTPUT" >> "$LOG_FILE"
    log "fill-inbox の実行が完了しました (終了コード: $FILL_EXIT)"
  fi
else
  log "inbox の未処理論文は十分にあるため、補充をスキップします"
fi

# -------------------------------------------------------------
# 4. パイプラインを実行
# -------------------------------------------------------------
log "パイプラインを開始します: npm start -- --headless --exit-on-quota"

if [ "$DRY_RUN" = true ]; then
  log "[dry-run] npm start -- --headless --exit-on-quota をスキップします"
else
  PIPELINE_EXIT=0
  npm start -- --headless --exit-on-quota >> "$LOG_FILE" 2>&1 || PIPELINE_EXIT=$?
  log "パイプラインが終了しました (終了コード: $PIPELINE_EXIT)"
fi

log "=== 定期実行チェックを完了しました ==="
