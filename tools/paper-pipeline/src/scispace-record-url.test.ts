import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalSciSpaceRecordUrl,
  isSciSpaceFolderUrl,
  isSciSpaceRecordUrl,
  pickSciSpaceRecordUrl,
} from "./scispace-record-url.ts";

test("isSciSpaceRecordUrl: /records/ だけを個別ページとみなす", () => {
  assert.equal(
    isSciSpaceRecordUrl("https://scispace.com/records/2403-17271v1-pdf-ih26ifq7"),
    true,
  );
  assert.equal(isSciSpaceRecordUrl("https://scispace.com/folder/notebooks-enu289ww"), false);
  assert.equal(isSciSpaceRecordUrl("https://scispace.com/papers/foo"), false);
});

test("isSciSpaceFolderUrl", () => {
  assert.equal(isSciSpaceFolderUrl("https://scispace.com/folder/notebooks-enu289ww"), true);
  assert.equal(
    isSciSpaceFolderUrl("https://scispace.com/records/2403-17271v1-pdf-ih26ifq7"),
    false,
  );
});

test("canonicalSciSpaceRecordUrl: クエリを落とす", () => {
  assert.equal(
    canonicalSciSpaceRecordUrl(
      "https://scispace.com/records/2403-17271v1-pdf-ih26ifq7?ref=folder",
    ),
    "https://scispace.com/records/2403-17271v1-pdf-ih26ifq7",
  );
});

test("pickSciSpaceRecordUrl: ファイル名のドットをハイフンにした slug で選ぶ", () => {
  const url = pickSciSpaceRecordUrl(
    [
      { href: "https://scispace.com/folder/notebooks-enu289ww", text: "folder" },
      { href: "https://scispace.com/records/other-paper-pdf-aaaa", text: "other" },
      {
        href: "https://scispace.com/records/2403-17271v1-pdf-ih26ifq7",
        text: "2403.17271v1.pdf",
        row: "Galaxy spin 2403.17271v1.pdf",
      },
    ],
    "2403.17271v1.pdf",
  );
  assert.equal(url, "https://scispace.com/records/2403-17271v1-pdf-ih26ifq7");
});

test("pickSciSpaceRecordUrl: hawking のような短い stem も行テキストから取る", () => {
  const url = pickSciSpaceRecordUrl(
    [
      {
        href: "https://scispace.com/records/hawking-pdf-xyz123",
        row: "hawking.pdf BLACK HOLES AREN'T BLACK",
      },
    ],
    "hawking.pdf",
  );
  assert.equal(url, "https://scispace.com/records/hawking-pdf-xyz123");
});
