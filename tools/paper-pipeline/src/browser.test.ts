import { test } from "node:test";
import assert from "node:assert/strict";
import { chromeLaunchArgs } from "./browser.ts";

test("chromeLaunchArgs: ヘッドレスでは --headless=new を付ける", () => {
  const headed = chromeLaunchArgs({ headed: true, exportExtensionPath: "" });
  const headless = chromeLaunchArgs({ headed: false, exportExtensionPath: "/ext" });
  assert.equal(headed.includes("--headless=new"), false);
  assert.equal(headless.includes("--headless=new"), true);
  assert.equal(headless.includes("--load-extension=/ext"), true);
  assert.equal(headed.includes("--load-extension="), false);
});
