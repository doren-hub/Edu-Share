#!/usr/bin/env bash

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
delegate_script="$script_dir/delegate.sh"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

origin="$tmp_dir/origin.git"
repo="$tmp_dir/repo"
fake_bin="$tmp_dir/bin"
mkdir -p "$fake_bin"
git init --bare "$origin" >/dev/null
git init -b main "$repo" >/dev/null
git -C "$repo" config user.name test
git -C "$repo" config user.email test@example.com
printf 'fixture\n' > "$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -m init >/dev/null
git -C "$repo" remote add origin "$origin"
git -C "$repo" push -u origin main >/dev/null
git -C "$repo" switch -c chore/issue-72 >/dev/null

cat > "$fake_bin/agy" <<'FAKE_AGY'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$AGY_ARGS_FILE"
if [ "${1:-}" = models ]; then
  printf 'gemini-9.9-flash-high\tGemini 9.9 Flash (High)\n'
  exit 0
fi
printf 'delegated\n' > DELEGATED.txt
cat > DELEGATE_RESULT.md <<'RESULT'
- 変更したファイルの一覧: DELEGATED.txt
- テスト: 成功
- 要約: fixture
- 判断に迷った点: なし
- 分かりにくかった点: なし
RESULT
printf '{"status":"SUCCESS","response":"done"}\n'
FAKE_AGY
chmod +x "$fake_bin/agy"

instruction="$tmp_dir/instruction.md"
cat > "$instruction" <<'INSTRUCTION'
# タスク: smoke-test
## 目的
fixture
INSTRUCTION

(
  cd "$repo"
  PATH="$fake_bin:$PATH" AGY_ARGS_FILE="$tmp_dir/agy-args" DELEGATE_LOG_DIR="$tmp_dir/log" DELEGATE_TIMEOUT=5s "$delegate_script" "$instruction"
)

test -f "$repo/.worktrees/72-smoke-test/DELEGATE_RESULT.md"
test -f "$repo/.worktrees/72-smoke-test/DELEGATED.txt"
test -f "$tmp_dir/log/repo.jsonl"
grep -q '"failure_type":"success"' "$tmp_dir/log/repo.jsonl"
grep -q '"model":"gemini-9.9-flash-high"' "$tmp_dir/log/repo.jsonl"
grep -q -- '--sandbox' "$tmp_dir/agy-args"
if grep -q 'fixture' "$tmp_dir/log/repo.jsonl"; then
  printf 'Instruction content leaked into the JSONL log.\n' >&2
  exit 1
fi

printf 'delegate.sh smoke test passed\n'
