import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { unstable_doesMiddlewareMatch } = require("next/experimental/testing/server.js");
// Test the literal consumed by Next without importing auth clients or credentials.
const source = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");
const matcher = source.match(/matcher:\s*\[\s*"([^"]+)"/)?.[1];
assert.ok(matcher);
const config = { matcher: [JSON.parse(`"${matcher}"`)] };

test("bounded API routes bypass middleware cloning, other APIs and pages still refresh sessions", () => {
  for (const path of ["/api/papers/abc/ask", "/api/tests/abc", "/api/quiz/abc/submit"]) {
    for (const suffix of ["", "/", "?query=1"]) {
      assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: path + suffix }), false, path + suffix);
    }
  }
  for (const path of ["/tests/abc", "/api/tests/abc/start", "/api/tests/upload", "/api/papers/abc", "/api/quiz/abc", "/api/tests/abc/material/video/commit"]) {
    assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: path }), true, path);
  }
});
