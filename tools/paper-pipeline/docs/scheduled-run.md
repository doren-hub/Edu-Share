# 定期実行と枠確認・自動補充の手順書

macOS の launchd を使って `paper-pipeline` を定期実行（例: 1 時間ごと）し、NotebookLM の利用枠が空いている時間を活用して自動的に論文処理と inbox 補充を進めるための手順書です。

---

## 1. 全体の動作フロー

定期実行スクリプト（`scripts/scheduled-run.sh`）は、起動されると次の順序で安全に判断を行います。すべての判断ロジックは TypeScript CLI（`npm run scheduled-decide`）により一元的に行われ、単体テストで保証されています。

1. **二重起動の防止（ロック取得と原子的一掃）**
   - ロックディレクトリ（既定 `/tmp/paper-pipeline-scheduled-run.lock`）をアトミックに取得します。
   - すでに別のスクリプトが動いている場合は何もせず終了します。古いプロセスがクラッシュ等で残した stale lock は `mv` による原子的退避を経て安全に回収されます。
   - SIGTERM / SIGINT を受信した場合はトラップにより即座にロックを解除して終了コード 143 / 130 で終了します。
2. **定期実行の判定（`npm run scheduled-decide`）**
   - **プロセス確認**: パイプラインの Node プロセス（`orchestrate`, `cli`, `fill-inbox-cli`）または専用プロファイル（`.chrome-profile` / `CHROME_USER_DATA_DIR`）の Chrome が実行中かを調べ、動いていればスキップ（終了コード 10）。専用プロファイルは同時に 1 つしか開けません。
   - **利用枠確認**: `src/notebook-quota.ts` により taskdesk または利用量ボードの利用量データを確認します。短期枠がしきい値（既定 85% 超、`NOTEBOOK_SHORT_STOP_PERCENT`）または週枠の上限（既定 100%、`NOTEBOOK_WEEKLY_STOP_PERCENT`）に達している場合は一時停止スキップ（終了コード 11: `EXIT_QUOTA`）。利用量データが読めない場合も安全側に倒してスキップ（終了コード 12: `EXIT_QUOTA_UNAVAILABLE`）。
   - **inbox 件数確認**: inbox 内の未処理 PDF 件数を確認します。inbox が未設定または読み込めない場合も安全側に倒してスキップ（終了コード 13）。
3. **inbox の未処理論文補充**
   - inbox 内の未処理論文数が設定値（既定 5 件、環境変数 `INBOX_MIN_PAPERS`）より少なければ、`npm run fill-inbox` を実行してライブラリから未処理論文を補充します。
4. **パイプラインの実行**
   - `npm start -- --headless --exit-on-quota --no-reveal-login` を実行します。
   - 枠が尽きるか進められる作業がなくなると、`--exit-on-quota` によりリセットを待たずにきりのいいところで終了し、次回の定期実行に備えます。
   - 進められる作業がなく生成待ちだけが一定時間（既定 60 分、`--max-waiting-minutes` または環境変数 `PAPER_MAX_WAITING_MINUTES` で変更可）続いた場合も、きりのいいところで終了コード 16（`EXIT_WAITING_TIMEOUT`）で終了し、次回の定期実行で続きから進みます。
   - `--no-reveal-login` により、定期実行中にログインや追加確認が必要になった場合でも画面を開いて永久待機せず、Chrome を閉じて終了コード 15 で安全に終了します。

---

## 2. コマンド一覧

### 2.1 枠確認コマンド (`quota-check`)

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

終了コード:
- `0`: 利用可能（枠に空きあり）
- `11`: 一時停止（`EXIT_QUOTA`: 枠上限到達）
- `12`: 取得不可（`EXIT_QUOTA_UNAVAILABLE`: 利用量取得失敗）
- `1`: エラー

### 2.2 判断コマンド (`scheduled-decide`)

プロセス、枠、inbox 件数を総合して、定期実行を開始可能かを判定するコマンドです。

```bash
cd tools/paper-pipeline

npm run scheduled-decide
npm run scheduled-decide -- --json
```

終了コード:
- `0`: 実行可能（run）
- `10`: 既存プロセス実行中（skip: `already_running`）
- `11`: 利用枠上限（skip: `quota_paused`）
- `12`: 利用量取得不可（skip: `quota_unavailable`）
- `13`: inbox 取得不可（skip: `inbox_error`）
- `14`: プロセス一覧取得不可（skip: `process_check_error`）
- `1`: 引数エラー（`INBOX_MIN_PAPERS` が不正な場合など）

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

launchd への登録は主人が手動で行います。

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

`.env` または launchd の `EnvironmentVariables` で以下の項目を設定・上書きできます（`.env` の読み込みは Node 内で安全に行われ、シェルとしてのコード実行は行われません）。

| 環境変数 | 既定値 | 説明 |
|---|---|---|
| `INBOX_MIN_PAPERS` | `5` | inbox の未処理論文がこの件数未満になると `fill-inbox` で補充します |
| `NOTEBOOK_SHORT_STOP_PERCENT` | `85` | 短期枠の使用率がこの％を超えたら生成を止めます |
| `NOTEBOOK_WEEKLY_STOP_PERCENT` | `100` | 週枠の使用率がこの％に達したら生成を止めます |
| `NO_REVEAL_LOGIN` | `0`（`scheduled-run.sh` 経由では `--no-reveal-login` により `1` 相当） | ログイン要求検知時に画面付き Chrome を開かず終了コード 15 で終了します |
| `SCHEDULED_LOG_FILE` | `logs/scheduled-run.log` | 定期実行ログファイルの出力先パス。ログの誤コミットを防ぐため、Git 管理対象外の `tools/paper-pipeline/logs/` 配下を推奨します。このディレクトリ外に出力する場合は、出力先を別途 `.gitignore` などで Git 管理対象外にしてください |
| `SCHEDULED_LOCK_DIR` | `/tmp/paper-pipeline-scheduled-run.lock` | 二重起動防止用ロックディレクトリのパス |

---

## 7. ログイン切れ（認証切れ）時の挙動と対処法

定期実行（`--headless --no-reveal-login`）中に Google / NotebookLM や SciSpace のセッション・Cookie が切れている場合の挙動は以下のとおりです。

1. **検知とログ出力**:
   - ヘッドレス実行中にログイン画面に到達すると、`human.ts` の `NeedVisibleChromeError` が発生します。
   - `--no-reveal-login`（または環境変数 `NO_REVEAL_LOGIN=1`）が指定されているため、画面付き Chrome は開かずにエラーログを出力し、ブラウザを閉じて終了コード 15（`EXIT_LOGIN_REQUIRED`）で即座に終了します。
   - 定期実行スクリプト（`scheduled-run.sh`）はこれを受けてログに次の注意を出力します:
     ```text
     注意: ログインまたは追加確認が必要です (終了コード: 15)
     ```
2. **安全な終了と後続実行の保護**:
   - 画面を開いて対話待ちでハングすることなく即座に終了し、ロックも確実に解放されるため、後続の定期実行や他プロセスがデッドロックすることはありません。
3. **主人が行うログイン復旧手順**:
   - ログに `注意: ログインまたは追加確認が必要です (終了コード: 15)` が記録されている場合は、主人が手動で画面付きモードを一度起動してログインを済ませてください:
     ```bash
     cd tools/paper-pipeline
     npm run worker -- --headed --only <論文名.pdf>
     ```
   - ログイン情報は専用プロファイル（`tools/paper-pipeline/.chrome-profile/`）に保持されるため、ログイン完了後は次回の定期実行で自動継続されます。
