export const ARTIFACT_KINDS = ["video", "slides", "pdf"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type ArtifactArchive = {
  provider: string;
  archivedAt: string;
  files: Partial<Record<ArtifactKind, { localPath: string; path: string; bytes: number }>>;
};

/** Metadata only: never inspect an archive path (streaming storage may hydrate it). */
export function validArchive(value: unknown): value is ArtifactArchive {
  if (!value || typeof value !== "object") return false;
  const a = value as ArtifactArchive;
  if (typeof a.provider !== "string" || !a.provider.trim() ||
      typeof a.archivedAt !== "string" || !Number.isFinite(Date.parse(a.archivedAt)) ||
      !a.files || typeof a.files !== "object") return false;
  const keys = Object.keys(a.files);
  return keys.length > 0 && keys.every((k) => {
    if (!ARTIFACT_KINDS.includes(k as ArtifactKind)) return false;
    const f = a.files[k as ArtifactKind];
    return f && typeof f.localPath === "string" && !!f.localPath &&
      typeof f.path === "string" && !!f.path && Number.isSafeInteger(f.bytes) && f.bytes > 0;
  });
}

export function artifactArchived(state: { artifactArchive?: ArtifactArchive }, kind: ArtifactKind): boolean {
  return validArchive(state.artifactArchive) && !!state.artifactArchive.files[kind];
}

export function archivedDone(state: { completed: string[]; artifactArchive?: ArtifactArchive }): boolean {
  return state.completed.includes("done") && validArchive(state.artifactArchive);
}
