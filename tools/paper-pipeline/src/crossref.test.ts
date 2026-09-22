import { test } from "node:test";
import assert from "node:assert/strict";
import { bibliographicPasteFromWork, parseCrossrefWork } from "./crossref.ts";
import { extractSciSpaceCardMeta, isDummySciSpacePaste, needsSciSpaceCardRecapture } from "./scispace-card.ts";

const boneJson = JSON.stringify({
  message: {
    DOI: "10.1016/j.bone.2015.04.014",
    title: ["Bone and skeletal muscle: Key players in mechanotransduction and potential overlapping mechanisms"],
    author: [
      { given: "Craig A.", family: "Goodman" },
      { given: "Troy A.", family: "Hornberger" },
      { given: "Alexander G.", family: "Robling" },
    ],
    "container-title": ["Bone"],
    issued: { "date-parts": [[2015, 11]] },
    "published-print": { "date-parts": [[2015, 11]] },
  },
});

test("parseCrossrefWork: Bone 論文の題名・著者・年・掲載を取る", () => {
  const work = parseCrossrefWork(boneJson);
  assert.ok(work);
  assert.match(work.title, /Bone and skeletal muscle/);
  assert.deepEqual(work.authors, ["Craig A. Goodman", "Troy A. Hornberger", "Alexander G. Robling"]);
  assert.equal(work.year, "2015");
  assert.equal(work.venue, "Bone");
  assert.equal(work.doi, "10.1016/j.bone.2015.04.014");
});

test("bibliographicPasteFromWork: Dewdney ではなく DOI の書誌になる", () => {
  const work = parseCrossrefWork(boneJson)!;
  const paste = bibliographicPasteFromWork("nihms690699.pdf", work);
  assert.equal(isDummySciSpacePaste(paste), false);
  const card = extractSciSpaceCardMeta(paste, "nihms690699.pdf");
  assert.match(card.title, /Bone and skeletal muscle/);
  assert.match(card.authors, /Craig A\. Goodman/);
  assert.match(card.authors, /Alexander G\. Robling/);
  assert.equal(card.publicationYear, "2015");
  assert.equal(card.venue, "Bone");
  assert.equal(
    needsSciSpaceCardRecapture({
      filename: "nihms690699.pdf",
      eduShareTestUrl: "http://localhost:3000/tests/x",
      filesPaste: paste,
    }),
    false,
  );
});
