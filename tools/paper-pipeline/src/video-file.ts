import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";

export const VIDEO_MIN_BYTES = 100_000;
/** Supabase Storage のオブジェクト上限（50MB）を少し下回る */
export const VIDEO_UPLOAD_MAX_BYTES = 45 * 1024 * 1024;

const require = createRequire(import.meta.url);

export function videoArtifactPath(paperDir: string, videoMp4Path: string): string {
  if (videoMp4Path.trim() && existsSync(videoMp4Path)) return videoMp4Path;
  return join(paperDir, "video.mp4");
}

/** 先頭バイトが MP4/QuickTime の ftyp か。PDF・ZIP を弾く。 */
export function isMp4FtypBuffer(buf: Uint8Array): boolean {
  if (buf.length < 8) return false;
  const head = Buffer.from(buf.subarray(0, 12));
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return false;
  if (head.subarray(0, 2).toString("latin1") === "PK") return false;
  return head.subarray(4, 8).toString("latin1") === "ftyp";
}

/** lh3 の小さいサムネ（=s96-c など） */
export function isLikelyThumbUrl(url: string): boolean {
  if (/fonts\.googleapis|favicon/i.test(url)) return true;
  if (/=s0(?:\b|$)/i.test(url)) return false;
  if (/=s\d{1,3}(?:-c)?(?:\b|$)/i.test(url)) return true;
  if (/=w\d{2,3}-h\d{2,3}/i.test(url)) return true;
  return false;
}

/** LIST_ARTIFACTS の URL から動画らしき順に並べる。拡張子無しの googleusercontent も含める。 */
export function rankVideoArtifactUrls(urls: string[]): string[] {
  const videoNamed = urls.filter((u) => /\.mp4(\?|$)|mime=video|video\/mp4/i.test(u));
  const downloads = urls.filter(
    (u) => /usercontent\.google\.com\/download/i.test(u) || /\.mp4(\?|$)/i.test(u),
  );
  const media = urls.filter((u) => /googleusercontent\.com/i.test(u) && !isLikelyThumbUrl(u));
  const rest = urls.filter((u) => !isLikelyThumbUrl(u));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of [...videoNamed, ...downloads, ...media, ...rest]) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= 24) break;
  }
  return out;
}

/** MP4/QuickTime の ftyp。PDF を video.mp4 として保存した誤ダウンロードを弾く。 */
export function isRealVideoFile(path: string): boolean {
  try {
    if (!existsSync(path) || statSync(path).size <= VIDEO_MIN_BYTES) return false;
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(12);
    const n = readSync(fd, buf, 0, 12, 0);
    closeSync(fd);
    if (n < 8) return false;
    return isMp4FtypBuffer(buf.subarray(0, n));
  } catch {
    return false;
  }
}

export function downloadNameLooksLikeVideo(name: string): boolean {
  const ext = extname(name).toLowerCase();
  if (!ext) return false;
  return ext === ".mp4" || ext === ".webm" || ext === ".mov" || ext === ".m4v";
}

export function videoFileReady(paperDir: string, videoMp4Path: string): boolean {
  const p = videoArtifactPath(paperDir, videoMp4Path);
  return isRealVideoFile(p);
}

export function needsLocalVideoFile(state: {
  paperDir: string;
  videoMp4Path: string;
  completed: string[];
  notebooklmUrl: string;
  waitingFor?: string;
  studioStarted?: string[];
}): boolean {
  if (!state.notebooklmUrl) return false;
  if (videoFileReady(state.paperDir, state.videoMp4Path)) return false;
  if (state.completed.includes("nlm-video") || state.completed.includes("done")) return true;
  if (state.waitingFor === "nlm-video") return true;
  return (state.studioStarted ?? []).includes("nlm-video");
}

function ffmpegBin(): string | null {
  const pathHit = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (pathHit.status === 0) return "ffmpeg";
  try {
    const packed = require("ffmpeg-static") as string | null;
    if (packed && existsSync(packed)) return packed;
  } catch {
    /* optional */
  }
  return null;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function transcodeWithFfmpeg(bin: string, src: string, dest: string, preset: "mid" | "low"): boolean {
  const scale = preset === "low" ? "scale=-2:480" : "scale=-2:720";
  const crf = preset === "low" ? "32" : "28";
  const run = spawnSync(
    bin,
    ["-y", "-i", src, "-vf", scale, "-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", dest],
    { encoding: "utf8", timeout: 300_000 },
  );
  return run.status === 0 && fileSize(dest) > VIDEO_MIN_BYTES;
}

/** Edu Share / Supabase に載せるため、50MB 超なら小さくしたコピーを返す */
export function ensureUploadableVideo(src: string): string {
  const size = fileSize(src);
  if (size <= VIDEO_UPLOAD_MAX_BYTES) return src;
  const dest = join(dirname(src), "video-upload.mp4");
  if (existsSync(dest) && fileSize(dest) > VIDEO_MIN_BYTES && fileSize(dest) <= VIDEO_UPLOAD_MAX_BYTES) {
    const srcM = statSync(src).mtimeMs;
    const destM = statSync(dest).mtimeMs;
    if (destM >= srcM) return dest;
  }

  const bin = ffmpegBin();
  if (!bin) {
    throw new Error(
      `動画が ${Math.round(size / (1024 * 1024))}MB でストレージ上限を超えます。ffmpeg で縮小できません`,
    );
  }

  for (const preset of ["mid", "low"] as const) {
    if (!transcodeWithFfmpeg(bin, src, dest, preset)) continue;
    const out = fileSize(dest);
    if (out > VIDEO_MIN_BYTES && out <= VIDEO_UPLOAD_MAX_BYTES && out < size) return dest;
  }
  const out = fileSize(dest);
  throw new Error(
    `動画を縮小しても ${Math.round((out || size) / (1024 * 1024))}MB あり、ストレージ上限を超えます`,
  );
}
