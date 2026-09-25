# PDF・動画の Cloudflare R2 保存

Edu Share は PDF、NotebookLM スライド、動画の本体を Cloudflare R2 に保存します。Supabase には `tests` のメタデータと、R2 のオブジェクトキーだけを残します。

## R2 の準備

1. Cloudflare R2 でバケットを作成する。
2. Object Read & Write 権限の API トークンを作成する。
3. `.env.example` の `R2_*` を `.env.local` とデプロイ環境へ設定する。
4. 公開バケットまたはカスタムドメインを使う場合は `R2_PUBLIC_BASE_URL` を設定する。未設定なら閲覧時に R2 の短期署名 URL を発行する。

スライドと動画はブラウザから署名付き PUT URL へ直接アップロードします。R2 バケットの CORS は、デプロイ先とローカル開発元からの `PUT` と `GET` を許可してください。

```json
[
  {
    "AllowedOrigins": ["https://your-app.example.com", "http://localhost:3000"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

## 既存ファイルの移行

Supabase の利用制限が解除され、Storage API が読める状態で実行します。最初はコピーだけを行い、成功を確認します。

```bash
npm run storage:migrate:r2
```

同じコマンドは再実行できます。R2 に同じサイズのオブジェクトがあればコピーを省略します。全件成功後、Supabase 側も同時に削除するには次を実行します。

```bash
npm run storage:migrate:r2 -- --delete-source
```

削除は、各オブジェクトが R2 に存在しサイズ検証が通った後だけ行います。DB の保存キーは変えないため、DB更新は不要です。
