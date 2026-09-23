import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { listExistingWorkPapers, listInboxPdfs } from "./inbox.ts";
import { normalizePdfFilename } from "./match.ts";

export type SourcePdf = {
  filename: string;
  absPath: string;
  mtimeMs: number;
};

const FINDER_LIST_SCRIPT = `
on run argv
  set rootPosix to item 1 of argv
  tell application "Finder"
    set folderRef to POSIX file rootPosix as alias
    set itemsList to every item of folderRef
    set out to ""
    repeat with itm in itemsList
      set nm to name of itm as text
      if nm starts with "." then
      else if class of itm is folder then
        set out to out & "DIR" & tab & (POSIX path of (itm as alias)) & linefeed
      else if name extension of itm is "pdf" then
        set d to modification date of itm
        set out to out & "PDF" & tab & nm & tab & (POSIX path of (itm as alias)) & tab & (year of d as text) & "-" & (month of d as integer as text) & "-" & (day of d as text) & " " & (time of d as text) & linefeed
      end if
    end repeat
    return out
  end tell
end run
`;

const FINDER_COPY_SCRIPT = `
on run argv
  set srcFile to POSIX file (item 1 of argv) as alias
  set destFolder to POSIX file (item 2 of argv) as alias
  tell application "Finder"
    duplicate srcFile to destFolder
  end tell
end run
`;

function isEperm(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as NodeJS.ErrnoException).code === "EPERM";
}

/** Finder が返す「年-月-日 深夜からの秒」をローカル時刻のミリ秒にする */
export function finderMtimeMs(year: number, month: number, day: number, seconds: number): number {
  const dt = new Date(year, month - 1, day);
  dt.setHours(0, 0, 0, 0);
  return dt.getTime() + seconds * 1000;
}

/** Finder 一覧の1フォルダ分。PDF とサブディレクトリの POSIX パス */
export function parseFinderLibraryListing(text: string): { pdfs: SourcePdf[]; dirs: string[] } {
  const pdfs: SourcePdf[] = [];
  const dirs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts[0] === "DIR" && parts[1]) {
      dirs.push(parts[1].replace(/\/$/, ""));
      continue;
    }
    if (parts[0] !== "PDF" || parts.length < 4) continue;
    const m = /^(\d+)-(\d+)-(\d+) (\d+)$/.exec(parts[3] ?? "");
    if (!m) continue;
    pdfs.push({
      filename: parts[1] ?? "",
      absPath: parts[2] ?? "",
      mtimeMs: finderMtimeMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])),
    });
  }
  return { pdfs, dirs };
}

function listOneFolderViaFinder(dir: string): { pdfs: SourcePdf[]; dirs: string[] } {
  const text = execFileSync("osascript", ["-e", FINDER_LIST_SCRIPT, "--", dir], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseFinderLibraryListing(text);
}

/** macOS の書類フォルダなど、プロセスから読めない場所を Finder 経由で歩く */
export function listLibraryPdfsViaFinder(root: string): SourcePdf[] {
  const out: SourcePdf[] = [];
  const pending = [root];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const dir = pending.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    const { pdfs, dirs } = listOneFolderViaFinder(dir);
    out.push(...pdfs);
    pending.push(...dirs);
  }
  return out;
}

function walkReadable(dir: string, out: SourcePdf[]): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (process.platform === "darwin" && isEperm(e)) {
      out.push(...listLibraryPdfsViaFinder(dir));
      return;
    }
    throw e;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkReadable(abs, out);
      continue;
    }
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith(".pdf")) continue;
    let mtimeMs = Number.POSITIVE_INFINITY;
    try {
      mtimeMs = statSync(abs).mtimeMs;
    } catch (e) {
      if (process.platform === "darwin" && isEperm(e)) {
        const viaFinder = listOneFolderViaFinder(dir).pdfs.find((pdf) => pdf.filename === ent.name);
        if (viaFinder) mtimeMs = viaFinder.mtimeMs;
      }
    }
    out.push({ filename: ent.name, absPath: abs, mtimeMs });
  }
}

/** ライブラリ内の PDF。隠しファイルと隠しディレクトリは対象外 */
export function listLibraryPdfs(root: string): SourcePdf[] {
  const out: SourcePdf[] = [];
  walkReadable(root, out);
  return out;
}

/** inbox または作業フォルダに同じ PDF 名があるものを処理済みとみなす */
export function processedPdfNames(inboxDir: string, workDir: string): Set<string> {
  const names = new Set<string>();
  for (const item of listInboxPdfs(inboxDir, workDir)) {
    names.add(normalizePdfFilename(item.filename));
  }
  for (const paper of listExistingWorkPapers(workDir)) {
    if (paper.filename) names.add(normalizePdfFilename(paper.filename));
  }
  return names;
}

/** 未処理のうち変更日が古い順に limit 件。同じファイル名は先に見た方だけ */
export function pickUnprocessedPdfs(
  source: readonly SourcePdf[],
  processedNames: ReadonlySet<string>,
  limit: number,
): SourcePdf[] {
  const seen = new Set<string>();
  const candidates = source.filter((pdf) => {
    const key = normalizePdfFilename(pdf.filename);
    if (!key || processedNames.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  candidates.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    return a.filename.localeCompare(b.filename, "en");
  });
  return candidates.slice(0, Math.max(0, limit));
}

function copyViaFinder(src: string, inboxDir: string): void {
  execFileSync("osascript", ["-e", FINDER_COPY_SCRIPT, "--", src, inboxDir], {
    encoding: "utf8",
    timeout: 120_000,
  });
}

/** 元のライブラリは残し、inbox 直下へコピーする。同名が既にあればスキップ */
export function copyPdfsToInbox(pdfs: readonly SourcePdf[], inboxDir: string): SourcePdf[] {
  const copied: SourcePdf[] = [];
  for (const pdf of pdfs) {
    const dest = join(inboxDir, pdf.filename);
    if (existsSync(dest)) continue;
    try {
      copyFileSync(pdf.absPath, dest);
    } catch (e) {
      if (!(process.platform === "darwin" && isEperm(e))) throw e;
      copyViaFinder(pdf.absPath, inboxDir);
      if (!existsSync(dest)) {
        throw new Error(`inbox へコピーできませんでした: ${pdf.filename}`);
      }
    }
    copied.push({ ...pdf, absPath: dest });
  }
  return copied;
}
