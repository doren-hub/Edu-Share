import { test } from "node:test";
import assert from "node:assert/strict";
import { pageLooksLikeGoogleLogin } from "./human.ts";

test("pageLooksLikeGoogleLogin: アカウント選択とログアウト済み", () => {
  assert.equal(
    pageLooksLikeGoogleLogin(
      "https://accounts.google.com/v3/signin/accountchooser?continue=https://notebook.google.com/",
      "アカウントを選択してください\nDoren\nログアウト済み",
    ),
    true,
  );
  assert.equal(pageLooksLikeGoogleLogin("https://notebook.google.com/notebook/x", "ソース"), false);
  assert.equal(
    pageLooksLikeGoogleLogin("https://scispace.com/folder/x", "アカウントを選択してください"),
    true,
  );
});
