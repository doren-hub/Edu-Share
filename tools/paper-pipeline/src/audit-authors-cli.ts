import { parseArgs } from "node:util";
import { auditAuthors } from "./audit-authors.ts";

function help(): string {
  return `手元の状態ファイル（work/<論文>/state.json）と PDF を読み、著者が未設定またはおかしい値の論文と、補える著者の候補を一覧で出す読み取り専用コマンド

使い方:
  npm run audit-authors
  npm run audit-authors -- --work work
  npm run audit-authors -- --json
`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      work: { type: "string", default: "work" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(help());
    return;
  }

  const result = await auditAuthors({
    workDir: values.work ?? "work",
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`=== 著者洗い出し結果 ===`);
  console.log(`対象論文数: ${result.total} 件`);
  console.log(`正常: ${result.okCount} 件`);
  console.log(`未設定: ${result.unsetCount} 件`);
  console.log(`おかしい値: ${result.invalidCount} 件`);
  console.log(`補える候補あり: ${result.recoverableCount} 件`);
  console.log("");

  if (result.items.length === 0) {
    console.log("未設定またはおかしい値の論文はありませんでした。");
    return;
  }

  for (const item of result.items) {
    const statusLabel = item.status === "unset" ? "【未設定】" : "【おかしい値】";
    const candidateStr = item.candidateAuthor
      ? ` → 補える候補: ${item.candidateAuthor} (${item.candidateSource})`
      : " → 補える候補なし";
    console.log(`${statusLabel} ${item.paper} (現在: "${item.currentAuthor}")${candidateStr}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
