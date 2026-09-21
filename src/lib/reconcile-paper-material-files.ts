import { createAdminClient } from "@/lib/supabase/admin";
import {
  dropMissingPaperMaterialStoragePaths,
  paperHasNotebookLmSlidePath,
  paperHasNotebookLmVideoPath,
  type PaperMaterialStorageRow,
} from "@/lib/paper-notebooklm-storage";

/** 既存論文の欠落ファイルを DB と表示の両方から外す。キー未設定ならそのまま */
export async function reconcileExistingPaperMaterialFiles<
  T extends PaperMaterialStorageRow,
>(rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows;
  try {
    const admin = createAdminClient();
    return await dropMissingPaperMaterialStoragePaths(admin, rows);
  } catch {
    const cleared = rows.map((r) => ({
      ...r,
      notebooklm_slide_pdf_storage_path: paperHasNotebookLmSlidePath(
        r.notebooklm_slide_pdf_storage_path,
      )
        ? null
        : r.notebooklm_slide_pdf_storage_path,
      notebooklm_video_mp4_storage_path: paperHasNotebookLmVideoPath(
        r.notebooklm_video_mp4_storage_path,
      )
        ? null
        : r.notebooklm_video_mp4_storage_path,
    }));
    return cleared;
  }
}
