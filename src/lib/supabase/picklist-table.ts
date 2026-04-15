import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import {
  isExamMetaPicklistCategory,
  isSchoolScopedPicklistCategory,
} from "@/lib/picklist-categories";
import type { PicklistItem } from "@/lib/picklist-merge";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type PicklistOptionRow = PicklistItem;

const PICKLIST_ROW_COLS = "id,value,scope_school_name,scope_department_value";

function isServiceRoleConfigured(): boolean {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return Boolean(k && k !== "your_service_role_key");
}

async function queryPicklistRows(
  db: SupabaseClient,
  category: string,
  filters?: { school?: string; department?: string },
): Promise<{ data: PicklistOptionRow[] | null; error: PostgrestError | null }> {
  const school = filters?.school?.trim() ?? "";
  const department = filters?.department?.trim() ?? "";

  if (!isSchoolScopedPicklistCategory(category)) {
    const { data, error } = await db
      .from("picklist_options")
      .select(PICKLIST_ROW_COLS)
      .eq("category", category)
      .order("sort_order", { ascending: true });

    if (error) return { data: null, error };
    return { data: (data ?? []) as PicklistOptionRow[], error: null };
  }

  if (category === "department_name") {
    const { data: globalRows, error: gErr } = await db
      .from("picklist_options")
      .select(PICKLIST_ROW_COLS)
      .eq("category", category)
      .is("scope_school_name", null)
      .is("scope_department_value", null)
      .order("sort_order", { ascending: true });

    if (gErr) return { data: null, error: gErr };

    let scoped: PicklistOptionRow[] = [];
    if (school) {
      const { data: scopedRows, error: sErr } = await db
        .from("picklist_options")
        .select(PICKLIST_ROW_COLS)
        .eq("category", category)
        .eq("scope_school_name", school)
        .is("scope_department_value", null)
        .order("sort_order", { ascending: true });

      if (sErr) return { data: null, error: sErr };
      scoped = (scopedRows ?? []) as PicklistOptionRow[];
    }

    const combined = [...((globalRows ?? []) as PicklistOptionRow[]), ...scoped];
    return { data: combined, error: null };
  }

  if (isExamMetaPicklistCategory(category)) {
    const { data: globalRows, error: gErr } = await db
      .from("picklist_options")
      .select(PICKLIST_ROW_COLS)
      .eq("category", category)
      .is("scope_school_name", null)
      .is("scope_department_value", null)
      .order("sort_order", { ascending: true });

    if (gErr) return { data: null, error: gErr };

    if (!school) {
      return { data: (globalRows ?? []) as PicklistOptionRow[], error: null };
    }

    const { data: schoolWideRows, error: swErr } = await db
      .from("picklist_options")
      .select(PICKLIST_ROW_COLS)
      .eq("category", category)
      .eq("scope_school_name", school)
      .is("scope_department_value", null)
      .order("sort_order", { ascending: true });

    if (swErr) return { data: null, error: swErr };

    if (!department) {
      const combined = [
        ...((globalRows ?? []) as PicklistOptionRow[]),
        ...((schoolWideRows ?? []) as PicklistOptionRow[]),
      ];
      return { data: combined, error: null };
    }

    const { data: deptRows, error: dErr } = await db
      .from("picklist_options")
      .select(PICKLIST_ROW_COLS)
      .eq("category", category)
      .eq("scope_school_name", school)
      .eq("scope_department_value", department)
      .order("sort_order", { ascending: true });

    if (dErr) return { data: null, error: dErr };

    const combined = [
      ...((globalRows ?? []) as PicklistOptionRow[]),
      ...((schoolWideRows ?? []) as PicklistOptionRow[]),
      ...((deptRows ?? []) as PicklistOptionRow[]),
    ];
    return { data: combined, error: null };
  }

  return { data: [], error: null };
}

/**
 * picklist_options を読む。department_name は学校スコープ、exam_subject / exam_period は学校＋任意の学科。
 */
export async function fetchPicklistOptionRows(
  category: string,
  options?: { school?: string; department?: string },
): Promise<{ rows: PicklistOptionRow[]; error: PostgrestError | null }> {
  const clients: SupabaseClient[] = [];

  if (isServiceRoleConfigured()) {
    try {
      clients.push(createAdminClient());
    } catch {
      /* 無視して次へ */
    }
  }

  clients.push(await createClient());

  let lastError: PostgrestError | null = null;

  for (const db of clients) {
    const { data, error } = await queryPicklistRows(db, category, options);
    if (!error && data) {
      const rows = [...data].sort((a, b) => {
        const byVal = a.value.localeCompare(b.value, "ja");
        if (byVal !== 0) return byVal;
        const sh = (a.scope_school_name ?? "").trim() ? 1 : 0;
        const bh = (b.scope_school_name ?? "").trim() ? 1 : 0;
        if (sh !== bh) return sh - bh;
        const ad = (a.scope_department_value ?? "").trim() ? 1 : 0;
        const bd = (b.scope_department_value ?? "").trim() ? 1 : 0;
        return ad - bd;
      });
      return { rows, error: null };
    }
    lastError = error;
  }

  return { rows: [], error: lastError };
}

/**
 * 書き込み用（認証後の insert/delete）。
 */
export async function createPicklistTableClient(): Promise<SupabaseClient> {
  if (isServiceRoleConfigured()) {
    try {
      return createAdminClient();
    } catch {
      /* fall through */
    }
  }
  return createClient();
}
