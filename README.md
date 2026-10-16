# Edu Share

入試の過去問や論文の PDF をアップロードすると、資料を取り込み、受験のたびに選択式・記述式がミックスされたテストを生成する学習用 Web アプリです。

## できること

- **PDF からテスト教材を作る** — 過去問（学校）と論文の 2 区分。本文をチャンクに分けて保存し、受験時に LLM が問題を作って記述の採点も行う
- **受験と振り返り** — 結果画面で出典箇所を PDF 上にハイライト表示。受験履歴と設問ごとの正答状況、理解度を確認できる
- **論文の補助教材** — NotebookLM のスライド・動画・クイズ／単語帳 CSV、SciSpace のリンクを論文に紐づけて閲覧・受験できる
- **整理** — ブックマークリスト、論文の学習ステータス、著者・業界・学校などの選択肢（ピックリスト）

## 構成

| 役割 | 使っているもの |
| --- | --- |
| フレームワーク | Next.js 15（App Router）/ React 19 / TypeScript / Tailwind CSS |
| 認証・DB | Supabase（Auth、Postgres、pgvector） |
| ファイル保存 | Cloudflare R2（PDF・スライド・動画の本体。DB にはオブジェクトキーだけ残す） |
| 問題生成・採点 | Anthropic Claude または Google Gemini |
| 埋め込み（任意） | OpenAI `text-embedding-3-small` |

```
src/app/          画面と API（Route Handlers）
src/components/   画面部品
src/lib/          取り込み・問題生成・ストレージなどのロジックと単体テスト
supabase/         マイグレーション SQL
tools/            移行スクリプトと論文アップロード自動化ツール
docs/             運用メモ
```

## セットアップ

Node.js 22 以上が必要です。

```bash
npm install
```

```bash
cp .env.example .env.local
```

### 1. Supabase

1. Supabase でプロジェクトを作り、`NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY` を `.env.local` に書く
2. Database → Extensions で `vector` を有効にする
3. SQL Editor に [supabase/apply_all_migrations.sql](supabase/apply_all_migrations.sql) を貼り付けて実行する（`supabase/migrations/` の全マイグレーションを 1 本にまとめたもの。詳細は [docs/database-migrations.md](docs/database-migrations.md) を参照）

「exam_period が schema cache に無い」のようにスキーマの反映だけが遅れているときは、[supabase/sql_editor_tests_app_columns.sql](supabase/sql_editor_tests_app_columns.sql) と [supabase/sql_editor_reload_postgrest_schema.sql](supabase/sql_editor_reload_postgrest_schema.sql) を順に実行します。

### 2. Cloudflare R2

バケットと Object Read & Write 権限の API トークンを作り、`R2_*` を設定します。スライドと動画はブラウザから直接アップロードするため、バケットの CORS 設定も必要です。手順は [docs/r2-storage.md](docs/r2-storage.md) にあります。

### 3. LLM

`ANTHROPIC_API_KEY` か `GEMINI_API_KEY` のどちらか一方を設定します。両方ある場合は Anthropic が使われ、Gemini を優先したいときは `LLM_PROVIDER=gemini` を指定します。モデル名や再試行回数の指定は [.env.example](.env.example) のコメントを参照してください。

`OPENAI_API_KEY` は任意です。未設定のときはベクトル検索を行わず、チャンクをランダムに選んで出題します。

### 4. 起動

```bash
npm run dev
```

http://localhost:3000 を開き、サインアップしてから「アップロード」で PDF を登録します。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバー |
| `npm run build` / `npm start` | 本番ビルドと起動 |
| `npm run lint` | ESLint（CI でも実行） |
| `npm test` | `src/**/*.test.ts` の単体テスト（Node 標準のテストランナー） |
| `npm run db:build-apply-all` | 個別マイグレーションから `supabase/apply_all_migrations.sql` を再生成する |
| `npm run storage:migrate:r2` | Supabase Storage のファイルを R2 へ移す。詳細は [docs/r2-storage.md](docs/r2-storage.md) |
| `npm run backfill:pdf-filename` | 既存の論文に PDF ファイル名を埋め戻す |

## 論文アップロードの自動化

NotebookLM・SciSpace・Edu Share をログイン済みの Chrome で順に操作し、論文 PDF の登録から補助教材の取り込みまでを自動で進めるツールが [tools/paper-pipeline](tools/paper-pipeline) にあります。本体とは別の npm パッケージで、準備と使い方は [tools/paper-pipeline/README.md](tools/paper-pipeline/README.md) を参照してください。
