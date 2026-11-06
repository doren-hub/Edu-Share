# 未参照の元 PDF を回収する

Issue #225。通常の PDF 差し替えでは旧キーを残す。回収は定期ジョブ・Web API に公開せず、所有者が別途承認した保守時間に限定する。この開発作業では本番への接続・migration 適用・回収を行っていない。

## 導入と安全条件

所有者が `042_pdf_object_gc.sql` を適用する。migration は既存 PDF を削除しない。既存アプリの tests INSERT/UPDATE/DELETE にも DB trigger が働く。service role も回避できない。保守中は tests の全更新を拒否するので、PDF 以外のメタデータ編集も一時的に失敗する。平常時は同じ guard 行のロックを短く保持するため tests 更新は直列化される。

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

モック R2 と組み込み PostgreSQL (PGlite) で参照、pending、フェンス、退役、削除失敗と再試行、DB 行削除後、権限を検証する。PGlite は SQL 呼び出しを直列化するため、本番 PostgreSQL の複数接続の負荷試験ではない。本番 DB/R2・本番資格情報はテストで使わない。外部 writer の停止確認は運用担当者の責任。未知のキーや NotebookLM 残存物の回収は対象外。
