import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dropMissingPaperMaterialStoragePaths,
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

const PDF_HEAD = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const VIDEO_HEAD = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);

function mockAdmin(names: string[]) {
  return {
    storage: {
      from: () => ({
        list: async () => ({
          data: names.map((name) => ({ name, metadata: { size: 50_000 } })),
          error: null,
        }),
        createSignedUrl: async (path: string) => ({
          data: { signedUrl: `https://cdn.example/${path}` },
          error: null,
        }),
      }),
    },
    from: () => ({
      update: () => ({
        in: async () => ({}),
      }),
    }),
  };
}

function installFetch(
  bodies: Record<string, { status: number; total: number; head: Uint8Array }>,
) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(bodies).find((k) => url.includes(k));
    const hit = key ? bodies[key] : undefined;
    if (!hit) {
      return new Response(null, { status: 404 });
    }
    return new Response(hit.head, {
      status: hit.status,
      headers: {
        "content-range": `bytes 0-${hit.head.length - 1}/${hit.total}`,
        "content-length": String(hit.head.length),
      },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

test("pdfsObjectExists: ディレクトリに論文PDFしか無いスライドパスは無い", async () => {
  const restore = installFetch({});
  try {
    const exists = await pdfsObjectExists(
      mockAdmin(["208bf347-1cc4-4f4f-9df7-35928369c31f.pdf"]),
      "u/208bf347-1cc4-4f4f-9df7-35928369c31f-notebooklm-slide.pdf",
      { kind: "slide", originalPdfPath: "u/208bf347-1cc4-4f4f-9df7-35928369c31f.pdf" },
    );
    assert.equal(exists, false);
  } finally {
    restore();
  }
});

test("pdfsObjectExists: 論文PDFと同じサイズのスライドは偽物", async () => {
  const restore = installFetch({
    "u/t-notebooklm-slide.pdf": { status: 206, total: 80_000, head: PDF_HEAD },
    "u/t.pdf": { status: 206, total: 80_000, head: PDF_HEAD },
  });
  try {
    const exists = await pdfsObjectExists(
      mockAdmin(["t.pdf", "t-notebooklm-slide.pdf"]),
      "u/t-notebooklm-slide.pdf",
      { kind: "slide", originalPdfPath: "u/t.pdf" },
    );
    assert.equal(exists, false);
  } finally {
    restore();
  }
});

test("pdfsObjectExists: 別サイズのPDFスライドとftyp動画は有り", async () => {
  const restore = installFetch({
    "u/t-notebooklm-slide.pdf": { status: 206, total: 120_000, head: PDF_HEAD },
    "u/t.pdf": { status: 206, total: 80_000, head: PDF_HEAD },
    "u/t-notebooklm-video.mp4": { status: 206, total: 400_000, head: VIDEO_HEAD },
  });
  try {
    const slide = await pdfsObjectExists(
      mockAdmin(["t.pdf", "t-notebooklm-slide.pdf", "t-notebooklm-video.mp4"]),
      "u/t-notebooklm-slide.pdf",
      { kind: "slide", originalPdfPath: "u/t.pdf" },
    );
    const video = await pdfsObjectExists(
      mockAdmin(["t.pdf", "t-notebooklm-slide.pdf", "t-notebooklm-video.mp4"]),
      "u/t-notebooklm-video.mp4",
      { kind: "video" },
    );
    assert.equal(slide, true);
    assert.equal(video, true);
  } finally {
    restore();
  }
});

test("dropMissing: 論文PDF以外が無い行はスライド・動画パスを外す", async () => {
  const restore = installFetch({});
  try {
    const [row] = await dropMissingPaperMaterialStoragePaths(mockAdmin(["abc.pdf"]), [
      {
        id: "abc",
        pdf_storage_path: "u/abc.pdf",
        notebooklm_slide_pdf_storage_path: "u/abc-notebooklm-slide.pdf",
        notebooklm_video_mp4_storage_path: "u/abc-notebooklm-video.mp4",
      },
    ]);
    assert.equal(row.notebooklm_slide_pdf_storage_path, null);
    assert.equal(row.notebooklm_video_mp4_storage_path, null);
  } finally {
    restore();
  }
});

