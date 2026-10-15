# kurukuru 導入のロールバック（旧スクリプトへの戻し方）

kurukuru v0.14.0 による開発ループへの切り替え（PR #91）を元に戻し、旧スクリプト（`scripts/run-issues.sh` / `scripts/claude-review.sh`）に戻す手順です。

本段階（1段階目）では旧スクリプトは削除せずに残されているため、以下の手順で安全に切り戻すことができます。

## 1. PR の revert

GitHub の PR 画面から「Revert」を押すか、Git でマージコミットを revert します。

```bash
git fetch origin main
git checkout -b revert/adopt-kurukuru origin/main
git revert -m 1 <merge_commit_sha>
git push -u origin revert/adopt-kurukuru
```

Draft PR を作成して CI を確認後、マージします。

## 2. `.kurukuru.toml` の扱い

- revert により `.kurukuru.toml`、`AGENTS.local.md`、本ドキュメントはリポジトリから削除され、`AGENTS.md` および `docs/development-workflow.md`、`.gitignore` は導入前の状態に戻ります。
- 実行時に生成されたローカルの `.kurukuru/` ディレクトリ（作業ログ・レビュー状態など）が残っていれば削除します。
  ```bash
  rm -rf .kurukuru/
  ```

## 3. 旧スクリプトの動作確認方法

revert 後、旧スクリプトのテストを実行して正常に動作することを確認します。

```bash
# run-issues のテスト
scripts/test-run-issues.sh

# claude-review のテスト
scripts/test-claude-review.sh
```

いずれのテストも成功（終了コード 0）することを確認してください。
その後、`scripts/run-issues.sh` または `scripts/claude-review.sh` による従来通りの開発ループを再開します。
