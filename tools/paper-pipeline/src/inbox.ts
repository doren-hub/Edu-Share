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
import { fileStem } from "./match.ts";
import { doneMarkerPath } from "./state.ts";

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
