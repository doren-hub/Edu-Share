import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOKMARK_LIST_NAME_MAX,
  bookmarkIconState,
  countBookmarkMemberships,
  normalizeBookmarkListName,
  sortByCreatedDesc,
  sortByUpdatedDesc,
} from "./bookmark-name.ts";

test("リスト名は前後の空白を除く", () => {
  const result = normalizeBookmarkListName("  読む予定  ");
  assert.deepEqual(result, { ok: true, name: "読む予定" });
});

test("空白だけのリスト名は作れない", () => {
  assert.equal(normalizeBookmarkListName("   ").ok, false);
  assert.equal(normalizeBookmarkListName("").ok, false);
  assert.equal(normalizeBookmarkListName(null).ok, false);
});

test("リスト名は80文字まで", () => {
  const ok = "あ".repeat(BOOKMARK_LIST_NAME_MAX);
  const tooLong = "あ".repeat(BOOKMARK_LIST_NAME_MAX + 1);
  assert.equal(normalizeBookmarkListName(ok).ok, true);
  const rejected = normalizeBookmarkListName(tooLong);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.match(rejected.error, /80文字/);
  }
});

test("リストは更新が新しい順、同着は名前順", () => {
  const sorted = sortByUpdatedDesc([
    { name: "試験前", updatedAt: "2026-09-01T00:00:00.000Z" },
    { name: "読む予定", updatedAt: "2026-09-22T00:00:00.000Z" },
    { name: "あとで", updatedAt: "2026-09-22T00:00:00.000Z" },
  ]);
  assert.deepEqual(
    sorted.map((row) => row.name),
    ["あとで", "読む予定", "試験前"],
  );
});

test("未登録は輪郭、1リストは塗り、複数リストだけ重なり", () => {
  assert.equal(bookmarkIconState(0), "none");
  assert.equal(bookmarkIconState(1), "one");
  assert.equal(bookmarkIconState(2), "many");
  assert.equal(bookmarkIconState(5), "many");
});

test("同じ教材が複数リストにあると件数になる", () => {
  assert.deepEqual(
    countBookmarkMemberships(["paper", "exam", "paper"]),
    { paper: 2, exam: 1 },
  );
});

test("リストの中身は追加が新しい順", () => {
  const sorted = sortByCreatedDesc([
    { createdAt: "2026-09-01T00:00:00.000Z", testId: "old" },
    { createdAt: "2026-09-22T00:00:00.000Z", testId: "new" },
  ]);
  assert.deepEqual(
    sorted.map((row) => row.testId),
    ["new", "old"],
  );
});
