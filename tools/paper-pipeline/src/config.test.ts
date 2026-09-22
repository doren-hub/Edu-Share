import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgv, resolveHeaded } from "./config.ts";

test("parseArgv: --headless / --headed。後の引数が勝つ", () => {
  assert.equal(parseArgv([]).headed, undefined);
  assert.equal(parseArgv(["--headless"]).headed, false);
  assert.equal(parseArgv(["--headed"]).headed, true);
  assert.equal(parseArgv(["--headed", "--headless"]).headed, false);
  assert.equal(parseArgv(["--headless", "--headed"]).headed, true);
});

test("resolveHeaded: 引数が HEADLESS より優先。未指定は画面付き", () => {
  assert.equal(resolveHeaded({}), true);
  assert.equal(resolveHeaded({}, "1"), false);
  assert.equal(resolveHeaded({}, "true"), false);
  assert.equal(resolveHeaded({}, "0"), true);
  assert.equal(resolveHeaded({ headed: true }, "1"), true);
  assert.equal(resolveHeaded({ headed: false }), false);
});
