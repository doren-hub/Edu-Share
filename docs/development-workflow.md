# Autonomous development workflow

The repository is delivered as a sequence of small, independently reviewed issues. The default is continuous implementation without waiting for routine user approval.

## Issue lifecycle

```text
select next unblocked issue
  -> branch and empty kickoff commit
  -> Draft PR with Closes #N
  -> implement and verify
  -> Claude Opus 5.5 review (low effort)
  -> fix and re-review until OK
  -> create follow-up issues for out-of-scope improvements
  -> update PR body and mark ready
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

- At the start of each session, read only `AGENTS.md`, this workflow, the target issue, and `docs/roadmap.md` if it exists. Read design notes, README, and other files only when the issue needs them.
- If the runner owns dispatch recording, do not duplicate it. Otherwise, if `ai-dispatch-log` is available, record every session separately: run `ai-dispatch-log start` when the session begins, and `ai-dispatch-log finish` followed by `ai-dispatch-log antigravity-attach` before it exits, including when it stops on a failure.
- Read only failures from test and lint output (for example pipe through `tail -n 30` or `grep -E 'FAIL|ERROR'`).
- Locally run the tests for changed code (using the configured test command and its relevant filters) and leave the full suite to CI unless the change affects shared code.
- Wait for a Claude review or CI with one blocking command (`gh pr checks <pr> --watch`) instead of repeated status polling.

## Starting work

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
PR, diff, and `gh pr checks` results tied to the reviewed head SHA in both modes.
The caller also runs tests/lint that the reviewer cannot execute and supplies
results with the reviewed SHA through the optional context argument. In
Read/Glob/Grep-only mode the reviewer must not run shell, Git, tests, lint, or
network tools, or expand permissions to obtain missing evidence. Report missing
evidence to the caller instead. The reviewer must not call `ai-dispatch-log`;
the caller or runner owns dispatch recording. Refresh evidence on re-review
while preserving the same Claude session.
CI states distinguish not run, pending, failed, skipped, and unavailable from
passed; a changed head invalidates the check snapshot. CI is evidence, not a
substitute for independent review.

## Claude conversation storage

If reviewer conversation storage is restricted, use the runner's normal approval/escalation mechanism for `kurukuru review`. Never disable the sandbox or bypass approval. Keep the reviewer's read-only permissions unchanged; do not grant unrestricted access to `~/.claude`.

Claude must save the conversation under `~/.claude/projects/<encoded-repo>/`
(or the corresponding `CLAUDE_CONFIG_DIR/projects/` directory) so re-reviews can
resume the same session. `kurukuru review` checks for a nonempty session JSONL
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

After Claude returns `OK` and CI passes:

1. Update the PR body with the final summary, tests, limitations, and follow-up issues.
2. Mark the PR ready for review.
3. Merge with squash merge and delete the remote branch.
4. Confirm the `Closes #N` issue is closed; close it manually only if GitHub did not do so.
5. Synchronize local `main` and, if the owner’s requested scope includes more issues, select the next unblocked issue using the selection rules above.

## Stop conditions

Routine review and merge decisions are not stop conditions. Pause and ask the user only for:

- authority outside the repository or workflow already granted;
- credentials or interactive account actions that cannot be completed autonomously;
- a material product decision with multiple incompatible outcomes;
- an unsafe or destructive ambiguity that cannot be resolved from repository evidence;
- repeated failure of required external infrastructure after safe retries and available alternatives are exhausted.
