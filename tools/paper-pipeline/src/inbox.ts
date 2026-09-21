import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fileStem, normalizePdfFilename, type ExistingPaper } from "./match.ts";
import { needsSciSpaceCardRecapture } from "./scispace-card.ts";
import { doneMarkerPath, emptyState, loadState, type PaperState, type StudioStageId } from "./state.ts";
import { missingStudioStages } from "./studio-select.ts";
import { needsLocalVideoFile } from "./video-file.ts";

export type InboxPdf = {
  filename: string;
  absPath: string;
  stem: string;
  paperDir: string;
};

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function listInboxPdfs(inboxDir: string, workDir: string, onlyFilename = ""): InboxPdf[] {
  const names = readdirSync(inboxDir).filter(
    (n) => n.toLowerCase().endsWith(".pdf") && !n.startsWith("."),
  );
  const filtered = onlyFilename
    ? names.filter((n) => n === onlyFilename || n.toLowerCase() === onlyFilename.toLowerCase())
    : names;
  return filtered
    .map((filename) => {
      const stem = sanitizeDirName(fileStem(filename));
      return {
        filename,
        absPath: join(inboxDir, filename),
        stem,
        paperDir: join(workDir, stem),
      };
    })
    .sort((a, b) => {
      const byMtime = mtimeMs(a.absPath) - mtimeMs(b.absPath);
      if (byMtime !== 0) return byMtime;
      return a.filename.localeCompare(b.filename, "en");
    });
}

export function sanitizeDirName(stem: string): string {
  const s = stem.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
  return s || "paper";
}

export function ensurePaperDir(paperDir: string): void {
  mkdirSync(paperDir, { recursive: true });
  mkdirSync(join(paperDir, "failures"), { recursive: true });
}

export function hasDoneMarker(paperDir: string): boolean {
  return existsSync(doneMarkerPath(paperDir));
}

export function writeDoneMarker(paperDir: string): void {
  writeFileSync(doneMarkerPath(paperDir), new Date().toISOString() + "\n", "utf8");
}

/** 完了後: 入力 PDF を論文フォルダへ移す。跨ボリュームなら copy + 削除 */
export function moveInboxPdfToPaperDir(inboxPdfPath: string, paperDir: string): string {
  const dest = join(paperDir, basename(inboxPdfPath));
  if (existsSync(dest)) {
    if (inboxPdfPath !== dest && existsSync(inboxPdfPath)) {
      try {
        unlinkSync(inboxPdfPath);
      } catch {
        /* 入力側が残っても完了は優先 */
      }
    }
    return dest;
  }
  try {
    renameSync(inboxPdfPath, dest);
    return dest;
  } catch {
    copyFileSync(inboxPdfPath, dest);
    unlinkSync(inboxPdfPath);
    return dest;
  }
}

function loadWorkPaper(workDir: string, name: string): { state: PaperState; paperDir: string } {
  const paperDir = join(workDir, name);
  const fallback = emptyState({
    filename: `${name}.pdf`,
    inboxPdfPath: join(paperDir, `${name}.pdf`),
    paperDir,
  });
  return { state: loadState(paperDir, fallback), paperDir };
}

function workPdfPath(state: PaperState): string | undefined {
  const absPath = existsSync(state.inboxPdfPath)
    ? state.inboxPdfPath
    : join(state.paperDir, state.filename);
  return existsSync(absPath) ? absPath : undefined;
}

function toInboxPdf(state: PaperState, absPath: string): InboxPdf {
  return {
    filename: state.filename,
    absPath,
    stem: sanitizeDirName(fileStem(state.filename)),
    paperDir: state.paperDir,
  };
}

function listWorkDirs(workDir: string): string[] {
  try {
    return readdirSync(workDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function pdfNamesInPaperDir(paperDir: string, stateFilename: string): string[] {
  const names = new Set<string>();
  if (stateFilename.trim()) names.add(stateFilename.trim());
  try {
    for (const n of readdirSync(paperDir)) {
      if (n.startsWith(".")) continue;
      if (!n.toLowerCase().endsWith(".pdf")) continue;
      names.add(n);
    }
  } catch {
    /* フォルダが読めなくても state の名前は使う */
  }
  return [...names];
}

/** 作業フォルダ内の PDF 名称（同一論文の判定用。Edu Share 一覧は見ない） */
export function listExistingWorkPapers(workDir: string): ExistingPaper[] {
  const papers: ExistingPaper[] = [];
  const seen = new Set<string>();
  for (const name of listWorkDirs(workDir)) {
    const { state, paperDir } = loadWorkPaper(workDir, name);
    for (const filename of pdfNamesInPaperDir(paperDir, state.filename)) {
      const key = `${paperDir}\0${normalizePdfFilename(filename)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      papers.push({
        title: state.title,
        doi: state.doi,
        filename,
        id: state.eduShareTestId || undefined,
        url: state.eduShareTestUrl || undefined,
        paperDir,
      });
    }
  }
  return papers;
}

export function existingWorkPapersExcept(
  workDir: string,
  paperDir: string,
): ExistingPaper[] {
  return listExistingWorkPapers(workDir).filter((p) => p.paperDir !== paperDir);
}

/** inbox から移したあとも、MP4 が無い完了論文を worker が拾えるようにする */
export function listVideoRepairPdfs(workDir: string, onlyFilename = ""): InboxPdf[] {
  const out: InboxPdf[] = [];
  for (const name of listWorkDirs(workDir)) {
    const { state } = loadWorkPaper(workDir, name);
    if (onlyFilename && state.filename !== onlyFilename) continue;
    if (!needsLocalVideoFile(state)) continue;
    const absPath = workPdfPath(state);
    if (!absPath) continue;
    out.push(toInboxPdf(state, absPath));
  }
  return out.sort((a, b) => a.filename.localeCompare(b.filename, "en"));
}

/** 完了済みでも Files 行が空／省略著者／デモ著者なら、貼り付け欄を取り直す */
export function listRawPasteRepairPdfs(workDir: string, onlyFilename = ""): InboxPdf[] {
  const out: InboxPdf[] = [];
  for (const name of listWorkDirs(workDir)) {
    const { state } = loadWorkPaper(workDir, name);
    if (onlyFilename && state.filename !== onlyFilename) continue;
    if (!needsSciSpaceCardRecapture(state)) continue;
    const absPath = workPdfPath(state);
    if (!absPath) continue;
    out.push(toInboxPdf(state, absPath));
  }
  return out.sort((a, b) => a.filename.localeCompare(b.filename, "en"));
}

/** --only で作業フォルダ側の PDF（Edu Share 済みを含む）を指定する */
export function listWorkPdfs(workDir: string, onlyFilename: string): InboxPdf[] {
  if (!onlyFilename) return [];
  const out: InboxPdf[] = [];
  for (const name of listWorkDirs(workDir)) {
    const { state } = loadWorkPaper(workDir, name);
    if (state.filename !== onlyFilename) continue;
    const absPath = workPdfPath(state);
    if (!absPath) continue;
    out.push(toInboxPdf(state, absPath));
  }
  return out;
}

function isUploadedPaper(state: PaperState): boolean {
  return Boolean(state.eduShareTestId || state.eduShareTestUrl || hasDoneMarker(state.paperDir));
}

/** Edu Share 済みで、指定 Studio の成果物がまだ無い論文 */
export function listStudioFollowupPdfs(
  workDir: string,
  selected: readonly StudioStageId[],
  onlyFilename = "",
): InboxPdf[] {
  if (selected.length === 0) return [];
  const out: InboxPdf[] = [];
  for (const name of listWorkDirs(workDir)) {
    const { state } = loadWorkPaper(workDir, name);
    if (onlyFilename && state.filename !== onlyFilename) continue;
    if (!isUploadedPaper(state)) continue;
    if (missingStudioStages(state, selected).length === 0) continue;
    const absPath = workPdfPath(state);
    if (!absPath) continue;
    out.push(toInboxPdf(state, absPath));
  }
  return out.sort((a, b) => a.filename.localeCompare(b.filename, "en"));
}

export function mergeInboxAndVideoRepair(
  inbox: InboxPdf[],
  repairs: InboxPdf[],
): InboxPdf[] {
  const seen = new Set(inbox.map((i) => i.filename));
  return [...inbox, ...repairs.filter((r) => !seen.has(r.filename))];
}
