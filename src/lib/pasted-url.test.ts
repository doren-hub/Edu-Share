import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizePastedUrl } from "./pasted-url.ts";

test("sanitizePastedUrl: 末尾改行つきアドレスバーコピーを通す", () => {
  assert.equal(
    sanitizePastedUrl("https://notebook.google.com/notebook/abc-def\n"),
    "https://notebook.google.com/notebook/abc-def",
  );
  assert.equal(
    sanitizePastedUrl("https://scispace.com/records/foo-pdf-abc123\r\n"),
    "https://scispace.com/records/foo-pdf-abc123",
  );
});

test("sanitizePastedUrl: 前後の空白と <> 囲みを外す", () => {
  assert.equal(
    sanitizePastedUrl("  <https://notebooklm.google.com/notebook/x>  "),
    "https://notebooklm.google.com/notebook/x",
  );
});

test("sanitizePastedUrl: 文中の http(s) URL を取り出す", () => {
  assert.equal(
    sanitizePastedUrl("SciSpace\nhttps://scispace.com/records/a-pdf-b\n開く"),
    "https://scispace.com/records/a-pdf-b",
  );
});

test("sanitizePastedUrl: 空は空のまま", () => {
  assert.equal(sanitizePastedUrl("   \n"), "");
});
