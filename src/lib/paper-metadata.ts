/**
 * 論文メタの業界・著者（expert_name カテゴリ）は picklist と同一の「その他（…）」規則を使う。
 */

import {
  finalizePickWithOther,
  parsePickWithOther,
} from "./picklist-parse";

export {
  assertStoredPickWithOther,
  buildStoredOtherValue,
  isOtherBracketValue,
  parsePickWithOther,
} from "./picklist-parse";

export function parseIndustryForForm(
  stored: string | null | undefined,
  optionValues: string[],
) {
  return parsePickWithOther(stored, optionValues, true);
}

export function parseExpertForForm(
  stored: string | null | undefined,
  optionValues: string[],
) {
  return parsePickWithOther(stored, optionValues, true);
}

export function finalizeIndustryPick(
  choice: string,
  other: string,
):
  | { ok: true; value: string }
  | { ok: false; message: string } {
  return finalizePickWithOther(choice, other, "業界");
}
