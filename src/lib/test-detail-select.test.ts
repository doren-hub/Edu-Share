import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEST_DETAIL_SELECT_VARIANTS,
  looksLikeMissingColumnError,
  mergeLinkColumns,
  withOptionalMaterialFields,
} from "./test-detail-select.ts";

test("詳細 SELECT は pdf_filename を外しても URL 列を残す", () => {
  const withoutFilename = TEST_DETAIL_SELECT_VARIANTS[1];
  assert.match(withoutFilename, /notebooklm_notebook_url/);
  assert.match(withoutFilename, /scispace_project_url/);
  assert.doesNotMatch(withoutFilename, /pdf_filename/);
});

test("looksLikeMissingColumnError: pdf_filename 欠落で次の SELECT へ進む", () => {
  assert.equal(
    looksLikeMissingColumnError('column tests.pdf_filename does not exist'),
    true,
  );
});

test("mergeLinkColumns: admin の URL を正本にする", () => {
  const merged = mergeLinkColumns(
    { title: "x", notebooklm_notebook_url: null, scispace_project_url: null },
    {
      notebooklm_notebook_url: "https://notebook.google.com/notebook/abc",
      scispace_project_url: "https://scispace.com/records/x",
    },
  );
  assert.equal(merged.notebooklm_notebook_url, "https://notebook.google.com/notebook/abc");
  assert.equal(merged.scispace_project_url, "https://scispace.com/records/x");
});

test("withOptionalMaterialFields: 無い列は null", () => {
  const row = withOptionalMaterialFields({ id: "1", title: "t" });
  assert.equal(row.notebooklm_notebook_url, null);
  assert.equal(row.scispace_project_url, null);
});
