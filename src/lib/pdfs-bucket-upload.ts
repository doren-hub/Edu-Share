export function looksLikeSlidePdf(file: File): boolean {
  const t = (file.type ?? "").toLowerCase();
  const name = file.name?.toLowerCase() ?? "";
  if (name.endsWith(".pdf")) return true;
  return t === "application/pdf" || t.startsWith("application/pdf");
}

export function looksLikeVideoMp4(file: File): boolean {
  const t = (file.type ?? "").toLowerCase();
  const name = file.name?.toLowerCase() ?? "";
  if (name.endsWith(".mp4")) return true;
  return t === "video/mp4" || t.startsWith("video/mp4");
}
