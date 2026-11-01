# 定期実行と枠確認・自動補充の手順書

macOS の launchd を使って `paper-pipeline` を定期実行（例: 1 時間ごと）し、NotebookLM の利用枠が空いている時間を活用して自動的に論文処理と inbox 補充を進めるための手順書です。

---

## 1. 全体の動作フロー

定期実行スクリプト（`scripts/scheduled-run.sh`）は、起動されると次の順序で安全に判断を行います。

1. **二重起動の防止（ロックとプロセス確認）**
   - ロックディレクトリ（既定 `/tmp/paper-pipeline-scheduled-run.lock`）を取得します。すでに別のスクリプトが動いている場合は何もせず終了します。
   - `pgrep` でパイプラインの Node プロセス（`orchestrate`, `cli`, `fill-inbox-cli`）または専用プロファイル（`.chrome-profile`）の Chrome が実行中かを調べ、動いていれば何もせず終了します（専用プロファイルは同時に 1 つしか開けません）。
2. **Notebook 利用枠の確認（`npm run quota-check`）**
   - `src/notebook-quota.ts` の判定ロジックにより、taskdesk または利用量ボードの利用量データを確認します。
   - 短期枠がしきい値（既定 85% 超、`NOTEBOOK_SHORT_STOP_PERCENT`）または週枠の上限（既定 100%、`NOTEBOOK_WEEKLY_STOP_PERCENT`）に達している場合は終了コード 11（`EXIT_QUOTA`）で安全に終了します。
   - 利用量データが読めない場合も終了コード 12（`EXIT_QUOTA_UNAVAILABLE`）で安全側に倒して終了します。
3. **inbox の未処理論文数の確認と補充**
   - inbox 直下の未処理 PDF 件数を確認します。
   - 設定した件数（既定 5 件、環境変数 `INBOX_MIN_PAPERS`）より少なければ、`npm run fill-inbox` を実行してライブラリから未処理論文を補充します。
4. **パイプラインの実行**
   - `npm start -- --headless --exit-on-quota` を実行します。
   - 枠が尽きるか進められる作業がなくなると、`--exit-on-quota` によりリセットを待たずにきりのいいところで終了し、次回の定期実行に備えます。

---

## 2. 枠確認コマンド (`quota-check`)

NotebookLM の利用枠だけを単体で確認するためのコマンドです。

```bash
cd tools/paper-pipeline

# 通常の確認
npm run quota-check

# 短期枠のしきい値を指定して確認（例: 80%）
npm run quota-check -- --notebook-short-stop-percent 80

# JSON 形式で出力
npm run quota-check -- --json
```

### 終了コード

| 終了コード | 状態 | 説明 |
|---|---|---|
| `0` | 利用可能 | 利用枠に空きがあり、生成を実行できます |
| `11` | 一時停止 (`EXIT_QUOTA`) | 短期枠がしきい値超、または週枠が上限に達しています |
| `12` | 取得不可 (`EXIT_QUOTA_UNAVAILABLE`) | taskdesk / 利用量ボードからデータを読めません。安全のため動かしません |
| `1` | エラー | 引数エラーまたは予期せぬ失敗 |

---

## 3. 起動スクリプトの手動確認

定期実行スクリプトは手動でテスト実行できます。

```bash
cd tools/paper-pipeline

# 判断結果のみ確認（補充やパイプラインの実行はスキップ）
./scripts/scheduled-run.sh --dry-run

# 通常の手動実行
./scripts/scheduled-run.sh
```

---

## 4. launchd の登録・解除・管理手順

launchd への登録は管理者が手動で行います。

### 4.1 設定ファイルの作成

設定見本ファイル `launchd/com.edushare.paper-pipeline.plist.example` を `~/Library/LaunchAgents/` 配下にコピーします。

```bash
cp tools/paper-pipeline/launchd/com.edushare.paper-pipeline.plist.example \
   ~/Library/LaunchAgents/com.edushare.paper-pipeline.plist
```

コピーした `~/Library/LaunchAgents/com.edushare.paper-pipeline.plist` をテキストエディタで開き、パスのプレースホルダーを実際の絶対パスに置き換えます。

- `/PATH/TO/edu-share-app` → お使いの作業ディレクトリの絶対パス（例: `/Users/username/Developer/edu-share-app`）
- `StartInterval` → 実行間隔（秒）。既定は `3600`（1 時間ごと）。必要に応じて変更してください。

設定ファイルに文法エラーがないか検証します:

```bash
plutil -lint ~/Library/LaunchAgents/com.edushare.paper-pipeline.plist
# => ~/Library/LaunchAgents/com.edushare.paper-pipeline.plist: OK
```

### 4.2 登録（ジョブのロード）

macOS 10.15 以降の推奨コマンド:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.edushare.paper-pipeline.plist
```

（旧バージョンの互換コマンド: `launchctl load ~/Library/LaunchAgents/com.edushare.paper-pipeline.plist`）

### 4.3 登録状態の確認

登録されているか確認します:

```bash
launchctl print gui/$(id -u)/com.edushare.paper-pipeline
```

または一覧から検索:

```bash
launchctl list | grep edushare
```

### 4.4 テスト起動（即時実行）

次回の間隔を待たずに即時実行して動作をテストする場合:

```bash
launchctl kickstart -k gui/$(id -u)/com.edushare.paper-pipeline
```

### 4.5 解除（ジョブのアンロード）

定期実行を停止・解除する場合:

```bash
launchctl bootout gui/$(id -u)/com.edushare.paper-pipeline
```

（旧バージョンの互換コマンド: `launchctl unload ~/Library/LaunchAgents/com.edushare.paper-pipeline.plist`）

---

## 5. ログの確認方法

実行ログは日付・時刻付きで次のファイルに記録されます。

- **定期実行スクリプトのログ**: `tools/paper-pipeline/logs/scheduled-run.log`
- **launchd の標準出力ログ**: `tools/paper-pipeline/logs/launchd.log`
- **launchd の標準エラーログ**: `tools/paper-pipeline/logs/launchd-error.log`

### ログの確認コマンド

```bash
# 最新の実行ログを末尾からリアルタイム監視
tail -n 50 -f tools/paper-pipeline/logs/scheduled-run.log

# 直近の実行結果を確認
cat tools/paper-pipeline/logs/scheduled-run.log | tail -n 30
```

---

## 6. 設定・環境変数

`.env` または launchd の `EnvironmentVariables` で以下の項目を設定・上書きできます。

| 環境変数 | 既定値 | 説明 |
|---|---|---|
| `INBOX_MIN_PAPERS` | `5` | inbox の未処理論文がこの件数未満になると `fill-inbox` で補充します |
| `NOTEBOOK_SHORT_STOP_PERCENT` | `85` | 短期枠の使用率がこの％を超えたら生成を止めます |
| `NOTEBOOK_WEEKLY_STOP_PERCENT` | `100` | 週枠の使用率がこの％に達したら生成を止めます |
| `SCHEDULED_LOG_FILE` | `logs/scheduled-run.log` | 定期実行ログファイルの出力先パス |
| `SCHEDULED_LOCK_DIR` | `/tmp/paper-pipeline-scheduled-run.lock` | 二重起動防止用ロックディレクトリのパス |
