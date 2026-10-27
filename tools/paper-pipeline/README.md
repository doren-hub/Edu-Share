# 論文アップロード外部自動化ツール

Edu Share の画面は変えず、NotebookLM・SciSpace・Edu Share をログイン済み Chrome で順に操作します。Google / SciSpace の UI 変更で壊れます。初回は画面付き（headed）でセレクタを合わせてください。

## 準備

```bash
cd tools/paper-pipeline
npm install
npx playwright install chrome
npx playwright install chromium   # Chrome が無い場合の予備
cp .env.example .env
```

`.env` で次を設定します。

- `PAPER_INBOX_DIR` — 未処理の論文 PDF（例: `/Users/doren/Developer/edu-share-papers/inbox`）
- `PAPER_WORK_DIR` — 作業用（入力とは別。例: `/Users/doren/Developer/edu-share-papers/work`）。論文ごとのフォルダが作られます
- `EDU_SHARE_BASE_URL` — 例: `http://localhost:3000`
- `SCISPACE_FOLDER_URL` — 既定は SciSpace Notebooks フォルダ
- 任意: `NOTEBOOKLM_EXPORT_EXTENSION_PATH` — クイズ/単語帳 CSV 用の Export 拡張のディレクトリ
- 任意: `EDU_SHARE_EMAIL` / `EDU_SHARE_PASSWORD`
- 任意: `TASKDESK_USAGE_URL` — Notebook 利用量 JSON（既定は taskdesk / ai-usage-board の `usage-latest.json`）

Chrome プロファイルは `tools/paper-pipeline/.chrome-profile/` に作られます（git 管理外）。

## 実行

Edu Share を起動した状態で:

```bash
npm start
# または
npm start -- --inbox /Users/doren/Developer/edu-share-papers/inbox --work /Users/doren/Developer/edu-share-papers/work
```

`npm start` が読むのは inbox 直下の PDF だけです。作業フォルダにしか無い論文の SciSpace メタ補修は別コマンドです。同じ Chrome プロファイルなので同時には起動しません。

```bash
npm run repair-meta -- --headed
npm run fill-inbox -- --source "/path/to/papers" --count 3
```

初回やログイン切れのときは Chrome が開くので、Google（NotebookLM）、SciSpace、Edu Share にログインしてください。`--headless` では通常ウィンドウを出さず、ログインや追加確認のときだけ画面を出して、終わったらヘッドレスに戻します。同じプロファイルを画面付きと同時には開かないでください。

```bash
npm start -- --headless
# または .env に HEADLESS=1
```

引数 `--headless` / `--headed` が `HEADLESS` より優先します。同じプロファイルを画面付きと同時には開かないでください。

Export 拡張をまだ入れていなければ、開いた Chrome の `chrome://extensions` から読み込むか、`.env` に拡張フォルダのパスを書きます。

inbox に置いてから完了までの操作手順は [docs/inbox.md](docs/inbox.md)。フローチャートと段階の説明は [docs/flow.md](docs/flow.md)。

## 動き

1. Edu Share の論文一覧からタイトルと DOI を取る
2. inbox 直下の PDF を変更日が古い順に処理する。作業フォルダだけにある論文は対象にしない
3. 作業フォルダに `DONE` がある、または一覧とタイトル/DOI が一致するものは無視（PDF は入力側に残す）
4. 作業開始時に `PAPER_WORK_DIR/<ファイル名>/` を作り、スライド・動画・CSV をそこに保存
5. **SciSpace 指定フォルダへ PDF を先に載せる**（カードメタはまだ待たない）
6. NotebookLM の Studio は `--generate` で選んだ項目（省略時は 4 種）を開始（または完了）してから Chrome を明け渡し、次の inbox の論文の生成へ進む。**短期枠の使用量が上限（既定 85%、`--notebook-short-stop-percent` で変更）を超えているあいだは生成を止め、週枠が 100% ならリセット時刻まで待つ**（taskdesk / 利用量ボードの Notebook 枠）。そのあいだは、処理中の inbox の論文について SciSpace 掲載・メタと、1 種でもできている生成物の Edu Share 登録を先に進める
7. Studio が揃ったら SciSpace のカードメタと `/records/…` を取る（掲載から遅れて出るメタを、NotebookLM 待ちのあいだに進めておく）
8. 業界はアップロード画面の PDF 自動入力と SciSpace メタから候補を選ぶ
9. SciSpace のリンクはフォルダではなく個別レコード（`/records/…`）を保存する
10. 全手順成功後、入力側の PDF を論文フォルダへ移して `DONE` を書く
11. 失敗した PDF は入力側のまま。同じフォルダの `state.json` から再開する

1件失敗しても次の PDF へ進みます。止めるときは `--stop-on-error`。

```bash
npm start -- --only paper.pdf --from sci-meta
npm start -- --generate quiz,flashcards
npm start -- --only paper.pdf --generate slides,video
npm start -- --generate all
npm run repair-meta -- --headed
```

`--generate` は `slides` / `video` / `quiz` / `flashcards` を複数指定できます。`all` で全部。省略時は 4 種すべて。`--skip-slides-video` は `--generate quiz,flashcards` と同じです。対象は inbox にあるその PDF です。作業フォルダだけのメタの取り直しは `npm run repair-meta` です。

## 注意

- SciSpace のカードメタは PDF 掲載から遅れるので、掲載は NotebookLM より先、メタ取得は Studio のあとです
- NotebookLM の Studio は、同じ論文のスライド・動画・クイズ・単語帳がすべて生成待ちか完了になってから次の論文の生成に進みます。動画は数十分かかることがあります。MP4 が取れない・Studio が空・SciSpace メタが進まないときは同じ論文をすぐ開き直さず、間隔を空けます
- Notebook の短期枠（Gemini Notebook）の使用量が上限を超えているあいだは生成を止めます。既定は 85% で、`--notebook-short-stop-percent 70` のように変えられます（環境変数 `NOTEBOOK_SHORT_STOP_PERCENT` より引数が優先）。ちょうどその％では止めず、超えたら止めます。週枠が 100% のときはリセット日時まで待ちます。値は taskdesk と同じ利用量 JSON をリアルタイムに読みます。止めないときは `--ignore-notebook-quota`
- 利用量が回復するまでは、SciSpace への PDF 掲載・メタ反映と、1 種でもできている生成物の Edu Share 登録を先に進めます。残りの生成は枠が空いてから再開します
- 公式 API ではないため、ボタン文言が変わると失敗します。失敗時は論文フォルダの `failures/` にスクリーンショットが残ります

### 生成済みカードの取得

クイズや単語帳の題名が「練習問題」「確認テスト」「記憶カード」などでも、Studio の出力カードの種別を使って既存の教材を取得します。生成開始タイルやソース一覧は出力として扱いません。教材の再生成はせず、保存した CSV は従来どおり Edu Share へ取り込みます。

教材を開いて取得した後は Studio 一覧に戻ってから次の教材を確認します。ビューア表示や生成中のカードを未生成と扱わず、開始記録を保持して通常の生成待ちとして次の巡回に明け渡します。生成が完了した教材は既存の出力から取得し、保存済みの CSV や原本は保持します。実サービスには接続せず、`tools/paper-pipeline` 内の `npm test` と `npm run typecheck` で一覧復帰と段階遷移を確認できます。

ソース PDF の投入は、表示中のモーダル内の file input を優先します。input がない場合は全候補を一つの探索期限（15 秒）で調べ、表示・有効状態を確認してから filechooser の監視とクリックを開始します。クリックは最大 5 秒、イベント待機はクリック猶予込みで最大 20 秒です。候補不在・クリック失敗・イベント未発生を別のエラーとして記録し、監視は終了時に解除します。モーダルがない従来の画面ではページ内の file input / 操作要素を使います。説明文だけには反応せず、名前が一致する操作要素を優先します。保存済みノートは通常の再開経路で再利用し、ソースが存在する場合は再投入しません。

テストには外部サービスへ接続しない画面フィクスチャが含まれます。`npx playwright install chromium` 済みの Chromium、またはローカルの Chrome を使います。CI はテスト用 Chromium を準備します。運用の Chrome プロファイルは使いません。
