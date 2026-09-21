import {
  paperHasNotebookLmSlidePath,
  paperHasNotebookLmVideoPath,
} from "./paper-notebooklm-materials.ts";

export { paperHasNotebookLmSlidePath, paperHasNotebookLmVideoPath };

const MIN_SLIDE_BYTES = 1_000;
const MIN_VIDEO_BYTES = 20_000;

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
  return materialFileFromListing(files, name);
}

export function materialFileFromListing(
  files: StorageListFile[] | null | undefined,
  name: string,
  opts?: { minBytes?: number; notSameSizeAs?: number | null },
): boolean {
  if (!files?.length) return false;
  const f = files.find((x) => x.name === name);
  if (!f) return false;
  const size = f.metadata?.size;
  if (typeof size !== "number" || !Number.isFinite(size)) return true;
  if (size <= 0) return false;
  if (opts?.minBytes != null && size < opts.minBytes) return false;
  if (opts?.notSameSizeAs != null && size === opts.notSameSizeAs) return false;
  return true;
}

export type PaperMaterialStorageRow = {
  id: string;
  uploaded_by?: string | null;
  pdf_storage_path?: string | null;
  notebooklm_slide_pdf_storage_path?: string | null;
  notebooklm_video_mp4_storage_path?: string | null;
};

export function storageDirForRow(r: PaperMaterialStorageRow): string | null {
  const fromPdf = storagePathDirAndName(r.pdf_storage_path);
  if (fromPdf) return fromPdf.dir;
  const fromSlide = storagePathDirAndName(r.notebooklm_slide_pdf_storage_path);
  if (fromSlide) return fromSlide.dir;
  const fromVideo = storagePathDirAndName(r.notebooklm_video_mp4_storage_path);
  if (fromVideo) return fromVideo.dir;
  const uploaded = r.uploaded_by?.trim();
  return uploaded || null;
}

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
    };
  };
  from: (table: string) => unknown;
};

function testsTable(admin: StorageLister) {
  return admin.from("tests") as {
    update: (values: Record<string, unknown>) => {
      eq: (column: string, value: string) => PromiseLike<unknown>;
    };
  };
}

async function listPdfsDir(
  admin: StorageLister,
  dir: string,
  search?: string,
): Promise<StorageListFile[] | null> {
  const { data, error } = await admin.storage.from("pdfs").list(dir, {
    limit: search ? 50 : 1000,
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
  if (listed == null) return null;
  const origParts = storagePathDirAndName(opts?.originalPdfPath);
  const orig =
    origParts && origParts.dir === parts.dir
      ? listed.find((f) => f.name === origParts.name)
      : undefined;
  const origSize =
    typeof orig?.metadata?.size === "number" && Number.isFinite(orig.metadata.size)
      ? orig.metadata.size
      : null;
  const minBytes =
    opts?.kind === "video" ? MIN_VIDEO_BYTES : opts?.kind === "slide" ? MIN_SLIDE_BYTES : undefined;
  return materialFileFromListing(listed, parts.name, {
    minBytes,
    notSameSizeAs: origSize,
  });
}

function origPdfFileName(r: PaperMaterialStorageRow): string {
  return storagePathDirAndName(r.pdf_storage_path)?.name || `${r.id}.pdf`;
}

/**
 * ストレージ listing に実ファイルがあればパスを戻し、listing で欠落が確定したときだけ外す。
 * listing 失敗時は DB も表示も変えない。
 */
export async function dropMissingPaperMaterialStoragePaths<
  T extends PaperMaterialStorageRow,
>(admin: StorageLister, rows: T[]): Promise<T[]> {
  const filesByDir = new Map<string, StorageListFile[] | null>();
  await Promise.all(
    rows.map(async (r) => {
      const dir = storageDirForRow(r);
      const key = `${dir ?? ""}\0${r.id}`;
      if (!dir) {
        filesByDir.set(key, null);
        return;
      }
      filesByDir.set(key, await listPdfsDir(admin, dir, r.id));
    }),
  );

  const persist: { id: string; values: Record<string, string | null> }[] = [];
  const out = rows.map((r) => {
    const next = { ...r };
    const dir = storageDirForRow(r);
    const listed = filesByDir.get(`${dir ?? ""}\0${r.id}`) ?? null;
    if (!dir || listed == null) return next;

    const orig = listed.find((f) => f.name === origPdfFileName(r));
    const origSize =
      typeof orig?.metadata?.size === "number" && Number.isFinite(orig.metadata.size)
        ? orig.metadata.size
        : null;
    const slideName = `${r.id}-notebooklm-slide.pdf`;
    const videoName = `${r.id}-notebooklm-video.mp4`;
    const slideOk = materialFileFromListing(listed, slideName, {
      minBytes: MIN_SLIDE_BYTES,
      notSameSizeAs: origSize,
    });
    const videoOk = materialFileFromListing(listed, videoName, {
      minBytes: MIN_VIDEO_BYTES,
    });
    const slidePath = `${dir}/${slideName}`;
    const videoPath = `${dir}/${videoName}`;
    const values: Record<string, string | null> = {};

    if (slideOk) {
      if (next.notebooklm_slide_pdf_storage_path !== slidePath) {
        next.notebooklm_slide_pdf_storage_path = slidePath;
        values.notebooklm_slide_pdf_storage_path = slidePath;
      }
    } else if (next.notebooklm_slide_pdf_storage_path) {
      next.notebooklm_slide_pdf_storage_path = null;
      values.notebooklm_slide_pdf_storage_path = null;
    }

    if (videoOk) {
      if (next.notebooklm_video_mp4_storage_path !== videoPath) {
        next.notebooklm_video_mp4_storage_path = videoPath;
        values.notebooklm_video_mp4_storage_path = videoPath;
      }
    } else if (next.notebooklm_video_mp4_storage_path) {
      next.notebooklm_video_mp4_storage_path = null;
      values.notebooklm_video_mp4_storage_path = null;
    }

    if (Object.keys(values).length) persist.push({ id: r.id, values });
    return next;
  });

  try {
    const table = testsTable(admin);
    for (const p of persist) {
      await table.update(p.values).eq("id", p.id);
    }
  } catch {
    // 表示用の更新は残す
  }

  return out;
}
