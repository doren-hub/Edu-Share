# クイズ提出の保存と設問別統計

Issue #233: API は採点後に `submit_quiz_with_performance` を1回呼び、
`quiz_sessions` の未提出→提出済み更新と、全設問の `question_performance`
更新を同じ PostgreSQL トランザクションで確定する。統計更新の例外を握りつぶさず、
途中障害では結果・統計をすべてロールバックする。未提出のままなので通常の再送で回復できる。

RPC は service_role 専用で、保存時にもセッション所有者と未提出状態を確認する。
条件付き UPDATE の行ロックにより同一セッションの競合提出は1件だけ成功し、
残りは false（API の409）になる。確定後にレスポンスが失われても再送では結果と統計を変更しない。
テストに紐づかないセッションは結果だけを保存する。

デプロイ時は `039_atomic_quiz_submit.sql` を API 更新より先に適用する必要がある。
開発作業では SQL ファイルを追加するだけで、本番への適用は行わない。
既存の提出済み結果と統計を変更するデータ移行は含まない。
旧実装で既に欠落した統計のバックフィルは、既存統計との重複判定情報がないため対象外。

検証: `npm test` に含まれる `quiz-submit-migration.test.ts` は隔離されたメモリ内
PostgreSQL（PGlite）で実際の PL/pgSQL を実行する。2件目の統計 INSERT にトリガーで
例外を注入し、先行する結果 UPDATE と1件目の INSERT もロールバックされること、
障害解除後の再送・確定後の再送・既存カウンターの加算・所有者・実行権限を検証する。
PGlite はクライアントから重ねた呼び出しを直列実行するため、複数接続間のロック待ち
そのものはこのテストでは再現しない。Issue #232のAPIテストでは採点前の処理権取得による競合応答も検証する。
本番 Supabase/R2、資格情報、ネットワーク、コンテナーは使用しない。

採点前の排他制御と040のデプロイ手順は[採点処理権](quiz-grading-claim.md)を参照。

## 統計payloadの整合性（Issue #262）

`045_quiz_attempt_integrity.sql` は既存のトークン付きRPCを置換する追加
マイグレーション。既存データを書き換えず、本番への適用はこの作業では行わない。
生成済み `apply_all_migrations.sql` にも同じ定義を含める。

保存の条件付きUPDATEが返す `test_id` と `questions_json` を照合元とする。
テスト付きセッションではpayloadは配列であり、設問と同数・同順で、各要素の
`question_key`・`question_type` が対応する設問に一致する必要がある。
キーはTypeScriptの `makeQuestionPerformanceKey` と同じ入力・SHA-256先頭48桁で
DBが再計算する（ECMAScriptのtrim対象文字も揃える）。`correct` はJSON boolean、
`prompt_excerpt` はJSON stringを要求する。正誤の再採点は行わない。
空・SQL NULL・JSON null・欠落要素・余分な要素・別テストや別設問のキーは例外にし、
結果・lease解除・先行する統計更新をすべてロールバックする。

同じ内容の設問はIDが異なっても同じキーになる。従来の互換仕様として重複を許可し、
設問の出現ごとにattemptsを1、正解した出現ごとにcorrect_countを1加算する。
重複排除は行わない。同一キーの出現同士を入れ替えてもキー・型だけでは区別しない。
集約行のprompt_excerptは最後の出現の値になる。

テスト付き・設問0件なら空配列のみを許可し、結果だけを保存する。
`test_id` なしなら従来どおり統計payloadを無視し、結果だけを保存する。
所有者・未提出・有効な処理権tokenの条件は維持し、条件に合わない呼出しはfalseを返す。

`quiz-attempt-integrity.test.ts` は隔離PGliteで実SQLを実行し、通常提出、Unicodeを
含むキー生成、重複加算、空・欠落・不正payload、関連test_id変更、途中障害の全件
rollback、既存カウンターの保護、提出済み結果の不変、所有者・token・権限、
再適用と設問0件・test_idなしの動作を検証する。
