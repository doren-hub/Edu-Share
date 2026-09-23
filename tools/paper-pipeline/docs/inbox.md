# inbox の論文をツールで処理する

未処理の PDF は `PAPER_INBOX_DIR` の直下に置く。処理は `tools/paper-pipeline` の `npm start`（オーケストレータ）が行う。段階の中身は [flow.md](flow.md)。

Edu Share の `npm run dev` は止めない。Chrome プロファイル（`tools/paper-pipeline/.chrome-profile/`）は同時に一つだけ開く。

## 1. 置く

1. PDF を inbox の直下に置く。サブディレクトリと、`.` で始まるファイルは対象外。
2. ファイル名の拡張子は `.pdf`。作業フォルダ名は拡張子を除いた名前（使えない文字は `_`）。
3. 既定の処理順は変更日が古い順。新しいものからにするときは `--newest-first`。

inbox と作業ディレクトリは別にする。例は `.env.example` の `PAPER_INBOX_DIR` と `PAPER_WORK_DIR`。

## 2. 始める前

1. Edu Share が `EDU_SHARE_BASE_URL`（既定 `http://localhost:3000`）で動いている。
2. `tools/paper-pipeline` で `npm install` 済み、`.env` がある。
3. 同じプロファイルの Chrome と、別の `npm start` が動いていない。動いていれば新しい方は起動しない。
4. 初回、または Google / SciSpace / Edu Share のログインが切れているときは画面付きで始める。

## 3. 起動する

```bash
cd tools/paper-pipeline
npm start -- --headed
```

ログイン済みでウィンドウを出したくないとき:

```bash
npm start -- --headless
```

`--headless` でも、ログインや追加確認のときだけ画面が出て、終わるとヘッドレスに戻る。

ログは標準出力と標準エラー。行頭は時刻。`オーケストレータ: worker を呼びます → ファイル名.pdf` がその論文の開始。

## 4. ツールがすること

1 論文につき worker が Chrome を一つ開き、終わると閉じる。次の worker はそのあと。

1. SciSpace の指定フォルダへ PDF を載せる（カードメタはまだ取らない）。
2. NotebookLM で、`--generate` の項目を開始する。省略時はスライド・解説動画・クイズ・単語帳の 4 種。指定した項目がすべて開始済みか完了になるまで、次の論文の生成には進まない。
3. 生成待ちのあいだは Chrome を明け渡し、次の論文の生成へ進む。動画は数十分かかることがある。
4. 揃ったら SciSpace のカードメタと `/records/…` を取る。
5. Edu Share に PDF・説明・資料・動画を載せ、確認する。
6. 成功したら inbox の PDF を `PAPER_WORK_DIR/<名前>/` へ移し、そこに `DONE` を書く。

作業の途中状態は同じフォルダの `state.json`。失敗しても次の PDF へ進む。1 件で止めるときは `--stop-on-error`。

Notebook の短期枠が 85% を超えているあいだは生成を止める。週枠が 100% のときはリセット時刻まで待つ。そのあいだは SciSpace の掲載・メタと、できている生成物の Edu Share 登録を先に進める。止めないときは `--ignore-notebook-quota`。

## 5. 一部だけ進める

```bash
# その PDF だけ
npm start -- --only paper.pdf --headed

# 途中の段階から（--only と併用。最初の worker だけ）
npm start -- --only paper.pdf --from sci-meta

# 生成する Studio を絞る（slides / video / quiz / flashcards、all で全部）
npm start -- --generate quiz,flashcards
npm start -- --only paper.pdf --generate slides,video
```

`--from` に渡せる段階は `sci-upload`、`nlm-create`、`nlm-upload`、`nlm-slides`、`nlm-video`、`nlm-quiz`、`nlm-flashcards`、`sci-meta`、`edu-upload`、`edu-materials`、`verify`、`done`。

worker を直接呼ぶとき（オーケストレータを経由しない）:

```bash
npm run worker -- --only paper.pdf --headed
```

## 6. 終わりの見分け

| 状態 | 置き場所 |
|---|---|
| 未処理 | inbox 直下に PDF がある |
| 処理中・失敗後の再開待ち | `work/<名前>/state.json` があり、inbox に PDF が残っている |
| 完了 | `work/<名前>/DONE` があり、PDF は inbox からそのフォルダへ移っている |
| スキップ | 作業フォルダの PDF 名が同じ、または既存論文と判定できたもの。PDF は inbox に残ることがある |

失敗時の画面は `work/<名前>/failures/`。同じ論文は `state.json` の完了段階から再開する。

終了コード: `0` 完了またはスキップ、`10` 生成待ち、`11` Notebook 利用量待ち、`1` 失敗。オーケストレータは待ちと失敗を自分で次の論文へ回す。

## 7. 止める・再開する

止めるときはオーケストレータへ SIGINT（Ctrl+C）。worker が Chrome を閉じてから終了する。

再開は同じコマンドでよい。`DONE` がある論文は、本物の MP4 が無いときだけ補修対象になる。MP4 が取れない、Studio が空、SciSpace メタが進まない論文は、すぐ開き直さず間隔を空ける。クールダウン中は Chrome を開かない。

同じ失敗の即再試行や、ログが同じ論文で進まないときは、プロセスと `failures/` を見てから直す。直したあとの再開は画面付き（`--headed`）にする。
