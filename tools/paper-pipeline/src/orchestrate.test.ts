import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkerSpawn } from "./orchestrate.ts";

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
