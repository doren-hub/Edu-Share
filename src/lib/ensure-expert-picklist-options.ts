import { MAX_AUTHORS } from "@/lib/paper-authors";
import { buildStoredOtherValue } from "@/lib/picklist-parse";

/** カンマ等で区切られた著者名を分割（貼り付け用） */
export function splitAuthorNamesForPicklist(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,，、]/)) {
    const t = part
      .replace(/\s*-\s*Show less\s*$/i, "")
      .replace(/\s*Show less\s*$/i, "")
      .trim();
    if (!t || t.length > 200) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_AUTHORS) break;
  }
  return out;
}

export type EnsureExpertPicklistResult = {
  /** フォームにセットする保存値（候補追加に成功したら素の名前、失敗時はその他（…）） */
  values: string[];
  /** ユーザー向けメッセージ（追加件数・スキップ等） */
  message: string | null;
};

/**
 * 著者名を picklist_options（category=expert_name）に未登録なら追加する。
 * 409（重複）は成功扱い。POST が失敗した名前は「その他（…）」にフォールバック。
 */
export async function ensureExpertNamePicklistOptions(
  displayNames: string[],
): Promise<EnsureExpertPicklistResult> {
  const values: string[] = [];
  let added = 0;
  let existed = 0;
  let failed = 0;

  for (const name of displayNames) {
    const res = await fetch("/api/picklists", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "expert_name", value: name }),
    });
    if (res.ok) {
      values.push(name);
      added += 1;
      continue;
    }
    if (res.status === 409) {
      values.push(name);
      existed += 1;
      continue;
    }
    failed += 1;
    values.push(buildStoredOtherValue(name));
  }

  const parts: string[] = [];
  if (added > 0) parts.push(`選択肢に${added}件を追加しました`);
  if (existed > 0) parts.push(`${existed}件は既に候補にありました`);
  if (failed > 0) {
    parts.push(
      `${failed}件は候補への追加に失敗したため「その他」形式で反映しました`,
    );
  }
  return {
    values,
    message: parts.length > 0 ? parts.join("。") + "。" : null,
  };
}

/**
 * 発表年（西暦4桁）を picklist_options（category=publication_year）に未登録なら追加する。
 * 409（重複）は成功扱い。
 */
export async function ensurePublicationYearPicklistOption(
  year: string,
): Promise<{ ok: boolean; message: string | null }> {
  const y = year.trim();
  if (!/^(?:19|20)\d{2}$/.test(y)) {
    return { ok: false, message: null };
  }
  const res = await fetch("/api/picklists", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "publication_year", value: y }),
  });
  if (res.ok) {
    return { ok: true, message: `発表年「${y}」を候補に追加しました。` };
  }
  if (res.status === 409) {
    return { ok: true, message: null };
  }
  return {
    ok: false,
    message:
      "発表年を候補に追加できませんでした。Supabase の picklist 設定を確認するか、「資料情報」から手動で選んでください。",
  };
}
