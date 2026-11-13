import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function fixture(run: (root: string, module: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pipeline-log-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    const module = join(root, "src/log.ts");
    copyFileSync(new URL("./log.ts", import.meta.url), module);
    run(root, module);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function emit(module: string, destination?: string) {
  const env = { ...process.env };
  delete env.PAPER_PIPELINE_LOG_FILE;
  if (destination !== undefined) env.PAPER_PIPELINE_LOG_FILE = destination;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { log, warn, error, firstLine } from ${JSON.stringify(pathToFileURL(module).href)};
    log("hello"); warn("careful");
    error(firstLine(new Error("failed\\nCall log: cookie=private")));
  `], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test("default file follows module root, appends identical timestamped output and excludes Call log", () => {
  fixture((root, module) => {
    const file = join(root, "logs/pipeline.log");
    let expected = "";
    for (let i = 0; i < 2; i++) {
      const result = emit(module);
      expected += result.stdout + result.stderr;
      assert.match(result.stdout, /^\[\d{4}-[^\]]+\] hello\n$/);
      assert.match(result.stderr, /WARN careful\n.*ERROR failed\n$/s);
    }
    assert.equal(readFileSync(file, "utf8"), expected);
    assert.doesNotMatch(expected, /cookie|Call log|private/);
    // ビルド後と同じ dist/ 配置でも保存先を変えない。
    mkdirSync(join(root, "dist"));
    const built = join(root, "dist/log.ts");
    copyFileSync(module, built);
    const result = emit(built);
    assert.equal(readFileSync(file, "utf8"), expected + result.stdout + result.stderr);
  });
});

test("custom destination creates parents and off disables all file output", () => {
  fixture((root, module) => {
    const file = join(root, "custom/nested/run.log");
    const result = emit(module, file);
    assert.equal(readFileSync(file, "utf8"), result.stdout + result.stderr);
    const disabled = emit(module, "off");
    assert.match(disabled.stdout, /hello/);
    assert.match(disabled.stderr, /ERROR failed/);
    assert.equal(existsSync(join(root, "logs")), false);
  });
});

test("unwritable destination warns once without details and preserves subsequent output", () => {
  fixture((root, module) => {
    // ファイルを親ディレクトリにして、権限に依存しない書き込み失敗を作る。
    const blocker = join(root, "secret-path");
    writeFileSync(blocker, "unchanged");
    const result = emit(module, join(blocker, "run.log"));
    assert.equal(result.stderr.match(/ログファイルに書き込めません/g)?.length, 1);
    assert.match(result.stdout, /hello/);
    assert.match(result.stderr, /WARN careful\n.*ERROR failed\n$/s);
    assert.doesNotMatch(result.stderr, /secret-path|ENOTDIR|cookie/);
    assert.equal(readFileSync(blocker, "utf8"), "unchanged");
  });
});

test("scheduled wrapper disables child file output before invoking npm", () => {
  const script = readFileSync(new URL("../scripts/scheduled-run.sh", import.meta.url), "utf8");
  const setting = script.indexOf("export PAPER_PIPELINE_LOG_FILE=off");
  assert.ok(setting > 0);
  assert.ok(setting < script.indexOf("DECISION_ENV=$(npm"));
  assert.match(script, /npm start .*>> "\$LOG_FILE" 2>&1/);
});
