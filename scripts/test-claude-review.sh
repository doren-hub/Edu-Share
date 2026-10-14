#!/usr/bin/env bash

# scripts/claude-review.sh のテスト。偽の claude / gh と一時 Git リポジトリで動き、
# ネットワークや認証は不要。

set -euo pipefail

script="$(git rev-parse --show-toplevel)/scripts/claude-review.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

# --- 一時リポジトリ (origin + 作業コピー) ---
git init -q --bare "$test_root/origin.git"
work="$test_root/work"
git clone -q "$test_root/origin.git" "$work" 2>/dev/null
cd "$work"
git config user.email t@example.com
git config user.name test
git switch -q -c main
echo base >file.txt
git add file.txt
git commit -qm base
git push -q 2>/dev/null origin main
git switch -q -c feature
echo first >>file.txt
git commit -qam first
git push -q 2>/dev/null origin feature

# --- 偽 gh ---
cat >"$test_root/gh" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "issue view") echo "ISSUE BODY: 受け入れ条件" ;;
  "pr view")
    if [[ "$*" == *--json* ]]; then
      echo "main feature $(git rev-parse origin/feature)"
    else
      echo "PR OVERVIEW"
    fi ;;
  "pr diff") git diff origin/main...origin/feature ;;
  "pr comment")
    [[ "$4" == "--body-file" ]] || exit 1
    n=$(($(cat "$KL_CALLS/comments" 2>/dev/null || echo 0) + 1))
    echo "$n" >"$KL_CALLS/comments"
    cp "$5" "$KL_CALLS/comment-$n" ;;
  *) exit 1 ;;
esac
EOF

# --- 偽 claude: 引数と標準入力を記録し、$KL_VERDICT を出力する ---
cat >"$test_root/claude" <<'EOF'
#!/usr/bin/env bash
n=$(($(cat "$KL_CALLS/count" 2>/dev/null || echo 0) + 1))
echo "$n" >"$KL_CALLS/count"
printf '%s\n' "$@" >"$KL_CALLS/args-$n"
cat >"$KL_CALLS/stdin-$n"
printf 'レビュー本文\n%s\n' "${KL_VERDICT:-OK}"
exit "${KL_EXIT:-0}"
EOF
chmod +x "$test_root/gh" "$test_root/claude"

calls="$test_root/calls"
mkdir -p "$calls"
export KL_CALLS="$calls"
export EDUSHARE_CLAUDE_BIN="$test_root/claude"
export EDUSHARE_GH_BIN="$test_root/gh"
export EDUSHARE_REVIEW_DIR="$test_root/review"
session_file="$EDUSHARE_REVIEW_DIR/7/session_id"
reviewed_file="$EDUSHARE_REVIEW_DIR/7/reviewed_sha"

run() {
  set +e
  output=$("$script" "$@" 2>&1)
  status=$?
  set -e
}

fail() { echo "FAIL: $1" >&2; echo "$output" >&2; exit 1; }

# 1. 初回: 全差分・固定モデル・新規セッション・承認
run 7 8
[[ $status -eq 0 ]] || fail "initial review should approve"
[[ -s "$session_file" ]] || fail "session id not saved"
[[ "$(cat "$reviewed_file")" == "$(git rev-parse origin/feature)" ]] || fail "reviewed sha not saved"
grep -Fx -- 'claude-opus-5-5' "$calls/args-1" >/dev/null || fail "model not pinned"
grep -Fx -- 'low' "$calls/args-1" >/dev/null || fail "effort not low"
grep -Fx -- '--session-id' "$calls/args-1" >/dev/null || fail "new session not created"
grep -F -- 'Bash(npm test:*)' "$calls/args-1" >/dev/null || fail "npm test not allowed"
grep -F -- 'Edit,Write' "$calls/args-1" >/dev/null || fail "write tools not disallowed"
grep -F 'ISSUE BODY' "$calls/stdin-1" >/dev/null || fail "issue not embedded"
grep -F '+first' "$calls/stdin-1" >/dev/null || fail "full diff not embedded"
grep -F 'ai-dispatch-log' "$calls/stdin-1" >/dev/null || fail "reviewer not told to skip dispatch logging"
grep -F 'Claude レビュー: APPROVED' "$calls/comment-1" >/dev/null || fail "review not posted to the PR"
grep -F 'レビュー本文' "$calls/comment-1" >/dev/null || fail "review body missing from the PR comment"
session_id=$(cat "$session_file")

# 2. 変更なしで再実行するとエラー (同じ差分を再送しない)
run 7 8
[[ $status -eq 1 ]] || fail "unchanged re-review should fail"
[[ "$(cat "$calls/count")" -eq 1 ]] || fail "claude should not be called without changes"

# 3. 再レビュー: 同じセッション・追加差分のみ・補足を渡す・指摘ありは 2
echo second >>file.txt
git commit -qam second
git push -q 2>/dev/null origin feature
KL_VERDICT="指摘が残っています" run 7 8 '指摘1を修正、npm test 成功'
[[ $status -eq 2 ]] || fail "changes requested should exit 2"
grep -Fx -- '--resume' "$calls/args-2" >/dev/null || fail "re-review did not resume"
grep -Fx -- "$session_id" "$calls/args-2" >/dev/null || fail "re-review used another session"
grep -F '+second' "$calls/stdin-2" >/dev/null || fail "incremental diff missing"
if grep -F '+first' "$calls/stdin-2" >/dev/null; then fail "re-review resent the full diff"; fi
grep -F '再レビュー' "$calls/stdin-2" >/dev/null || fail "re-review prompt not used"
grep -F '指摘1を修正' "$calls/stdin-2" >/dev/null || fail "follow-up context missing"
[[ "$(cat "$reviewed_file")" == "$(git rev-parse origin/feature)" ]] || fail "reviewed sha not advanced"
grep -F 'Claude レビュー: CHANGES REQUESTED' "$calls/comment-2" >/dev/null || fail "re-review not posted to the PR"

# 4. claude の失敗はエラー 1、レビュー済みコミットは進めない
echo third >>file.txt
git commit -qam third
git push -q 2>/dev/null origin feature
before=$(cat "$reviewed_file")
KL_EXIT=3 run 7 8
[[ $status -eq 1 ]] || fail "claude failure should exit 1"
[[ "$(cat "$reviewed_file")" == "$before" ]] || fail "reviewed sha advanced on failure"
[[ "$(cat "$calls/comments")" -eq 2 ]] || fail "failed review should not be posted"


# 5. 履歴が書き換えられた場合は全差分に戻る
git reset -q --hard origin/main
echo rewritten >>file.txt
git commit -qam rewritten
git push -q -f origin feature 2>/dev/null
EDUSHARE_REVIEW_COMMENT=0 run 7 8
[[ $status -eq 0 ]] || fail "rewritten history review should run"
[[ "$(cat "$calls/comments")" -eq 2 ]] || fail "comment posted although disabled"
n=$(cat "$calls/count")
grep -F '+rewritten' "$calls/stdin-$n" >/dev/null || fail "rewritten diff missing"
if grep -F '再レビューです' "$calls/stdin-$n" >/dev/null; then fail "should fall back to full review"; fi
grep -Fx -- '--resume' "$calls/args-$n" >/dev/null || fail "should still resume the issue session"

# 6. 不正な引数
run abc 8
[[ $status -eq 64 ]] || fail "invalid args should exit 64"

echo "claude-review tests passed"
