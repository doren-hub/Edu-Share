import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isMainModule, resolveWorkerSpawn } from "./orchestrate.ts";

test("resolveWorkerSpawn: 事前変換済み JS (dist) で動くときは tsx を使わず node dist/cli.js を起動する", () => {
  const result = resolveWorkerSpawn(["--only", "paper.pdf", "--headless"], {
    metaUrl: "file:///path/to/tools/paper-pipeline/dist/orchestrate.js",
    distCliExists: true,
  });

  assert.equal(result.command, process.execPath);
  assert.equal(result.spawnArgs[0].endsWith("dist/cli.js"), true);
  assert.equal(result.spawnArgs.some((arg) => arg.includes("tsx")), false);
  assert.deepEqual(result.spawnArgs.slice(1), ["--only", "paper.pdf", "--headless"]);
});

test("resolveWorkerSpawn: TypeScript 実行時または dist が無いときは tsx src/cli.ts にフォールバックする", () => {
  const fromTs = resolveWorkerSpawn(["--only", "paper.pdf"], {
    metaUrl: "file:///path/to/tools/paper-pipeline/src/orchestrate.ts",
    distCliExists: true,
  });
  assert.equal(fromTs.command, process.execPath);
  assert.equal(fromTs.spawnArgs[0].endsWith("node_modules/tsx/dist/cli.mjs"), true);
  assert.equal(fromTs.spawnArgs[1].endsWith("src/cli.ts"), true);
  assert.deepEqual(fromTs.spawnArgs.slice(2), ["--only", "paper.pdf"]);

  const noDist = resolveWorkerSpawn(["--only", "paper.pdf"], {
    metaUrl: "file:///path/to/tools/paper-pipeline/dist/orchestrate.js",
    distCliExists: false,
  });
  assert.equal(noDist.command, process.execPath);
  assert.equal(noDist.spawnArgs[0].endsWith("node_modules/tsx/dist/cli.mjs"), true);
  assert.equal(noDist.spawnArgs[1].endsWith("src/cli.ts"), true);
});

test("resolveWorkerSpawn: 引数 opts を省略した場合も実行環境に応じて起動引数を返す", () => {
  const defaultSpawn = resolveWorkerSpawn(["--only", "test.pdf"]);
  assert.equal(defaultSpawn.command, process.execPath);
  assert.equal(defaultSpawn.spawnArgs.length >= 2, true);
  assert.equal(defaultSpawn.spawnArgs.includes("--only"), true);
  assert.equal(defaultSpawn.spawnArgs.includes("test.pdf"), true);
});

test("isMainModule: 直接実行時のみ真になり、別モジュールからのインポートや未定義では偽になる", () => {
  assert.equal(isMainModule(import.meta.url, null), false);
  assert.equal(isMainModule(import.meta.url, "/non/existent/path/file.js"), false);
  assert.equal(isMainModule(), false);
  assert.equal(isMainModule(import.meta.url, fileURLToPath(import.meta.url)), true);
});
