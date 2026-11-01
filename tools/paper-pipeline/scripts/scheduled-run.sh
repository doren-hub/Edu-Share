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
# 4. パイプライン実行（npm start -- --headless --exit-on-quota --no-reveal-login）

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
LOCK_OWNED=0

cleanup_lock() {
  if [ "$LOCK_OWNED" -eq 1 ]; then
    rm -rf "$LOCK_DIR"
    LOCK_OWNED=0
  fi
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
    LOCK_OWNED=1
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
    local moved_pid=""
    if [ -f "$stale_dir/pid" ]; then
      moved_pid=$(cat "$stale_dir/pid" 2>/dev/null || true)
    fi
    if [ "$moved_pid" != "$existing_pid" ]; then
      log "警告: 退避したロックは別プロセス (PID: ${moved_pid:-なし}) のものでした。元に戻してスキップします"
      mv "$stale_dir" "$LOCK_DIR" 2>/dev/null || rm -rf "$stale_dir"
      exit 0
    fi
    rm -rf "$stale_dir"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "$$" > "$LOCK_DIR/pid"
      LOCK_OWNED=1
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

DECISION_ENV=""
DECISION_EXIT=0
DECISION_ENV=$(npm run --silent scheduled-decide -- --env 2>> "$LOG_FILE") || DECISION_EXIT=$?

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
    14)
      log "スキップ: プロセス一覧の取得に失敗しました。安全のため動かしません"
      ;;
    *)
      log "スキップ: 判断処理で予期せぬ終了コード ($DECISION_EXIT) が返されました。安全のため動かしません"
      ;;
  esac
  exit 0
fi

log "判断結果: 実行可能です"

# key-value から各変数を安全に取得
NEEDS_FILL=false
if echo "$DECISION_ENV" | grep -q '^NEEDS_FILL=true'; then
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
log "パイプラインを開始します: npm start -- --headless --exit-on-quota --no-reveal-login"

if [ "$DRY_RUN" = true ]; then
  log "[dry-run] npm start -- --headless --exit-on-quota --no-reveal-login をスキップします"
else
  PIPELINE_EXIT=0
  npm start -- --headless --exit-on-quota --no-reveal-login >> "$LOG_FILE" 2>&1 || PIPELINE_EXIT=$?
  if [ "$PIPELINE_EXIT" -eq 15 ]; then
    log "注意: ログインまたは追加確認が必要です (終了コード: 15)。主人が画面付きモード等でログインを完了してください"
  else
    log "パイプラインが終了しました (終了コード: $PIPELINE_EXIT)"
  fi
fi

log "=== 定期実行チェックを完了しました ==="
