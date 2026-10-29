import assert from "node:assert/strict";
import test from "node:test";
import { embedTexts, embedQuery, openAiEmbeddingsEnabled } from "./embeddings.ts";

test("embeddings SDK sends compatible requests and decodes/sorts responses without network", async (t) => {
  const oldKey = process.env.OPENAI_API_KEY;
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  });
  process.env.OPENAI_API_KEY = "test-only-fake-key";
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://api.openai.com/v1/embeddings");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("authorization"), "Bearer test-only-fake-key");
    requests.push(await request.json());
    const encoded = (values: number[]) => Buffer.from(new Float32Array(values).buffer).toString("base64");
    return Response.json({ object: "list", model: "text-embedding-3-small", usage: { prompt_tokens: 2, total_tokens: 2 }, data: requests.length === 1
      ? [{ object: "embedding", index: 1, embedding: encoded([3, 4]) }, { object: "embedding", index: 0, embedding: encoded([1, 2]) }]
      : [{ object: "embedding", index: 0, embedding: [5, 6] }] });
  });
  assert.deepEqual(await embedTexts(["first", "second"]), [[1, 2], [3, 4]]);
  assert.deepEqual(await embedQuery("query"), [5, 6]);
  assert.deepEqual(requests, [
    { model: "text-embedding-3-small", input: ["first", "second"], dimensions: 1536, encoding_format: "base64" },
    { model: "text-embedding-3-small", input: ["query"], dimensions: 1536, encoding_format: "base64" },
  ]);
  const fetchCount = requests.length;
  for (const key of ["", "your_openai_key_for_embeddings", "your_example"]) {
    process.env.OPENAI_API_KEY = key;
    assert.equal(openAiEmbeddingsEnabled(), false);
    await assert.rejects(embedTexts(["x"]), /OPENAI_API_KEY/);
  }
  assert.equal(requests.length, fetchCount);
});
