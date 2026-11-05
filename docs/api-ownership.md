# 教材・受験 API の所有者検査

Issue #243 の着手時に既存ルートを確認した。教材は共有して閲覧・受験する設計であり、
全ルートをアップロード者だけに制限すると既存の方針を壊す。教材の変更操作と、
個人の受験セッションへの操作に所有者検査を適用する。

| API | 検査する所有者・アクセス方針 |
| --- | --- |
| `tests/[id]` PATCH / DELETE | `tests.uploaded_by` がログインユーザーと一致 |
| `tests/[id]/pdf` POST | 同上。本文・ファイル処理より前 |
| `tests/[id]/material/{slide,video}` POST / DELETE と `commit` POST | 同上。本文・アップロード・署名 URL 発行・R2 操作より前 |
| `tests/[id]/summarize` POST | 同上。PDF 取得・本文抽出・LLM 呼び出しより前 |
| `quiz/[sessionId]` DELETE / `submit` POST | `quiz_sessions.user_id` がログインユーザーと一致 |
| `tests/[id]/start` POST の再出題 | 参照元セッションの `user_id` を検査。教材との関連・問題データ検査より前 |
| `tests/[id]/start` の通常・過去・復習出題 | 共有教材から本人のセッションを作成。過去・復習の検索は本人の `user_id` で絞る |
| `tests/[id]/pdf` GET と `notebooklm/prepare` POST | ログインと教材の公開状態（ready / failed）を検査し、共有 PDF の閲覧を許可 |
| `papers/[id]/ask`・`related`・`study-status` | 共有論文を対象とする既存のアクセス検査を維持。学習状況は本人のユーザー ID で保存・削除 |

着手時点で所有者検査自体は実装済みだった。不足していた検査順序を変更し、
教材 PATCH と答案 submit は認証・所有者検査後に JSON 本文を解析する。
再出題は教材 ID の一致判定より先にセッション所有者を確認する。
認証直後の LLM レート制限は、過剰リクエストを DB 参照前に拒否する既存の順序を維持する。
再出題元 ID が本文にある start は、その ID を取り出してから所有者検査を行う。

`src/lib/owner-check-routes.test.ts` は外部依存を偽物に置き換え、未認証・他人・存在しない ID
で副作用がないこと、所有者の成功、不正 JSON を所有者検査前に読まないこと、
別教材の他人のセッションを先に拒否すること、共有教材の閲覧・本人の再出題を検証する。
本番 DB・R2 への接続やマイグレーション適用は必要ない。
