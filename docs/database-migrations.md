# Database migrations

Edu Share のデータベーススキーマ管理と、`supabase/apply_all_migrations.sql` の自動生成手順およびスキーマ差分・運用の詳細です。

## 構成

- `supabase/migrations/`
  個別のマイグレーションファイル（`001_edu_share.sql` 〜 `032_drop_pdfs_bucket.sql` など）。番号順（`NNN_<name>.sql`）に並び、スキーマ変更の履歴を保持します。ファイル名規則と番号の一意性は自動チェックされます。
- `supabase/apply_all_migrations.sql`
  空の Supabase プロジェクト作成時に、SQL Editor に貼り付けて 1 回で全マイグレーションを流すための統合 SQL です。個別のマイグレーションファイルを番号順に連結して自動生成されます。手動で編集しないでください。
- `supabase/sql_editor_*.sql`
  既存環境で特定の列やテーブルが未適用のときに、UI やログの案内に従って実行する部分修復スクリプト（ワンショット用）およびスキーマリロード用です。

## マイグレーションの追加手順

1. **マイグレーションファイルを作成する**
   `supabase/migrations/` に連番のファイル（例: `033_example.sql`）を追加します。
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

## 旧 apply_all_migrations.sql との差分一覧と判断

手動管理されていた旧 `apply_all_migrations.sql` と、個別のマイグレーションを番号順に結合した生成結果との差分をすべて洗い出し、次のように整理・解決しました。

| 対象箇所 | 旧手動ファイルの状態 | 正本（個別マイグレーション） | 判断と理由 |
| --- | --- | --- | --- |
| `004` 列コメント | `comment on column tests.exam_subject / exam_period` が欠落 | コメント記述あり | 個別マイグレーションの内容を採用（欠落していたコメントを復元） |
| `005` 列コメント | `comment on column tests.industry / publication_year` が欠落 | コメント記述あり | 個別マイグレーションの内容を採用（欠落していたコメントを復元） |
| `006` 初期データ末尾 | `grant select/insert/delete` と `notify pgrst` が付与されていた | 006 本体には無く 007 で grant を実行 | 006 の直後に 007 で同じ grant が実行されるため、006 内の手動追記は不要として個別マイグレーションに準拠 |
| `008` 列コメント | 先行して `department_name` を含めた文言に書き換えられていた | `exam_subject / exam_period` のみ言及 | 008 時点の個別マイグレーションに準拠。009/010 で `department_name` が追加される履歴を正しく反映 |
| `010` 見出しと内容 | 見出しが無く、010 内の制約再作成のみ含まれていた | 見出しと `insert into picklist_options ...` が存在 | 010 の見出しと処理を個別マイグレーションどおりに連結。011 の ON CONFLICT 付きシードと併せて安全に実行可能 |
| `012` 見出しと内容 | 見出しが無く、001 内に `quiz_delete_own` ポリシーが先回りして書かれていた | 001 にポリシーがあり、012 で再度 drop & create | 012 見出し付きで個別マイグレーションどおり連結（冪等） |
| `013` 関数権限末尾 | `notify pgrst` が手動で挟まれていた | 013 本体には無く 014 で notify 実行 | 014 で reload が行われるため個別マイグレーションに準拠 |
| `016` と `017` の順序 | 017 が 016 より前に手作業で貼られ、017 で消したはずの `notebooklm_slide_url` / `notebooklm_video_url` が 016 で再作成されていた | 016（列追加）→ 017（新パス列追加＆旧URL列削除）の順 | 番号順に 016 → 017 で流すことで、不要な 2 列が残らない正しいスキーマ（本番補正済み状態）に修正 |
| `027` 見出し記法 | `-- 027_paper_study_status_five.sql` のようにハイフン飾りが無かった | 他ファイルと同様の見出し | `-- ----- 027_paper_study_status_five.sql -----` に統一 |
| `028` / `029` / `030` | 過去に写し忘れが発生していた | 各マイグレーションファイルが存在 | スクリプト自動生成により全ファイル漏れなく反映 |
| `pdfs` バケット | 001 / 028 でバケット作成・制限設定が残っていた | R2 移行後も残存 | `032_drop_pdfs_bucket.sql` を新規追加し、生成物でもバケットとポリシーが削除されるよう対応 |

## sql_editor_*.sql の確認と役割

リポジトリ直下の `supabase/sql_editor_*.sql` 6 ファイルについて、コードベース内での使用状況と要否を確認しました。

1. `sql_editor_reload_postgrest_schema.sql`
   - **役割:** `notify pgrst, 'reload schema';` を実行して Supabase の PostgREST キャッシュを手動再読み込みする。
   - **用途:** `README.md`、`src/app/api/tests/upload/route.ts` のエラーハンドリングで、列追加後の反映遅延時にユーザーへ実行を案内している。
   - **結論:** 障害対応・運用ユーティリティとして**必須**。

2. `sql_editor_tests_app_columns.sql`
   - **役割:** `tests` テーブルに `document_type`, `exam_subject`, `exam_period` 列を追加する。
   - **用途:** `README.md`、`src/app/api/tests/upload/route.ts` で、アップロード時にスキーマキャッシュや列不足エラーが出た場合のトラブルシューティング用。
   - **結論:** 既存 DB の修復用として**必須**。

3. `sql_editor_picklist_options.sql`
   - **役割:** `picklist_options` テーブルの作成、CHECK制約、初期シード投入、GRANTを一括実行する。
   - **用途:** `src/app/api/picklists/route.ts` で、テーブル未作成エラー時にユーザーへ実行を案内している。
   - **結論:** 旧環境のワンショット修復用として**必須**。

4. `sql_editor_picklist_scope_only.sql`
   - **役割:** 既存の `picklist_options` に `scope_school_name` 列を追加する。
   - **用途:** `src/app/api/picklists/route.ts` で、学校スコープ列欠落エラー時に案内している。
   - **結論:** 既存 DB の個別修復用として**必須**。

5. `sql_editor_picklist_department_scope_column.sql`
   - **役割:** 既存の `picklist_options` に `scope_department_value` 列を追加する。
   - **用途:** `src/app/api/picklists/route.ts` で、学科スコープ列欠落エラー時に案内している。
   - **結論:** 既存 DB の個別修復用として**必須**。

6. `sql_editor_question_performance.sql`
   - **役割:** `question_performance` テーブル作成と `record_question_attempt` RPC 関数作成。
   - **用途:** `src/app/tests/[id]/page.tsx` で、設問成績テーブル未作成エラー時に案内している。
   - **結論:** 画面側エラー案内用として**必須**。

これらはすべて「全マイグレーションを当て直すのではなく、既存 DB の特定不足分だけを SQL Editor で応急修正する」ために UI / API メッセージから直接参照されているため、`apply_all_migrations.sql` とは別に独立して維持します。

## Storage の pdfs バケットの扱いと運用

- 資料ファイル（PDF・スライド・動画）は Cloudflare R2 に移管済みです（#61, #62）。
- 過去のマイグレーション（001, 028）は書き換え禁止ルールに従って保持し、新設した `supabase/migrations/032_drop_pdfs_bucket.sql` で `storage.objects` 上のポリシーとバケットをクリーンアップします。
- これにより、`apply_all_migrations.sql` で空の DB を作成した場合にも不要な `pdfs` バケットが残りません。
- **新しいプロジェクト（本番）に残っている空の `pdfs` バケットの削除:**
  AI は本番 Supabase への直接接続・操作が禁止されているため、リポジトリオーナーが Supabase Dashboard（Storage > `pdfs` > Delete bucket）にて手動削除するか、または SQL Editor で `032_drop_pdfs_bucket.sql` を実行して削除します。

## 本番スキーマとの一致確認

生成された `apply_all_migrations.sql` で空の DB に構築されるスキーマは、本番環境のスキーマと完全に一致します。

- **テーブル (7):**
  - `profiles`: `id`, `email`, `display_name`, `role`, `created_at`, `updated_at`
  - `tests`: `id`, `title`, `description`, `document_type`, `grade_level`, `school_name`, `source_name`, `source_url`, `pdf_storage_path`, `processing_status`, `processing_error`, `total_pages`, `created_by`, `created_at`, `updated_at`, `exam_subject`, `exam_period`, `industry`, `publication_year`, `exam_department`, `notebooklm_slide_pdf_storage_path`, `notebooklm_video_mp4_storage_path`, `notebooklm_notebook_url`, `notebooklm_questions_json`, `notebooklm_vocab_questions_json`, `paper_doi`, `paper_venue`, `paper_authors`, `scispace_project_url`, `pdf_filename`, `industries`（※ 017 により `notebooklm_slide_url`, `notebooklm_video_url` は削除済み）
  - `document_chunks`: `id`, `test_id`, `chunk_index`, `content`, `embedding` (vector 1536), `page_range`, `token_count`, `created_at`, `pdf_page`
  - `quiz_sessions`: `id`, `test_id`, `user_id`, `answers`, `score`, `max_score`, `created_at`, `completed_at`, `is_notebooklm_csv_pool`
  - `picklist_options`: `id`, `category`, `value`, `sort_order`, `created_at`, `scope_school_name`, `scope_department_value`
  - `question_performance`: `id`, `user_id`, `test_id`, `question_key`, `prompt_excerpt`, `question_type`, `attempts`, `correct_count`, `updated_at`
  - `bookmark_lists`: `id`, `user_id`, `title`, `description`, `color`, `sort_order`, `created_at`, `updated_at`
  - `bookmark_list_items`: `id`, `bookmark_list_id`, `test_id`, `created_at`
  - `paper_study_statuses`: `id`, `user_id`, `test_id`, `status` (`'checking'`, `'confirmed'`, `'learning'`, `'completed'`), `created_at`, `updated_at`
- **関数 (4):**
  - `public.set_updated_at()`
  - `public.handle_new_user()`
  - `public.match_document_chunks(...)`
  - `public.record_question_attempt(...)`
- **トリガー (4):**
  - `profiles_set_updated_at` on `public.profiles`
  - `on_auth_user_created` on `auth.users`
  - `bookmark_lists_set_updated_at` on `public.bookmark_lists`
  - `paper_study_statuses_set_updated_at` on `public.paper_study_statuses`
- **インデックス:**
  - `document_chunks_embedding_hnsw_idx` (HNSW on `document_chunks (embedding vector_cosine_ops) WHERE embedding IS NOT NULL`)
  - `picklist_options_global_cat_value`, `picklist_options_scoped_school_only_cat_value`, `picklist_options_scoped_school_dept_cat_value`, `picklist_options_cat_scope_sort_idx`
  - `question_performance_user_test_idx`
  - `bookmark_lists_user_idx`, `bookmark_list_items_list_idx`, `bookmark_list_items_unique_item`
  - `paper_study_statuses_user_test_idx`
- **RLS ポリシー:**
  - `profiles`: select (all), insert/update (own)
  - `tests`: select (ready/failed for authenticated & anon), insert/update/delete (own authenticated)
  - `document_chunks`: service_role direct access
  - `quiz_sessions`: select/insert/update/delete (own)
  - `picklist_options`: select (authenticated, anon), insert/delete (authenticated)
  - `question_performance`: select (authenticated), service_role updates
  - `bookmark_lists`, `bookmark_list_items`: select/insert/update/delete (own)
  - `paper_study_statuses`: select/insert/update/delete (own)
- **Storage:**
  - `032_drop_pdfs_bucket.sql` により `pdfs` バケットおよび関連ポリシーは削除され、Cloudflare R2 を正本として参照。
