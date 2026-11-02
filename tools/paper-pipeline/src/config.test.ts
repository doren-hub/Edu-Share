import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseArgv, parseRequiredPercent, resolveHeaded } from "./config.ts";

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

test("parseArgv: --exit-on-quota", () => {
  assert.equal(parseArgv([]).exitOnQuota, undefined);
  assert.equal(parseArgv(["--exit-on-quota"]).exitOnQuota, true);
});

test("parseArgv: --max-waiting-minutes / --waiting-timeout-minutes", () => {
  assert.equal(parseArgv([]).maxWaitingMinutes, undefined);
  assert.equal(parseArgv(["--max-waiting-minutes", "45"]).maxWaitingMinutes, 45);
  assert.equal(parseArgv(["--waiting-timeout-minutes", "30"]).maxWaitingMinutes, 30);
});

test("parseArgv: --no-reveal-login", () => {
  assert.equal(parseArgv([]).noRevealLogin, undefined);
  assert.equal(parseArgv(["--no-reveal-login"]).noRevealLogin, true);
});

test("loadConfig: noRevealLogin は引数または環境変数 NO_REVEAL_LOGIN=1 を反映する", () => {
  const prev = process.env.NO_REVEAL_LOGIN;
  try {
    delete process.env.NO_REVEAL_LOGIN;
    const def = loadConfig({ inbox: "/tmp/inbox", work: "/tmp/work" });
    assert.equal(def.noRevealLogin, false);

    const flag = loadConfig({ inbox: "/tmp/inbox", work: "/tmp/work", noRevealLogin: true });
    assert.equal(flag.noRevealLogin, true);

    process.env.NO_REVEAL_LOGIN = "1";
    const env1 = loadConfig({ inbox: "/tmp/inbox", work: "/tmp/work" });
    assert.equal(env1.noRevealLogin, true);
  } finally {
    if (prev !== undefined) process.env.NO_REVEAL_LOGIN = prev;
    else delete process.env.NO_REVEAL_LOGIN;
  }
});

test("loadConfig: exitOnQuota は引数または環境変数 NOTEBOOK_EXIT_ON_QUOTA=1 を反映する", () => {
  const prevEnv = process.env.NOTEBOOK_EXIT_ON_QUOTA;
  try {
    delete process.env.NOTEBOOK_EXIT_ON_QUOTA;
    const cfgDefault = loadConfig({ inbox: "/tmp/inbox", work: "/tmp/work" });
    assert.equal(cfgDefault.exitOnQuota, false);

    const cfgFlag = loadConfig({ inbox: "/tmp/inbox", work: "/tmp/work", exitOnQuota: true });
    assert.equal(cfgFlag.exitOnQuota, true);

    process.env.NOTEBOOK_EXIT_ON_QUOTA = "1";
    const cfgEnv1 = loadConfig({ inbox: "/tmp/inbox", work: "/tmp/work" });
    assert.equal(cfgEnv1.exitOnQuota, true);

    process.env.NOTEBOOK_EXIT_ON_QUOTA = "true";
    const cfgEnvTrue = loadConfig({ inbox: "/tmp/inbox", work: "/tmp/work" });
    assert.equal(cfgEnvTrue.exitOnQuota, true);

    process.env.NOTEBOOK_EXIT_ON_QUOTA = "0";
    const cfgEnv0 = loadConfig({ inbox: "/tmp/inbox", work: "/tmp/work" });
    assert.equal(cfgEnv0.exitOnQuota, false);
  } finally {
    if (prevEnv !== undefined) {
      process.env.NOTEBOOK_EXIT_ON_QUOTA = prevEnv;
    } else {
      delete process.env.NOTEBOOK_EXIT_ON_QUOTA;
    }
  }
});

test("loadConfig: maxWaitingMinutes は exitOnQuota 時は既定 60、手動時は既定 0、引数や環境変数を反映", () => {
  const prevEnv = process.env.PAPER_MAX_WAITING_MINUTES;
  try {
    delete process.env.PAPER_MAX_WAITING_MINUTES;
    delete process.env.WAITING_TIMEOUT_MINUTES;

    // 手動実行（exitOnQuota=false）は既定 0（無効）
    const cfgManual = loadConfig({ inbox: "/tmp/inbox", work: "/tmp/work" });
    assert.equal(cfgManual.maxWaitingMinutes, 0);

    // exitOnQuota=true のときは既定 60 分
    const cfgQuota = loadConfig({ inbox: "/tmp/inbox", work: "/tmp/work", exitOnQuota: true });
    assert.equal(cfgQuota.maxWaitingMinutes, 60);

    // 引数による明示指定（30 分）
    const cfgExplicit = loadConfig({ inbox: "/tmp/inbox", work: "/tmp/work", exitOnQuota: true, maxWaitingMinutes: 30 });
    assert.equal(cfgExplicit.maxWaitingMinutes, 30);

    // 引数で 0 を指定して無効化
    const cfgDisabled = loadConfig({ inbox: "/tmp/inbox", work: "/tmp/work", exitOnQuota: true, maxWaitingMinutes: 0 });
    assert.equal(cfgDisabled.maxWaitingMinutes, 0);

    // 環境変数 PAPER_MAX_WAITING_MINUTES
    process.env.PAPER_MAX_WAITING_MINUTES = "45";
    const cfgEnv = loadConfig({ inbox: "/tmp/inbox", work: "/tmp/work" });
    assert.equal(cfgEnv.maxWaitingMinutes, 45);
  } finally {
    if (prevEnv !== undefined) process.env.PAPER_MAX_WAITING_MINUTES = prevEnv;
    else delete process.env.PAPER_MAX_WAITING_MINUTES;
  }
});

