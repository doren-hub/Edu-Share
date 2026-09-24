import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgv, parseRequiredPercent, resolveHeaded } from "./config.ts";

test("parseArgv: --headless / --headed。後の引数が勝つ", () => {
  assert.equal(parseArgv([]).headed, undefined);
  assert.equal(parseArgv(["--headless"]).headed, false);
  assert.equal(parseArgv(["--headed"]).headed, true);
  assert.equal(parseArgv(["--headed", "--headless"]).headed, false);
  assert.equal(parseArgv(["--headless", "--headed"]).headed, true);
});

test("parseArgv: --notebook-short-stop-percent", () => {
  assert.equal(parseArgv([]).notebookShortStopPercent, undefined);
  assert.equal(parseArgv(["--notebook-short-stop-percent", "70"]).notebookShortStopPercent, 70);
  assert.equal(parseArgv(["--notebook-short-stop-percent", "70.5"]).notebookShortStopPercent, 70.5);
  assert.equal(parseArgv(["--notebook-short-stop-percent", "0"]).notebookShortStopPercent, 0);
  assert.equal(parseArgv(["--notebook-short-stop-percent", "100"]).notebookShortStopPercent, 100);
  assert.throws(
    () => parseArgv(["--notebook-short-stop-percent", "101"]),
    /0 以上 100 以下/,
  );
  assert.throws(() => parseArgv(["--notebook-short-stop-percent"]), /0 以上 100 以下/);
  assert.throws(() => parseRequiredPercent("--notebook-short-stop-percent", "x"), /0 以上 100 以下/);
});

test("resolveHeaded: 引数が HEADLESS より優先。未指定は画面付き", () => {
  assert.equal(resolveHeaded({}), true);
  assert.equal(resolveHeaded({}, "1"), false);
  assert.equal(resolveHeaded({}, "true"), false);
  assert.equal(resolveHeaded({}, "0"), true);
  assert.equal(resolveHeaded({ headed: true }, "1"), true);
  assert.equal(resolveHeaded({ headed: false }), false);
});
