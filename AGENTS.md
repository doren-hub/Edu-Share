# Repository instructions

Follow [docs/development-workflow.md](docs/development-workflow.md) for all implementation work. If `docs/roadmap.md` exists, use it to order implementation issues. Otherwise, use explicitly requested issues or the repository’s GitHub issue priorities and dependencies.

## Required delivery loop

1. Work on exactly one open implementation issue at a time, following the issue selection rules in `docs/development-workflow.md`.
2. Create a branch named `antigravity/<short-description>`.
3. At the beginning of the issue, create an empty kickoff commit, push the branch, and open a Draft PR containing `Closes #<issue>`.
4. Implement the complete issue, including tests, static checks, documentation, and PR-body updates.
5. Run an independent Claude Code review with Claude Opus 5.5 at low effort (`kurukuru review <issue> <pr>`). Preserve and reuse the same Claude review session for every re-review of that PR.
6. Fix every actionable in-scope finding, rerun verification, and ask Claude to review again. Repeat until Claude explicitly returns `OK`.
7. If Claude identifies a worthwhile improvement outside the current issue, create a separate GitHub issue with acceptance criteria and continue the current issue without expanding its scope.
8. After Claude returns `OK` and CI passes, update the PR body with final changes, verification results, limitations, and follow-up issues; mark the PR ready; merge it; verify the linked issue closed; then begin the next issue if it is within the owner’s requested scope.
9. Continue this loop until all selected issues are closed, within the owner’s requested scope.

## Sessions

Run each issue in a fresh Antigravity session (`kurukuru run`) and follow the context-budget and per-session `ai-dispatch-log` rules in `docs/development-workflow.md`.

## Project constraints

- 終了しないコマンド（npm run dev, npm start, next start, --watch, tail -f など）を実行しない
- curl を使うときは必ず -m <秒> を付ける

## Verification

- Test: `npm test`
- Lint: `npm run lint`

## Additional review notes

- 本番の DB・R2 を壊しうる変更（削除、広い範囲の書き換え、マイグレーションの安全性）

## Repository-local instructions

### 本番データ・環境の保護

- **本番の Supabase と R2 に接続しない。** `.env.local` を作らない、コピーしない、読まない。DB の行や R2 のファイルを消す・書き換える操作をしない。マイグレーションは SQL ファイルを追加するだけで、適用しない。
- **paper-pipeline（`tools/paper-pipeline`）を実行しない。** NotebookLM や SciSpace、Edu Share を操作し、ツール専用の Chrome プロファイル（同時に 1 つしか開けない）を使う。コードの変更とテスト（`npm test`、`npm run typecheck`）は可。

### コマンド実行の制約

- **終了しないコマンドを実行しない。** `npm run dev`、`npm start`、`next start`、`--watch`、`tail -f`、対話的なプロンプトは使わない。
- **curl を使うときは必ず `-m <秒>` を付ける。**

### 作業環境・他セッションへの配慮

- 作業は専用の作業木（既定は `../edu-share-app-agy`）の中だけで行う。元のフォルダ `edu-share-app` では開発サーバーが動いているので、ブランチの切り替え、`next build`、ファイルの変更をしない。
- 別の AI（Codex など）の作業木、ブランチ（`codex/*` など）、PR に触らない。
- 秘密情報をコミット・ログ・PR に書かない。既存のユーザー変更を破棄しない。テスト未実施や制約を隠さない。


## Autonomy

- Do not request routine user approval between implementation steps, reviews, PR operations, merges, or issue transitions. The repository owner has authorized this workflow.
- Preserve normal tool, operating-system, repository, and agent safety controls. Never bypass permission systems merely to avoid a prompt.
- Ask the user only when work requires authority not already granted, a product decision that materially changes scope, an unavailable credential/account action, or recovery from an unsafe/destructive ambiguity.
- When an external service is temporarily unavailable, retry safe operations and continue other in-scope work before treating it as a blocker.

## Claude review contract

- Executable: `claude`, resolved from `KURUKURU_CLAUDE_BIN`, `[commands].claude` in `.kurukuru.toml`, or `PATH`.
- Model: `claude-opus-5-5`.
- Effort: `low`.
- Review mode: read-only. For same-repository PRs, configured Bash rules and Git diff/log/show/status run only inside Claude Code’s required sandbox. Fork or unknown-origin PRs use Read/Glob/Grep only and ignore `review_allowed`. Never edit files, commit, push, merge, change GitHub state, or read credentials. The caller supplies CI evidence tied to the reviewed head SHA.
- Evidence and logging: the caller obtains issue/PR metadata, diffs, and test/lint/CI results tied to the reviewed head SHA. In Read/Glob/Grep-only mode never run commands or expand reviewer permissions to obtain missing evidence; report it to the caller. The reviewer must not call `ai-dispatch-log`; the caller or runner owns recording.
- Conversation continuity: create one Claude session ID per issue/PR and reuse it with `--resume` for all follow-up reviews.
- Approval criterion: Claude must return a final standalone verdict of `OK`. Any other verdict requires either a fix and re-review or a documented follow-up issue for an explicitly out-of-scope improvement.

## Pull request body

Before marking a PR ready, include:

- summary and background;
- main changes;
- tests and static checks with results;
- known limitations, deferred work, and review notes;
- `Closes #<issue>`.
