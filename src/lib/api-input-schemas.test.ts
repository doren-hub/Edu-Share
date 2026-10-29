import assert from "node:assert/strict";
import test from "node:test";
import {
  uuidSchema, testPatchSchema, paperAskSchema, startBodySchema,
  uploadFormSchema, picklistPostSchema, quizSubmitSchema,
  bookmarkItemSchema, studyStatusSchema,
} from "./api-input-schemas.ts";
import { MAX_INDUSTRIES } from "./paper-industries.ts";

const id = "123e4567-e89b-42d3-a456-426614174000";
const cases = [
  ["UUID", uuidSchema, id, "invalid"],
  ["test PATCH", testPatchSchema, { title: "Paper", description: null, paper_authors: ["Author"], industries: ["IT"] }, {}],
  ["ask", paperAskSchema, { question: "  Why?  ", history: [{ role: "assistant", content: "  text  " }] }, { question: " " }],
  ["start", startBodySchema, { reuseQuestionsFromSessionId: id, pickRandomPastSession: false, pickReviewMistakesSession: true, reviewMistakesScope: "csv", useNotebookLmCsvPool: true, notebookLmCsvPool: "vocab" }, { notebookLmCsvPool: "unknown" }],
  ["upload", uploadFormSchema, { title: " Paper ", document_type: "paper" }, { title: "x", document_type: "unknown" }],
  ["picklist", picklistPostSchema, { category: "school_name", value: " School " }, { category: "invalid", value: "x" }],
  ["quiz", quizSubmitSchema, { answers: { [id]: 1, other: "text" } }, { answers: { [id]: true } }],
  ["bookmark item", bookmarkItemSchema, { testId: id, inList: true }, { testId: "invalid", inList: true }],
  ["study status", studyStatusSchema, { status: "reading" }, { status: 1 }],
] as const;

for (const [name, schema, valid, invalid] of cases) {
  test(`${name}: valid input succeeds and invalid input exposes issues/flatten`, () => {
    assert.equal(schema.safeParse(valid).success, true);
    for (const value of [invalid, null, []]) {
      const result = schema.safeParse(value);
      assert.equal(result.success, false);
      if (!result.success) {
        assert.ok(result.error.issues.length > 0);
        assert.ok(result.error.flatten());
      }
    }
  });
}

test("trim, unknown-key stripping, optional and nullable semantics remain intact", () => {
  assert.deepEqual(paperAskSchema.parse({ question: " q ", extra: true }), { question: "q" });
  assert.deepEqual(uploadFormSchema.parse({ title: " t ", document_type: "paper" }), { title: "t", document_type: "paper" });
  assert.equal(testPatchSchema.safeParse({ description: null, exam_period: null }).success, true);
  assert.equal(testPatchSchema.safeParse({ title: null }).success, false);
  assert.equal(testPatchSchema.safeParse({ unknown: 1 }).success, false);
  assert.deepEqual(startBodySchema.parse({}), {});
  assert.deepEqual(quizSubmitSchema.parse({ answers: {} }), { answers: {} });
});

test("picklist custom issues preserve school/department scope rules", () => {
  for (const category of ["exam_subject", "exam_period", "department_name"]) {
    const result = picklistPostSchema.safeParse({ category, value: "x" });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.error.issues.some((issue) => issue.code === "custom"));
      assert.ok(result.error.flatten().fieldErrors.scope_school_name);
    }
    assert.equal(picklistPostSchema.safeParse({ category, value: "x", scope_school_name: "School", ...(category === "department_name" ? {} : { scope_department_value: "Dept" }) }).success, true);
  }
  assert.equal(picklistPostSchema.safeParse({ category: "school_name", value: "x", scope_school_name: "School" }).success, false);
  assert.equal(picklistPostSchema.safeParse({ category: "department_name", value: "x", scope_school_name: "School", scope_department_value: "Dept" }).success, false);
});

test("all PATCH string fields enforce their existing limits", () => {
  const limits = { title: 200, description: 2000, source_name: 200, exam_department: 120, exam_subject: 120, exam_period: 120, publication_year: 32, paper_venue: 400, paper_doi: 200, notebooklm_notebook_url: 2048, scispace_project_url: 2048 };
  for (const [field, limit] of Object.entries(limits)) {
    assert.equal(testPatchSchema.safeParse({ [field]: "x".repeat(limit) }).success, true, field);
    assert.equal(testPatchSchema.safeParse({ [field]: "x".repeat(limit + 1) }).success, false, field);
  }
});

for (const [field, max, element, validElement] of [
  ["history", 6, { role: "user", content: "x" }, { role: "user", content: "x" }],
  ["industries", MAX_INDUSTRIES, "x", "x"],
  ["paper_authors", 24, "x", "x"],
] as const) {
  const schema = field === "history" ? paperAskSchema : testPatchSchema;
  const body = (value: unknown) => field === "history" ? { question: "q", [field]: value } : { [field]: value };
  test(`${field}: boundary, invalid elements, and oversized arrays have bounded validation cost`, () => {
    assert.equal(schema.safeParse(body(Array(max).fill(validElement))).success, true);
    assert.equal(schema.safeParse(body([null])).success, false);
    assert.equal(schema.safeParse(body("not an array")).success, false);
    for (const length of [max + 1, 10_000_000]) {
      const array = new Array(length);
      // Throw on any element access: rejection must depend only on length,
      // not on elapsed-time thresholds or allocating millions of bad issues.
      Object.defineProperty(array, "0", { get() { throw new Error("element was visited"); } });
      const result = schema.safeParse(body(array));
      assert.equal(result.success, false);
      if (!result.success) {
        assert.equal(result.error.issues.length, 1);
        assert.equal(result.error.issues[0].code, "too_big");
        assert.deepEqual(result.error.issues[0].path, [field]);
      }
    }
    assert.equal(schema.safeParse(body([element])).success, true);
  });
}

test("array item constraints and history roles still reject malformed bounded inputs", () => {
  for (const industries of [[""], ["x".repeat(121)], [42]]) assert.equal(testPatchSchema.safeParse({ industries }).success, false);
  for (const paper_authors of [[""], ["x".repeat(201)], [42]]) assert.equal(testPatchSchema.safeParse({ paper_authors }).success, false);
  for (const history of [[{ role: "system", content: "x" }], [{ role: "user", content: "x".repeat(4001) }]]) assert.equal(paperAskSchema.safeParse({ question: "q", history }).success, false);
  assert.equal(paperAskSchema.safeParse({ question: "x".repeat(4001) }).success, false);
});

test("upload string fields and enums preserve success/failure behavior", () => {
  const limits = { title: 200, description: 2000, school_name: 200, expert_name: 200, paper_venue: 400, paper_doi: 200, publication_year: 32, exam_department: 120, exam_subject: 120, exam_period: 120 };
  for (const [field, limit] of Object.entries(limits)) {
    const input = { title: "x", document_type: "past_exam" };
    assert.equal(uploadFormSchema.safeParse({ ...input, [field]: "x".repeat(limit) }).success, true, field);
    for (const value of ["x".repeat(limit + 1), null, 42]) {
      assert.equal(uploadFormSchema.safeParse({ ...input, [field]: value }).success, false, field);
    }
  }
  assert.equal(uploadFormSchema.safeParse({ title: " ", document_type: "paper" }).success, false);
  assert.equal(testPatchSchema.safeParse({ document_type: "invalid" }).success, false);
  for (const field of ["title", "source_name", "exam_department", "exam_subject", "exam_period"]) assert.equal(testPatchSchema.safeParse({ [field]: "" }).success, false, field);
});

test("start, quiz, bookmark and UUID schemas reject wrong field types", () => {
  for (const field of ["pickRandomPastSession", "pickReviewMistakesSession", "useNotebookLmCsvPool"]) assert.equal(startBodySchema.safeParse({ [field]: "true" }).success, false);
  assert.equal(startBodySchema.safeParse({ reuseQuestionsFromSessionId: "bad" }).success, false);
  assert.equal(startBodySchema.safeParse({ reviewMistakesScope: "bad" }).success, false);
  assert.equal(bookmarkItemSchema.safeParse({ testId: id, inList: 1 }).success, false);
  for (const answers of [[], null, { x: null }, { x: Infinity }, { x: NaN }]) assert.equal(quizSubmitSchema.safeParse({ answers }).success, false);
  for (const value of ["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff", id.toUpperCase()]) assert.equal(uuidSchema.safeParse(value).success, true);
  assert.deepEqual(paperAskSchema.parse({ question: " q ", history: [{ role: "user", content: " text " }] }), { question: "q", history: [{ role: "user", content: "text" }] });
});

test("quiz answers enforce count, key and essay boundaries before visiting oversized records", () => {
  const answers = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`q${i}`, "x".repeat(2000)]));
  assert.equal(quizSubmitSchema.safeParse({ answers }).success, true);
  Object.defineProperty(answers, "overflow", {
    enumerable: true, get() { throw new Error("oversized record values must not be visited"); },
  });
  const result = quizSubmitSchema.safeParse({ answers });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.length, 1);
  assert.equal(quizSubmitSchema.safeParse({ answers: { q: "x".repeat(2001) } }).success, false);
  assert.equal(quizSubmitSchema.safeParse({ answers: { ["k".repeat(128)]: "" } }).success, true);
  assert.equal(quizSubmitSchema.safeParse({ answers: { ["k".repeat(129)]: 0 } }).success, false);
});
