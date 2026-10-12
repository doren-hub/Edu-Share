import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { normalizePdfFilename } from "../src/lib/pdf-filename.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}

const DEFAULT_PAPER_WORK_DIR = "/Users/doren/Developer/edu-share-papers/work";

interface StateJson {
  filename?: string;
  eduShareTestId?: string;
  title?: string;
}

interface BackfillTarget {
  testId: string;
  originalFilename: string;
  normalizedFilename: string;
  workDir: string;
}

async function collectTargets(workDir: string): Promise<BackfillTarget[]> {
  const dirs = await readdir(workDir, { withFileTypes: true });
  const targets: BackfillTarget[] = [];

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const statePath = join(workDir, dir.name, "state.json");
    try {
      const raw = await readFile(statePath, "utf8");
      const state = JSON.parse(raw) as StateJson;
      if (state.eduShareTestId && state.filename) {
        targets.push({
          testId: state.eduShareTestId.trim(),
          originalFilename: state.filename.trim(),
          normalizedFilename: normalizePdfFilename(state.filename),
          workDir: dir.name,
        });
      }
    } catch {
      // state.json が無い、または壊れているディレクトリは無視
    }
  }

  return targets;
}

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  const workDir = process.env.PAPER_WORK_DIR?.trim() || DEFAULT_PAPER_WORK_DIR;

  console.log(`=== tests.pdf_filename 埋め戻しスクリプト ===`);
  console.log(`モード: ${isDryRun ? "DRY-RUN (更新なし)" : "EXECUTE (本番更新)"}`);
  console.log(`参照元作業ディレクトリ: ${workDir}\n`);

  const targets = await collectTargets(workDir);
  console.log(`state.json から読み取った対象件数: ${targets.length} 件`);

  // 1. targets 内での重複チェック
  const seenNorm = new Map<string, BackfillTarget>();
  const seenId = new Map<string, BackfillTarget>();
  const internalCollisions: string[] = [];

  for (const t of targets) {
    if (seenNorm.has(t.normalizedFilename)) {
      const prev = seenNorm.get(t.normalizedFilename)!;
      internalCollisions.push(
        `正規化ファイル名重複: ${t.normalizedFilename} (ID: ${t.testId} と ID: ${prev.testId})`
      );
    } else {
      seenNorm.set(t.normalizedFilename, t);
    }

    if (seenId.has(t.testId)) {
      const prev = seenId.get(t.testId)!;
      internalCollisions.push(
        `テストID重複: ${t.testId} (フォルダ: ${t.workDir} と ${prev.workDir})`
      );
    } else {
      seenId.set(t.testId, t);
    }
  }

  if (internalCollisions.length > 0) {
    console.error("収集データ内に重複が検出されました:");
    for (const msg of internalCollisions) console.error(`  - ${msg}`);
    process.exit(1);
  }

  // 2. DB 接続して現状を確認
  const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: dbTests, error: fetchErr } = await supabase
    .from("tests")
    .select("id, title, document_type, processing_status, pdf_filename");

  if (fetchErr || !dbTests) {
    console.error("DB から tests の取得に失敗しました:", fetchErr);
    process.exit(1);
  }

  console.log(`DB の tests 総行数: ${dbTests.length} 件`);

  const dbMap = new Map(dbTests.map((t) => [t.id, t]));
  const existingDbFilenameNorms = new Set(
    dbTests
      .filter((t) => t.document_type === "paper" && t.pdf_filename)
      .map((t) => normalizePdfFilename(t.pdf_filename!))
  );

  const toUpdate: BackfillTarget[] = [];
  const skippedCollision: Array<{ target: BackfillTarget; reason: string }> = [];
  const notFoundInDb: BackfillTarget[] = [];
  const alreadySet: BackfillTarget[] = [];

  for (const t of targets) {
    const dbRow = dbMap.get(t.testId);
    if (!dbRow) {
      notFoundInDb.push(t);
      continue;
    }

    if (dbRow.pdf_filename) {
      alreadySet.push(t);
      continue;
    }

    // 既に他の paper で同じ normalized filename があるか（一意制約衝突防止）
    if (existingDbFilenameNorms.has(t.normalizedFilename)) {
      skippedCollision.push({
        target: t,
        reason: `DB内に既に同一の正規化ファイル名が存在 (${t.normalizedFilename})`,
      });
      continue;
    }

    toUpdate.push(t);
  }

  console.log("\n【分類結果】");
  console.log(`- 更新対象 (更新可): ${toUpdate.length} 件`);
  console.log(`- 既に pdf_filename 設定済み: ${alreadySet.length} 件`);
  console.log(`- DB にテストIDが存在しない: ${notFoundInDb.length} 件`);
  console.log(`- 一意制約衝突のためスキップ: ${skippedCollision.length} 件`);

  if (skippedCollision.length > 0) {
    console.log("\n一意制約衝突によりスキップされた一覧:");
    for (const s of skippedCollision) {
      console.log(`  - ID: ${s.target.testId}, ファイル名: ${s.target.normalizedFilename}, 理由: ${s.reason}`);
    }
  }

  // 手元に対応が無い DB 上の論文
  const unmatchedDbPapers = dbTests.filter(
    (t) => t.document_type === "paper" && !seenId.has(t.id)
  );
  console.log(`\n手元の state.json に対応が無い DB 上の論文: ${unmatchedDbPapers.length} 件`);
  for (const u of unmatchedDbPapers) {
    console.log(`  - ID: ${u.id} [${u.processing_status}] タイトル: ${u.title}`);
  }

  if (toUpdate.length === 0) {
    console.log("\n更新が必要なレコードはありません。終了します。");
    return;
  }

  if (isDryRun) {
    console.log("\n[DRY-RUN] 以下の更新が予定されています (DBは変更されません):");
    for (const t of toUpdate.slice(0, 5)) {
      console.log(`  - ID: ${t.testId} -> pdf_filename: "${t.normalizedFilename}"`);
    }
    if (toUpdate.length > 5) {
      console.log(`  ... 他 ${toUpdate.length - 5} 件`);
    }
    console.log("\n--dry-run 完了");
    return;
  }

  console.log(`\nDB 更新を開始します (${toUpdate.length} 件)...`);
  let updatedCount = 0;
  for (const t of toUpdate) {
    const { error: updateErr } = await supabase
      .from("tests")
      .update({ pdf_filename: t.normalizedFilename })
      .eq("id", t.testId)
      .is("pdf_filename", null); // 既存値を誤って上書きしない安全ガード

    if (updateErr) {
      console.error(`ID: ${t.testId} の更新に失敗:`, updateErr.message);
      process.exit(1);
    }
    updatedCount++;
  }

  console.log(`正常に更新完了: ${updatedCount} 件`);
}

main().catch((err) => {
  console.error("エラーが発生しました:", err);
  process.exit(1);
});
