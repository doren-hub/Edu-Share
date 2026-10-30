import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chromeLaunchArgs,
  DEFAULT_CHROME_USER_AGENT,
  cleanHeadlessUserAgent,
  createStealthUserAgentData,
} from "./browser.ts";

test("chromeLaunchArgs: ヘッドレスでは --headless=new を付ける", () => {
  const headed = chromeLaunchArgs({ headed: true, exportExtensionPath: "" });
  const headless = chromeLaunchArgs({ headed: false, exportExtensionPath: "/ext" });
  assert.equal(headed.includes("--headless=new"), false);
  assert.equal(headless.includes("--headless=new"), true);
  assert.equal(headless.includes("--load-extension=/ext"), true);
  assert.equal(headed.includes("--load-extension="), false);
});

test("DEFAULT_CHROME_USER_AGENT: HeadlessChrome を含まず通常の Chrome User-Agent である", () => {
  assert.equal(DEFAULT_CHROME_USER_AGENT.includes("HeadlessChrome"), false);
  assert.match(DEFAULT_CHROME_USER_AGENT, /Mozilla\/5\.0.*Chrome\/\d+/);
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

test("createStealthUserAgentData: brands から Headless を除きつつ getHighEntropyValues やプロパティを保持する", async () => {
  const mockUaData = {
    brands: [
      { brand: "HeadlessChrome", version: "131" },
      { brand: "Chromium", version: "131" },
      { brand: "Not_A Brand", version: "24" },
    ],
    mobile: false,
    platform: "macOS",
    async getHighEntropyValues(hints: string[]) {
      return { platform: "macOS", architecture: "arm", hints };
    },
    toJSON() {
      return { brands: this.brands, mobile: this.mobile };
    },
  };

  const proxy = createStealthUserAgentData(mockUaData);

  assert.deepEqual(proxy.brands, [
    { brand: "Chrome", version: "131" },
    { brand: "Chromium", version: "131" },
    { brand: "Not_A Brand", version: "24" },
  ]);
  assert.equal(proxy.mobile, false);
  assert.equal(proxy.platform, "macOS");
  assert.equal(typeof proxy.getHighEntropyValues, "function");

  const entropy = await proxy.getHighEntropyValues?.(["architecture"]);
  assert.deepEqual(entropy, { platform: "macOS", architecture: "arm", hints: ["architecture"] });
  assert.deepEqual(proxy.toJSON?.(), { brands: proxy.brands, mobile: false });
});

