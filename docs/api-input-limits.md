# API JSON 入力の上限（Issue #175）

## 実行環境と読み込み

対象は Next.js 15.5.28 App Router の Node.js Route Handler。Web Request の
stream を `readBoundedJson` で読み、UTF-8 のバイト数を確認してから decode /
JSON.parse する。`req.json()` や `req.text()` による無制限の読み込みは行わない。

Next.js の Server Actions の `bodySizeLimit: 200mb` は Route Handler の制限ではない。
また、このリポジトリの `middlewareClientMaxBodySize: 200mb` は大きなファイルの
アップロード用であり、JSON API 用の上限には使えない。インストール済み Next の
`dist/server/body-streams.js` と [Next.js 15 の公式説明](https://nextjs.org/docs/15/app/api-reference/config/next-config-js/middlewareClientMaxBodySize)
で middleware が本文を複製することを確認した。

対象3ルートは middleware の matcher から除外し、ハンドラー到達前の本文複製を避ける。
各ハンドラーの `auth.getUser()` は維持する。Route Handler の Supabase クライアントは
cookie を更新できるため、対象 API でのセッション更新も維持する。tests の DELETE も
同じパスを使用し、ハンドラー自身が認証・所有者確認を行う。
PDF 本体のアップロード `/api/tests/upload` や他のページ・API には従来の middleware を適用する。

| 対象 | 上限（UTF-8 bytes） | 根拠 |
| --- | --- | --- |
| POST `/api/papers/:id/ask` | 192 KiB = 196608 | 質問4000 + 履歴6件×4000 code units を JSON escape で各6 bytes にしても収まる |
| PATCH `/api/tests/:id` | 128 KiB = 131072 | 全フィールド・著者24件・業界8件の既存スキーマ上限を同時に escape しても収まる |
| POST `/api/quiz/:sessionId/submit` | 512 KiB = 524288 | 下記32回答のキー・本文を最大長で escape しても収まる |

Content-Length は数字のみの過大値の早期拒否に使用する。未指定、不正値、過小申告は
実際の stream サイズで判定する。ちょうど上限なら受理、1 byte でも超えれば **413** と
`{"error":"リクエスト本文が大きすぎます"}` を返す。未知フィールドと空白も計上する。
上限超過時は stream を cancel し、それ以上読み進めず JSON.parse もしない。
tee の cancel は他の reader を待つことがあるため await しない。
保持する本文バッファは固定上限以内（stream が渡す現在の chunk は別）。
不正 JSON、不正 UTF-8、空・中断本文は **400**。スキーマ違反も引き続き **400**。
tests PATCH / quiz submit は未認証なら本文を読まず401を返す。

## quiz 回答

通常の出題は pool から3〜9問、LLM への指定は6〜9問。既存セッションの再利用に
余裕を持たせ、answers は **32件** まで。空オブジェクト・未回答の省略も受理する。
自由記述は **2000 UTF-16 code units**（既存の200字想定の設問に余裕を持たせた値）、
キーは **128 code units**（`q1`、UUID、CSV/再出題用生成IDに十分）。数値回答は従来通り。
UI の textarea にも同じ2000の maxLength と案内を付ける。
件数超過は値検証の前に拒否し、大量の要素エラーを作らない。

従来は回答件数・記述長が無制限だったため、32問超の旧セッションや2000文字超の
直接API送信は新しい制限で400になる。保存済みデータの変更・削除は行わない。
全ての任意JSON表現を受理する保証はなく、冗長な空白や未知キーで本文上限を超えれば413。

## 検証と範囲

ネットワーク非依存のテストで各本文上限の境界、Content-Length の欠落・不正・偽装、
途中でのキャンセル、不正JSON/UTF-8/stream、複数chunkにまたがる文字、
最大フィールドの escape 表現、回答件数・文字数・キー長、middleware の実際の matcher を検証する。
本番 Supabase / R2 / AI API、paper-pipeline の操作は実施しない。

上流プロキシやOSのsocketバッファまでアプリの上限で管理するものではない。
低速送信のタイムアウトや他ルートへの制限は本Issueの対象外。

## ask の認証・回数制限の優先順位（Issue #180）

POST `/api/papers/:id/ask` は次の順に判定し、最初のエラーを返す。

1. URL の UUID が不正なら **400**。認証も本文読み込みも行わない。
2. `auth.getUser()` で未認証なら **401**。本文の不正JSON・サイズ超過より優先する。
3. 認証済みユーザーの回数制限に達していれば **429** と `retryAfterSeconds`。
   本文の不正JSON・サイズ超過より優先し、本文を読み込まない。
4. 許可された場合だけ本文を最大192 KiBまで読み、サイズ超過は **413**、
   不正JSON / UTF-8 / スキーマ違反は **400**。
5. 論文とチャンクの確認、回答生成を行う。

従来は本文検証が認証・回数制限より先だった。防御強化により、認証済みで
回数制限内の不正本文・サイズ超過も1回分を消費する（1分間に6回）。
これにより不正本文を繰り返し送る場合にも本文の読み込み回数を制限する。
Issue #234 で共有カウンタへ移行した。詳細は末尾を参照。

middleware 除外は維持する。Route Handler の既存 `createClient()` と
`auth.getUser()` を本文検証より先に呼ぶため、Supabase の cookie 更新経路も維持し、
401 / 429 / 400 / 413 と正常応答のいずれも認証時の更新を妨げない。
ネットワーク非依存のハンドラーテストでは実際の Supabase server helper を読み込み、
認証SDKと Next の cookie store を偽物に置き換え、cookie の読み取り・更新を検証する。


## 動画・スライド登録のストリーム維持（Issue #213）

`/api/tests/:id/material/video` と `/api/tests/:id/material/slide` も middleware の
matcher から除外する。ハンドラーは multipart 本文をストリームで R2 に送るが、
middleware を通すとハンドラー到達前に Next.js が本文を複製して保持するため、
動画最大200 MiB・スライド最大45 MiBのファイル全体をメモリに載せない目的を満たせない。
除外により、この middleware による複製を避けて既存のストリーム処理に渡す。

POST / DELETE のハンドラーは変更せず、既存の `auth.getUser()` と `uploaded_by` の
所有者確認を維持する。Route Handler の Supabase クライアントによる cookie 更新も維持する。
除外は video / slide のパスそのもの（末尾スラッシュ・クエリを含む）に限定し、
`/video/commit`・`/slide/commit` はファイル本文を受け取らないため引き続き middleware を通す。
`/api/tests/upload`、他の material パス、ページも引き続き対象とする。

ネットワーク非依存のテストで、`src/middleware.ts` の実際の matcher を
Next.js の `unstable_doesMiddlewareMatch` に渡し、除外対象と周辺パスの境界を確認する。
実サーバーでの大容量アップロードやメモリ計測は実施せず、本番 Supabase / R2 に接続しない。

## LLM 呼び出しのレート制限（Issue #216）

LLM（Anthropic / Gemini / 埋め込み）を呼ぶ認証済み API は、ログイン確認の直後・本文を
読む前にユーザー単位で回数を数える。超過時は LLM を呼ばず **429**、`Retry-After`
ヘッダー（秒）と `{"error": ..., "retryAfterSeconds": n}` を返す。制限値は
`src/lib/llm-rate-limit.ts` の `LLM_RATE_LIMITS` で一元管理する。

| 対象 | 上限 |
| --- | --- |
| POST `/api/tests/:id/start` | 1分あたり10回 |
| POST `/api/quiz/:sessionId/submit` | 1分あたり10回 |
| POST `/api/tests/upload/summarize` と `/api/tests/:id/summarize` | 合計で1分あたり5回 |
| POST `/api/papers/:id/ask`（共通モジュールに統合） | 1分あたり6回 |

### 共有カウンタの導入・障害時運用（Issue #234）

全5ルートが `LLM_RATE_LIMITS` と `llmRateLimitResponse` を使う。
Supabase PostgreSQL の `llm_rate_limit_buckets` にユーザー・種類ごとの直近60秒の
許可時刻を最大10件保存する。要約2ルートは同じ `summarize` キーを使う。
`consume_llm_rate_limit` RPC が初回の一意制約と行ロックで、間引き・判定・追加を
1トランザクションとして実行する。DB時計をロック取得後に読み、境界時刻以前の記録を除外する。
不許可のリクエストは窓を延長しない。プロセス再起動でも枠はリセットされない。

所有者はアプリのデプロイ**前**に `038_shared_llm_rate_limit.sql` の個別マイグレーションを
適用する。既存環境に統合SQL全体を再適用しない。AIは本番への接続・適用を行わない。
既存の `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` をサーバー側だけで使い、
追加のサービスや環境変数は不要。テーブルはRLS有効・クライアント用ポリシーなし、
テーブル操作とRPCは service role 専用で、ブラウザーからカウンタを変更できない。
移行時に旧メモリの消費履歴は引き継がれず、全インスタンスの切替完了まで混在期間がある。
展開中も厳密な総枠が必要なら、対象APIへの流入を止めて切り替え、60秒待って再開する。

未適用、認証情報不足、DB障害、ロック待ちを含むRPCの5秒タイムアウト、応答不正は
**503 + Retry-After: 5** で閉じる。LLMや埋め込み・本文処理へ進まず、ローカルカウンタへの
フォールバックはしない。通常の枠超過だけが **429** になる。
障害時は所有者がデプロイ履歴、038の適用、service role の権限、DB稼働状況を確認する。
復旧すれば自動で再開する。アプリ再起動やカウンタ削除で回避しない。
タイムアウト時にはDBで消費が確定済みの場合があり、その枠は60秒以内に回復する。

カウンタは既存ユーザーにつき最大4行で、各行の時刻配列も有界。期限切れ時刻は次の許可時に
間引く。非アクティブな行の自動削除はせず、ユーザー削除時には外部キーで削除する。
DB時計の大きな変更やDBの復元、旧コードへのロールバックは枠の保証に影響する。
全体のLLM費用上限や匿名/IP単位の防御は対象外。

ネットワーク非依存のPGliteテストで実SQLと別々のアプリ判定器からの並行呼び出し、
窓の経過、種類・ユーザーの独立性、権限、ロールバックを検証する。
PGlite自体は接続を直列化するため、実PostgreSQLのロック競合・運用上の遅延までは再現しない。
本番PostgREST経由の動作確認は所有者が適用後に行う。
