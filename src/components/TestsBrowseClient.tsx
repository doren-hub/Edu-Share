"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { RecentTestsByCategory, TestList, type TestRow } from "@/components/TestList";
import { normalizePaperAuthorsFromDb } from "@/lib/paper-authors";
import { TESTS_LIST_PATHS } from "@/lib/tests-list-paths";

type TestsCategory = "past_exam" | "paper";

const EMPTY_SENTINEL = "__empty__";

/** 論文一覧の並び順（サーバー取得後にクライアントで適用） */
export type PaperSortKey =
  | "created_desc"
  | "created_asc"
  | "title_asc"
  | "title_desc"
  | "year_desc"
  | "year_asc";

function publicationYearNum(t: TestRow): number | null {
  const y = String(t.publication_year ?? "").trim();
  if (!/^\d{4}$/.test(y)) return null;
  const n = parseInt(y, 10);
  return Number.isFinite(n) ? n : null;
}

function sortPaperRows(rows: TestRow[], key: PaperSortKey): TestRow[] {
  const out = [...rows];
  const cmpCreated = (a: TestRow, b: TestRow, asc: boolean) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    return asc ? ta - tb : tb - ta;
  };
  const cmpTitle = (a: TestRow, b: TestRow, asc: boolean) => {
    const c = a.title.localeCompare(b.title, "ja", { sensitivity: "base" });
    return asc ? c : -c;
  };
  const cmpYear = (a: TestRow, b: TestRow, asc: boolean) => {
    const ya = publicationYearNum(a);
    const yb = publicationYearNum(b);
    if (ya == null && yb == null) return cmpCreated(a, b, false);
    if (ya == null) return 1;
    if (yb == null) return -1;
    const d = asc ? ya - yb : yb - ya;
    if (d !== 0) return d;
    return cmpCreated(a, b, false);
  };

  switch (key) {
    case "created_desc":
      out.sort((a, b) => cmpCreated(a, b, false));
      break;
    case "created_asc":
      out.sort((a, b) => cmpCreated(a, b, true));
      break;
    case "title_asc":
      out.sort((a, b) => cmpTitle(a, b, true) || cmpCreated(a, b, false));
      break;
    case "title_desc":
      out.sort((a, b) => cmpTitle(a, b, false) || cmpCreated(a, b, false));
      break;
    case "year_desc":
      out.sort((a, b) => cmpYear(a, b, false));
      break;
    case "year_asc":
      out.sort((a, b) => cmpYear(a, b, true));
      break;
    default:
      break;
  }
  return out;
}

function paperSortLabel(key: PaperSortKey): string {
  switch (key) {
    case "created_desc":
      return "追加が新しい順";
    case "created_asc":
      return "追加が古い順";
    case "title_asc":
      return "タイトル（昇順）";
    case "title_desc":
      return "タイトル（降順）";
    case "year_desc":
      return "発表年が新しい順";
    case "year_asc":
      return "発表年が古い順";
    default:
      return "";
  }
}

function TestsBrowseFallback() {
  return (
    <div
      className="h-40 animate-pulse rounded-xl bg-zinc-100"
      aria-hidden
    />
  );
}

export { TestsBrowseFallback };

const META_SEP = "\x1f";

function usePastSchoolFilterOptions(
  tests: TestRow[],
  category: TestsCategory,
): { key: string; label: string }[] {
  return useMemo(() => {
    if (category !== "past_exam") return [];
    const byKey = new Map<string, { key: string; label: string }>();
    for (const t of tests) {
      const name = t.source_name?.trim() ?? "";
      const key = ["past", name].join(META_SEP);
      const label = name === "" ? "（学校名なし）" : name;
      byKey.set(key, { key, label });
    }
    return Array.from(byKey.values()).sort((a, b) =>
      a.label.localeCompare(b.label, "ja", { sensitivity: "base" }),
    );
  }, [tests, category]);
}

function paperRowsMatchingIndustry(tests: TestRow[], industry: string): TestRow[] {
  if (!industry) return tests;
  if (industry === EMPTY_SENTINEL) {
    return tests.filter((t) => (t.industry ?? "").trim() === "");
  }
  return tests.filter((t) => (t.industry ?? "").trim() === industry);
}

/** 業界は全件から候補（著者に依存しない） */
function usePaperIndustryOptions(
  tests: TestRow[],
  category: TestsCategory,
): { values: string[]; hasEmpty: boolean } {
  return useMemo(() => {
    if (category !== "paper") return { values: [], hasEmpty: false };
    const set = new Set<string>();
    let hasEmpty = false;
    for (const t of tests) {
      const i = (t.industry ?? "").trim();
      if (i) set.add(i);
      else hasEmpty = true;
    }
    return {
      values: Array.from(set).sort((a, b) => a.localeCompare(b, "ja", { sensitivity: "base" })),
      hasEmpty,
    };
  }, [tests, category]);
}

function usePaperAuthorOptions(
  tests: TestRow[],
  category: TestsCategory,
  industry: string,
): string[] {
  return useMemo(() => {
    if (category !== "paper") return [];
    const base = paperRowsMatchingIndustry(tests, industry);
    const s = new Set<string>();
    for (const t of base) {
      const n = (t.source_name ?? "").trim();
      if (n) s.add(n);
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b, "ja", { sensitivity: "base" }));
  }, [tests, category, industry]);
}

function usePaperYearOptions(
  tests: TestRow[],
  category: TestsCategory,
  industry: string,
  author: string,
): { values: string[]; hasEmpty: boolean } {
  return useMemo(() => {
    if (category !== "paper") return { values: [], hasEmpty: false };
    let base = paperRowsMatchingIndustry(tests, industry);
    if (author) {
      base = base.filter((t) => (t.source_name?.trim() ?? "") === author);
    }
    const set = new Set<string>();
    let hasEmpty = false;
    for (const t of base) {
      const y = (t.publication_year ?? "").trim();
      if (/^\d{4}$/.test(y)) set.add(y);
      else hasEmpty = true;
    }
    return {
      values: Array.from(set).sort((a, b) => parseInt(b, 10) - parseInt(a, 10)),
      hasEmpty,
    };
  }, [tests, category, industry, author]);
}

function matchesPaperAxisFilters(
  t: TestRow,
  author: string,
  industry: string,
  year: string,
): boolean {
  if (author && (t.source_name?.trim() ?? "") !== author) return false;
  if (industry === EMPTY_SENTINEL) {
    if ((t.industry ?? "").trim() !== "") return false;
  } else if (industry && (t.industry ?? "").trim() !== industry) return false;
  if (year === EMPTY_SENTINEL) {
    const y = (t.publication_year ?? "").trim();
    if (/^\d{4}$/.test(y)) return false;
  } else if (year && (t.publication_year ?? "").trim() !== year) return false;
  return true;
}

function testRowSearchBlob(t: TestRow, category: TestsCategory): string {
  const parts: string[] = [
    t.title,
    t.description,
    t.source_name,
    t.exam_department,
    t.exam_subject,
    t.exam_period,
    t.industry,
    t.publication_year,
    t.paper_venue,
    t.paper_doi,
    t.pdf_filename,
  ].map((x) => String(x ?? ""));
  if (category === "paper") {
    parts.push(normalizePaperAuthorsFromDb(t.paper_authors).join(" "));
  }
  return parts.join("\u0000").normalize("NFKC").toLowerCase();
}

function matchesTextSearch(t: TestRow, raw: string, category: TestsCategory): boolean {
  const q = raw.trim();
  if (!q) return true;
  const needle = q.normalize("NFKC").toLowerCase();
  return testRowSearchBlob(t, category).includes(needle);
}

type ParsedPastKey = { kind: "past"; name: string };

function parsePastSchoolKey(key: string): ParsedPastKey | null {
  const parts = key.split(META_SEP);
  if (parts.length !== 2 || parts[0] !== "past") return null;
  return { kind: "past", name: parts[1] };
}

const selectClass =
  "min-h-[2.5rem] min-w-[12rem] rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition hover:border-zinc-300 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-200 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-400";

const inputClass =
  "min-h-[2.5rem] w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition placeholder:text-zinc-400 hover:border-zinc-300 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-200";

export function TestsBrowseClient({
  tests,
  category,
  showRecent = false,
  /** 過去問・論文を合わせて0件のとき（アップロード案内） */
  globalEmpty,
}: {
  tests: TestRow[];
  category: TestsCategory;
  /** true のときのみ「最近追加」を表示（過去問・論文の専用ページでは使わない） */
  showRecent?: boolean;
  globalEmpty: boolean;
}) {
  const [pastSchoolKey, setPastSchoolKey] = useState("");
  const [paperAuthor, setPaperAuthor] = useState("");
  const [paperIndustry, setPaperIndustry] = useState("");
  const [paperYear, setPaperYear] = useState("");
  const [textSearch, setTextSearch] = useState("");
  const [paperSort, setPaperSort] = useState<PaperSortKey>("created_desc");

  const pastSchoolOptions = usePastSchoolFilterOptions(tests, category);
  const paperIndustryOpts = usePaperIndustryOptions(tests, category);
  const paperAuthorOptions = usePaperAuthorOptions(tests, category, paperIndustry);
  const paperYearOpts = usePaperYearOptions(tests, category, paperIndustry, paperAuthor);

  useEffect(() => {
    if (category !== "past_exam") return;
    const valid = new Set(pastSchoolOptions.map((o) => o.key));
    if (pastSchoolKey && !valid.has(pastSchoolKey)) {
      setPastSchoolKey("");
    }
  }, [pastSchoolOptions, pastSchoolKey, category]);

  useEffect(() => {
    if (category !== "paper") return;
    const { values, hasEmpty } = paperIndustryOpts;
    if (paperIndustry === EMPTY_SENTINEL) {
      if (!hasEmpty) setPaperIndustry("");
      return;
    }
    if (paperIndustry && !values.includes(paperIndustry)) {
      setPaperIndustry("");
    }
  }, [category, paperIndustry, paperIndustryOpts]);

  useEffect(() => {
    if (category !== "paper") return;
    if (paperAuthor && !paperAuthorOptions.includes(paperAuthor)) {
      setPaperAuthor("");
    }
  }, [category, paperAuthor, paperAuthorOptions]);

  useEffect(() => {
    if (category !== "paper") return;
    const { values, hasEmpty } = paperYearOpts;
    if (paperYear === EMPTY_SENTINEL) {
      if (!hasEmpty) setPaperYear("");
      return;
    }
    if (paperYear && !values.includes(paperYear)) {
      setPaperYear("");
    }
  }, [category, paperYear, paperYearOpts]);

  const displayedList = useMemo(() => {
    let list: TestRow[];
    if (category === "past_exam") {
      if (!pastSchoolKey) {
        list = tests;
      } else {
        const parsed = parsePastSchoolKey(pastSchoolKey);
        list = parsed
          ? tests.filter((t) => (t.source_name?.trim() ?? "") === parsed.name)
          : tests;
      }
    } else {
      list = tests.filter((t) =>
        matchesPaperAxisFilters(t, paperAuthor, paperIndustry, paperYear),
      );
    }
    list = list.filter((t) => matchesTextSearch(t, textSearch, category));
    if (category === "paper") {
      return sortPaperRows(list, paperSort);
    }
    return list;
  }, [
    tests,
    category,
    pastSchoolKey,
    paperAuthor,
    paperIndustry,
    paperYear,
    textSearch,
    paperSort,
  ]);

  const hasAxisFilter =
    category === "past_exam"
      ? pastSchoolKey !== ""
      : Boolean(paperAuthor || paperIndustry || paperYear);
  const hasTextFilter = textSearch.trim() !== "";
  const hasActiveFilters = hasAxisFilter || hasTextFilter;

  function clearFilters() {
    setPastSchoolKey("");
    setPaperAuthor("");
    setPaperIndustry("");
    setPaperYear("");
    setTextSearch("");
  }

  const otherHref =
    category === "past_exam" ? TESTS_LIST_PATHS.paper : TESTS_LIST_PATHS.pastExam;
  const otherLabel = category === "past_exam" ? "論文の一覧" : "過去問（学校）の一覧";

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-zinc-600">
        <Link href="/" className="font-medium text-zinc-800 underline-offset-2 hover:underline">
          ホーム
        </Link>
        <span aria-hidden className="text-zinc-400">
          /
        </span>
        <Link href={otherHref} className="underline-offset-2 hover:underline">
          {otherLabel}
        </Link>
      </nav>

      {showRecent && !globalEmpty ? (
        <RecentTestsByCategory tests={tests} filter={category} />
      ) : null}

      <div className="space-y-4">
        <div className="min-h-[4rem]">
          {globalEmpty ? (
            <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-600">
              まだ公開中のテストがありません。ログインしてPDFをアップロードすると、この一覧に表示されます。
            </p>
          ) : tests.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/80 px-4 py-5 text-sm text-zinc-600">
              {category === "past_exam"
                ? "過去問（学校）として登録されたテストはまだありません。"
                : "論文として登録されたテストはまだありません。"}
            </p>
          ) : (
            <>
              <div className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4">
                <div className="flex flex-col gap-4">
                  {category === "paper" ? (
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="flex min-w-0 flex-col gap-1">
                        <label htmlFor="paper-filter-industry" className="text-xs font-medium text-zinc-600">
                          業界
                        </label>
                        <select
                          id="paper-filter-industry"
                          className={`${selectClass} w-full`}
                          value={paperIndustry}
                          onChange={(e) => {
                            setPaperIndustry(e.target.value);
                            setPaperAuthor("");
                            setPaperYear("");
                          }}
                        >
                          <option value="">すべて</option>
                          {paperIndustryOpts.hasEmpty ? (
                            <option value={EMPTY_SENTINEL}>（業界未設定）</option>
                          ) : null}
                          {paperIndustryOpts.values.map((ind) => (
                            <option key={ind} value={ind}>
                              {ind}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex min-w-0 flex-col gap-1">
                        <label htmlFor="paper-filter-author" className="text-xs font-medium text-zinc-600">
                          著者（表示名）
                        </label>
                        <select
                          id="paper-filter-author"
                          className={`${selectClass} w-full`}
                          value={paperAuthor}
                          onChange={(e) => {
                            setPaperAuthor(e.target.value);
                            setPaperYear("");
                          }}
                        >
                          <option value="">すべて</option>
                          {paperAuthorOptions.map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                        {paperIndustry ? (
                          <p className="text-[11px] leading-snug text-zinc-500">
                            業界を選ぶと、著者と発表年の候補が絞り込まれます。
                          </p>
                        ) : null}
                      </div>
                      <div className="flex min-w-0 flex-col gap-1">
                        <label htmlFor="paper-filter-year" className="text-xs font-medium text-zinc-600">
                          発表年
                        </label>
                        <select
                          id="paper-filter-year"
                          className={`${selectClass} w-full`}
                          value={paperYear}
                          onChange={(e) => setPaperYear(e.target.value)}
                        >
                          <option value="">すべて</option>
                          {paperYearOpts.hasEmpty ? (
                            <option value={EMPTY_SENTINEL}>（発表年未設定）</option>
                          ) : null}
                          {paperYearOpts.values.map((y) => (
                            <option key={y} value={y}>
                              {y}年
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ) : (
                    <div className="flex max-w-lg flex-col gap-1">
                      <label htmlFor="filter-past-school" className="text-xs font-medium text-zinc-600">
                        学校名で絞り込み
                      </label>
                      <select
                        id="filter-past-school"
                        className={`${selectClass} w-full max-w-lg`}
                        value={pastSchoolKey}
                        onChange={(e) => setPastSchoolKey(e.target.value)}
                        disabled={pastSchoolOptions.length === 0}
                      >
                        <option value="">すべて</option>
                        {pastSchoolOptions.map((o) => (
                          <option key={o.key} value={o.key}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <label htmlFor="tests-text-search" className="text-xs font-medium text-zinc-600">
                        テキスト検索（タイトル・説明・メタ情報）
                      </label>
                      <input
                        id="tests-text-search"
                        type="search"
                        className={inputClass}
                        placeholder={
                          category === "paper"
                            ? "例: タイトル、DOI、掲載、著者名…"
                            : "例: 学校名、科目、タイトル…"
                        }
                        value={textSearch}
                        onChange={(e) => setTextSearch(e.target.value)}
                        autoComplete="off"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                      <button
                        type="button"
                        onClick={() => clearFilters()}
                        disabled={!hasActiveFilters}
                        className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        条件をクリア
                      </button>
                      {category === "paper" ? (
                        <div className="flex w-full min-w-[12rem] flex-col gap-1 sm:w-auto">
                          <label htmlFor="paper-sort" className="text-xs font-medium text-zinc-600">
                            並び順
                          </label>
                          <select
                            id="paper-sort"
                            className={`${selectClass} w-full sm:min-w-[14rem]`}
                            value={paperSort}
                            onChange={(e) => setPaperSort(e.target.value as PaperSortKey)}
                          >
                            <option value="created_desc">{paperSortLabel("created_desc")}</option>
                            <option value="created_asc">{paperSortLabel("created_asc")}</option>
                            <option value="title_asc">{paperSortLabel("title_asc")}</option>
                            <option value="title_desc">{paperSortLabel("title_desc")}</option>
                            <option value="year_desc">{paperSortLabel("year_desc")}</option>
                            <option value="year_asc">{paperSortLabel("year_asc")}</option>
                          </select>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>

              {displayedList.length === 0 ? (
                <p className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/80 px-4 py-5 text-sm text-zinc-600">
                  条件に一致するテストがありません。絞り込み・検索をクリアするか、別の条件を試してください。
                </p>
              ) : (
                <>
                  <p className="mb-3 text-xs text-zinc-500">
                    {category === "paper"
                      ? hasActiveFilters
                        ? `表示中 ${displayedList.length} 件／区分内 ${tests.length} 件 · ${paperSortLabel(paperSort)}`
                        : `${paperSortLabel(paperSort)}です（全 ${tests.length} 件）。`
                      : hasActiveFilters
                        ? `表示中 ${displayedList.length} 件／区分内 ${tests.length} 件 · 追加が新しい順`
                        : `追加が新しい順です（全 ${tests.length} 件）。`}
                  </p>
                  <TestList
                    tests={displayedList}
                    hideDocumentTypeInCard
                    showPaperMaterialHints={category === "paper"}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
