# paper-pipeline のメモリ測定と削減

## 概要

paper-pipeline 実行時のメモリ使用量（macOS アクティビティモニタの「メモリ」列 = `phys_footprint`）を測定・確認する手順です。

### 変更前の課題（2026-10-31 計測値）

PDF 処理中の全体メモリ: **約 1.4 GB**

1. **Chrome プロセス群: 約 890 MB**
   - ヘッドレス起動時に描画を CPU で代行（SwiftShader）しており、GPU プロセスが約 270 MB を消費。
   - ページ表示（NotebookLM 等）312 MB、本体 108 MB、小プロセス計 約 150 MB、通信 32 MB、保存領域 20 MB。
2. **Node プロセス群: 約 520 MB**
   - 進行役 `orchestrate.ts`（約 215 MB）と worker `cli.ts`（約 182 MB）の双方が `tsx` で TypeScript をその場で変換して実行しており、メモリ・CPU 負荷が 2 重に発生。

### 改善内容

1. **ヘッドレス起動時の GPU 無効化 (`--disable-gpu`)**
   - `src/browser.ts` の `chromeLaunchArgs` で、`--headless=new` 起動時に `--disable-gpu` を追加。
   - ヘッドレスで不要な GPU プロセス / SwiftShader の負荷を抑制します（画面付き `--headed` では通常描画を維持）。
2. **事前ビルド (`npm run build`) による JS 直接実行**
   - TypeScript を `tsc -p tsconfig.build.json` で事前変換し、`dist/` 配下の JavaScript を `node` で直接実行。
   - `npm start` 時に自動で `prestart` が走り事前ビルドされるため、利用者の使い方は変わりません。
   - 進行役 (`orchestrate.js`) から起動する worker も `dist/cli.js` が存在する場合は `node` で直接起動し、`tsx` を介しません。

---

## メモリ測定手順

パイプラインの処理中に別ターミナルを開き、以下のいずれかの方法で測定します。

### 方法 A: 付属スクリプトを実行する（推奨）

パイプライン実行中に以下を実行します:

```bash
./tools/paper-pipeline/scripts/measure-memory.sh
```

実行中の `paper-pipeline` 関連 Node プロセスおよび Chrome プロセスを自動検出し、RSS および macOS の `phys_footprint`（アクティビティモニタのメモリと同等）を集計して表示します。

### 方法 B: 手動で ps / footprint を確認する

#### 1. プロセス一覧と RSS の確認

```bash
# 進行役・worker・Chrome 関連プロセスの PID を取得
PIDS=$(pgrep -f "(dist|src)/(orchestrate|cli|fill-inbox-cli)\.(js|ts)|\.chrome-profile")

# BSD ps 用にカンマ区切りの PID を作成して表示
ps -o pid,rss,%cpu,%mem,command -p "$(echo $PIDS | tr ' ' ',')"
```

※ `rss` 列は KB 単位（1024 で割ると MB）です。

#### 2. アクティビティモニタ同等の物理フットプリント（macOS `footprint` コマンド）

```bash
# 各プロセスの Footprint を表示
for PID in $PIDS; do
  echo "PID: $PID"
  footprint -p "$PID" | grep -E "Footprint:|TOTAL"
done
```

---

## 期待される削減効果

- **Chrome GPU プロセス**: `--disable-gpu` により不要な GPU プロセスのメモリ消費が抑制されます。
- **Node プロセス**: `tsx` によるランタイム TypeScript 変換（esbuild / source maps）の常駐メモリが解消され、Node プロセス（進行役 + worker）の合計メモリが大幅に削減されます。
