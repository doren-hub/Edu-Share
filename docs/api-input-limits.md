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
アップロード `/api/tests/upload` や他のページ・API には従来の middleware を適用する。

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
既存の認証順序は維持し、tests PATCH / quiz submit は未認証なら本文を読まず401を返す。

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
