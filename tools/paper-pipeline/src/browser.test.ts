import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStealthUserAgentMetadata,
  chromeLaunchArgs,
  cleanHeadlessBrands,
  cleanHeadlessUserAgent,
  shouldOverrideHeadlessUserAgent,
} from "./browser.ts";

test("chromeLaunchArgs: ヘッドレスでは --headless=new を付ける", () => {
  const headed = chromeLaunchArgs({ headed: true, exportExtensionPath: "" });
  const headless = chromeLaunchArgs({ headed: false, exportExtensionPath: "/ext" });
  assert.equal(headed.includes("--headless=new"), false);
  assert.equal(headless.includes("--headless=new"), true);
  assert.equal(headless.includes("--load-extension=/ext"), true);
  assert.equal(headed.includes("--load-extension="), false);
});

test("shouldOverrideHeadlessUserAgent: HeadlessChrome が含まれる場合のみ置換対象とする", () => {
  assert.equal(
    shouldOverrideHeadlessUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X) HeadlessChrome/156.0.8078.79 Safari/537.36"),
    true,
  );
  assert.equal(
    shouldOverrideHeadlessUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/156.0.8078.79 Safari/537.36"),
    false,
  );
});

test("cleanHeadlessUserAgent: HeadlessChrome を Chrome に置換して実バージョンを保つ", () => {
  const original =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.8078.79 Safari/537.36";
  const cleaned = cleanHeadlessUserAgent(original);
  assert.equal(cleaned.includes("HeadlessChrome"), false);
  assert.equal(
    cleaned,
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.79 Safari/537.36",
  );
});

test("cleanHeadlessBrands: ブランド配列から Headless を除去する", () => {
  const brands = [
    { brand: "HeadlessChrome", version: "131" },
    { brand: "Chromium", version: "131" },
    { brand: "Not_A Brand", version: "24" },
  ];
  assert.deepEqual(cleanHeadlessBrands(brands), [
    { brand: "Chrome", version: "131" },
    { brand: "Chromium", version: "131" },
    { brand: "Not_A Brand", version: "24" },
  ]);
});

test("buildStealthUserAgentMetadata: rawUserAgent からバージョンを抽出しメタデータを構築する", () => {
  const rawUa =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.6778.86 Safari/537.36";
  const metadata = buildStealthUserAgentMetadata({
    rawUserAgent: rawUa,
    platform: "macOS",
    platformVersion: "15.7.0",
    architecture: "arm",
  });
  assert.equal(metadata.fullVersion, "131.0.6778.86");
  assert.equal(metadata.platform, "macOS");
  assert.equal(metadata.platformVersion, "15.7.0");
  assert.equal(metadata.architecture, "arm");
  assert.equal(metadata.mobile, false);
  assert.deepEqual(metadata.brands, [
    { brand: "Chromium", version: "131" },
    { brand: "Google Chrome", version: "131" },
    { brand: "Not=A?Brand", version: "24" },
  ]);
});



