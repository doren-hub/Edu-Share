import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import ts from "typescript";
import * as config from "./anthropic-config.ts";
import type * as Quiz from "./claude-quiz.ts";
import type * as LlmText from "./llm-text.ts";

// Node's test runner has no Next.js path aliases. Replace only quiz helpers
// unrelated to these API requests; use the real SDK and shared model config.
function loadModule(path: string, fetch: typeof globalThis.fetch) {
  const require = createRequire(import.meta.url);
  const { outputText } = ts.transpileModule(
    readFileSync(new URL(path, import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
  );
  const exports = {};
  new Function("exports", "require", outputText)(exports, (name: string) => {
    if (name === "@anthropic-ai/sdk") {
      return class extends Anthropic {
        constructor(options: ConstructorParameters<typeof Anthropic>[0]) {
          super({ ...options, fetch });
        }
      };
    }
    if (name === "./anthropic-config.ts") return config;
    if (name === "@/lib/notebooklm-csv") return { csvMcHintTextForStripClient: () => undefined };
    if (name === "@/lib/source-excerpt") return { excerptAppearsInJoined: () => true };
    return require(name);
  });
  return exports;
}

test("quiz generation, grading and text requests share the model override without sampling parameters", async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of ["ANTHROPIC_MODEL", "ANTHROPIC_API_KEY", "LLM_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only";
  process.env.LLM_PROVIDER = "anthropic";
  const requests: Record<string, unknown>[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://api.anthropic.com/v1/messages");
    requests.push(await request.json());
    return Response.json({
      id: "test", type: "message", role: "assistant", model: requests.at(-1)!.model,
      content: [{ type: "text", text: requests.length % 3 === 2 ? '{"score":8,"comment":"ok"}' : "[]" }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  const quiz = loadModule("./claude-quiz.ts", fetch) as typeof Quiz;
  const { generateLlmText } = loadModule("./llm-text.ts", fetch) as typeof LlmText;
  for (const override of [undefined, " claude-opus-5-5 "]) {
    if (override === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = override;
    assert.deepEqual(await quiz.generateQuizFromContext({ contextChunks: [], documentType: "paper", nonce: "test" }), []);
    const grade = await quiz.gradeWithClaude({
      questions: [{ id: "e1", type: "essay", prompt: "test", referenceAnswer: "test" }],
      answers: { e1: "test" },
    });
    assert.equal(grade.scoreEssay, 80);
    assert.equal(await generateLlmText({ user: "test", temperature: 0.2 }), "[]");
    for (const request of requests.slice(-3)) {
      assert.equal(request.model, override?.trim() || config.DEFAULT_ANTHROPIC_MODEL);
      assert.equal(Object.hasOwn(request, "temperature"), false);
    }
  }
  assert.equal(requests.length, 6);
});
