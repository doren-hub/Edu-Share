# 未参照の元 PDF を回収する

Issue #225 / #273。通常の PDF 差し替えでは旧キーを残す。回収は定期ジョブ・Web API に公開せず、所有者が別途承認した保守時間に限定する。この開発作業では本番への接続・migration 適用・回収を行っていない。

## 導入と安全条件

所有者が `042_pdf_object_gc.sql`、続いて `043_pdf_gc_shared_guard.sql` を適用する。migration は既存 PDF を削除しない。既存アプリの tests INSERT/UPDATE/DELETE にも DB trigger が働く。service role も回避できない。保守中は tests の全更新を拒否するので、PDF 以外のメタデータ編集も一時的に失敗する。043 では平常時の guard 行ロックを `FOR SHARE` とし、異なる tests 行の通常更新は並行できる。トランザクション終了まで共有ロックを保持し、回収開始の `FOR UPDATE` と排他する。`FOR KEY SHARE` は active_run 更新との排他に不十分なので使わない。

回収範囲は `<user UUID>/<test UUID>.pdf` と `<user UUID>/<test UUID>-<random UUID>.pdf` だけ。NotebookLM のスライド・動画・一時ファイル・未知のキーは対象外。tests の元 PDF・スライド・動画の保存パスのどれかに参照があれば保護する。DB 行削除後の旧キーや、初回アップロード失敗後の残存キーも一覧から発見する。

R2 最終更新から最低7日待つ。pending または処理トークンが1件でもあれば全候補を除外し、実行開始も拒否する。時間経過だけで pending を解除しない。必要なら先に `docs/database-migrations.md` の停止確認付き復旧手順を使う。

## dry-run（既定・更新なし）

所有者が承認した環境で必要な環境変数を注入する。`.env.local` は読み込まない。変数は `NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`R2_ENDPOINT`、`R2_BUCKET_NAME`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`。R2_ENDPOINT は対象アカウントの S3 エンドポイント。DB とバケットの組み合わせを必ず確認する。

```sh
node --experimental-strip-types tools/gc-orphan-pdfs.ts > pdf-gc-preview.jsonl
```

DB 参照と R2 一覧を読むだけで、DB 書込・削除・保守ロック取得をしない。JSONL にキー、サイズ、ETag、最終更新、候補/除外理由を出す。`would-delete` は `unreferenced-source-pdf-older-than-seven-days` の場合だけ。プレビュー中は更新可能なので、その結果は削除許可として再利用しない。API・一覧取得エラーは成功扱いせず終了する。

## 承認後の実削除

1. dry-run の候補と合計サイズを確認し、対象環境・日時・候補範囲の所有者承認を別途得る。この PR の承認は本番削除の承認ではない。
2. 候補オブジェクトを別バケット等にバックアップし、復元できることを確認する。R2 削除の取り消し機能には依存しない。
3. 全アプリ世代・worker・移行/復元ツール等の DB/R2 writer を停止・ドレインする。処理中の PUT・multipart・NotebookLM commit・テスト削除リクエストも完了を待つ。停止確認なしでフラグを渡さない。DB trigger は R2 自体への書込を停止しない。
4. 次を実行する。operator と approval は非秘密の担当者名・承認記録番号。標準出力を保管する。

```sh
node --experimental-strip-types tools/gc-orphan-pdfs.ts \
  --execute --writers-stopped --operator '<担当者>' --approval '<所有者承認記録>' \
  > pdf-gc-execution.jsonl
```

実行開始 RPC が tests 更新と共通の guard 行をロックし、pending/トークンを検査して永続保守フェンスを設定する。すでに開始した DB 更新は先に完了するか、フェンスを検出して拒否される。別の回収処理は開始できない。フェンス中は新規取り込み・差し替え・参照変更・テスト削除を DB で拒否する。

一覧を再取得し、候補ごとに HEAD で ETag/最終更新/サイズの一致を確認し、RPC で再度参照と猶予期間を検査する。削除前にキーを恒久的に退役登録する。退役キーは削除成功/失敗にかかわらず tests のどの保存パスにも登録できない。R2 DeleteObject の条件付きヘッダーの対応には依存しないため、外部 writer は最後まで停止しておく。詳細は [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/) と [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) を参照。

正常終了時と捕捉可能な例外時は同じ run UUID のフェンスを解除する。削除失敗は `failed` として記録し、非ゼロ終了する。残りの候補は処理しない。再実行は新しい run で参照・年齢・実体を再検査し、失敗キーも再試行できる。削除成功後に応答を失った場合は、実体がなければ次回の一覧には出ず、監査が reserved/failed のままでも退役保護は維持される。

## 強制終了・通信障害からの復旧

フェンスに自動期限はない。SIGKILL や begin RPC のタイムアウト後も DB に保守状態が残ることがある。勝手に新セッションへ移したり期限切れで解除しない。まず実行プロセスが停止し、R2 リクエストも完了したことを確認し、所有者の復旧承認を得る。service role で次を確認する（この開発セッションでは実行しない）。

```sql
select * from public.pdf_gc_guard;
select * from public.pdf_gc_runs order by started_at desc;
select * from public.pdf_gc_objects order by updated_at desc;
-- 停止・通信中操作の完了を確認し、active_run と一致する値だけ指定:
select public.end_pdf_gc('<active_run UUID>'::uuid);
```

違う UUID での解除は拒否される。フェンス解除後にアプリを再開する。begin がタイムアウトして run UUID が出力されなかった場合も guard と runs を調べる。監査表にはサービスロールの SELECT と専用 RPC だけを許可し、一般ユーザーには公開しない。reserved は削除前または応答不明、deleted は削除成功応答、failed は削除エラーを意味する。

誤った候補選択が疑われたら writer を停止したまま中断し、バックアップから**新しい未退役キー**に復元する。元の退役キーへの参照復活は禁止される。所有者の別途承認のもと、データ・チャンクの整合を確認して通常の取り込み経路で復旧する。退役記録や trigger を削除して保護を回避しない。

## 検証範囲と制約

モック R2 と組み込み PostgreSQL (PGlite)、隔離 PostgreSQL の複数接続で参照、pending、フェンス、退役、削除失敗と再試行、DB 行削除後、権限を検証する。PGlite は SQL 呼び出しを直列化する。別の `src/lib/pdf-gc-postgres.test.ts` は `pg_config` からローカル PostgreSQL バイナリを見つけ、専用の一時クラスタ・Unix ソケット（TCP 無効）を作り、異なる行の更新の共存、取り込みが先の場合の回収待機と拒否、回収が先の場合の更新待機と拒否、終了/ロールバック後の解除を実測する。既存の PG 接続環境変数を引き継がず、終了時にクラスタを停止・削除する。PostgreSQL 未導入ならこのテストだけ明示的に skip するため、複数接続の検証には PostgreSQL をインストールして `node --test src/lib/pdf-gc-postgres.test.ts` を実行する。これは性能ベンチマークではない。本番 DB/R2・本番資格情報はテストで使わない。外部 writer の停止確認は運用担当者の責任。未知のキーや NotebookLM 残存物の回収は対象外。


## 大規模一覧の上限と再開

1 回の走査は既定 10,000 件、`--max-objects N` で 1〜100,000 件。対象外を含む一覧の全エントリを数える。R2 一覧は最大 1,000 件/ページ、逐次・定数メモリで処理し、上限到達後は次のページを取得しない。対象外の名前空間、不完全なメタデータ、ローカル時刻で7日未満のエントリは DB RPC 前に除外する。25,000 件（PDF 25 件）のモックでは判定 RPC は 25 回。ローカル時刻は除外専用であり、削除可否は引き続き DB 時計と参照の再検査で決める。

最終 JSON の `scanned` は走査数、`limited: true` は上限到達、`resumeAfter` は最後に処理完了したキー。ちょうど上限と同数の一覧も保守的に limited になる。次回は同じ環境・バケットを確認し、`--start-after '<resumeAfter の文字列>'` を渡す（S3 ListObjectsV2 の StartAfter）。シェルで安全にクォートし、JSON のエスケープ表現をそのままコピーしない。再開は新しい run UUID でフェンス・参照・年齢・実体を検査する。上限による正常終了でもフェンスは解除されるので、実削除の再開時も writer 停止・ドレインと別途承認が必要。

キー順の走査中や再開間に前方へ追加されたオブジェクトは今回の範囲に含まれない。全体の再確認には後日 start-after なしで dry-run する。例外時は完了サマリーを出さず非ゼロ終了し、同じ開始キーから安全に再試行する。成功した削除は一覧から消え、退役記録は残る。

上限は件数であり経過時間の保証ではない。候補1件は判定 RPC、HEAD、予約 RPC、DELETE、結果 RPC を逐次実行する。RPC は30秒タイムアウト、S3 は接続10秒・要求30秒に加えて SDK の再試行時間があり、障害時には小さい件数でも時間がかかる。保守枠に合わせて小さい上限から始める。強制終了は自動フェンス解除を保証しないため上記の復旧手順に従う。無制限並列化や全一覧のメモリ保持はしない。
