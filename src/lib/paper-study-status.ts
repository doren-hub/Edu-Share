import type { SupabaseClient } from "@supabase/supabase-js";

/** 画面上の4状態。未確認は行が無いときの既定。 */
export const PAPER_STUDY_STATUSES = [
  "unconfirmed",
  "content_confirmed",
  "learning",
  "completed",
] as const;

export type PaperStudyStatus = (typeof PAPER_STUDY_STATUSES)[number];

/** テーブルに保存する値。未確認は行を消す。 */
export const STORED_PAPER_STUDY_STATUSES = [
  "content_confirmed",
  "learning",
  "completed",
] as const;

export type StoredPaperStudyStatus = (typeof STORED_PAPER_STUDY_STATUSES)[number];

export const PAPER_STUDY_STATUS_LABEL: Record<PaperStudyStatus, string> = {
  unconfirmed: "未確認",
  content_confirmed: "内容確認",
  learning: "学習中",
  completed: "学習完了",
};

const STORED = new Set<string>(STORED_PAPER_STUDY_STATUSES);

export function parsePaperStudyStatus(value: unknown): PaperStudyStatus | null {
  if (typeof value !== "string") return null;
  if ((PAPER_STUDY_STATUSES as readonly string[]).includes(value)) {
    return value as PaperStudyStatus;
  }
  return null;
}

export function paperStudyStatusFromStored(value: unknown): PaperStudyStatus {
  if (typeof value === "string" && STORED.has(value)) {
    return value as StoredPaperStudyStatus;
  }
  return "unconfirmed";
}

export function paperMatchesStudyStatus(
  stored: StoredPaperStudyStatus | undefined,
  filter: PaperStudyStatus | "",
): boolean {
  if (!filter) return true;
  return paperStudyStatusFromStored(stored) === filter;
}

export function humanizePaperStudyStatusDbError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("paper_study_status_not_paper")) {
    return "過去問には学習ステータスを付けられません";
  }
  if (
    m.includes("paper_study_statuses") &&
    (m.includes("does not exist") ||
      m.includes("schema cache") ||
      m.includes("could not find the table"))
  ) {
    return (
      "paper_study_statuses がありません。Supabase の SQL Editor で " +
      "supabase/migrations/026_paper_study_status.sql を実行してください。"
    );
  }
  return "";
}

export type PaperStudyStatusMap = Partial<Record<string, StoredPaperStudyStatus>>;

export async function loadPaperStudyStatuses(
  supabase: SupabaseClient,
): Promise<{ signedIn: boolean; byTestId: PaperStudyStatusMap; error: string | null }> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return { signedIn: false, byTestId: {}, error: null };
  }

  const { data, error } = await supabase
    .from("paper_study_statuses")
    .select("test_id, status");

  if (error) {
    return {
      signedIn: true,
      byTestId: {},
      error:
        humanizePaperStudyStatusDbError(error.message) ||
        "学習ステータスを読み込めませんでした",
    };
  }

  const byTestId: PaperStudyStatusMap = {};
  for (const row of data ?? []) {
    const id = typeof row.test_id === "string" ? row.test_id : "";
    const status = paperStudyStatusFromStored(row.status);
    if (!id || status === "unconfirmed") continue;
    byTestId[id] = status;
  }
  return { signedIn: true, byTestId, error: null };
}

export async function loadPaperStudyStatusForTest(
  supabase: SupabaseClient,
  testId: string,
): Promise<{ status: PaperStudyStatus; error: string | null }> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { status: "unconfirmed", error: null };

  const { data, error } = await supabase
    .from("paper_study_statuses")
    .select("status")
    .eq("test_id", testId)
    .maybeSingle();

  if (error) {
    return {
      status: "unconfirmed",
      error:
        humanizePaperStudyStatusDbError(error.message) ||
        "学習ステータスを読み込めませんでした",
    };
  }
  return { status: paperStudyStatusFromStored(data?.status), error: null };
}
