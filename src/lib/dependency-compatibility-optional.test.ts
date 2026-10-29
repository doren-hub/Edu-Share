import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Simulate an omitted optional package without changing node_modules or using
// the network. The hook is confined to each child process.
const hook = `
  import { registerHooks } from 'node:module';
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === 'sharp') throw new Error('simulated optional sharp unavailable');
    return nextResolve(specifier, context);
  } });
`;

for (const ci of [false, true]) {
  test(`sharp 不在時は ${ci ? "CI で失敗する" : "ローカルで理由付き skip になる"}`, () => {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: ci ? "true" : "" };
    // A fresh test runner must not inherit the parent's child-test marker.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      "--import", `data:text/javascript,${encodeURIComponent(hook)}`,
      "--test", "--test-reporter=tap", "--test-name-pattern=sharp",
      "src/lib/dependency-compatibility.test.ts",
    ], { env, encoding: "utf8", timeout: 30_000 });

    assert.ifError(result.error);
    assert.equal(result.status, ci ? 1 : 0, result.stdout + result.stderr);
    assert.match(result.stdout, /simulated optional sharp unavailable/);
    assert.match(result.stdout, ci ? /# fail 1/ : /# SKIP optional sharp could not be loaded/);
  });
}
