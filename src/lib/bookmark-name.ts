/** リスト名の上限（PostgreSQL の char_length と揃える） */
export const BOOKMARK_LIST_NAME_MAX = 80;

export type BookmarkIconState = "none" | "one" | "many";

/** 0 は未登録、1 はしおりの塗り、2 以上は重なりの塗り */
export function bookmarkIconState(listCount: number): BookmarkIconState {
  if (listCount >= 2) return "many";
  if (listCount === 1) return "one";
  return "none";
}

export function countBookmarkMemberships(
  testIds: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of testIds) {
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

export type BookmarkNameResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

/** 前後の空白を除き、空と長すぎる名前を拒む */
export function normalizeBookmarkListName(raw: unknown): BookmarkNameResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "リスト名を入力してください" };
  }
  const name = raw.trim();
  if (!name) {
    return { ok: false, error: "リスト名を入力してください" };
  }
  if ([...name].length > BOOKMARK_LIST_NAME_MAX) {
    return {
      ok: false,
      error: `リスト名は${BOOKMARK_LIST_NAME_MAX}文字までです`,
    };
  }
  return { ok: true, name };
}

export function sortByUpdatedDesc<T extends { updatedAt: string; name: string }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    const byTime = b.updatedAt.localeCompare(a.updatedAt);
    if (byTime !== 0) return byTime;
    return a.name.localeCompare(b.name, "ja");
  });
}

export function sortByCreatedDesc<T extends { createdAt: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
