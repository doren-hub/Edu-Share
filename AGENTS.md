# Edu Share repository instructions

Antigravity CLI (`agy`) に Issue の実装を任せるときの決まり。進め方の詳細は [docs/development-workflow.md](docs/development-workflow.md) を正とする。

## 必須の進め方

1. 一度に扱う Issue は 1 件だけ。
2. ブランチ `antigravity/<短い内容>` を最新の `main` から作成する。
3. 開始時に空コミット `chore: start issue <N>` を push し、`Closes #<N>` を含む Draft PR を作る。
4. テスト・lint・ドキュメント・PR 本文の更新まで含めて Issue を完了させる。
5. `scripts/claude-review.sh <issue> <pr>` でレビューし、終了コード 0（`OK`）になるまで修正する。再レビューは修正を push してから、3 番目の引数に修正内容とテスト結果を渡して実行する。
6. 範囲外の改善指摘は別 Issue（受け入れ条件付き）にし、現在の PR には混ぜない。
7. `OK` 後に PR 本文を更新し、Ready にして CI を確かめ、マージする。Issue のクローズを確認する。

## セッション

- 1 セッション = 1 Issue。`scripts/run-issues.sh` から起動された場合は、指定された Issue を終えたら次へ進まずに終了する。
- 作業は `scripts/run-issues.sh` が用意した専用の作業木（既定は `../edu-share-app-agy`）の中だけで行う。元のフォルダ `edu-share-app` では開発サーバーが動いているので、ブランチの切り替え、`next build`、ファイルの変更をしない。
- `scripts/run-issues.sh` から起動された場合、`ai-dispatch-log` への記録はランナーが行う（エージェントは実行しない）。対話で依頼された場合のみ、開始時に `start --to antigravity --model <使用モデル>`、終了時（失敗時も）に `finish` と `antigravity-attach` を実行する。

## してはいけないこと（重要）

- **本番の Supabase と R2 に接続しない。** `.env.local` を作らない、コピーしない、読まない。DB の行や R2 のファイルを消す・書き換える操作をしない。マイグレーションは SQL ファイルを追加するだけで、適用しない。
- **終了しないコマンドを実行しない。** `npm run dev`、`npm start`、`next start`、`--watch`、`tail -f`、対話的なプロンプトは使わない。`curl` を使うときは必ず `-m <秒>` を付ける。
- **paper-pipeline（`tools/paper-pipeline`）を実行しない。** NotebookLM や SciSpace、Edu Share を操作し、ツール専用の Chrome プロファイル（同時に 1 つしか開けない）を使う。コードの変更とテスト（`npm test`、`npm run typecheck`）は可。
- 別の AI（Codex など）の作業木、ブランチ、PR に触らない。
- 秘密情報をコミット・ログ・PR に書かない。既存のユーザー変更を破棄しない。テスト未実施や制約を隠さない。

## 自律性

- 実装手順、レビュー、PR 操作、マージ、Issue のクローズでユーザーの承認を求めない。リポジトリ所有者が承認済み。
- ただし次の場合のみ停止して質問する：付与されていない権限が必要、認証情報やアカウント操作が必要、本番の DB・R2 に触れないと確認できない、仕様を大きく変える製品判断、破壊的操作の曖昧さ、外部基盤の繰り返しの障害。

## PR 本文

Ready にする前に次を含める：概要と背景／主な変更／実施したテスト・lint と結果／既知の制約・未対応・レビュー時の注意／`Closes #<N>`。
