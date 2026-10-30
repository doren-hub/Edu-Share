# Autonomous development workflow

The repository is delivered as a sequence of small, independently reviewed issues. The default is continuous implementation without waiting for routine user approval.

## Issue lifecycle

```text
select next unblocked issue
  -> branch and empty kickoff commit
  -> Draft PR with Closes #N
  -> implement and run the configured local test command
  -> Claude Opus 5.5 review (low effort)
  -> fix and re-review until OK
  -> create follow-up issues for out-of-scope improvements
  -> update PR body and mark ready
  -> wait for CI to pass
  -> merge PR
  -> verify issue closed
  -> select next issue
```

Only one implementation issue may be active in this loop. A newly discovered follow-up issue is recorded but not started until the active issue is merged.

## Selecting the next issue

1. Follow the owner’s explicitly requested issue scope and order. Otherwise, use the order in `docs/roadmap.md` if it exists; if it does not, select from open GitHub issues using repository priorities and dependencies.
2. Skip an issue only when an unresolved dependency makes it impossible to complete.
3. Prefer the earliest unblocked prerequisite instead.
4. Record any ordering change in the relevant issue.

## Sessions and context budget

Run each issue in its own Antigravity session, preferably with `kurukuru run <issue>...`, so conversation context does not accumulate across issues.

The owner or outer orchestrator starts those sessions. Inside a runner session, never invoke `kurukuru run`, `kurukuru exec`, or `kurukuru queue` (including `queue run`), or `kurukuru batch`: this would recursively start runners. Complete only the assigned issue in the current session. `kurukuru review` and `kurukuru ci-wait` remain available.

- At the start of each session, read only `AGENTS.md`, this workflow, the target issue, and `docs/roadmap.md` if it exists. Read design notes, README, and other files only when the issue needs them.
- If the runner owns dispatch recording, do not duplicate it. Otherwise, if `ai-dispatch-log` is available, record every session separately: run `ai-dispatch-log start` when the session begins, and `ai-dispatch-log finish` followed by `ai-dispatch-log antigravity-attach` before it exits, including when it stops on a failure.
- Read only failures from test and lint output (for example pipe through `tail -n 30` or `grep -E 'FAIL|ERROR'`).
- Locally run the tests for changed code (using the configured test command and its relevant filters) and run the full local test command before Draft review.
- Wait for CI by invoking `kurukuru ci-wait <pr>` once per reviewed head. It pins the head SHA, waits quietly without AI calls, and returns one summary. Do not repeatedly poll `gh pr checks`. Exit 0 means passed; 1 means failure/unavailable, 2 means head changed (fresh verification and review required), 3 means timeout (including checks that remain all-skipped), and 4 means No CI: no checks, check suites or workflow runs have been observed, and either no workflows exist, all PR workflows are provably excluded by paths, or the registration grace of `max(60, interval)` seconds has elapsed. Exit 5 (CI excluded) is no longer emitted; proven path exclusion also returns 4. Unsupported YAML/globs do not prove exclusion but may reach the registration grace. A timeout shorter than the grace still returns 3; any observed CI prevents No CI even if it later disappears. Metadata errors remain unavailable. CI that registers after the grace cannot be predicted. For exit 4, require local verification and Claude OK tied to the same head, and record both plus the No CI result in the PR body before merging. `--timeout` (default 3600) and `--interval` (default 60) use positive seconds. Failure output includes job names and at most 20 log lines per failed job when available. Timing and head metadata are saved under `.kurukuru/run/ci-wait-*.json`.

## Starting work

The target branch is `main`, configured by top-level `base_branch` in `.kurukuru.toml` (default: `main`). Use it as the PR base.

1. Update local `main` with a fast-forward-only pull.
2. Create `antigravity/<short-description>` from `main`.
3. Create an empty commit named `chore: start issue <N>`.
4. Push the branch.
5. Open a Draft PR immediately and include `Closes #N`.

## Implementation and verification

- Implement only the issue acceptance criteria and necessary supporting work.
- Add tests proportional to risk. Tests must not touch the network or real GitHub or AI CLIs.
- Run the repository verification commands:

- Test: `npm test`
- Lint: `npm run lint`

- Keep the PR body current when scope or verification results change.
- Do not hide failing checks or describe an unverified result as passing.

## Draft review and final CI

Keep the PR Draft while implementing. Run the configured local test command before Claude
review and repeat verification and review until `OK`. For each local result,
record execution time, current head SHA, command, and exit code in the PR body
or review context. Supply this evidence instead of CI while Draft; skipped or
absent Draft CI is expected, never a passing result. The reviewer must not return
`OK` if the evidence SHA differs from the current PR head or evidence is missing.
After `OK`, update the PR body, mark Ready, and wait for CI as the final gate.
If CI fails after Ready, keep the PR Ready, fix and push, rerun local checks,
and re-review the changed diff in the same Claude conversation until `OK`;
then wait for CI on that head to pass before merging.

## Repository-local review instructions

Before reviewing, read the
[repository-local instructions in AGENTS.md](../AGENTS.md#repository-local-instructions),
sourced from `AGENTS.local.md` when present. Those instructions take precedence
over the generated review defaults below, including the review command, reviewer
permissions, evidence and logging rules. Apply stricter local restrictions; the
defaults never authorize expanding reviewer permissions. If local rules require
Read/Glob/Grep only, do not use the same-repository Bash allowance below.

## Claude review

The review must use Claude Code with:

```text
model: claude-opus-5-5
effort: low
session: persistent per issue/PR
mode: read-only
```

Run `kurukuru review <issue> <pr>` for the first review and `kurukuru review <issue> <pr> "<what changed, test results>"` for each re-review. The script tells Claude to:

- review the issue requirements and the complete PR diff;
- prioritize correctness, regressions, security, data loss, concurrency, permissions, and missing tests;
- cite files and lines for actionable findings;
- distinguish blocking findings from optional, out-of-scope improvements;
- return a final standalone `OK` only when no actionable in-scope findings remain.

Additional repository review notes:

- 本番の DB・R2 を壊しうる変更（削除、広い範囲の書き換え、マイグレーションの安全性）


## Default Claude review contract

- Executable: `claude`, resolved from `KURUKURU_CLAUDE_BIN`, `[commands].claude` in `.kurukuru.toml`, or `PATH`.
- Model: `claude-opus-5-5`.
- Effort: `low`.
- Review mode: read-only. For same-repository PRs, configured Bash rules and Git diff/log/show/status run only inside Claude Code’s required sandbox. Fork or unknown-origin PRs use Read/Glob/Grep only and ignore `review_allowed`. Never edit files, commit, push, merge, change GitHub state, or read credentials. The caller supplies CI evidence tied to the reviewed head SHA.
- Evidence and logging: the caller obtains issue/PR metadata, diffs, and test/lint/CI results tied to the reviewed head SHA. In Read/Glob/Grep-only mode never run commands or expand reviewer permissions to obtain missing evidence; report it to the caller. The reviewer must not call `ai-dispatch-log`; the caller or runner owns recording.
- Conversation continuity: create one Claude session ID per issue/PR and reuse it with `--resume` for all follow-up reviews.
- Approval criterion: Claude must return a final standalone verdict of `OK`. Any other verdict requires either a fix and re-review or a documented follow-up issue for an explicitly out-of-scope improvement.

## Reviewer permissions and CI evidence

Same-repository PRs may use configured `review_allowed` Bash rules (including
explicit rules for the configured `test` and `lint` commands), plus `git diff`,
`git log`, `git show`, and `git status`. These commands run in Claude Code's
sandbox: repository writes and network access are denied, unsandboxed fallback
is disabled, and startup fails if sandboxing is unavailable. Use temporary
storage for probes; tests requiring repository writes or network access must be
run by the caller and their results supplied as context. Never edit, commit,
push, merge, change GitHub state, or read credentials, `.env*`, or `auth.json`.
Fork and unknown-origin PRs use Read/Glob/Grep only; `review_allowed` is ignored
and this restriction is stated in the warning, review instructions, and comment.
Origin is established by matching the head and base repository identities at
the reviewed SHA, never by branch name or PR author. The caller supplies issue,
PR and diff evidence tied to the reviewed head SHA in both modes; while Draft,
local verification replaces CI evidence. After Ready, supply the final summary from
`kurukuru ci-wait <pr>` plus its pinned head SHA as CI evidence. Invoke it once per
reviewed head and wait for completion; do not repeatedly poll `gh pr checks`.
The caller also runs tests/lint that the reviewer cannot execute and supplies
results with the reviewed SHA through the optional context argument. In
Read/Glob/Grep-only mode the reviewer must not run shell, Git, tests, lint, or
network tools, or expand permissions to obtain missing evidence. Report missing
evidence to the caller instead. The reviewer must not call `ai-dispatch-log`;
the caller or runner owns dispatch recording. Refresh evidence on re-review
while preserving the same Claude session.
CI states distinguish not run, pending, failed, skipped, and unavailable from
passed; a changed head invalidates the CI evidence and requires fresh verification
and review. CI is evidence, not a substitute for independent review.

## Claude conversation storage

If reviewer conversation storage is restricted, use the runner's normal approval/escalation mechanism for `kurukuru review`. Never disable the sandbox or bypass approval. Keep the reviewer's read-only permissions unchanged; do not grant unrestricted access to `~/.claude`.

Claude must save the conversation under `~/.claude/projects/<encoded-repo>/`
(or the corresponding `CLAUDE_CONFIG_DIR/projects/` directory) so re-reviews can
resume the same session. Session IDs accepted by Python’s `uuid.UUID` (including
uppercase, braced, URN and unhyphenated UUIDs) retain their recorded spelling
in diagnostics (with control and non-ASCII characters escaped), transcript
filenames and `--resume`. No canonical filename
fallback or state rewrite is performed: differently spelled records remain
distinct for storage and recovery, even when their UUID values are equal.
`kurukuru review` checks for a nonempty session JSONL
file after execution, including failed calls. `kurukuru doctor` checks recorded
review sessions without launching Claude or reading transcript contents. These
are metadata checks, not proof that a future resume will succeed. Before the
first review, doctor reports that storage has not yet been checked.

Project-folder naming is a compatibility assumption about Claude Code, not a
stable public API: the resolved absolute repository path has each character
outside ASCII letters and digits replaced with one `-` (including separators,
spaces, punctuation and non-ASCII characters). Symlink paths use their resolved
target. If Claude changes this convention, a warning may mean the lookup needs
updating; preserve the session and investigate before attempting recovery.

When recorded review state belongs to another working directory, `kurukuru review`
automatically starts a new session in the current worktree without owner approval.
It reviews the current head's complete diff and evidence, records the old session
and reason in `session-recovery.jsonl` alongside review state, and prints a recovery
line in the run log. Original evidence and state history are retained. This exception
also applies when the recorded PR differs from the requested PR and GitHub confirms
that the recorded PR is merged or closed. In that case the original `state.json`
is preserved as `state.pr<old-pr>-<unique-id>.json`, and its path and the reason
are recorded in `session-recovery.jsonl`. Existing review logs remain intact.
An open or unverifiable previous PR blocks recovery. Missing, corrupt, or otherwise
unresumable sessions still require the recovery decision below.

If a warning appears, preserve the session ID and all evidence, correct the
execution permissions through normal approval, and retry the same session.
Do not silently create a replacement session. If the conversation was never
saved and resume fails, report the lost session and obtain an explicit owner
recovery decision. Diagnostics never change permissions or create home folders.

## Handling findings

- Fix every actionable in-scope finding and rerun relevant checks.
- Resume the same Claude session for re-review.
- Repeat until the final verdict is `OK`.
- Convert valuable out-of-scope improvements into new issues with context, rationale, and acceptance criteria.
- Link follow-up issues from the current PR without adding them to the current implementation scope.

## Completion

After local verification and Claude returns `OK`:

1. Update the PR body with the final summary, tests, limitations, and follow-up issues.
2. Mark the PR ready for review.
3. Wait for CI on the Ready PR. Merge with squash merge and delete the remote branch after exit 0, or exit 4 (No CI) with same-head local verification and Claude OK recorded in the PR body. All other exits block merging.
4. Confirm the `Closes #N` issue is closed; close it manually only if GitHub did not do so.
5. Synchronize local `main` and, if the owner’s requested scope includes more issues, select the next unblocked issue using the selection rules above.

## Repository opt-in for No CI

```toml
[ci]
merge_without_ci = true
```

This setting changes only the instructions supplied by `kurukuru run` (including
queue/batch launches). The documented workflow above retains its existing exit
4 allowance; runner instructions take precedence in runner sessions and
already require exit 0 by default. The default is false; user-level configuration
cannot enable this exception. With the opt-in, runner sessions may merge on exit 0
as usual, or on exit 4 (No CI) only when all of these conditions hold:

- `kurukuru ci-wait <pr>` returned exit 4 for the current PR head SHA.
- Claude returned `OK` for that same head.
- The configured local `test` command was freshly executed and passed with exit 0 for that same head. An empty or missing `test` forbids this exception.
- The PR body records the head SHA, ci-wait final summary, test command, execution time, exit code and result.
- Merge using `gh pr merge <pr> --squash --delete-branch --match-head-commit <verified-head-SHA>`.

Failed, pending, cancelled, skipped, unavailable or timed-out CI and legacy exit 5 never qualify for this runner exception. A changed head invalidates all
evidence: rerun local verification, obtain Claude OK and wait for CI on the new
head. This is a runner instruction policy; it does not change ci-wait exit codes
or GitHub branch protection.

## Stop conditions

Routine review and merge decisions are not stop conditions. Pause and ask the user only for:

- authority outside the repository or workflow already granted;
- credentials or interactive account actions that cannot be completed autonomously;
- a material product decision with multiple incompatible outcomes;
- an unsafe or destructive ambiguity that cannot be resolved from repository evidence;
- repeated failure of required external infrastructure after safe retries and available alternatives are exhausted.

## Reviewer dispatch recording

`kurukuru review` records each Claude invocation (including re-reviews) with
`ai-dispatch-log start --to claude --kind review`, finishes the record, then attaches usage with
`claude-attach --conversation-id <review-session-id>` (the attachment needs an end time).
The task names the repository, PR and issue. The caller sets
`KURUKURU_ROLE=reviewer` for the reviewer child process; the reviewer must never
record dispatch itself. If ai-dispatch-log is unavailable, recording is skipped
and review continues. Use `KURUKURU_AI_DISPATCH_LOG_BIN` or
`[commands].ai-dispatch-log` to replace the executable.
