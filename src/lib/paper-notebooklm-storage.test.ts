import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dropMissingPaperMaterialStoragePaths,
  materialFileFromListing,
  paperMaterialPathIdsMissingFromListings,
  pdfsObjectExists,
  storageListingHasFile,
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

test("storageListingHasFile: 0バイトは無いものとして扱う", () => {
  assert.equal(
    storageListingHasFile([{ name: "a.pdf", metadata: { size: 0 } }], "a.pdf"),
    false,
  );
  assert.equal(
    storageListingHasFile([{ name: "a.pdf", metadata: { size: 12 } }], "a.pdf"),
    true,
  );
  assert.equal(storageListingHasFile([{ name: "b.pdf" }], "a.pdf"), false);
});

test("materialFileFromListing: 論文PDFと同じサイズはスライドとみなさない", () => {
  const files = [
    { name: "t.pdf", metadata: { size: 80_000 } },
    { name: "t-notebooklm-slide.pdf", metadata: { size: 80_000 } },
    { name: "t-notebooklm-video.mp4", metadata: { size: 400_000 } },
  ];
  assert.equal(
    materialFileFromListing(files, "t-notebooklm-slide.pdf", {
      minBytes: 1_000,
      notSameSizeAs: 80_000,
    }),
    false,
  );
  assert.equal(
    materialFileFromListing(files, "t-notebooklm-video.mp4", { minBytes: 20_000 }),
    true,
  );
});

test("missingFromListings: ファイル欠落は確定、listing 失敗は未確認", () => {
  const rows = [
    {
      id: "gone",
      notebooklm_slide_pdf_storage_path: "u/gone-notebooklm-slide.pdf",
      notebooklm_video_mp4_storage_path: "u/gone-notebooklm-video.mp4",
    },
    {
      id: "ok",
      notebooklm_slide_pdf_storage_path: "u/ok-notebooklm-slide.pdf",
      notebooklm_video_mp4_storage_path: "u/ok-notebooklm-video.mp4",
    },
    {
      id: "unknown",
      notebooklm_slide_pdf_storage_path: "other/x-notebooklm-slide.pdf",
      notebooklm_video_mp4_storage_path: null,
    },
  ];
  const filesByDir = new Map([
    [
      "u",
      [
        { name: "ok-notebooklm-slide.pdf", metadata: { size: 100 } },
        { name: "ok-notebooklm-video.mp4", metadata: { size: 100 } },
      ],
    ],
    ["other", null],
  ]);
  const { missingConfirmed, unconfirmed } = paperMaterialPathIdsMissingFromListings(
    rows,
    filesByDir,
  );
  assert.deepEqual(missingConfirmed.slideIds, ["gone"]);
  assert.deepEqual(missingConfirmed.videoIds, ["gone"]);
  assert.deepEqual(unconfirmed.slideIds, ["unknown"]);
  assert.deepEqual(unconfirmed.videoIds, []);
});

function mockAdmin(files: { name: string; size: number }[]) {
  const updates: { id: string; values: Record<string, unknown> }[] = [];
  return {
    updates,
    storage: {
      from: () => ({
        list: async () => ({
          data: files.map(({ name, size }) => ({ name, metadata: { size } })),
          error: null,
        }),
      }),
    },
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

test("pdfsObjectExists: ディレクトリに論文PDFしか無いスライドパスは無い", async () => {
  const exists = await pdfsObjectExists(
    mockAdmin([{ name: "208bf347-1cc4-4f4f-9df7-35928369c31f.pdf", size: 537_039 }]),
    "u/208bf347-1cc4-4f4f-9df7-35928369c31f-notebooklm-slide.pdf",
    { kind: "slide", originalPdfPath: "u/208bf347-1cc4-4f4f-9df7-35928369c31f.pdf" },
  );
  assert.equal(exists, false);
});

test("pdfsObjectExists: 論文PDFと同じサイズのスライドは偽物", async () => {
  const exists = await pdfsObjectExists(
    mockAdmin([
      { name: "t.pdf", size: 80_000 },
      { name: "t-notebooklm-slide.pdf", size: 80_000 },
    ]),
    "u/t-notebooklm-slide.pdf",
    { kind: "slide", originalPdfPath: "u/t.pdf" },
  );
  assert.equal(exists, false);
});

test("pdfsObjectExists: 別サイズのスライドと十分な動画は有り", async () => {
  const admin = mockAdmin([
    { name: "t.pdf", size: 80_000 },
    { name: "t-notebooklm-slide.pdf", size: 120_000 },
    { name: "t-notebooklm-video.mp4", size: 400_000 },
  ]);
  const slide = await pdfsObjectExists(admin, "u/t-notebooklm-slide.pdf", {
    kind: "slide",
    originalPdfPath: "u/t.pdf",
  });
  const video = await pdfsObjectExists(admin, "u/t-notebooklm-video.mp4", {
    kind: "video",
  });
  assert.equal(slide, true);
  assert.equal(video, true);
});

test("dropMissing: 論文PDF以外が無い行はスライド・動画パスを外す", async () => {
  const [row] = await dropMissingPaperMaterialStoragePaths(
    mockAdmin([{ name: "abc.pdf", size: 50_000 }]),
    [
      {
        id: "abc",
        uploaded_by: "u",
        pdf_storage_path: "u/abc.pdf",
        notebooklm_slide_pdf_storage_path: "u/abc-notebooklm-slide.pdf",
        notebooklm_video_mp4_storage_path: "u/abc-notebooklm-video.mp4",
      },
    ],
  );
  assert.equal(row.notebooklm_slide_pdf_storage_path, null);
  assert.equal(row.notebooklm_video_mp4_storage_path, null);
});

test("dropMissing: listing にある実ファイルは DB パスが空でも戻す", async () => {
  const admin = mockAdmin([
    { name: "abc.pdf", size: 50_000 },
    { name: "abc-notebooklm-slide.pdf", size: 200_000 },
    { name: "abc-notebooklm-video.mp4", size: 400_000 },
  ]);
  const [row] = await dropMissingPaperMaterialStoragePaths(admin, [
    {
      id: "abc",
      uploaded_by: "u",
      pdf_storage_path: "u/abc.pdf",
      notebooklm_slide_pdf_storage_path: null,
      notebooklm_video_mp4_storage_path: null,
    },
  ]);
  assert.equal(row.notebooklm_slide_pdf_storage_path, "u/abc-notebooklm-slide.pdf");
  assert.equal(row.notebooklm_video_mp4_storage_path, "u/abc-notebooklm-video.mp4");
  assert.equal(admin.updates.length, 1);
  assert.equal(admin.updates[0]?.id, "abc");
});

test("dropMissing: listing 失敗時はパスを消さない", async () => {
  const admin = {
    storage: {
      from: () => ({
        list: async () => ({ data: null, error: { message: "fail" } }),
      }),
    },
    from: () => ({
      update: () => ({
        eq: async () => {
          throw new Error("should not persist");
        },
      }),
    }),
  };
  const [row] = await dropMissingPaperMaterialStoragePaths(admin, [
    {
      id: "abc",
      uploaded_by: "u",
      notebooklm_slide_pdf_storage_path: "u/abc-notebooklm-slide.pdf",
      notebooklm_video_mp4_storage_path: "u/abc-notebooklm-video.mp4",
    },
  ]);
  assert.equal(row.notebooklm_slide_pdf_storage_path, "u/abc-notebooklm-slide.pdf");
  assert.equal(row.notebooklm_video_mp4_storage_path, "u/abc-notebooklm-video.mp4");
});
