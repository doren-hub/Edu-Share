#!/usr/bin/env bash
set -euo pipefail

# macOS launchd または cron 用 paper-pipeline 定期実行スクリプト
#
# 処理順序:
# 1. 二重起動防止（ロック取得、既存プロセスの確認）
# 2. Notebook 利用枠の確認（npm run quota-check）
# 3. inbox の未処理論文数を確認し、足りなければ補充（npm run fill-inbox）
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

# .env を読み込み（既存の環境変数は上書きしない）
if [ -f "$PIPELINE_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PIPELINE_ROOT/.env" 2>/dev/null || true
  set +a
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
# 0. ロック取得（二重起動防止）
# -------------------------------------------------------------
LOCK_DIR="${SCHEDULED_LOCK_DIR:-/tmp/paper-pipeline-scheduled-run.lock}"

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$LOCK_DIR/pid"
    return 0
  fi

  local existing_pid=""
  if [ -f "$LOCK_DIR/pid" ]; then
    existing_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  fi

  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    log "スキップ: 別の定期実行スクリプトが動作中です (PID: $existing_pid)"
    exit 0
  fi

  log "警告: 古いロックファイルを検出しました (PID: ${existing_pid:-不明} は停止中)。ロックを再取得します"
  rm -rf "$LOCK_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$LOCK_DIR/pid"
    return 0
  fi

  log "エラー: ロックの取得に失敗しました"
  exit 1
}

acquire_lock
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

# -------------------------------------------------------------
# 1. すでにパイプラインか専用プロファイルの Chrome が動いていれば終了
# -------------------------------------------------------------
NODE_PIDS=$(pgrep -f "(dist|src)/(orchestrate|cli|fill-inbox-cli)\.(js|ts)" || true)
CHROME_PIDS=$(pgrep -f "\.chrome-profile" || true)

if [ -n "$NODE_PIDS" ] || [ -n "$CHROME_PIDS" ]; then
  log "スキップ: すでにパイプラインまたは専用プロファイルの Chrome が実行中です (Node PID: ${NODE_PIDS:-なし}, Chrome PID: ${CHROME_PIDS:-なし})"
  exit 0
fi

# -------------------------------------------------------------
# 2. Notebook の利用枠を確認
# -------------------------------------------------------------
log "Notebook 利用枠を確認します (npm run quota-check)"
QUOTA_EXIT=0
QUOTA_OUTPUT=$(npm run quota-check 2>&1) || QUOTA_EXIT=$?

echo "$QUOTA_OUTPUT" >> "$LOG_FILE"

if [ "$QUOTA_EXIT" -ne 0 ]; then
  if [ "$QUOTA_EXIT" -eq 11 ]; then
    log "スキップ: Notebook 利用枠が止める値に達しています (終了コード: 11)"
  elif [ "$QUOTA_EXIT" -eq 12 ]; then
    log "スキップ: Notebook 利用量を読めませんでした (終了コード: 12)。安全のため実行を見送ります"
  else
    log "スキップ: Notebook 利用枠の確認でエラーが発生しました (終了コード: $QUOTA_EXIT)。安全のため実行を見送ります"
  fi
  exit 0
fi

log "Notebook 利用枠に空きがあります"

# -------------------------------------------------------------
# 3. inbox の未処理論文数を確認し、足りなければ補充
# -------------------------------------------------------------
INBOX_DIR="${PAPER_INBOX_DIR:-}"
INBOX_MIN_PAPERS="${INBOX_MIN_PAPERS:-5}"

INBOX_COUNT=0
if [ -n "$INBOX_DIR" ] && [ -d "$INBOX_DIR" ]; then
  INBOX_COUNT=$(find "$INBOX_DIR" -maxdepth 1 -type f -iname "*.pdf" ! -name ".*" 2>/dev/null | wc -l | tr -d ' ')
fi

log "inbox の未処理論文数: ${INBOX_COUNT} 件（しきい値: ${INBOX_MIN_PAPERS} 件）"

if [ "$INBOX_COUNT" -lt "$INBOX_MIN_PAPERS" ]; then
  log "未処理論文が不足しているため、npm run fill-inbox で補充します"
  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] npm run fill-inbox をスキップします"
  else
    FILL_EXIT=0
    FILL_OUTPUT=$(npm run fill-inbox 2>&1) || FILL_EXIT=$?
    echo "$FILL_OUTPUT" >> "$LOG_FILE"
    log "fill-inbox の実行が完了しました (終了コード: $FILL_EXIT)"
  fi
else
  log "未処理論文が十分にあるため、補充をスキップします"
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
