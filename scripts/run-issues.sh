#!/usr/bin/env bash

# Antigravity CLI (agy) を Issue ごとに新しい非対話セッションで起動し、
# 指定した Issue を 1 件ずつ完了させる。KotoLink の scripts/run-issues.sh を元にしている。
#
#   scripts/run-issues.sh 81 82      # 指定した Issue を順に処理
#
# 1 セッション = 1 Issue とすることで会話コンテキストの肥大化を防ぎ、
# --print-timeout で固まったセッションを打ち切って同じ Issue を新しいセッションで再開する。
#
# 元のフォルダでは開発サーバー (npm run dev) が動いている。そこでブランチを切り替えたり
# next build したりすると動いているアプリが壊れるので、agy は専用の作業木で動かす。
# 本番の Supabase / R2 につながる .env.local は作業木へコピーしない。

set -u
set -o pipefail

readonly EXIT_USAGE=64
readonly EXIT_FAILED=1
readonly EXIT_NOT_CLOSED=2
readonly EXIT_AUTH=70
readonly EXIT_LIMIT=71

fail() {
  printf 'run-issues: %s\n' "$1" >&2
  exit "${2:-$EXIT_FAILED}"
}

log() {
  printf 'run-issues: %s\n' "$1" >&2
}

agy_bin=${EDUSHARE_AGY_BIN:-agy}
# 作業記録 (ai-dispatch-log)。無ければ記録を省く。空文字を渡すと無効化できる。
dispatch_bin=${EDUSHARE_DISPATCH_BIN-ai-dispatch-log}
gh_bin=${EDUSHARE_GH_BIN:-gh}
model=${EDUSHARE_AGY_MODEL:-}
session_timeout=${EDUSHARE_SESSION_TIMEOUT:-90m}
limit_wait=${EDUSHARE_LIMIT_WAIT:-1800}
limit_retries=${EDUSHARE_LIMIT_RETRIES:-6}
stall_retries=${EDUSHARE_STALL_RETRIES:-2}
# 非対話実行では権限確認に応答できないため、既定で確認を省略する。
# 変更したい場合は EDUSHARE_AGY_ARGS で上書きする。
read -r -a agy_args <<<"${EDUSHARE_AGY_ARGS---dangerously-skip-permissions}"

command -v "$agy_bin" >/dev/null 2>&1 || fail "agy not found: $agy_bin" "$EXIT_USAGE"
command -v "$gh_bin" >/dev/null 2>&1 || fail "gh not found: $gh_bin" "$EXIT_USAGE"

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail "not inside a Git repository" "$EXIT_USAGE"
cd "$repo_root" || fail "cannot enter $repo_root" "$EXIT_USAGE"
log_dir=${EDUSHARE_RUN_LOG_DIR:-$repo_root/.run-issues}
mkdir -p "$log_dir" || fail "cannot create log directory: $log_dir"
work_dir=${EDUSHARE_AGY_WORKTREE:-$(dirname "$repo_root")/$(basename "$repo_root")-agy}

[[ $# -gt 0 ]] || fail "usage: scripts/run-issues.sh <issue>..." "$EXIT_USAGE"
issues=("$@")

for issue in "${issues[@]}"; do
  [[ "$issue" =~ ^[0-9]+$ ]] || fail "issue number must be numeric: $issue" "$EXIT_USAGE"
done

# agy 専用の作業木を用意する。既にあれば使い回す (ブランチや作業中の変更は agy が扱う)。
prepare_worktree() {
  if [[ ! -e "$work_dir/.git" ]]; then
    git fetch --quiet origin main || return 1
    git worktree add --quiet --detach "$work_dir" origin/main || return 1
  fi
  [[ -e "$work_dir/.env.local" ]] && { log "refusing to run: $work_dir/.env.local exists"; return 1; }
  if [[ -f "$work_dir/package-lock.json" && ! -d "$work_dir/node_modules" ]]; then
    log "installing dependencies in $work_dir"
    (cd "$work_dir" && npm ci --silent) || return 1
  fi
  return 0
}

issue_state() {
  "$gh_bin" issue view "$1" --json state --jq .state 2>/dev/null
}

matches() {
  tail -n 80 "$2" | grep -Eqi "$1"
}

# セッションの記録はランナーが取る。実際に渡したモデル名を残すため、エージェント任せにしない。
have_dispatch() {
  [[ -n "$dispatch_bin" ]] && command -v "$dispatch_bin" >/dev/null 2>&1
}

dispatch_start() {
  have_dispatch || return 0
  local args=(start --to antigravity --kind implement --task "Issue #$1 (attempt $2)"
    --instruction "run-issues.sh: Issue #$1 を完了させる")
  [[ -n "$model" ]] && args+=(--model "$model")
  "$dispatch_bin" "${args[@]}" 2>/dev/null | tail -n 1
}

dispatch_finish() {
  local id=$1 result=$2
  shift 2
  [[ -n "$id" ]] || return 0
  "$dispatch_bin" finish --id "$id" --result "$result" --usage-note "未計測" "$@" >/dev/null 2>&1
  "$dispatch_bin" antigravity-attach --id "$id" >/dev/null 2>&1
  return 0
}

build_prompt() {
  cat <<EOF
AGENTS.md と docs/development-workflow.md に従い、Issue #$1 だけを完了させてください。
作業はこの作業木 ($work_dir) の中だけで行ってください。元のフォルダ ($repo_root) には触れないでください。
このリポジトリの作業は所有者が承認済みです。途中でユーザーへ確認を求めず、最後まで進めてください。
この Issue のブランチや Draft PR が既にあれば、最初からやり直さずに続きから再開してください。
PR がマージされ Issue がクローズされたら、次の Issue には進まずに終了してください。
npm run dev などの終了しないコマンドを実行しないでください。制限時間 (-m) のない curl も実行しないでください。
本番の Supabase / R2 への接続、.env.local の作成、paper-pipeline の実行はしないでください。
EOF
  if have_dispatch; then
    printf '%s\n' 'ai-dispatch-log への記録はランナーが行います。あなたは start / finish を実行しないでください。'
  fi
}

prepare_worktree || fail "cannot prepare worktree: $work_dir"

for issue in "${issues[@]}"; do
  if [[ "$(issue_state "$issue")" == "CLOSED" ]]; then
    log "issue #$issue is already closed; skipping"
    continue
  fi

  limit_count=0
  stall_count=0
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    log_file="$log_dir/issue-$issue-attempt-$attempt.log"
    log "issue #$issue: starting fresh Antigravity session (attempt $attempt, log $log_file)"

    cmd=("$agy_bin" -p "$(build_prompt "$issue")" --print-timeout "$session_timeout")
    [[ -n "$model" ]] && cmd+=(--model "$model")
    cmd+=(${agy_args[@]+"${agy_args[@]}"})
    dispatch_id=$(dispatch_start "$issue" "$attempt")
    (cd "$work_dir" && "${cmd[@]}") >"$log_file" 2>&1
    status=$?

    if [[ $status -eq 0 ]]; then
      dispatch_finish "$dispatch_id" "セッション終了 (Issue の状態: $(issue_state "$issue"))"
      break
    fi
    dispatch_finish "$dispatch_id" "agy が終了コード $status で終了 (ログ: ${log_file##*/})" --failed

    if matches 'unauthenticated|authentication|not logged in|login required|invalid credential' "$log_file"; then
      fail "issue #$issue: agy authentication failed; run 'agy' once interactively to log in (see $log_file)" "$EXIT_AUTH"
    fi

    if matches 'usage limit|rate.?limit|quota|resource exhausted|too many requests|limit (reached|exceeded)|try again (in|later)' "$log_file"; then
      limit_count=$((limit_count + 1))
      [[ $limit_count -le $limit_retries ]] \
        || fail "issue #$issue: usage limit persisted after $limit_retries retries" "$EXIT_LIMIT"
      log "issue #$issue: usage limit reached; waiting ${limit_wait}s before resuming"
      sleep "$limit_wait"
      continue
    fi

    if matches 'timed? ?out|timeout|deadline exceeded' "$log_file"; then
      stall_count=$((stall_count + 1))
      [[ $stall_count -le $stall_retries ]] \
        || fail "issue #$issue: session timed out $stall_count times; see $log_file"
      log "issue #$issue: session exceeded $session_timeout; resuming in a fresh session"
      continue
    fi

    tail -n 20 "$log_file" >&2
    fail "issue #$issue: agy exited with status $status; see $log_file"
  done

  if [[ "$(issue_state "$issue")" != "CLOSED" ]]; then
    fail "issue #$issue: session finished but the issue is still open; see $log_file" "$EXIT_NOT_CLOSED"
  fi
  log "issue #$issue: closed"
done

log "all requested issues are closed"
