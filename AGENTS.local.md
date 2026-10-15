### 本番データ・環境の保護

- **本番の Supabase と R2 に接続しない。** `.env.local` を作らない、コピーしない、読まない。DB の行や R2 のファイルを消す・書き換える操作をしない。マイグレーションは SQL ファイルを追加するだけで、適用しない。
- **paper-pipeline（`tools/paper-pipeline`）を実行しない。** NotebookLM や SciSpace、Edu Share を操作し、ツール専用の Chrome プロファイル（同時に 1 つしか開けない）を使う。コードの変更とテスト（`npm test`、`npm run typecheck`）は可。

### コマンド実行の制約

- **終了しないコマンドを実行しない。** `npm run dev`、`npm start`、`next start`、`--watch`、`tail -f`、対話的なプロンプトは使わない。
- **curl を使うときは必ず `-m <秒>` を付ける。**

### ランナー（Antigravity）固有の規則・上書き

- **ブランチ名**: ランナーが Antigravity（agy）の場合、ブランチ名は `antigravity/<短い内容>` を使用する（テンプレートの `codex/<short-description>` を上書き）。
- **セッション記録**: 対話実行でエージェントが記録を行う場合は、`ai-dispatch-log finish` の後に `ai-dispatch-log antigravity-attach` を使用する（テンプレートの `codex-attach` を上書き）。`kurukuru run` 経由ではランナーが記録を行うためエージェント自身は実行しない。

### 作業環境・他セッションへの配慮

- 作業は専用の作業木（既定は `../edu-share-app-agy`）の中だけで行う。元のフォルダ `edu-share-app` では開発サーバーが動いているので、ブランチの切り替え、`next build`、ファイルの変更をしない。
- 別の AI（Codex など）の作業木、ブランチ（`codex/*` など）、PR に触らない。
- 秘密情報をコミット・ログ・PR に書かない。既存のユーザー変更を破棄しない。テスト未実施や制約を隠さない。
