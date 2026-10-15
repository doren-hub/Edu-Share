# Database migrations

Edu Share のデータベーススキーマ管理と、`supabase/apply_all_migrations.sql` の自動生成手順です。

## 構成

- `supabase/migrations/`
  個別のマイグレーションファイル（`001_edu_share.sql` 〜 `031_expose_failed_tests.sql` など）。番号順に並び、スキーマ変更の履歴を保持します。
- `supabase/apply_all_migrations.sql`
  空の Supabase プロジェクト作成時に、SQL Editor に貼り付けて 1 回で全マイグレーションを流すための統合 SQL です。個別のマイグレーションファイルを番号順に連結して自動生成されます。手動で編集しないでください。
- `supabase/sql_editor_*.sql`
  既存環境で特定の列やテーブルが未適用のときに、UI やログの案内に従って実行する部分修復スクリプト（ワンショット用）およびスキーマリロード用（`sql_editor_reload_postgrest_schema.sql`）です。全適用スクリプトとは役割が異なるため独立して維持されています。

## マイグレーションの追加手順

1. **マイグレーションファイルを作成する**
   `supabase/migrations/` に連番のファイル（例: `032_example.sql`）を追加します。
   過去のマイグレーション（すでに適用された環境があるファイル）は直接書き換えず、必ず新しい番号のマイグレーションを追加してください。

2. **`apply_all_migrations.sql` を再生成する**
   以下のコマンドを実行します。
   ```bash
   npm run db:build-apply-all
   ```

3. **差分とチェックを確認する**
   ```bash
   npm run db:check-apply-all
   npm test
   ```

4. **コミットする**
   作成した `supabase/migrations/0xx_*.sql` と、再生成された `supabase/apply_all_migrations.sql` の両方をコミットします。

## CI チェック

GitHub Actions（`.github/workflows/ci.yml`）で `npm run db:check-apply-all` が実行されます。
マイグレーションファイルを追加したのに `apply_all_migrations.sql` の再生成を忘れた場合、CI が失敗して食い違いを防ぎます。

## Storage の pdfs バケットについて

PDF・動画等の資料ファイルは Cloudflare R2 へ移行済み（#61, #62）であり、Supabase Storage の `pdfs` バケットは新規ファイル保存には使用されていません。
既存環境との互換性維持のため過去のマイグレーション（001, 028）は書き換えずに保持されています。
