/** プルダウンで「自由記述と併用する」ときの特別ラベル（DB 値・保存形式と一致させる） */
export const PICKLIST_OTHER_LABEL = "その他";

const OTHER = PICKLIST_OTHER_LABEL;

export function isOtherBracketValue(value: string): boolean {
  return value.startsWith("その他（") && value.endsWith("）");
}

export function buildStoredOtherValue(trimmedDetail: string): string {
  return `その他（${trimmedDetail}）`;
}

/** 候補＋任意で「その他」から、保存値とプルダウン用の分解 */
export function parsePickWithOther(
  stored: string | null | undefined,
  optionValues: string[],
  allowOther: boolean,
): { choice: string; other: string } {
  const opts = [...new Set(optionValues.filter(Boolean))];
  const s = (stored ?? "").trim();
  if (!s) return { choice: "", other: "" };
  if (opts.includes(s)) return { choice: s, other: "" };
  if (allowOther && isOtherBracketValue(s)) {
    return { choice: OTHER, other: s.slice(4, -1) };
  }
  if (allowOther && opts.includes(OTHER)) {
    return { choice: OTHER, other: s };
  }
  if (!allowOther) {
    return { choice: s, other: "" };
  }
  return { choice: "", other: s };
}

export function finalizePickWithOther(
  choice: string,
  other: string,
  fieldLabel: string,
):
  | { ok: true; value: string }
  | { ok: false; message: string } {
  const c = choice.trim();
  if (!c) {
    return { ok: false, message: `${fieldLabel}を選択してください` };
  }
  if (c === OTHER) {
    const o = other.trim();
    if (!o) {
      return {
        ok: false,
        message: `${fieldLabel}が「その他」のときは内容を入力してください`,
      };
    }
    return { ok: true, value: buildStoredOtherValue(o) };
  }
  return { ok: true, value: c };
}

/** 保存済み文字列が候補＋その他ルールを満たすか検証（送信前に利用） */
export function assertStoredPickWithOther(
  stored: string | null | undefined,
  optionValues: string[],
  allowOther: boolean,
  fieldLabel: string,
):
  | { ok: true; value: string }
  | { ok: false; message: string } {
  const p = parsePickWithOther((stored ?? "").trim(), optionValues, allowOther);
  return finalizePickWithOther(p.choice, p.other, fieldLabel);
}
