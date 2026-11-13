import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ARTIFACT_KINDS, validArchive, type ArtifactArchive, type ArtifactKind } from "./artifact-record.ts";
import { doneMarkerPath, statePath, type PaperState } from "./state.ts";

type FileEntry = { kind: ArtifactKind; localPath: string; path: string; bytes: number };
function inside(root: string, path: string): boolean {
  const r = relative(root, path);
  return !!r && r !== ".." && !r.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(r);
}
function localFile(paperDir: string, path: string): string {
  const absolute = resolve(path);
  const p = join(realpathSync(dirname(absolute)), basename(absolute));
  if (!inside(paperDir, p) || realpathSync(join(p, "..")) !== paperDir) {
    throw new Error("Artifact must be directly inside the paper directory");
  }
  if (["state.json", "DONE", "quiz.csv", "vocab.csv", ".artifact-archive.lock"].includes(basename(p))) {
    throw new Error("Protected local file cannot be archived or restored");
  }
  if (existsSync(p) && (!lstatSync(p).isFile() || lstatSync(p).isSymbolicLink())) {
    throw new Error("Artifact must be a regular local file, not a link");
  }
  return p;
}
function readState(paperDir: string): PaperState {
  if (lstatSync(statePath(paperDir)).isSymbolicLink()) throw new Error("Linked state is not supported");
  return { ...JSON.parse(readFileSync(statePath(paperDir), "utf8")), paperDir } as PaperState;
}
function writeState(state: PaperState): void {
  const temp = join(state.paperDir, `.state-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2), { flag: "wx" });
    renameSync(temp, statePath(state.paperDir));
  } finally { rmSync(temp, { force: true }); }
}
function withLock<T>(paperDir: string, action: () => T): T {
  const lock = join(paperDir, ".artifact-archive.lock");
  const fd = openSync(lock, "wx");
  try { return action(); } finally { closeSync(fd); unlinkSync(lock); }
}
function eligible(state: PaperState): void {
  if (state.giveUp || !existsSync(doneMarkerPath(state.paperDir)) ||
      !state.completed.includes("done") ||
      !(state.eduShareTestId || state.eduShareTestUrl) ||
      !state.completed.includes("edu-materials")) {
    throw new Error("Only DONE papers with completed Edu Share registration/materials can be archived");
  }
}
export function listArchive(paperDir: string): ArtifactArchive | undefined {
  const record = readState(realpathSync(paperDir)).artifactArchive;
  if (record !== undefined && !validArchive(record)) throw new Error("Invalid archive record");
  return record;
}

/** All copies are verified before recording; recording precedes any local deletion. */
export function archivePaper(options: {
  paperDir: string; root: string; provider?: string; execute?: boolean;
}, copy: typeof copyFileSync = copyFileSync): FileEntry[] {
  const paperDir = realpathSync(options.paperDir);
  if (!options.root.trim()) throw new Error("Archive root is not configured");
  const root = realpathSync(options.root);
  if (!statSync(root).isDirectory()) throw new Error("Archive root is not a directory");
  if (root === paperDir || inside(paperDir, root) || inside(root, paperDir)) {
    throw new Error("Archive root and paper directory must be separate");
  }
  const run = () => {
    const state = readState(paperDir);
    eligible(state);
    if (state.artifactArchive) throw new Error("Already archived; restore before archiving again");
    const provider = options.provider ?? "google-drive";
    if (!provider.trim()) throw new Error("Archive provider is required");
    const destination = join(root, `${basename(paperDir)}-${randomUUID()}`);
    const sources: Record<ArtifactKind, string> = {
      video: state.videoMp4Path || join(paperDir, "video.mp4"),
      slides: state.slidePdfPath || join(paperDir, "slides.pdf"),
      pdf: join(paperDir, state.filename),
    };
    const files: FileEntry[] = [];
    for (const kind of ARTIFACT_KINDS) {
      const localPath = localFile(paperDir, sources[kind]);
      if (!existsSync(localPath)) {
        if (kind === "pdf" || (kind === "video" ? !!state.videoMp4Path : !!state.slidePdfPath) || state.completed.includes(kind === "video" ? "nlm-video" : "nlm-slides") ||
            state.eduUploaded.includes(kind === "video" ? "nlm-video" : "nlm-slides")) {
          throw new Error(`Missing local artifact: ${kind}`);
        }
        continue;
      }
      for (const protectedPath of [state.quizCsvPath, state.vocabCsvPath]) {
        if (protectedPath && localPath === join(realpathSync(dirname(resolve(protectedPath))), basename(protectedPath))) {
          throw new Error("Artifact overlaps a retained CSV");
        }
      }
      const bytes = statSync(localPath).size;
      if (bytes <= 0) throw new Error(`Empty artifact: ${kind}`);
      files.push({ kind, localPath, path: join(destination, `${kind}${kind === "video" ? ".mp4" : ".pdf"}`), bytes });
    }
    if (new Set(files.map((f) => f.localPath)).size !== files.length) throw new Error("Artifact paths overlap");
    if (!options.execute) return files;
    mkdirSync(destination);
    // On failure retain both the originals and any partial archive for manual inspection.
    for (const f of files) copy(f.localPath, f.path, constants.COPYFILE_EXCL);
    for (const f of files) {
      if (statSync(f.path).size !== f.bytes || statSync(f.localPath).size !== f.bytes) {
        throw new Error(`Size verification failed: ${f.kind}`);
      }
    }
    state.artifactArchive = {
      provider, archivedAt: new Date().toISOString(),
      files: Object.fromEntries(files.map(({ kind, ...f }) => [kind, f])),
    };
    writeState(state);
    for (const f of files) unlinkSync(f.localPath);
    return files;
  };
  return options.execute ? withLock(paperDir, run) : run();
}

export function restorePaper(paperPath: string, execute = false, copy: typeof copyFileSync = copyFileSync): FileEntry[] {
  const paperDir = realpathSync(paperPath);
  const run = () => {
    const state = readState(paperDir);
    if (!validArchive(state.artifactArchive)) throw new Error("No valid archive record");
    const files = ARTIFACT_KINDS.flatMap((kind) => {
      const f = state.artifactArchive!.files[kind];
      return f ? [{ kind, ...f, localPath: localFile(paperDir, f.localPath) }] : [];
    });
    if (new Set(files.map((f) => f.localPath)).size !== files.length) throw new Error("Artifact paths overlap");
    if (!execute) return files;
    // Copy without overwriting existing local files; leave the archive intact on every failure.
    for (const f of files) {
      if (!lstatSync(f.path).isFile() || statSync(f.path).size !== f.bytes) throw new Error(`Archive size mismatch: ${f.kind}`);
      if (existsSync(f.localPath)) throw new Error(`Local file already exists: ${f.kind}`);
    }
    const temps = files.map((f) => ({ ...f, temp: join(paperDir, `.restore-${randomUUID()}.tmp`) }));
    try {
      for (const f of temps) {
        copy(f.path, f.temp, constants.COPYFILE_EXCL);
        if (statSync(f.temp).size !== f.bytes) throw new Error(`Restore size mismatch: ${f.kind}`);
      }
      // Exclusive copy also protects files created after preflight.
      for (const f of temps) copyFileSync(f.temp, f.localPath, constants.COPYFILE_EXCL);
      delete state.artifactArchive;
      writeState(state);
    } finally { for (const f of temps) rmSync(f.temp, { force: true }); }
    return files;
  };
  return execute ? withLock(paperDir, run) : run();
}
