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
- 過去のマイグレーション（001, 028）は書き換え禁止ルールに従って保持し、新設した `supabase/migrations/032_drop_pdfs_bucket.sql` で `storage.objects` 上の 4 つのポリシー（insert, select, update, delete）を削除します。
- Supabase Storage の内部保護トリガーや外部キー制約との競合を避けるため、バケット自体の削除は SQL で直接 DELETE せず、空であることを確認したうえで Supabase Dashboard（Storage > `pdfs` > Delete bucket）にて行います。
- **本番プロジェクトに残っている空の `pdfs` バケットの削除:**
  AI は AGENTS.md のルールにより本番環境への直接操作が禁止されているため、リポジトリオーナーが Supabase Dashboard から手動で削除を行ってください。

## 本番スキーマとの整合性と検証状況

- **検証上の制約:**
  `AGENTS.md` のセキュリティルール（本番 Supabase / R2 への非接続・`.env.local` 読み込み禁止）に基づき、AI は本番 Supabase への直接接続や `pg_dump` の自動比較は行っていません。
- **整合性の根拠:**
  - 個別のマイグレーション `001` 〜 `031` は本番 DB に順次適用されてきた正本そのものです。
  - 旧 `apply_all_migrations.sql` では `017` が `016` の前に手作業で貼られたことで、`017` で削除されるべき `notebooklm_slide_url` と `notebooklm_video_url` が `016` で再作成される不整合がありました。本番 DB ではこの 2 列が手動削除で補正済みであったため、個別マイグレーションを番号順（016 → 017）に連結することで、本番の補正後スキーマと一致するスキーマが生成されます。
  - さらに `029`（`industries text[]`）や `031`（処理失敗テストの閲覧許可ポリシー）も順番どおり確実に適用されます。
- **今後の推奨確認:**
  新しい Supabase プロジェクト作成時やステージング環境構築時に、空 DB で `apply_all_migrations.sql` を実行し、本番 DB との `pg_dump --schema-only` 差分比較を実施することを推奨します。


## processing_error の列権限（035 / #75）

`035_protect_processing_error.sql` は anon と PUBLIC のテーブル全体の SELECT、
および `processing_error` の列 SELECT を取り消し、公開可能な既存列だけを anon に付与します。
既存の ready / failed の行ポリシー、authenticated の SELECT、service_role の権限は維持します。
データの更新・削除やエラー列の移動は行いません。

- **今後の公開列追加時:** 新しい列は anon に自動公開されません。公開する列だけに列 SELECT を付与するマイグレーションを追加してください。
  `GRANT SELECT ON public.tests TO anon` は保護を解除するので使わないでください。
- **アプリ:** 未ログインの一覧・最近追加・詳細は `processing_error` を SELECT しません。
  ready のテキスト未抽出注意書きも含めて、未ログインには非公開とします。
  ログイン済みは従来どおり詳細の失敗理由・注意書き、一覧の ready 注意バッジを表示します。
- **書き込み経路の確認:** PDF取込失敗（upload、PDF差し替え）は `sanitizeProcessingError` を利用しています。
  `ingest-pdf.ts` の本文未抽出は固定の注意文、正常完了と NotebookLM CSV 登録・差し替えは null を書き込みます。
  生例外を直接 `processing_error` に渡す経路はありません。列権限による保護はこれらのサニタイズに依存しません。
- **オフライン検証:** `npm test` の `processing-error-access.test.ts` が PGlite（インメモリ PostgreSQL）で実際の列定義・行ポリシー・035を使います。
  anon の列取得・SELECT *・行全体JSON化・エラーによる絞り込み/ソートを拒否し、公開列、件数取得、authenticated / service_role の取得、再適用、将来列の非公開を確認します。
  Docker、外部DB、認証情報は不要です。

### 所有者による適用・確認

AIは本番に接続せず、035は未適用です。先に本PRのアプリ変更をデプロイし、所有者が既存環境に
**035の個別SQLだけ**を適用してください。既存環境に `apply_all_migrations.sql` を流し直さないでください。
PostgRESTのスキーマリロード通知も035に含みます。

適用後は所有者が未ログインのAPIリクエスト
`GET /rest/v1/tests?select=title,processing_status,processing_error&processing_status=eq.failed`
を確認し、権限エラー（42501）で理由を取得できないこと、同じリクエストがログイン済みでは成功することを確認してください。
`select=title,processing_status` に変更した未ログインリクエストは ready / failed とも成功し、pending は非公開です。
画面の未ログイン一覧・詳細、ログイン後の失敗理由・ready注意書きも確認してください。
本番のPostgRESTリクエスト・画面の検証は、オフラインテストだけでは代替できません。
