# Issue #165: 依存の脆弱性監査（2026-10-29）

対象はルートの package.json / package-lock.json（Web アプリ）。初回の
`npm audit --json` は 38 件（moderate 25 / high 12 / critical 1）を報告した。
Issue 起票時の 13 件とは調査時点が異なる。以下はコード上の利用経路からの
到達可能性の判断であり、本番に対する検証は行っていない。

## 優先度と対応

| 優先度 | 対象・指摘 | 到達可能性と対応 |
| --- | --- | --- |
| 最優先 | next / sharp（critical / high） | App Router と middleware を使用。Server Actions、画像最適化、キャッシュ等の条件付き指摘を含む。`next/image` の直接利用や独自サーバーは見当たらないが、フレームワーク経由の攻撃面を優先し Next 15.5.15 → 15.5.28、sharp 0.34.5 → 0.35.5 へ更新。Next のメジャーは維持。 |
| 高 | Zod / OpenAI（high、残存） | API のユーザー入力検証に使用。ask の history、tests PATCH の industries / paper_authors が配列の到達候補。巨大な不正配列による検証 issue の蓄積でメモリ枯渇の恐れがあり、`.max()` だけで安全とは判断しない。ask は認証前に検証する。後述の移行 Issue で対応。 |
| 高 | ws → Supabase / OpenAI（high / moderate） | Supabase クライアントと embeddings SDK に推移依存。直接の Realtime 購読・WebSocket サーバー利用は見当たらず、公開サーバーとしての到達可能性は低いが、ws 8.20.0 → 8.22.0 で解消。 |
| 高 | form-data → @types/node-fetch → Anthropic / OpenAI（high） | 型定義経由の推移依存。SDK をサーバーで利用するがアプリで form-data を直接利用していない。form-data 4.0.5 → 4.0.6 へ更新。 |
| 中 | postcss / nanoid / source-map-js（high / moderate） | CSS のビルド処理。アプリはアップロードされた CSS を処理せず、通常は開発側の信頼された入力。PostCSS 8.5.32、nanoid 3.3.20、source-map-js 1.2.2 へ更新。Next の固定 PostCSS については下記参照。 |
| 中 | js-yaml / brace-expansion / @humanfs/node / postcss-selector-parser（high / moderate） | ESLint / TypeScript ESLint / Tailwind の開発時の設定読込、glob、CSS 解析。Web API での直接利用なし。各既存範囲内の修正版（4.3.2 / 1.1.21・5.0.12 / 0.16.8 / 6.1.5）へ更新。監査の ESLint / Tailwind 等への波及指摘も解消。 |

監査件数は影響を受ける親パッケージも含むため、独立した欠陥の数ではない。
詳細な条件・修正版は [Next の advisory](https://github.com/advisories/GHSA-2464-fhr4-w9xw)、
[Zod の advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)、および
`npm audit --json` の各 via.url / range を参照する。

## 互換性の判断

`npm audit fix --ignore-scripts` により既存の semver 範囲内で修正し、
Next と eslint-config-next の最小バージョンを 15.5.28 に揃えた。
`npm audit fix --force` は使用していない。

Next 15.5.28 は PostCSS を 8.4.31 に固定しており、通常の更新だけでは
脆弱なコピーが残る。Next 配下に限定した `overrides.next.postcss = "$postcss"`
で直接依存と同じ PostCSS ^8.5.32 に統一する。PostCSS のメジャーは 8 のまま。
クリーンインストール、依存ツリー、Next の CSS 処理と Tailwind の組み合わせを
オフラインの互換性テストで検証する。Next 側の固定が修正されたら override の
削除可否を再評価する。Next 16 への移行は本 Issue に含めない。

npm が既存の固定 PostCSS の lock エントリを再利用したため、そのエントリだけを
外して `npm install --package-lock-only --ignore-scripts` で再解決した。
その後 `npm ci` でロックファイルから再現できることを確認する。

## 残存する指摘と次の対応

更新後の監査は **2 件（high 2 / critical 0）**。Zod 3.25.76 とそれに依存する
OpenAI 4.104.0 の指摘が残る。これは解消済み・到達不能とは扱わない。
修正版は Zod >=4.6.6 だが OpenAI 4.104.0 の peer 条件は `zod ^3.23.8`。
さらにアプリは ZodError.errors と引数 1 個の z.record を使用しており、
強制メジャー更新は互換性を壊す可能性がある。

[Issue #168](https://github.com/doren-hub/Edu-Share/issues/168) に高優先の移行作業、
全入力スキーマの検証、巨大配列の回帰テスト、embeddings のモック検証を記録した。
本 Issue は互換更新と残存リスクの記録までとし、Zod / SDK の移行は実施しない。

## 検証と制約

実行時刻、所要時間、コマンド、終了コード、対象 head SHA は PR #167 本文と
Claude レビューに渡すローカル証跡に記録する。Draft 中はローカルの
`npm test` / `npm run lint` と互換性検証を使い、Claude OK 後に Ready CI を待つ。

本番 Supabase / R2 / AI API への接続、.env.local の参照、DB マイグレーション適用、
paper-pipeline の実行は行わない。実環境のアップロード・認証・画像最適化を
含む E2E 検証は対象外であり、単体検証だけで本番のすべての挙動を保証しない。

追加の `tsc --noEmit --incremental false` は既存の 3 件の型エラーで終了コード 2。
`origin/main` のソースと元の lockfile を本作業木内の隔離ディレクトリに展開し、
元の依存を `npm ci --ignore-scripts` で入れた状態でも同じエラーを確認した。
対象は papers/[id]/ask の PaperAskChunk の型述語 2 件と papers/graph の
RpcCaller / PromiseLike 不一致 1 件で、依存更新による追加の型エラーはない。
必須の lint / test と CI とは区別して記録し、本 Issue では修正しない。
