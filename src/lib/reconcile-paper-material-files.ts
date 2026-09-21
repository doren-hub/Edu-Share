import { createAdminClient } from "@/lib/supabase/admin";
import {
  dropMissingPaperMaterialStoragePaths,
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
    return rows;
  }
}
