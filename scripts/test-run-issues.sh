#!/usr/bin/env bash

# scripts/run-issues.sh のテスト。偽の agy / gh を使い、ネットワークや認証なしで動く。

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

state_dir="$test_root/state"
mkdir -p "$state_dir"
calls_file="$test_root/calls"

# 偽 gh: Issue の状態を $state_dir/<issue> から読む (既定は OPEN)。
cat >"$test_root/gh" <<'EOF'
#!/usr/bin/env bash
cat "$KL_TEST_STATE_DIR/$3" 2>/dev/null || printf 'OPEN\n'
EOF

# 偽 agy: 呼び出しごとの動作を $KL_TEST_SCRIPT の行で指定する。
cat >"$test_root/agy" <<'EOF'
#!/usr/bin/env bash
count=$(($(cat "$KL_TEST_COUNT" 2>/dev/null || printf 0) + 1))
printf '%s' "$count" >"$KL_TEST_COUNT"
printf 'CALL [%s] %s\n' "$PWD" "$*" | tr '\n' ' ' >>"$KL_TEST_CALLS"
printf '\n' >>"$KL_TEST_CALLS"
issue=$(printf '%s' "$*" | grep -Eo 'Issue #[0-9]+' | head -n 1 | tr -dc 0-9)
action=$(sed -n "${count}p" "$KL_TEST_SCRIPT")
case "$action" in
  close) printf 'CLOSED\n' >"$KL_TEST_STATE_DIR/$issue"; exit 0 ;;
  leave-open) exit 0 ;;
  limit) printf 'Error: usage limit reached. Try again later.\n'; exit 1 ;;
  timeout) printf 'Error: print timeout exceeded\n'; exit 1 ;;
  auth) printf 'Error: not logged in\n'; exit 1 ;;
  *) printf 'Error: build failed\n'; exit 1 ;;
esac
EOF

# 偽 ai-dispatch-log: 呼び出しを記録し、start では id を返す (本物のログには書かない)。
cat >"$test_root/dispatch" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$KL_TEST_DISPATCH"
[[ "$1" == "start" ]] && printf 'test-id\n'
exit 0
EOF
chmod +x "$test_root/gh" "$test_root/agy" "$test_root/dispatch"


export EDUSHARE_AGY_BIN="$test_root/agy"
export EDUSHARE_GH_BIN="$test_root/gh"
export EDUSHARE_DISPATCH_BIN="$test_root/dispatch"
export KL_TEST_DISPATCH="$test_root/dispatch-calls"
export EDUSHARE_RUN_LOG_DIR="$test_root/logs"
# 作業木は作成済みとして扱い、本物のリポジトリに作業木を足さない。
export EDUSHARE_AGY_WORKTREE="$test_root/worktree"
mkdir -p "$EDUSHARE_AGY_WORKTREE"
printf 'gitdir: none\n' >"$EDUSHARE_AGY_WORKTREE/.git"
export EDUSHARE_LIMIT_WAIT=0
export EDUSHARE_LIMIT_RETRIES=2
export EDUSHARE_STALL_RETRIES=1
export KL_TEST_STATE_DIR="$state_dir"
export KL_TEST_CALLS="$calls_file"
export KL_TEST_COUNT="$test_root/count"
export KL_TEST_SCRIPT="$test_root/script"
unset EDUSHARE_AGY_MODEL

reset() {
  rm -f "$calls_file" "$KL_TEST_COUNT" "$KL_TEST_DISPATCH" "$state_dir"/*
  printf '%s\n' "$@" >"$KL_TEST_SCRIPT"
}

run() {
  set +e
  (cd "$repo_root" && "$repo_root/scripts/run-issues.sh" "$@" 2>/dev/null)
  status=$?
  set -e
}

calls() { grep -c '^CALL' "$calls_file" 2>/dev/null || true; }

# Issue ごとに新しいセッション。クローズ済みはスキップ。既定で権限確認を省略。
reset close close
printf 'CLOSED\n' >"$state_dir/12"
run 12 13 14
[[ $status -eq 0 ]]
[[ "$(calls)" -eq 2 ]]
grep -F -- '--dangerously-skip-permissions' "$calls_file" >/dev/null
grep -F -- '--print-timeout 90m' "$calls_file" >/dev/null
grep -F 'Issue #13 だけ' "$calls_file" >/dev/null
grep -F 'Issue #14 だけ' "$calls_file" >/dev/null
if grep -F 'Issue #12' "$calls_file" >/dev/null; then exit 1; fi

# 引数なしは拒否する。
reset close
run
[[ $status -eq 64 ]]
[[ "$(calls)" -eq 0 ]]

# 利用制限は待ってから同じ Issue を新しいセッションで再開する。
reset limit close
run 13
[[ $status -eq 0 ]]
[[ "$(calls)" -eq 2 ]]

# 利用制限が続けば 71 で停止。
reset limit limit limit
run 13
[[ $status -eq 71 ]]
[[ "$(calls)" -eq 3 ]]

# タイムアウト (固まったセッション) は新しいセッションで再開する。
reset timeout close
run 13
[[ $status -eq 0 ]]
[[ "$(calls)" -eq 2 ]]

# タイムアウトが上限を超えたら停止。
reset timeout timeout close
run 13
[[ $status -eq 1 ]]
[[ "$(calls)" -eq 2 ]]

# 認証エラーは 70 で即停止。
reset auth close
run 13
[[ $status -eq 70 ]]
[[ "$(calls)" -eq 1 ]]

# その他の失敗は後続 Issue に進まず停止。
reset fail close
run 13 14
[[ $status -eq 1 ]]
if grep -F 'Issue #14' "$calls_file" >/dev/null; then exit 1; fi

# 正常終了でも Issue が開いたままなら失敗扱い。
reset leave-open close
run 13 14
[[ $status -eq 2 ]]
if grep -F 'Issue #14' "$calls_file" >/dev/null; then exit 1; fi

# 作業記録はランナーが取り、渡したモデル名を残す。失敗したセッションは --failed。
reset fail
EDUSHARE_AGY_MODEL=test-model run 13
[[ $status -eq 1 ]]
grep -F -- '--model test-model' "$calls_file" >/dev/null
grep -E '^start .*--to antigravity .*Issue #13 \(attempt 1\).*--model test-model' "$KL_TEST_DISPATCH" >/dev/null
grep -E '^finish --id test-id .*--failed' "$KL_TEST_DISPATCH" >/dev/null
grep -Fx 'antigravity-attach --id test-id' "$KL_TEST_DISPATCH" >/dev/null
grep -F 'start / finish を実行しないでください' "$calls_file" >/dev/null

reset close
run 13
[[ $status -eq 0 ]]
if grep -F -- '--model' "$KL_TEST_DISPATCH" >/dev/null; then exit 1; fi
if grep -F -- '--failed' "$KL_TEST_DISPATCH" >/dev/null; then exit 1; fi

# ai-dispatch-log が無い環境でも動き、プロンプトでも触れない。
reset close
EDUSHARE_DISPATCH_BIN= run 13
[[ $status -eq 0 ]]
[[ ! -e "$KL_TEST_DISPATCH" ]]
if grep -F 'ai-dispatch-log' "$calls_file" >/dev/null; then exit 1; fi

# agy は専用の作業木で動く。
reset close
run 13
grep -F "CALL [$EDUSHARE_AGY_WORKTREE]" "$calls_file" >/dev/null

# 作業木に .env.local があれば agy を起動しない。
reset close
touch "$EDUSHARE_AGY_WORKTREE/.env.local"
run 13
rm -f "$EDUSHARE_AGY_WORKTREE/.env.local"
[[ $status -eq 1 ]]
[[ "$(calls)" -eq 0 ]]

# 不正な引数は拒否。
run abc
[[ $status -eq 64 ]]

printf 'run-issues tests passed\n'
