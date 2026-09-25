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
  const updates: { id: string; values: Record<string, unknown> }[] = [];
  return {
    updates,
    from: () => ({
      update: (values: Record<string, unknown>) => ({
        eq: async (_column: string, id: string) => {
          updates.push({ id, values });
          return {};
        },
      }),
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
  assert.equal(admin.updates.length, 1);
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
