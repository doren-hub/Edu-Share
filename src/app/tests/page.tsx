import { redirect } from "next/navigation";
import { TESTS_LIST_PATHS } from "@/lib/tests-list-paths";

/** `/tests` は廃止。旧クエリだけ専用一覧へ誘導し、それ以外はホームへ。 */
export default async function TestsLegacyRedirect({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; category?: string }>;
}) {
  const sp = await searchParams;
  const t = sp.tab;
  const c = sp.category;
  if (t === "paper" || c === "paper") {
    redirect(TESTS_LIST_PATHS.paper);
  }
  if (
    t === "past_exam" ||
    t === "past" ||
    c === "past_exam" ||
    c === "past"
  ) {
    redirect(TESTS_LIST_PATHS.pastExam);
  }
  redirect("/");
}
