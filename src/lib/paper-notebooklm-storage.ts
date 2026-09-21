import {
  paperHasNotebookLmSlidePath,
  paperHasNotebookLmVideoPath,
} from "./paper-notebooklm-materials.ts";

export { paperHasNotebookLmSlidePath, paperHasNotebookLmVideoPath };

export type StorageListFile = {
  name: string;
  metadata?: { size?: number } | null;
};

export function storagePathDirAndName(
  path: string | null | undefined,
): { dir: string; name: string } | null {
  const p = path?.trim() ?? "";
  if (!p || p.includes("..")) return null;
  const i = p.lastIndexOf("/");
  if (i <= 0 || i === p.length - 1) return null;
  return { dir: p.slice(0, i), name: p.slice(i + 1) };
}

export function storageListingHasFile(
  files: StorageListFile[] | null | undefined,
  name: string,
): boolean {
  if (!files?.length) return false;
  const f = files.find((x) => x.name === name);
  if (!f) return false;
  const size = f.metadata?.size;
  if (typeof size === "number" && Number.isFinite(size) && size <= 0) {
    return false;
  }
  return true;
}

export type PaperMaterialStorageRow = {
  id: string;
  pdf_storage_path?: string | null;
  notebooklm_slide_pdf_storage_path?: string | null;
  notebooklm_video_mp4_storage_path?: string | null;
};

/** `null` の listing は不明。表示では欠落とみなすが、DB からは消さない */
export function paperMaterialPathIdsMissingFromListings(
  rows: PaperMaterialStorageRow[],
  filesByDir: Map<string, StorageListFile[] | null>,
): { missingConfirmed: { slideIds: string[]; videoIds: string[] }; unconfirmed: { slideIds: string[]; videoIds: string[] } } {
  const missingConfirmed = { slideIds: [] as string[], videoIds: [] as string[] };
  const unconfirmed = { slideIds: [] as string[], videoIds: [] as string[] };
  for (const r of rows) {
    const slide = r.notebooklm_slide_pdf_storage_path;
    if (paperHasNotebookLmSlidePath(slide)) {
      const parts = storagePathDirAndName(slide);
      if (!parts || !filesByDir.has(parts.dir)) {
        unconfirmed.slideIds.push(r.id);
      } else {
        const listed = filesByDir.get(parts.dir) ?? null;
        if (listed == null) unconfirmed.slideIds.push(r.id);
        else if (!storageListingHasFile(listed, parts.name)) {
          missingConfirmed.slideIds.push(r.id);
        }
      }
    }
    const video = r.notebooklm_video_mp4_storage_path;
    if (paperHasNotebookLmVideoPath(video)) {
      const parts = storagePathDirAndName(video);
      if (!parts || !filesByDir.has(parts.dir)) {
        unconfirmed.videoIds.push(r.id);
      } else {
        const listed = filesByDir.get(parts.dir) ?? null;
        if (listed == null) unconfirmed.videoIds.push(r.id);
        else if (!storageListingHasFile(listed, parts.name)) {
          missingConfirmed.videoIds.push(r.id);
        }
      }
    }
  }
  return {
    missingConfirmed: {
      slideIds: [...new Set(missingConfirmed.slideIds)],
      videoIds: [...new Set(missingConfirmed.videoIds)],
    },
    unconfirmed: {
      slideIds: [...new Set(unconfirmed.slideIds)],
      videoIds: [...new Set(unconfirmed.videoIds)],
    },
  };
}

type StorageLister = {
  storage: {
    from: (bucket: string) => {
      list: (
        path?: string,
        options?: { limit?: number; search?: string },
      ) => Promise<{ data: StorageListFile[] | null; error: { message?: string } | null }>;
      createSignedUrl: (
        path: string,
        expiresIn: number,
      ) => Promise<{ data: { signedUrl?: string } | null; error: { message?: string } | null }>;
    };
  };
  from: (table: string) => unknown;
};

function testsTable(admin: StorageLister) {
  return admin.from("tests") as {
    update: (values: Record<string, unknown>) => {
      in: (column: string, values: string[]) => PromiseLike<unknown>;
    };
  };
}

async function listPdfsDir(
  admin: StorageLister,
  dir: string,
  search?: string,
): Promise<StorageListFile[] | null> {
  const { data, error } = await admin.storage.from("pdfs").list(dir, {
    limit: 1000,
    ...(search ? { search } : {}),
  });
  if (error) return null;
  return data ?? [];
}

export async function pdfsObjectExists(
  admin: StorageLister,
  path: string | null | undefined,
  opts?: { kind?: "slide" | "video"; originalPdfPath?: string | null },
): Promise<boolean | null> {
  const raw = path?.trim() ?? "";
  const parts = storagePathDirAndName(raw);
  if (!parts) return false;
  const listed = await listPdfsDir(admin, parts.dir);
  if (listed != null && !storageListingHasFile(listed, parts.name)) return false;
  const probe = await probeStorageObject(admin, raw, opts?.kind === "video" ? 32 : 8);
  if (!probe) return false;
  const minBytes = opts?.kind === "video" ? 20_000 : 1_000;
  if (probe.total < minBytes) return false;
  if (opts?.kind === "slide" && !looksLikePdfHead(probe.head)) return false;
  if (opts?.kind === "video" && !looksLikeVideoHead(probe.head)) return false;
  const orig = opts?.originalPdfPath?.trim();
  if (orig && orig !== raw) {
    const origProbe = await probeStorageObject(admin, orig, 8);
    if (origProbe && origProbe.total === probe.total) return false;
  }
  return true;
}

function looksLikePdfHead(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

function looksLikeVideoHead(buf: Uint8Array): boolean {
  if (buf.length < 12) return false;
  return buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
}

async function probeStorageObject(
  admin: StorageLister,
  path: string,
  endByte: number,
): Promise<{ total: number; head: Uint8Array } | null> {
  try {
    const { data, error } = await admin.storage.from("pdfs").createSignedUrl(path, 60);
    const url = data?.signedUrl;
    if (error || !url) return null;
    const res = await fetch(url, {
      method: "GET",
      headers: { Range: `bytes=0-${endByte}` },
      redirect: "follow",
    });
    if (res.status !== 200 && res.status !== 206) return null;
    const head = new Uint8Array(await res.arrayBuffer());
    const range = res.headers.get("content-range");
    const fromRange = range ? Number(/\/(\d+)\s*$/.exec(range)?.[1]) : NaN;
    const fromLen = Number(res.headers.get("content-length"));
    const total = Number.isFinite(fromRange)
      ? fromRange
      : Number.isFinite(fromLen)
        ? fromLen
        : head.length;
    if (!Number.isFinite(total) || total <= 0) return null;
    return { total, head };
  } catch {
    return null;
  }
}

/**
 * 既存論文: ストレージに実ファイルが無い（または確認できない）スライド／動画は
 * 表示上パスを外す。listing が成功して欠落が確定したときだけ DB を null にする。
 */
export async function dropMissingPaperMaterialStoragePaths<
  T extends PaperMaterialStorageRow,
>(admin: StorageLister, rows: T[]): Promise<T[]> {
  const persistSlide: string[] = [];
  const persistVideo: string[] = [];
  const out = await Promise.all(
    rows.map(async (r) => {
      const next = { ...r };
      if (paperHasNotebookLmSlidePath(next.notebooklm_slide_pdf_storage_path)) {
        const slidePath = next.notebooklm_slide_pdf_storage_path ?? "";
        const parts = storagePathDirAndName(slidePath);
        const originalPdfPath =
          next.pdf_storage_path?.trim() ||
          (parts ? `${parts.dir}/${r.id}.pdf` : "");
        const exists = await pdfsObjectExists(admin, slidePath, {
          kind: "slide",
          originalPdfPath,
        });
        if (exists !== true) {
          next.notebooklm_slide_pdf_storage_path = null;
          if (exists === false) persistSlide.push(r.id);
        }
      }
      if (paperHasNotebookLmVideoPath(next.notebooklm_video_mp4_storage_path)) {
        const exists = await pdfsObjectExists(admin, next.notebooklm_video_mp4_storage_path, {
          kind: "video",
        });
        if (exists !== true) {
          next.notebooklm_video_mp4_storage_path = null;
          if (exists === false) persistVideo.push(r.id);
        }
      }
      return next;
    }),
  );

  try {
    const table = testsTable(admin);
    const slideIds = [...new Set(persistSlide)];
    const videoIds = [...new Set(persistVideo)];
    if (slideIds.length) {
      await table.update({ notebooklm_slide_pdf_storage_path: null }).in("id", slideIds);
    }
    if (videoIds.length) {
      await table.update({ notebooklm_video_mp4_storage_path: null }).in("id", videoIds);
    }
  } catch {
    // 表示用の null 化は残す
  }

  return out;
}
