import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedJson, API_BODY_LIMITS } from "./request-json.ts";
import { paperAskSchema, testPatchSchema, quizSubmitSchema } from "./api-input-schemas.ts";
import { MAX_QUIZ_ANSWERS, MAX_QUIZ_ANSWER_LENGTH } from "./quiz-input-limits.ts";

function request(body: string | Uint8Array | ReadableStream<Uint8Array>, length?: string) {
  return new Request("http://localhost/input", {
    method: "POST", body: body instanceof Uint8Array ? new Uint8Array(body) : body,
    headers: length === undefined ? {} : { "content-length": length },
    // Node's Request requires duplex for streamed bodies.
    ...{ duplex: "half" },
  });
}

for (const [name, limit] of Object.entries(API_BODY_LIMITS)) {
  test(`${name}: exact byte boundary succeeds, one byte over rejects before JSON parsing`, async () => {
    const body = JSON.stringify({ value: "x".repeat(limit - 12) });
    assert.equal(Buffer.byteLength(body), limit);
    assert.equal((await readBoundedJson(request(body), limit)).ok, true);
    const result = await readBoundedJson(request(body + "!"), limit);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.response.status, 413);
      assert.deepEqual(await result.response.json(), { error: "リクエスト本文が大きすぎます" });
    }
  });
}

test("missing, invalid, and understated Content-Length never bypass the stream limit", async () => {
  for (const length of [undefined, "invalid", "-1", "1.5", "1e2", "0", "2", "999999999999999999999999999999"]) {
    const result = await readBoundedJson(request('"' + "x".repeat(1000) + '"', length), 20);
    assert.equal(result.ok, false, String(length));
    if (!result.ok) assert.equal(result.response.status, 413, String(length));
  }
});

test("oversized declared length rejects and cancels without reading", async () => {
  let pulled = false;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() { pulled = true; throw new Error("must not read"); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const result = await readBoundedJson(request(stream, "21"), 20);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 413);
  assert.equal(pulled, false);
  assert.equal(cancelled, true);
});

test("overflow cancels immediately, does not drain, and does not await cancellation", async () => {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls > 2) throw new Error("read past overflow");
      controller.enqueue(new Uint8Array(11));
    },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  }, { highWaterMark: 0 });
  const result = await readBoundedJson(request(stream), 20);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 413);
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("UTF-8 is counted in bytes and decoded across chunk boundaries", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ question: "日本語😀" }));
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(offset, ++offset));
    },
  });
  assert.deepEqual(await readBoundedJson(request(stream), bytes.length), {
    ok: true, data: { question: "日本語😀" },
  });
  const result = await readBoundedJson(request(bytes), bytes.length - 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 413);
});

test("malformed JSON, invalid UTF-8, empty and interrupted bodies return 400", async () => {
  const broken = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error("interrupted")); },
  });
  for (const body of ["", "{", "null trailing", new Uint8Array([34, 255, 34]), broken]) {
    const result = await readBoundedJson(request(body), 100);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 400);
  }
  const noBody = await readBoundedJson(new Request("http://localhost/input"), 100);
  assert.equal(noBody.ok, false);
  if (!noBody.ok) assert.equal(noBody.response.status, 400);
});

test("normal client payloads and worst-case escaped field maxima fit each body budget", async () => {
  const escaped = "\u0000"; // JSON encodes each code unit as six ASCII bytes.
  const cases = [
    [API_BODY_LIMITS.paperAsk, paperAskSchema, {
      question: escaped.repeat(4000),
      history: Array.from({ length: 6 }, () => ({ role: "user", content: escaped.repeat(4000) })),
    }],
    [API_BODY_LIMITS.testPatch, testPatchSchema, {
      title: escaped.repeat(200), description: escaped.repeat(2000), source_name: escaped.repeat(200),
      exam_department: escaped.repeat(120), exam_subject: escaped.repeat(120), exam_period: escaped.repeat(120),
      industries: Array(8).fill(escaped.repeat(120)), paper_authors: Array(24).fill(escaped.repeat(200)),
      publication_year: escaped.repeat(32), paper_venue: escaped.repeat(400), paper_doi: escaped.repeat(200),
      notebooklm_notebook_url: escaped.repeat(2048), scispace_project_url: escaped.repeat(2048),
    }],
    [API_BODY_LIMITS.quizSubmit, quizSubmitSchema, {
      answers: Object.fromEntries(Array.from({ length: MAX_QUIZ_ANSWERS }, (_, i) => [
        `${i}${escaped.repeat(125)}`, escaped.repeat(MAX_QUIZ_ANSWER_LENGTH),
      ])),
    }],
  ] as const;
  for (const [limit, schema, input] of cases) {
    const result = await readBoundedJson(request(JSON.stringify(input)), limit);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(schema.safeParse(result.data).success, true);
  }
  for (const input of [{ answers: {} }, { answers: { q1: 0, e1: "日本語の回答" } }]) {
    const result = await readBoundedJson(request(JSON.stringify(input)), API_BODY_LIMITS.quizSubmit);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(quizSubmitSchema.safeParse(result.data).success, true);
  }
});
