"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { PaperFormFields } from "@/components/PaperFormFields";
import { PastExamFormFields } from "@/components/PastExamFormFields";
import { normalizePaperAuthorsFromDb } from "@/lib/paper-authors";
import { fetchPicklistValues } from "@/lib/picklist-api";
import { assertStoredPickWithOther } from "@/lib/picklist-parse";
import type { DocumentType } from "@/lib/types";

export type TestMetadataInitial = {
  id: string;
  title: string;
  description: string | null;
  source_name: string;
  document_type: DocumentType | null;
  exam_department: string | null;
  exam_subject: string | null;
  exam_period: string | null;
  industry: string | null;
  publication_year: string | null;
  paper_authors?: unknown;
  paper_venue?: string | null;
  paper_doi?: string | null;
};

export function TestMetadataEditor({ initial }: { initial: TestMetadataInitial }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description ?? "");
  const [primaryName, setPrimaryName] = useState(initial.source_name);
  const [documentType, setDocumentType] = useState<DocumentType>(
    initial.document_type ?? "past_exam",
  );

  const [examDepartment, setExamDepartment] = useState("");
  const [examSubject, setExamSubject] = useState("");
  const [examPeriod, setExamPeriod] = useState("");

  const [industry, setIndustry] = useState("");
  const [publicationYear, setPublicationYear] = useState("");
  const [paperAuthors, setPaperAuthors] = useState<string[]>([""]);
  const [paperVenue, setPaperVenue] = useState("");
  const [paperDoi, setPaperDoi] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [authorsPicklistKey, setAuthorsPicklistKey] = useState(0);
  const prevDocumentType = useRef<DocumentType | null>(null);

  const applyExamFromInitial = useCallback(() => {
    setExamDepartment((initial.exam_department ?? "").trim());
    setExamSubject((initial.exam_subject ?? "").trim());
    setExamPeriod((initial.exam_period ?? "").trim());
  }, [initial.exam_department, initial.exam_subject, initial.exam_period]);

  const applyPaperFromInitial = useCallback(() => {
    setIndustry((initial.industry ?? "").trim());
    const y = (initial.publication_year ?? "").trim();
    setPublicationYear(y && /^\d{4}$/.test(y) ? y : "");
    setPaperVenue((initial.paper_venue ?? "").trim());
    setPaperDoi((initial.paper_doi ?? "").trim());
    const fromArr = normalizePaperAuthorsFromDb(initial.paper_authors);
    if (fromArr.length > 0) {
      setPaperAuthors(fromArr);
    } else {
      const sn = (initial.source_name ?? "").trim();
      setPaperAuthors(sn ? [sn] : [""]);
    }
  }, [
    initial.industry,
    initial.publication_year,
    initial.paper_venue,
    initial.paper_doi,
    initial.paper_authors,
    initial.source_name,
  ]);

  const resetFromInitial = useCallback(() => {
    setTitle(initial.title);
    setDescription(initial.description ?? "");
    setPrimaryName(initial.source_name);
    setDocumentType(initial.document_type ?? "past_exam");
    applyExamFromInitial();
    applyPaperFromInitial();
  }, [initial, applyExamFromInitial, applyPaperFromInitial]);

  useEffect(() => {
    if (!open) resetFromInitial();
  }, [initial, open, resetFromInitial]);

  useEffect(() => {
    const prev = prevDocumentType.current;
    if (prev === "past_exam" && documentType === "paper") {
      setExamDepartment("");
      setExamSubject("");
      setExamPeriod("");
      applyPaperFromInitial();
    } else if (prev === "paper" && documentType === "past_exam") {
      setIndustry("");
      setPublicationYear("");
      setPaperAuthors([""]);
      setPaperVenue("");
      setPaperDoi("");
      applyExamFromInitial();
    }
    prevDocumentType.current = documentType;
  }, [documentType, applyExamFromInitial, applyPaperFromInitial]);

  function openEditor() {
    resetFromInitial();
    prevDocumentType.current = initial.document_type ?? "past_exam";
    setError(null);
    setNote(null);
    setOpen(true);
  }

  function closeEditor() {
    setOpen(false);
    setError(null);
    setNote(null);
  }

  async function onSummarize() {
    setError(null);
    setNote(null);
    setSummarizing(true);
    try {
      const res = await fetch(`/api/tests/${initial.id}/summarize`, {
        method: "POST",
        credentials: "include",
      });
      const json = (await res.json().catch(() => null)) as
        | { summary?: string; error?: string }
        | null;
      if (!res.ok || !json?.summary) {
        setError(json?.error || "要約の生成に失敗しました");
        return;
      }
      setDescription(json.summary);
      setNote("PDF内容の要約を説明欄に反映しました。必要に応じて編集してください。");
    } finally {
      setSummarizing(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const initialDoc = initial.document_type ?? "past_exam";
    const payload: Record<string, unknown> = {
      title,
      description: description.trim() === "" ? null : description.trim(),
    };

    if (documentType === "past_exam") {
      payload.source_name = primaryName.trim();
    }

    if (documentType !== initialDoc) {
      payload.document_type = documentType;
    }

    try {
      if (documentType === "past_exam") {
        const schoolVals = await fetchPicklistValues("school_name");
        const school = assertStoredPickWithOther(
          primaryName,
          schoolVals,
          true,
          "学校名",
        );
        if (!school.ok) {
          setError(school.message);
          return;
        }
        const deptVals = await fetchPicklistValues("department_name", {
          school: school.value,
        });
        const dept = assertStoredPickWithOther(
          examDepartment,
          deptVals,
          true,
          "学科名",
        );
        if (!dept.ok) {
          setError(dept.message);
          return;
        }
        const [subVals, perVals] = await Promise.all([
          fetchPicklistValues("exam_subject", {
            school: school.value,
            department: dept.value,
          }),
          fetchPicklistValues("exam_period", {
            school: school.value,
            department: dept.value,
          }),
        ]);
        const sub = assertStoredPickWithOther(
          examSubject,
          subVals,
          true,
          "科目",
        );
        const per = assertStoredPickWithOther(
          examPeriod,
          perVals,
          true,
          "テストの時期",
        );
        if (!sub.ok || !per.ok) {
          setError(
            [sub.ok ? "" : sub.message, per.ok ? "" : per.message]
              .filter(Boolean)
              .join("\n"),
          );
          return;
        }
        payload.source_name = school.value;
        payload.exam_department = dept.value;
        payload.exam_subject = sub.value;
        payload.exam_period = per.value;
        payload.industry = null;
        payload.publication_year = null;
        payload.paper_authors = null;
        payload.paper_venue = null;
        payload.paper_doi = null;
      } else {
        const authorsFiltered = paperAuthors.map((a) => a.trim()).filter(Boolean);
        if (authorsFiltered.length === 0) {
          setError("著者を1人以上選択してください");
          return;
        }
        const [expVals, indVals, yearVals] = await Promise.all([
          fetchPicklistValues("expert_name"),
          fetchPicklistValues("paper_industry"),
          fetchPicklistValues("publication_year"),
        ]);
        const resolvedAuthors: string[] = [];
        for (const raw of authorsFiltered) {
          const exp = assertStoredPickWithOther(raw, expVals, true, "著者");
          if (!exp.ok) {
            setError(exp.message);
            return;
          }
          if (!resolvedAuthors.includes(exp.value)) resolvedAuthors.push(exp.value);
        }
        let industryPayload: string | null = null;
        if (industry.trim()) {
          const ind = assertStoredPickWithOther(
            industry,
            indVals,
            true,
            "業界",
          );
          if (!ind.ok) {
            setError(ind.message);
            return;
          }
          industryPayload = ind.value;
        }
        let yearPayload: string | null = null;
        if (publicationYear.trim()) {
          const year = assertStoredPickWithOther(
            publicationYear,
            yearVals,
            false,
            "発表年",
          );
          if (!year.ok) {
            setError(year.message);
            return;
          }
          if (!/^\d{4}$/.test(year.value)) {
            setError("発表年は西暦4桁を選んでください");
            return;
          }
          yearPayload = year.value;
        }
        payload.paper_authors = resolvedAuthors;
        payload.paper_venue = paperVenue.trim() === "" ? null : paperVenue.trim();
        payload.paper_doi = paperDoi.trim() === "" ? null : paperDoi.trim();
        payload.industry = industryPayload;
        payload.publication_year = yearPayload;
        payload.exam_department = null;
        payload.exam_subject = null;
        payload.exam_period = null;
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "候補の取得に失敗しました。マイグレーション済みか確認してください。",
      );
      return;
    }

    setLoading(true);
    const res = await fetch(`/api/tests/${initial.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => null)) as {
      error?: string;
      details?: unknown;
    } | null;
    setLoading(false);
    if (!res.ok) {
      setError(json?.error || "保存に失敗しました");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <section className="mt-10 border-t border-zinc-100 pt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-zinc-950">資料情報</h2>
        {!open ? (
          <button
            type="button"
            onClick={() => openEditor()}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
          >
            編集する
          </button>
        ) : null}
      </div>

      {!open ? (
        <p className="mt-2 text-sm text-zinc-600">
          タイトル・説明・学校名／著者などは、必要なときだけ「編集する」から変更できます。
        </p>
      ) : null}

      {open ? (
        <>
          <p className="mt-2 text-sm text-zinc-600">
            PDFファイル本体の差し替えは、詳細ページの「PDFの差し替え」から行えます。
          </p>

          <form
            onSubmit={(e) => void onSubmit(e)}
            className="mt-4 space-y-4 rounded-lg border border-zinc-200 bg-zinc-50/50 p-5"
          >
            <label className="block space-y-1 text-sm">
              <span className="text-zinc-700">タイトル</span>
              <input
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={200}
              />
            </label>

            <label className="block space-y-1 text-sm">
              <span className="text-zinc-700">説明（任意）</span>
              <div className="mb-1 flex justify-end">
                <button
                  type="button"
                  onClick={() => void onSummarize()}
                  disabled={summarizing || loading}
                  className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {summarizing ? "要約中..." : "PDF内容を要約"}
                </button>
              </div>
              <textarea
                className="min-h-[80px] w-full rounded-md border border-zinc-200 bg-white px-3 py-2"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
              />
            </label>

            {note ? (
              <p className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
                {note}
              </p>
            ) : null}

            <label className="block space-y-1 text-sm">
              <span className="text-zinc-700">資料の種類</span>
              <select
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2"
                value={documentType}
                onChange={(e) =>
                  setDocumentType(e.target.value as DocumentType)
                }
              >
                <option value="past_exam">過去問</option>
                <option value="paper">論文</option>
              </select>
            </label>

            {documentType === "past_exam" ? (
              <PastExamFormFields
                schoolName={primaryName}
                onSchoolName={setPrimaryName}
                examDepartment={examDepartment}
                onExamDepartment={setExamDepartment}
                examSubject={examSubject}
                onExamSubject={setExamSubject}
                examPeriod={examPeriod}
                onExamPeriod={setExamPeriod}
              />
            ) : (
              <>
                <PaperFormFields
                  authorsPicklistKey={authorsPicklistKey}
                  paperAuthors={paperAuthors}
                  onPaperAuthors={setPaperAuthors}
                  paperVenue={paperVenue}
                  onPaperVenue={setPaperVenue}
                  paperDoi={paperDoi}
                  onPaperDoi={setPaperDoi}
                  industry={industry}
                  onIndustry={setIndustry}
                  publicationYear={publicationYear}
                  onPublicationYear={setPublicationYear}
                />
              </>
            )}

            {error ? (
              <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={loading}
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
              >
                {loading ? "保存中..." : "変更を保存"}
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => closeEditor()}
                className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
              >
                閉じる
              </button>
            </div>
          </form>
        </>
      ) : null}
    </section>
  );
}
