import assert from "node:assert/strict";
import test from "node:test";
import { anthropicModel, DEFAULT_ANTHROPIC_MODEL } from "./anthropic-config.ts";

test("Anthropic model defaults and environment overrides", (t) => {
  const original = process.env.ANTHROPIC_MODEL;
  t.after(() => {
    if (original === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = original;
  });

  assert.equal(DEFAULT_ANTHROPIC_MODEL, "claude-sonnet-5-5");
  delete process.env.ANTHROPIC_MODEL;
  assert.equal(anthropicModel(), DEFAULT_ANTHROPIC_MODEL);
  for (const value of ["", " ", "\t\n"]) {
    process.env.ANTHROPIC_MODEL = value;
    assert.equal(anthropicModel(), DEFAULT_ANTHROPIC_MODEL);
  }
  for (const value of ["claude-opus-5-5", " custom-model \n"]) {
    process.env.ANTHROPIC_MODEL = value;
    assert.equal(anthropicModel(), value.trim());
  }
});
