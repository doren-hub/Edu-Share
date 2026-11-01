import {
  getObjectMetadata,
  type ObjectMetadata,
} from "./object-storage.ts";
import {
  paperHasNotebookLmSlidePath,
  paperHasNotebookLmVideoPath,
} from "./paper-notebooklm-materials.ts";

export { paperHasNotebookLmSlidePath, paperHasNotebookLmVideoPath };

const MIN_SLIDE_BYTES = 1_000;
const MIN_VIDEO_BYTES = 20_000;

export type PaperMaterialStorageRow = {
  id: string;
  uploaded_by?: string | null;
  pdf_storage_path?: string | null;
  notebooklm_slide_pdf_storage_path?: string | null;
  notebooklm_video_mp4_storage_path?: string | null;
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

export type ObjectMetadataReader = (key: string) => Promise<ObjectMetadata>;

async function readMetadata(
  read: ObjectMetadataReader,
  key: string,
): Promise<ObjectMetadata | null> {
  try {
    return await read(key);
  } catch {
    return null;
  }
}

function isUsableMaterial(
  metadata: ObjectMetadata,
  minBytes: number,
  originalSize?: number | null,
): boolean {
  if (!metadata.exists) return false;
  if (metadata.size != null && metadata.size < minBytes) return false;
  if (originalSize != null && metadata.size === originalSize) return false;
  return true;
}

export async function r2ObjectExists(
  path: string | null | undefined,
  opts?: {
    kind?: "slide" | "video";
    originalPdfPath?: string | null;
    readMetadata?: ObjectMetadataReader;
  },
): Promise<boolean | null> {
  const key = path?.trim();
  if (!key || !storagePathDirAndName(key)) return false;
  const read = opts?.readMetadata ?? getObjectMetadata;
  const [metadata, original] = await Promise.all([
    readMetadata(read, key),
    opts?.originalPdfPath
      ? readMetadata(read, opts.originalPdfPath)
      : Promise.resolve(null),
  ]);
  if (!metadata) return null;
  const minBytes =
    opts?.kind === "video"
      ? MIN_VIDEO_BYTES
      : opts?.kind === "slide"
        ? MIN_SLIDE_BYTES
        : 1;
  return isUsableMaterial(metadata, minBytes, original?.size);
}

type TestsTableClient = {
  from: (table: string) => unknown;
};

type UpdateQuery = PromiseLike<unknown> & {
  eq: (column: string, value: string) => UpdateQuery;
  is: (column: string, value: null) => UpdateQuery;
};

function testsTable(admin: TestsTableClient) {
  return admin.from("tests") as {
    update: (values: Record<string, unknown>) => UpdateQuery;
  };
}

/** R2の実在確認を行い、資料キーを正規化する。確認失敗時はDB値を変更しない。 */
export async function reconcilePaperMaterialObjectPaths<
  T extends PaperMaterialStorageRow,
>(
  admin: TestsTableClient,
  rows: T[],
  read: ObjectMetadataReader = getObjectMetadata,
): Promise<T[]> {
  const persist: { id: string; column: string; previous: string | null; value: string | null }[] = [];

  const out = await Promise.all(
    rows.map(async (row) => {
      const dir = storageDirForRow(row);
      if (!dir) return { ...row };

      const next = { ...row };
      // Prefer the registered object. Never replace a known immutable reference
      // with a missing or stale fixed-key upload. Unknown nonempty paths are left alone.
      const slidePath = row.notebooklm_slide_pdf_storage_path == null
        ? `${dir}/${row.id}-notebooklm-slide.pdf`
        : paperHasNotebookLmSlidePath(row.notebooklm_slide_pdf_storage_path)
          ? row.notebooklm_slide_pdf_storage_path : null;
      const videoPath = row.notebooklm_video_mp4_storage_path == null
        ? `${dir}/${row.id}-notebooklm-video.mp4`
        : paperHasNotebookLmVideoPath(row.notebooklm_video_mp4_storage_path)
          ? row.notebooklm_video_mp4_storage_path : null;
      const [original, slide, video] = await Promise.all([
        row.pdf_storage_path ? readMetadata(read, row.pdf_storage_path) : Promise.resolve(null),
        slidePath ? readMetadata(read, slidePath) : Promise.resolve(null),
        videoPath ? readMetadata(read, videoPath) : Promise.resolve(null),
      ]);

      if (slide) {
        const slideOk = isUsableMaterial(slide, MIN_SLIDE_BYTES, original?.size);
        const current = paperHasNotebookLmSlidePath(row.notebooklm_slide_pdf_storage_path)
          ? row.notebooklm_slide_pdf_storage_path
          : null;
        const value = slideOk ? slidePath : null;
        if (current !== value) {
          next.notebooklm_slide_pdf_storage_path = value;
          persist.push({ id: row.id, column: "notebooklm_slide_pdf_storage_path", previous: row.notebooklm_slide_pdf_storage_path ?? null, value });
        }
      }

      if (video) {
        const videoOk = isUsableMaterial(video, MIN_VIDEO_BYTES);
        const current = paperHasNotebookLmVideoPath(row.notebooklm_video_mp4_storage_path)
          ? row.notebooklm_video_mp4_storage_path
          : null;
        const value = videoOk ? videoPath : null;
        if (current !== value) {
          next.notebooklm_video_mp4_storage_path = value;
          persist.push({ id: row.id, column: "notebooklm_video_mp4_storage_path", previous: row.notebooklm_video_mp4_storage_path ?? null, value });
        }
      }

      return next;
    }),
  );

  try {
    const table = testsTable(admin);
    for (const update of persist) {
      const query = table.update({ [update.column]: update.value }).eq("id", update.id);
      // A page load started before commit must not clear or revert its new reference.
      await (update.previous === null ? query.is(update.column, null) : query.eq(update.column, update.previous));
    }
  } catch {
    // 表示用の正規化結果は残す。
  }

  return out;
}
