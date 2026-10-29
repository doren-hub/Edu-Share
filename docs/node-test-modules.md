# Node テストのモジュール種別

Issue #166 で Node v22.23.4 / v24.11.1 の `npm test` を調査した。
変更前は両方とも 136 テストが成功する一方、各 `.test.ts` の読み込みで
`MODULE_TYPELESS_PACKAGE_JSON` が計 23 回発生していた。
最初の発生元は `src/lib/api-input-schemas.test.ts`。
ルートの `package.json` に `type` がなく、Node が CommonJS として解析してから
`import` / `export` を検出して ES Modules として再解析していた。

[Node の TypeScript 仕様](https://nodejs.org/docs/latest-v22.x/api/typescript.html#determining-module-system)
では `.ts` のモジュール種別は `.js` と同じ規則で決まり、親の `package.json` の
`"type": "module"` で ES Modules を指定できる。
この指定をルートに追加し、警告抑制フラグを使わず解析方法を明示した。
`npm test` のコマンドと `.ts` のファイル名は変更しない。

## 設定・既存コマンドとの互換性

- アプリとルートの TypeScript ツールはすでに `import` / `export` を使う。
  テストからインポートする `tools/backfill-pdf-filename.ts` にも指定が適用される。
  `src/` だけに別の `package.json` を置く方法ではツール側が未指定のままになる。
- `next.config.ts` は Next.js 15 の TypeScript 設定トランスパイラーで読み込めることを
  回帰テストで確認する。通常の設定ローダーは `.env` を読むため使用しない。
- `postcss.config.mjs` はもともと ES Modules。既存の互換性テストで Next の
  PostCSS ローダーから `tailwind.config.ts` とアプリの CSS を処理する。
- `.eslintrc.json` は JSON のためモジュール種別に依存しない。`npm run lint` で確認する。
- `tools/paper-pipeline/package.json` は独立したパッケージ境界であり、ルートの指定を
  継承しない。ローカルでは paper-pipeline を実行しない。
- CommonJS のファイルを追加する場合は `.cjs` / `.cts` を明示する。

Node 22 / 24 のローカルテストで警告が消えることを確認し、CI のアプリ検証ジョブも
両バージョンで実行する。実行時刻・head SHA・コマンド・終了コードは PR に記録する。
本番サービスへの接続、データ変更、環境ファイルの読み込みを伴う実行や
Next の開発サーバー起動は検証に含めない。
