/** テスト教材の一覧（ブラウズ）用 URL */
export const TESTS_LIST_PATHS = {
  pastExam: "/tests/past-exam",
  paper: "/tests/paper",
} as const;

export function testsListPathForDocumentType(
  documentType: string | null | undefined,
): (typeof TESTS_LIST_PATHS)["pastExam"] | (typeof TESTS_LIST_PATHS)["paper"] {
  return documentType === "paper" ? TESTS_LIST_PATHS.paper : TESTS_LIST_PATHS.pastExam;
}
