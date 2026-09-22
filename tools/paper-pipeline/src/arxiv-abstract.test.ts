import { test } from "node:test";
import assert from "node:assert/strict";
import { arxivIdFromFilename, parseArxivAtomAuthors, parseArxivAtomSummary, parseArxivAtomTitle, parseArxivAtomYear } from "./arxiv-abstract.ts";

test("arxivIdFromFilename: 新形式 ID だけを取る", () => {
  assert.equal(arxivIdFromFilename("0709.2257v2.pdf"), "0709.2257");
  assert.equal(arxivIdFromFilename("2410.15269v1.pdf"), "2410.15269");
  assert.equal(arxivIdFromFilename("819_1_5.0150209.pdf"), "");
  assert.equal(arxivIdFromFilename("hawking.pdf"), "");
});

test("parseArxivAtomAuthors: author/name を列挙する", () => {
  const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <published>2016-01-08T19:00:00Z</published>
    <author><name>S. W. Hawking</name></author>
    <author><name>Malcolm J. Perry</name></author>
    <author><name>Andrew Strominger</name></author>
    <summary>Soft hair on black holes.</summary>
    <title>Soft Hair on Black Holes</title>
  </entry>
</feed>`;
  assert.deepEqual(parseArxivAtomAuthors(xml), ["S. W. Hawking", "Malcolm J. Perry", "Andrew Strominger"]);
  assert.equal(parseArxivAtomYear(xml), "2016");
  assert.equal(parseArxivAtomTitle(xml), "Soft Hair on Black Holes");
});

test("parseArxivAtomSummary: summary 要素を平文にする", () => {
  const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <summary>
      Schwarzschild's solution of Einstein's field equations in vacuum can be written in many different forms.
    </summary>
  </entry>
</feed>`;
  assert.match(parseArxivAtomSummary(xml), /Schwarzschild's solution of Einstein's field equations/);
});
