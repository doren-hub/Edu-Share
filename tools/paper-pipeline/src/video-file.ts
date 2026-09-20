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

/** MP4/QuickTime の ftyp。PDF を video.mp4 として保存した誤ダウンロードを弾く。 */
export function isRealVideoFile(path: string): boolean {
  try {
    if (!existsSync(path) || statSync(path).size <= VIDEO_MIN_BYTES) return false;
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(12);
    const n = readSync(fd, buf, 0, 12, 0);
    closeSync(fd);
    if (n < 8) return false;
    if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return false;
    return buf.subarray(4, 8).toString("latin1") === "ftyp";
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
}): boolean {
  if (!state.notebooklmUrl) return false;
  if (!state.completed.includes("nlm-video") && !state.completed.includes("done")) return false;
  return !videoFileReady(state.paperDir, state.videoMp4Path);
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
