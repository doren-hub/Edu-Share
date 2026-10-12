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

export interface StateJson {
  filename?: string;
  eduShareTestId?: string;
  title?: string;
}

export interface BackfillTarget {
  testId: string;
  originalFilename: string;
  normalizedFilename: string;
  workDir: string;
}

export interface DbTestRow {
  id: string;
  title: string | null;
  document_type: string | null;
  processing_status: string | null;
  pdf_filename: string | null;
}

export interface ClassifyResult {
  toUpdate: BackfillTarget[];
  alreadySet: BackfillTarget[];
  notFoundInDb: BackfillTarget[];
  skippedNotPaper: BackfillTarget[];
  skippedCollision: Array<{ target: BackfillTarget; reason: string }>;
  unmatchedDbPapers: DbTestRow[];
}

export function classifyTargets(
  targets: BackfillTarget[],
  dbTests: DbTestRow[]
): ClassifyResult {
  const dbMap = new Map(dbTests.map((t) => [t.id, t]));
  const targetIdSet = new Set(targets.map((t) => t.testId));

  const existingDbFilenameNorms = new Set(
    dbTests
      .filter((t) => t.document_type === "paper" && t.pdf_filename && t.pdf_filename.trim())
      .map((t) => normalizePdfFilename(t.pdf_filename!))
  );

  const toUpdate: BackfillTarget[] = [];
  const alreadySet: BackfillTarget[] = [];
  const notFoundInDb: BackfillTarget[] = [];
  const skippedNotPaper: BackfillTarget[] = [];
  const skippedCollision: Array<{ target: BackfillTarget; reason: string }> = [];

  for (const t of targets) {
    if (!t.normalizedFilename) {
      skippedCollision.push({
        target: t,
        reason: "正規化ファイル名が空です",
      });
      continue;
    }

    const dbRow = dbMap.get(t.testId);
    if (!dbRow) {
      notFoundInDb.push(t);
      continue;
    }

    if (dbRow.document_type !== "paper") {
      skippedNotPaper.push(t);
      continue;
    }

    if (dbRow.pdf_filename && dbRow.pdf_filename.trim()) {
      alreadySet.push(t);
      continue;
    }

    if (existingDbFilenameNorms.has(t.normalizedFilename)) {
      skippedCollision.push({
        target: t,
        reason: `DB内に既に同一の正規化ファイル名が存在 (${t.normalizedFilename})`,
      });
      continue;
    }

    toUpdate.push(t);
  }

  const unmatchedDbPapers = dbTests.filter(
    (t) => t.document_type === "paper" && !targetIdSet.has(t.id)
  );

  return {
    toUpdate,
    alreadySet,
    notFoundInDb,
    skippedNotPaper,
    skippedCollision,
    unmatchedDbPapers,
  };
}

export async function collectTargets(workDir: string): Promise<BackfillTarget[]> {
  const dirs = await readdir(workDir, { withFileTypes: true });
  const targets: BackfillTarget[] = [];

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const statePath = join(workDir, dir.name, "state.json");
    try {
      const raw = await readFile(statePath, "utf8");
      const state = JSON.parse(raw) as StateJson;
      const original = (state.filename ?? "").trim();
      const norm = normalizePdfFilename(original);
      if (state.eduShareTestId && original && norm) {
        targets.push({
          testId: state.eduShareTestId.trim(),
          originalFilename: original,
          normalizedFilename: norm,
          workDir: dir.name,
        });
      }
    } catch {
      // state.json が存在しないかパースできない場合はスキップ
    }
  }

  return targets;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAllDbTests(supabase: any): Promise<DbTestRow[]> {
  const rows: DbTestRow[] = [];
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("tests")
      .select("id, title, document_type, processing_status, pdf_filename")
      .range(from, to);

    if (error) {
      throw new Error(`DB tests の取得に失敗しました: ${error.message}`);
    }

    if (!data || data.length === 0) break;
    rows.push(...(data as DbTestRow[]));

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

export async function main() {
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

  // 2. DB 接続して現状を確認 (ページネーション対応)
  const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const dbTests = await fetchAllDbTests(supabase);
  console.log(`DB の tests 総行数: ${dbTests.length} 件`);

  const classified = classifyTargets(targets, dbTests);

  console.log("\n【分類結果】");
  console.log(`- 更新対象 (更新可): ${classified.toUpdate.length} 件`);
  console.log(`- 既に pdf_filename 設定済み: ${classified.alreadySet.length} 件`);
  console.log(`- DB にテストIDが存在しない: ${classified.notFoundInDb.length} 件`);
  console.log(`- 論文 (document_type = paper) ではないためスキップ: ${classified.skippedNotPaper.length} 件`);
  console.log(`- 一意制約衝突のためスキップ: ${classified.skippedCollision.length} 件`);

  if (classified.skippedCollision.length > 0) {
    console.log("\n一意制約衝突によりスキップされた一覧:");
    for (const s of classified.skippedCollision) {
      console.log(`  - ID: ${s.target.testId}, ファイル名: ${s.target.normalizedFilename}, 理由: ${s.reason}`);
    }
  }

  console.log(`\n手元の state.json に対応が無い DB 上の論文: ${classified.unmatchedDbPapers.length} 件`);
  for (const u of classified.unmatchedDbPapers) {
    console.log(`  - ID: ${u.id} [${u.processing_status}] タイトル: ${u.title}`);
  }

  if (classified.toUpdate.length === 0) {
    console.log("\n更新が必要なレコードはありません。終了します。");
    return;
  }

  if (isDryRun) {
    console.log("\n[DRY-RUN] 以下の更新が予定されています (DBは変更されません):");
    for (const t of classified.toUpdate) {
      console.log(`  - ID: ${t.testId} -> pdf_filename: "${t.normalizedFilename}"`);
    }
    console.log("\n--dry-run 完了");
    return;
  }

  console.log(`\nDB 更新を開始します (${classified.toUpdate.length} 件)...`);
  let updatedCount = 0;
  let zeroRowCount = 0;

  for (const t of classified.toUpdate) {
    const { data, error: updateErr } = await supabase
      .from("tests")
      .update({ pdf_filename: t.normalizedFilename })
      .eq("id", t.testId)
      .is("pdf_filename", null)
      .select("id");

    if (updateErr) {
      console.error(`ID: ${t.testId} の更新に失敗:`, updateErr.message);
      process.exit(1);
    }

    if (data && data.length > 0) {
      updatedCount += data.length;
    } else {
      zeroRowCount++;
      console.warn(`ID: ${t.testId} は更新されませんでした (0行更新)`);
    }
  }

  console.log(`\n更新結果: 正常更新 ${updatedCount} 件, 0行更新 ${zeroRowCount} 件`);
}

// 直接実行された場合のみ main() を呼び出す
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^[A-Za-z]:/, ""))) {
  main().catch((err) => {
    console.error("エラーが発生しました:", err);
    process.exit(1);
  });
}
