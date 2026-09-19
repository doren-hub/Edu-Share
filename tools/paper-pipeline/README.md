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

Chrome プロファイルは `tools/paper-pipeline/.chrome-profile/` に作られます（git 管理外）。

## 実行

Edu Share を起動した状態で:

```bash
npm start
# または
npm start -- --inbox /Users/doren/Developer/edu-share-papers/inbox --work /Users/doren/Developer/edu-share-papers/work
```

初回は Chrome が開くので、Google（NotebookLM）、SciSpace、Edu Share にログインしてください。NotebookLM は **ホームに「ノートブックを新規作成」が見えてから** ターミナルで Enter を押します。以降は同じプロファイルを使います。

Export 拡張をまだ入れていなければ、開いた Chrome の `chrome://extensions` から読み込むか、`.env` に拡張フォルダのパスを書きます。

## 動き

1. Edu Share の論文一覧からタイトルと DOI を取る
2. 入力ディレクトリ直下の PDF を変更日が古い順に処理
3. 作業フォルダに `DONE` がある、または一覧とタイトル/DOI が一致するものは無視（PDF は入力側に残す）
4. 作業開始時に `PAPER_WORK_DIR/<ファイル名>/` を作り、スライド・動画・CSV をそこに保存
5. 業界はアップロード画面の PDF 自動入力と SciSpace メタから候補を選ぶ
6. SciSpace のリンクはフォルダではなく個別レコード（`/records/…`）を保存する
7. 全手順成功後、入力側の PDF を論文フォルダへ移して `DONE` を書く
8. 失敗した PDF は入力側のまま。同じフォルダの `state.json` から再開する

1件失敗しても次の PDF へ進みます。止めるときは `--stop-on-error`。

```bash
npm start -- --only paper.pdf --from sci-upload
```

## 注意

- NotebookLM の動画生成は数十分かかることがあります
- 公式 API ではないため、ボタン文言が変わると失敗します。失敗時は論文フォルダの `failures/` にスクリーンショットが残ります
