import { test } from "node:test";
import assert from "node:assert/strict";
import {
  humanPauseMode,
  pageLooksLikeGoogleLogin,
  pageLooksLikeLoginWall,
  pageLooksLikeBotChallenge,
  NeedVisibleChromeError,
} from "./human.ts";

test("humanPauseMode: ヘッドレスは画面付きへ上げる。画面付きは Enter か poll", () => {
  assert.equal(humanPauseMode({ headed: false, stdinIsTty: true }), "promote");
  assert.equal(humanPauseMode({ headed: true, stdinIsTty: true }), "enter");
  assert.equal(humanPauseMode({ headed: true, stdinIsTty: false }), "poll");
});


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

test("pageLooksLikeLoginWall: Edu Share と SciSpace のログインも画面が要る", () => {
  assert.equal(
    pageLooksLikeLoginWall("http://localhost:3000/auth/login", "ログイン"),
    true,
  );
  assert.equal(
    pageLooksLikeLoginWall("https://scispace.com/folder/x", "Log in to continue"),
    true,
  );
  assert.equal(pageLooksLikeLoginWall("http://localhost:3000/tests/x", "資料情報"), false);
});

test("NeedVisibleChromeError: ヘッドレス側が画面付きへ渡す", () => {
  const e = new NeedVisibleChromeError("NotebookLM", "https://accounts.google.com/signin", "テスト理由");
  assert.equal(e.name, "NeedVisibleChromeError");
  assert.equal(e.context, "NotebookLM");
  assert.match(e.url, /accounts\.google/);
  assert.equal(e.reason, "テスト理由");
  assert.match(e.message, /テスト理由/);
});

test("pageLooksLikeBotChallenge: Cloudflare や Turnstile、キャプチャを判定する", () => {
  assert.equal(
    pageLooksLikeBotChallenge("https://scispace.com/folder/x", "Just a moment...", "Checking your browser before accessing scispace.com"),
    true,
  );
  assert.equal(
    pageLooksLikeBotChallenge("https://challenges.cloudflare.com/turnstile/v0/api.js", "SciSpace", "Verify you are human"),
    true,
  );
  assert.equal(
    pageLooksLikeBotChallenge("https://scispace.com/folder/x", "Attention Required! | Cloudflare", "Ray ID: 8123abc"),
    true,
  );
  assert.equal(
    pageLooksLikeBotChallenge("https://scispace.com/folder/x", "SciSpace - Folder", "Upload PDFs Files (10)"),
    false,
  );
  // 論文名や要旨に captcha や access denied が含まれても誤検出しない
  assert.equal(
    pageLooksLikeBotChallenge(
      "https://scispace.com/folder/x",
      "Analysis of CAPTCHA robust systems in modern web security",
      "Upload PDFs Files (10) We evaluate reCAPTCHA bypass techniques and access denied response patterns.",
    ),
    false,
  );
});
