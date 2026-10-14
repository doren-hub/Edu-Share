# Antigravity への実装の委任

Edu Share の Issue の実装を、Antigravity CLI (`agy`) に 1 件ずつ任せる。KotoLink と同じ方法で、Claude のレビューが `OK` になるまで直してからマージする。決まりは [AGENTS.md](../AGENTS.md) にある。

## Issue のライフサイクル

```text
ランナーが専用の作業木を用意し、agy を起動
  -> ブランチ作成・空コミット・Draft PR (Closes #N)
  -> 実装と検証 (npm run lint / npm test / 必要なら tools/paper-pipeline の npm test)
  -> Claude レビュー (scripts/claude-review.sh)
  -> 修正と同一セッションでの再レビューを OK まで
  -> 範囲外の改善は新規 Issue に
  -> PR 本文の更新 → Ready → CI 確認 → マージ
  -> Issue クローズ確認 → 終了
```

## 実行方法

Mac のターミナルで、元のフォルダから実行する。

```bash
scripts/run-issues.sh 82          # Issue #82 を処理
scripts/run-issues.sh 82 83       # 指定した Issue を順に処理
```

- `agy` は専用の作業木 `../edu-share-app-agy` で動く。無ければ `origin/main` から作り、`npm ci` する。元のフォルダの開発サーバーには影響しない。
- 作業木に `.env.local` があると起動しない（本番の DB・R2 に触れさせないため）。
- Issue ごとに新しい `agy -p` セッションを起動するため、会話コンテキストが溜まらない。
- セッションは `EDUSHARE_SESSION_TIMEOUT`（既定 `90m`）で打ち切られる。固まった場合は同じ Issue を新しいセッションで再開する（既定 2 回まで）。ブランチと Draft PR が残っているので続きから進む。
- ログは `.run-issues/issue-<N>-attempt-<k>.log`。
- `ai-dispatch-log` があれば、ランナーがセッションごとに `start` / `finish` / `antigravity-attach` を記録する。

| 環境変数 | 既定値 | 内容 |
| --- | --- | --- |
| `EDUSHARE_AGY_MODEL` | （agy の既定） | 使用モデル |
| `EDUSHARE_AGY_ARGS` | `--dangerously-skip-permissions` | agy への追加引数。非対話では権限確認に応答できないため既定で省略する |
| `EDUSHARE_AGY_WORKTREE` | `../edu-share-app-agy` | agy の作業木 |
| `EDUSHARE_SESSION_TIMEOUT` | `90m` | 1 セッションの上限時間 |
| `EDUSHARE_STALL_RETRIES` | `2` | タイムアウト時の再開回数 |
| `EDUSHARE_LIMIT_WAIT` / `EDUSHARE_LIMIT_RETRIES` | `1800` / `6` | 利用制限時の待機秒数と再試行回数 |

| 終了コード | 意味 |
| --- | --- |
| 0 | 指定した Issue がすべてクローズ |
| 1 | agy の失敗、作業木の準備の失敗、またはタイムアウトの上限超過（ログを確認） |
| 2 | セッションは終了したが Issue が開いたまま |
| 64 | 引数・環境の誤り |
| 70 | agy の認証切れ（`agy` を一度対話起動してログイン） |
| 71 | 利用制限が続いた |

ランナーを変更したら `scripts/test-run-issues.sh` を実行する。

### 対話で依頼する場合

Antigravity エディタで作業木 `../edu-share-app-agy` を開き、チャットに次を送る。

```text
AGENTS.md と docs/development-workflow.md に従い、Issue #<N> だけを完了させてください。
```

## Claude レビュー

```bash
scripts/claude-review.sh <issue> <pr>                         # 初回
scripts/claude-review.sh <issue> <pr> "<修正内容とテスト結果>"   # 再レビュー
```

- 終了コード: 0 = `OK`、2 = 指摘あり、1 = 実行エラー（変更なしでの再実行を含む）、64 = 引数の誤り。
- モデルは `claude-opus-5-5`、推論量は low（`EDUSHARE_CLAUDE_MODEL` / `EDUSHARE_CLAUDE_EFFORT` で変更可）。
- Issue ごとに `.review/<issue>/session_id` を保持し、再レビューは同じセッションを再開する。前回レビューしたコミット以降の差分だけを送る。
- レビュー全文と判定は PR にコメントとして投稿される（`EDUSHARE_REVIEW_COMMENT=0` で無効）。
- Claude は読み取り専用。ファイル参照、`git diff/log/show/status`、`npm run lint`、`npm test` だけを実行できる。
- レビュー用スクリプトを変更したら `scripts/test-claude-review.sh` を実行する。

## 停止条件

通常のレビューやマージの判断では止まらない。止まって質問するのは AGENTS.md の「自律性」に書いた場合だけ。
