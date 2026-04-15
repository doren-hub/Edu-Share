/**
 * 過去問メタの「その他」形式は picklist-parse に統一。
 * フォーム用の分解は候補一覧（API 取得値）を渡して parsePickWithOther を使う。
 */

import { parsePickWithOther } from "./picklist-parse";

export {
  PICKLIST_OTHER_LABEL,
  assertStoredPickWithOther,
  buildStoredOtherValue,
  finalizePickWithOther as finalizeExamPick,
  isOtherBracketValue,
  parsePickWithOther,
} from "./picklist-parse";

export function parseSubjectForForm(
  stored: string | null | undefined,
  optionValues: string[],
) {
  return parsePickWithOther(stored, optionValues, true);
}

export function parsePeriodForForm(
  stored: string | null | undefined,
  optionValues: string[],
) {
  return parsePickWithOther(stored, optionValues, true);
}
