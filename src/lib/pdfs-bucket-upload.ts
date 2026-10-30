export type FileLike = {
  name?: string;
  filename?: string;
  type?: string;
  mimeType?: string;
};

export function looksLikeSlidePdf(file: FileLike): boolean {
  const t = (file.type ?? file.mimeType ?? "").toLowerCase();
  const name = (file.name ?? file.filename ?? "").toLowerCase();
  if (name.endsWith(".pdf")) return true;
  return t === "application/pdf" || t.startsWith("application/pdf");
}

export function looksLikeVideoMp4(file: FileLike): boolean {
  const t = (file.type ?? file.mimeType ?? "").toLowerCase();
  const name = (file.name ?? file.filename ?? "").toLowerCase();
  if (name.endsWith(".mp4")) return true;
  return t === "video/mp4" || t.startsWith("video/mp4");
}
