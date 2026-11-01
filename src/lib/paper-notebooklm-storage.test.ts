import { test } from "node:test";
import assert from "node:assert/strict";
import type { ObjectMetadata } from "./object-storage.ts";
import {
  r2ObjectExists,
  reconcilePaperMaterialObjectPaths,
  storagePathDirAndName,
} from "./paper-notebooklm-storage.ts";

test("storagePathDirAndName: 2階層パスを分ける", () => {
  assert.deepEqual(
    storagePathDirAndName("user/abc-notebooklm-slide.pdf"),
    { dir: "user", name: "abc-notebooklm-slide.pdf" },
  );
  assert.equal(storagePathDirAndName(""), null);
  assert.equal(storagePathDirAndName("nofilename/"), null);
});

function metadataReader(files: Record<string, number>, shouldFail = false) {
  return async (key: string): Promise<ObjectMetadata> => {
    if (shouldFail) throw new Error("R2 unavailable");
    const size = files[key];
    return size == null
      ? { exists: false, size: null, contentType: null }
      : { exists: true, size, contentType: null };
  };
}

function mockAdmin() {
  const updates: { id: string; values: Record<string, unknown>; guard: [string, unknown] }[] = [];
  return {
    updates,
    from: () => ({
      update: (values: Record<string, unknown>) => {
        let id: string;
        let guard: [string, unknown];
        const query = {
          eq: (column: string, value: string) => { if (column === "id") id = value; else guard = [column, value]; return query; },
          is: (column: string, value: null) => { guard = [column, value]; return query; },
          then: (resolve: (result: object) => unknown) => { updates.push({ id, values, guard }); return Promise.resolve({}).then(resolve); },
        };
        return query;
      },
    }),
  };
}

test("r2ObjectExists: 元PDFと同じサイズのスライドは偽物", async () => {
  const readMetadata = metadataReader({
    "u/t.pdf": 80_000,
    "u/t-notebooklm-slide.pdf": 80_000,
  });
  assert.equal(
    await r2ObjectExists("u/t-notebooklm-slide.pdf", {
      kind: "slide",
      originalPdfPath: "u/t.pdf",
      readMetadata,
    }),
    false,
  );
});

test("reconcile: R2にある資料キーをDBへ戻す", async () => {
  const admin = mockAdmin();
  const [row] = await reconcilePaperMaterialObjectPaths(
    admin,
    [
      {
        id: "abc",
        uploaded_by: "u",
        pdf_storage_path: "u/abc.pdf",
        notebooklm_slide_pdf_storage_path: null,
        notebooklm_video_mp4_storage_path: null,
      },
    ],
    metadataReader({
      "u/abc.pdf": 50_000,
      "u/abc-notebooklm-slide.pdf": 200_000,
      "u/abc-notebooklm-video.mp4": 400_000,
    }),
  );
  assert.equal(row.notebooklm_slide_pdf_storage_path, "u/abc-notebooklm-slide.pdf");
  assert.equal(row.notebooklm_video_mp4_storage_path, "u/abc-notebooklm-video.mp4");
  assert.equal(admin.updates.length, 2);
  assert.ok(admin.updates.every(update => update.guard[1] === null));
});

test("reconcile: R2で欠落した資料キーを外す", async () => {
  const [row] = await reconcilePaperMaterialObjectPaths(
    mockAdmin(),
    [
      {
        id: "abc",
        uploaded_by: "u",
        pdf_storage_path: "u/abc.pdf",
        notebooklm_slide_pdf_storage_path: "u/abc-notebooklm-slide.pdf",
        notebooklm_video_mp4_storage_path: "u/abc-notebooklm-video.mp4",
      },
    ],
    metadataReader({ "u/abc.pdf": 50_000 }),
  );
  assert.equal(row.notebooklm_slide_pdf_storage_path, null);
  assert.equal(row.notebooklm_video_mp4_storage_path, null);
});

test("reconcile: R2確認失敗時は既存キーを残す", async () => {
  const [row] = await reconcilePaperMaterialObjectPaths(
    mockAdmin(),
    [
      {
        id: "abc",
        uploaded_by: "u",
        notebooklm_slide_pdf_storage_path: "u/abc-notebooklm-slide.pdf",
        notebooklm_video_mp4_storage_path: "u/abc-notebooklm-video.mp4",
      },
    ],
    metadataReader({}, true),
  );
  assert.equal(row.notebooklm_slide_pdf_storage_path, "u/abc-notebooklm-slide.pdf");
  assert.equal(row.notebooklm_video_mp4_storage_path, "u/abc-notebooklm-video.mp4");
});

const immutableSlide = "u/abc-notebooklm-slide-11111111-1111-4111-8111-111111111111.pdf";
const immutableVideo = "u/abc-notebooklm-video-11111111-1111-4111-8111-111111111111.mp4";

test("reconcile: retains committed immutable paths even if fixed paths are absent", async () => {
  const admin = mockAdmin();
  const input = { id: "abc", uploaded_by: "u", pdf_storage_path: "u/abc.pdf",
    notebooklm_slide_pdf_storage_path: immutableSlide, notebooklm_video_mp4_storage_path: immutableVideo };
  const [row] = await reconcilePaperMaterialObjectPaths(admin, [input], metadataReader({
    "u/abc.pdf": 50_000, [immutableSlide]: 200_000, [immutableVideo]: 400_000,
  }));
  assert.deepEqual(row, input);
  assert.equal(admin.updates.length, 0);
});

test("reconcile: does not overwrite unknown nonempty paths", async () => {
  const admin = mockAdmin();
  const input = { id: "abc", uploaded_by: "u", notebooklm_slide_pdf_storage_path: "u/custom.pdf", notebooklm_video_mp4_storage_path: "u/custom.mp4" };
  const [row] = await reconcilePaperMaterialObjectPaths(admin, [input], metadataReader({
    "u/abc-notebooklm-slide.pdf": 200_000, "u/abc-notebooklm-video.mp4": 400_000,
  }));
  assert.deepEqual(row, input);
  assert.equal(admin.updates.length, 0);
});

test("reconcile: clearing a missing immutable path is guarded against a concurrent replacement", async () => {
  const admin = mockAdmin();
  await reconcilePaperMaterialObjectPaths(admin, [{ id: "abc", uploaded_by: "u",
    notebooklm_slide_pdf_storage_path: immutableSlide, notebooklm_video_mp4_storage_path: immutableVideo,
  }], metadataReader({}));
  assert.deepEqual(admin.updates.map(update => update.guard), [
    ["notebooklm_slide_pdf_storage_path", immutableSlide], ["notebooklm_video_mp4_storage_path", immutableVideo],
  ]);
});
