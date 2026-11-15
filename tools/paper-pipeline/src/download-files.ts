import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, lstatSync, openSync, readSync, realpathSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function fileHash(path: string): string {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes: number;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

export function fingerprint(path: string): string {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink()) throw new Error("Expected regular file");
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}

/** Delete only a verified, unchanged source directly in the dedicated downloads directory. */
export function importDownload(src: string, dest: string, downloadsDir?: string,
  copy: typeof copyFileSync = copyFileSync, validate: (path: string) => boolean = () => true): void {
  const before = fingerprint(src);
  if (resolve(src) === resolve(dest) || (existsSync(dest) && realpathSync(src) === realpathSync(dest))) {
    if (!validate(src)) throw new Error("Download format validation failed");
    return;
  }
  if (existsSync(dest)) fingerprint(dest);
  const temp = join(dirname(dest), `.download-${randomUUID()}.tmp`);
  try {
    copy(src, temp, constants.COPYFILE_EXCL);
    if (!validate(temp)) throw new Error("Download format validation failed");
    const destination = fingerprint(temp);
    if (fileHash(src) !== fileHash(temp) || fingerprint(src) !== before || fingerprint(temp) !== destination) {
      throw new Error("Download copy verification failed");
    }
    renameSync(temp, dest);
  } finally { rmSync(temp, { force: true }); }
  if (downloadsDir && dirname(resolve(src)) === resolve(downloadsDir) && !src.endsWith(".crdownload")) {
    if (fingerprint(src) !== before) throw new Error("Download changed before source removal");
    if (!lstatSync(downloadsDir).isSymbolicLink() && lstatSync(downloadsDir).isDirectory()) unlinkSync(src);
  }
}
