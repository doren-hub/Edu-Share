import { lstatSync, readdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ARTIFACT_KINDS, validArchive } from "./artifact-record.ts";
import { fileHash, fingerprint } from "./download-files.ts";

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
function directory(path: string): string {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error("Expected unlinked directory");
  return realpathSync(path);
}

type Entry = { name: string; bytes: number; reason: string; eligible: boolean };
/** Offline only. Archive paths are never accessed, including stat/realpath. */
export function cleanupDownloads(options: {
  profile: string; work: string; execute?: boolean; pipelineStopped?: boolean; now?: number;
}): { entries: Entry[]; eligibleBytes: number; deletedBytes: number } {
  const profile = directory(options.profile);
  const downloads = directory(join(profile, "playwright-downloads"));
  const work = directory(options.work);
  if (work === profile || work.startsWith(`${profile}/`) || profile.startsWith(`${work}/`)) throw new Error("Work and profile must be separate");
  if (options.execute && !options.pipelineStopped) throw new Error("Stop the pipeline and pass --pipeline-stopped");
  if (present(join(profile, "SingletonLock"))) throw new Error("Chrome profile is in use; close Chrome first");
  const matches = new Map<string, string>();
  for (const paper of readdirSync(work, { withFileTypes: true })) {
    if (!paper.isDirectory() || paper.isSymbolicLink()) continue;
    const dir = join(work, paper.name);
    const statePath = join(dir, "state.json");
    if (!present(statePath) || lstatSync(statePath).isSymbolicLink()) continue;
    if (present(join(dir, ".artifact-archive.lock")) || present(join(dir, ".artifact-archive-rename.json"))) throw new Error("Archive operation in progress");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const localPaths = [join(dir, "video.mp4"), join(dir, "slides.pdf"),
      ...[state.videoMp4Path, state.slidePdfPath, state.filename && join(dir, state.filename)].filter((p): p is string => typeof p === "string" && !!p)];
    for (const local of localPaths) {
      const path = resolve(local);
      if (dirname(path) !== dir || !present(path)) continue;
      try {
        const before = fingerprint(path);
        const size = lstatSync(path).size;
        const hash = fileHash(path);
        if (fingerprint(path) === before && size > 0) matches.set(`${size}:${hash}`, `local:${paper.name}/${basename(path)}`);
      } catch { /* Nonregular or changing counterparts are not evidence. */ }
    }
    if (validArchive(state.artifactArchive)) {
      for (const kind of ARTIFACT_KINDS) {
        const record = state.artifactArchive.files[kind];
        if (record && /^[a-f0-9]{64}$/.test(record.sha256 ?? "")) {
          matches.set(`${record.bytes}:${record.sha256}`, `archive-record:${paper.name}`);
        }
      }
    }
  }
  const entries: Entry[] = [];
  let eligibleBytes = 0;
  let deletedBytes = 0;
  for (const name of readdirSync(downloads)) {
    const path = join(downloads, name);
    const stat = lstatSync(path);
    const entry: Entry = { name, bytes: stat.size, eligible: false, reason: "unmatched" };
    entries.push(entry);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || name.endsWith(".crdownload")) {
      entry.reason = "nonregular/link/incomplete"; continue;
    }
    // Conservative guard against recent or unfinished writes, even with a matching copy.
    if ((options.now ?? Date.now()) - Math.max(stat.mtimeMs, stat.ctimeMs) < 86_400_000 || present(`${path}.crdownload`)) {
      entry.reason = "recent/incomplete"; continue;
    }
    const before = fingerprint(path);
    const match = matches.get(`${stat.size}:${fileHash(path)}`);
    if (!match || fingerprint(path) !== before) continue;
    entry.eligible = true;
    entry.reason = match;
    eligibleBytes += stat.size;
    if (options.execute) {
      if (fingerprint(path) !== before) throw new Error("Download changed during cleanup");
      unlinkSync(path);
      deletedBytes += stat.size;
    }
  }
  return { entries, eligibleBytes, deletedBytes };
}
