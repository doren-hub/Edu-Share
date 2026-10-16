# kurukuru 導入のロールバック（旧スクリプトへの戻し方）

kurukuru による開発ループへの切り替え（PR #91・#93）および旧スクリプト削除を元に戻し、旧スクリプト（`scripts/run-issues.sh` / `scripts/claude-review.sh`）に戻す手順です。

## 1. コミットの revert

旧スクリプトの削除コミット（本 PR）、kurukuru 設定更新（PR #93）、kurukuru 導入（PR #91）を逆順に revert します。
（本ワークフローでは Squash merge を基本としているため、各 PR のマージコミットを新しい順に revert します）

```bash
git fetch origin main
git checkout -b revert/kurukuru-migration origin/main

# 1. 旧スクリプト削除のコミット（本 PR）を revert して scripts/ を復活
git revert <remove_legacy_scripts_commit_sha>

# 2. kurukuru 設定更新（PR #93: 70c7403）を revert
git revert 70c7403

# 3. kurukuru 導入（PR #91: b642b7e）を revert
git revert b642b7e

git push -u origin revert/kurukuru-migration
```

Draft PR を作成して CI を確認後、マージします。

## 2. `.kurukuru.toml` および設定の扱い

- revert により `.kurukuru.toml`、`AGENTS.local.md`、本ドキュメントはリポジトリから削除され、`AGENTS.md` および `docs/development-workflow.md`、`.gitignore` は kurukuru 導入前の状態に戻ります。
- 実行時に生成されたローカルの `.kurukuru/` ディレクトリ（作業ログ・レビュー状態など）が残っていれば削除します。
  ```bash
  rm -rf .kurukuru/
  ```

## 3. 旧スクリプトの動作確認方法

revert 後、復活した旧スクリプトのテストを実行して正常に動作することを確認します。

```bash
# run-issues のテスト
scripts/test-run-issues.sh

# claude-review のテスト
scripts/test-claude-review.sh
```

いずれのテストも成功（終了コード 0）することを確認してください。
その後、`scripts/run-issues.sh` または `scripts/claude-review.sh` による従来通りの開発ループを再開します。

