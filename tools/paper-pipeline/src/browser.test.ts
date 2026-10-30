import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStealthUserAgentMetadata,
  chromeLaunchArgs,
  cleanHeadlessBrands,
  cleanHeadlessUserAgent,
  createStealthUserAgentData,
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

test("createStealthUserAgentData: 組み込み getter / メソッドと同様に private フィールドを持つクラスでも Illegal invocation にならない", async () => {
  class NativeNavigatorUADataSimulator {
    #platform: string;
    #mobile: boolean;
    brands: Array<{ brand: string; version: string }>;

    constructor() {
      this.#platform = "macOS";
      this.#mobile = false;
      this.brands = [
        { brand: "HeadlessChrome", version: "131" },
        { brand: "Chromium", version: "131" },
      ];
    }

    get platform(): string {
      return this.#platform;
    }

    get mobile(): boolean {
      return this.#mobile;
    }

    async getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>> {
      return { platform: this.#platform, hints };
    }

    toJSON(): Record<string, unknown> {
      return { platform: this.#platform, mobile: this.#mobile };
    }
  }

  const nativeSimulator = new NativeNavigatorUADataSimulator();
  const proxy = createStealthUserAgentData(nativeSimulator);

  assert.deepEqual(proxy.brands, [
    { brand: "Chrome", version: "131" },
    { brand: "Chromium", version: "131" },
  ]);
  assert.equal(proxy.platform, "macOS");
  assert.equal(proxy.mobile, false);
  const entropy = await proxy.getHighEntropyValues?.(["arch"]);
  assert.deepEqual(entropy, { platform: "macOS", hints: ["arch"] });
  assert.deepEqual(proxy.toJSON?.(), {
    platform: "macOS",
    mobile: false,
    brands: [
      { brand: "Chrome", version: "131" },
      { brand: "Chromium", version: "131" },
    ],
  });
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



