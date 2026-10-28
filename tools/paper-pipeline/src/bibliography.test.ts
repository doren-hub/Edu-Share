import assert from "node:assert/strict";
import test from "node:test";
import { titleHasPdfContinuation } from "./bibliography.ts";

// Entirely synthetic text: this table exercises the helper without browser,
// DOI lookup, PDF extraction, or the bibliography verification orchestrator.
const title = "Synthetic Robot Emulation Study";
const subtitle = "On the Basis of Synthetic Field Trials";
const narrative = "We compare synthetic robot systems.";
const author = "Alice Example, Bob Sample";

const cases = [
  { name: "complete title", suffix: "", expected: false },
  { name: "author line", suffix: author, expected: false },
  { name: "affiliation", suffix: "Institute for Synthetic Robotics", expected: false },
  { name: "prepositional subtitle", suffix: "In Synthetic Robotics", expected: true },
  { name: "tool subtitle (AgROS shape)", suffix: "Tool for Synthetic Robotics", expected: true },
  { name: "basis subtitle alone", suffix: subtitle, expected: true },
  { name: "unlabelled In this abstract", suffix: "In this study, we evaluate synthetic robots.", expected: false },
  { name: "unlabelled basis abstract on one line", suffix: `On the basis of synthetic trials, ${narrative}`, expected: false },
  { name: "unlabelled basis abstract wrapped before We", suffix: `On the basis of synthetic trials,\n${narrative}`, expected: false },
  { name: "unlabelled basis abstract wrapped within phrase", suffix: `On the basis\nof synthetic trials, ${narrative}`, expected: false },
  // Characterize the current two-following-line heuristic: an author line is
  // not a section boundary, so nearby present-tense prose still supplies context.
  { name: "basis subtitle then author then unlabelled We prose", suffix: `${subtitle}\n${author}\n${narrative}`, expected: false },
  // Optional tense expansion in #156 remains deferred. Ambiguous past-tense
  // openings are conservatively held for title verification today.
  { name: "past-tense we proposed", suffix: "On the basis of synthetic trials, we proposed a model.", expected: true },
  { name: "past-tense this study examined", suffix: "On the basis of synthetic trials, this study examined a model.", expected: true },
];

for (const heading of ["Abstract", "Keywords", "Introduction"]) {
  for (const boundary of ["\n", " "]) {
    cases.push({
      name: `basis subtitle before ${heading} (${boundary === "\n" ? "new line" : "same line"})`,
      suffix: `${subtitle}\n${heading}${boundary}${narrative}`,
      expected: true,
    });
    cases.push({
      name: `author before ${heading} (${boundary === "\n" ? "new line" : "same line"})`,
      suffix: `${subtitle}\n${author}\n${heading}${boundary}${narrative}`,
      expected: true,
    });
  }
  cases.push({ name: `${heading} immediately after title`, suffix: `${heading}\n${narrative}`, expected: false });
}

for (const entry of cases) {
  for (const separator of ["\n", " "]) {
    for (const uppercase of [false, true]) {
      const pdf = `${title}${separator}${entry.suffix}`;
      test(`titleHasPdfContinuation: ${entry.name}; title ${separator === "\n" ? "new line" : "same line"}; ${uppercase ? "uppercase" : "original case"}`, () => {
        assert.equal(titleHasPdfContinuation(title, uppercase ? pdf.toUpperCase() : pdf), entry.expected);
      });
    }
  }
}

test("titleHasPdfContinuation: CRLF and blank lines preserve subtitle detection", () => {
  assert.equal(titleHasPdfContinuation(title, `${title}\r\n\r\n${subtitle}\r\nAbstract`), true);
});

test("titleHasPdfContinuation: short and unrelated candidates provide no evidence", () => {
  assert.equal(titleHasPdfContinuation("Short", "Short\nTool for Synthetic Robotics"), false);
  assert.equal(titleHasPdfContinuation(title, "Unrelated Synthetic Title\nTool for Synthetic Robotics"), false);
});
