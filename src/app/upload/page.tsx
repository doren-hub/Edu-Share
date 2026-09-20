"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PaperFormFields } from "@/components/PaperFormFields";
import { PastExamFormFields } from "@/components/PastExamFormFields";
import {
  ensureExpertNamePicklistOptions,
  splitAuthorNamesForPicklist,
} from "@/lib/ensure-expert-picklist-options";
import {
  looksLikeMisparsedAuthors,
  parsePaperMetadataPaste,
} from "@/lib/paper-metadata-paste";
import { createClient } from "@/lib/supabase/client";

export default function UploadPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [ready, setReady] = useState<boolean | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [documentType, setDocumentType] = useState<"past_exam" | "paper">(
    "paper",
  );

  const [schoolName, setSchoolName] = useState("");
  const [examDepartment, setExamDepartment] = useState("");
  const [examSubject, setExamSubject] = useState("");
  const [examPeriod, setExamPeriod] = useState("");

  const [paperAuthors, setPaperAuthors] = useState<string[]>([""]);
  const [paperVenue, setPaperVenue] = useState("");
  const [paperDoi, setPaperDoi] = useState("");
  const [industry, setIndustry] = useState("");
  const [publicationYear, setPublicationYear] = useState("");

  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoFilling, setAutoFilling] = useState(false);
  const [autoFillNote, setAutoFillNote] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [paperMetadataPaste, setPaperMetadataPaste] = useState("");
  const [authorsPicklistKey, setAuthorsPicklistKey] = useState(0);
  const [pastingPaperMeta, setPastingPaperMeta] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setReady(!!data.user));
  }, [supabase]);

  useEffect(() => {
    if (documentType === "paper") {
      setSchoolName("");
      setExamDepartment("");
      setExamSubject("");
      setExamPeriod("");
    } else {
      setPaperAuthors([""]);
      setPaperVenue("");
      setPaperDoi("");
      setIndustry("");
      setPublicationYear("");
    }
  }, [documentType]);

  async function onPickFile(nextFile: File | null) {
    setFile(nextFile);
    setAutoFillNote(null);
    if (!nextFile) return;

    setAutoFilling(true);
    try {
      const fd = new FormData();
      fd.set("file", nextFile);
      const res = await fetch("/api/tests/upload/autofill", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      const json = (await res.json().catch(() => null)) as
        | {
            error?: string;
            autofill?: {
              title?: string;
              description?: string;
              document_type?: "past_exam" | "paper";
              school_name?: string;
              exam_department?: string;
              exam_subject?: string;
              exam_period?: string;
              expert_name?: string;
              paper_authors?: string[];
              paper_venue?: string;
              paper_doi?: string;
              industry?: string;
              publication_year?: string;
            };
          }
        | null;
      if (!res.ok || !json?.autofill) {
        const reason = json?.error?.trim();
        setAutoFillNote(
          reason
            ? `自動入力はスキップされました（${reason}）。必要項目を手入力してください。`
            : "自動入力はスキップされました。必要項目を手入力してください。",
        );
        return;
      }
      const a = json.autofill;
      if (a.title) setTitle(a.title);
      if (a.description) setDescription(a.description);
      if (a.document_type) setDocumentType(a.document_type);
      setSchoolName(a.school_name ?? "");
      setExamDepartment(a.exam_department ?? "");
      setExamSubject(a.exam_subject ?? "");
      setExamPeriod(a.exam_period ?? "");
      if (Array.isArray(a.paper_authors) && a.paper_authors.length > 0) {
        setPaperAuthors(a.paper_authors.map(String));
      } else if (a.expert_name) {
        setPaperAuthors([a.expert_name]);
      }
      setPaperVenue(a.paper_venue ?? "");
      setPaperDoi(a.paper_doi ?? "");
      setIndustry(a.industry ?? "");
      setPublicationYear(a.publication_year ?? "");
      setAutoFillNote("PDF内容から項目を自動入力しました。内容を確認してから送信してください。");
    } catch (e) {
      const reason = e instanceof Error ? e.message : "";
      setAutoFillNote(
        reason
          ? `自動入力に失敗しました（${reason}）。必要項目を手入力してください。`
          : "自動入力に失敗しました。必要項目を手入力してください。",
      );
    } finally {
      setAutoFilling(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError("PDFを選択してください");
      return;
    }

    const authors = paperAuthors.map((a) => a.trim()).filter(Boolean);
    if (documentType === "paper" && authors.length === 0) {
      setError("論文では著者を1人以上選択してください");
      return;
    }
    if (!title.trim()) {
      setError("タイトルを入力してください");
      return;
    }

    setLoading(true);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("title", title);
    fd.set("description", description);
    fd.set("document_type", documentType);

    if (documentType === "past_exam") {
      fd.set("school_name", schoolName.trim());
      fd.set("exam_department", examDepartment.trim());
      fd.set("exam_subject", examSubject.trim());
      fd.set("exam_period", examPeriod.trim());
    } else {
      fd.set("paper_authors", JSON.stringify(authors));
      fd.set("paper_venue", paperVenue.trim());
      fd.set("paper_doi", paperDoi.trim());
      fd.set("industry", industry.trim());
      fd.set("publication_year", publicationYear.trim());
    }

    let res: Response;
    try {
      res = await fetch("/api/tests/upload", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
    } catch (e) {
      setLoading(false);
      setError(
        e instanceof Error
          ? `通信に失敗しました: ${e.message}`
          : "通信に失敗しました。ネットワークを確認してください。",
      );
      return;
    }

    const raw = await res.text();
    setLoading(false);

    type UploadJson = {
      error?: string;
      message?: string;
      details?: unknown;
      testId?: string;
    };
    let json: UploadJson | null = null;
    try {
      json = raw ? (JSON.parse(raw) as UploadJson) : null;
    } catch {
      setError(
        `アップロードに失敗しました（HTTP ${res.status}）。応答を解釈できませんでした。` +
          (raw ? `\n${raw.slice(0, 600)}` : ""),
      );
      return;
    }

    if (!res.ok) {
      if (res.status === 409 && typeof json?.testId === "string" && json.testId) {
        router.push(`/tests/${json.testId}`);
        return;
      }
      if (res.status === 413) {
        setError(
          "アップロードデータが大きすぎます（HTTP 413）。PDF のサイズを抑えるか、ホスティングのリクエスト上限を確認してください。",
        );
        return;
      }
      const base =
        (typeof json?.error === "string" && json.error.trim()
          ? json.error.trim()
          : null) ||
        (typeof json?.message === "string" && json.message.trim()
          ? json.message.trim()
          : null) ||
        `アップロードに失敗しました（HTTP ${res.status}）`;
      const d = json?.details;
      let detail = "";
      if (typeof d === "string" && d.trim()) {
        detail = d.trim();
      } else if (d != null && typeof d === "object") {
        try {
          detail = JSON.stringify(d, null, 2).slice(0, 4000);
        } catch {
          detail = String(d);
        }
      }
      if (
        !detail &&
        json &&
        typeof json === "object" &&
        base === `アップロードに失敗しました（HTTP ${res.status}）`
      ) {
        try {
          detail = JSON.stringify(json, null, 2).slice(0, 4000);
        } catch {
          /* ignore */
        }
      }
      setError(detail ? `${base}\n\n${detail}` : base);
      return;
    }
    if (json?.testId) {
      router.push(`/tests/${json.testId}`);
      router.refresh();
    }
  }

  async function applyPaperMetadataPaste() {
    setPastingPaperMeta(true);
    try {
    const parsed = parsePaperMetadataPaste(paperMetadataPaste);
    if (parsed.title) setTitle(parsed.title);
    if (parsed.publicationYear) setPublicationYear(parsed.publicationYear);
    if (parsed.venue) setPaperVenue(parsed.venue);
    if (parsed.doi) setPaperDoi(parsed.doi);

    let picklistMsg: string | null = null;
    let authorsWarning: string | null = null;
    if (parsed.authors) {
      const names = splitAuthorNamesForPicklist(parsed.authors);
      if (names.length > 0 && looksLikeMisparsedAuthors(names)) {
        authorsWarning =
          "著者の解析に失敗した可能性があるため、著者は反映しませんでした。貼り付け内容を確認するか、手動で著者を入力してください。";
      } else if (names.length > 0) {
        const { values, message } = await ensureExpertNamePicklistOptions(names);
        setPaperAuthors(values);
        setAuthorsPicklistKey((k: number) => k + 1);
        picklistMsg = message;
      }
    }
    if (parsed.authorsTruncated) {
      const n = parsed.truncatedAuthorsCount;
      authorsWarning =
        (authorsWarning ? `${authorsWarning}\n` : "") +
        `貼り付け元で著者が省略されています（他${n ?? "数"}名、"...+${n ?? "N"} More" 等の表記）。不足分は手動で追記してください。`;
    }
    const venueWarning = parsed.venueUncertain
      ? `掲載欄には「${parsed.venue}」を反映しましたが、分野タグ等の可能性があり掲載誌名として未確認です。内容を確認・修正してください。`
      : null;

    const ok =
      Boolean(parsed.title) ||
      Boolean(parsed.publicationYear) ||
      Boolean(parsed.venue) ||
      Boolean(parsed.doi) ||
      Boolean(parsed.authors);
    const warnings = [venueWarning, authorsWarning].filter(Boolean).join("\n");
    if (ok) {
      const base =
        "貼り付けを反映しました。業界・発表年は任意です。必要なら入力してください。";
      const noted = picklistMsg ? `${base}${picklistMsg}` : base;
      setAutoFillNote(warnings ? `${noted}\n${warnings}` : noted);
    } else {
      setAutoFillNote(
        "貼り付けから有効な項目を検出できませんでした。形式（Title: / DOI / 著者 / 年-掲載）を確認してください。",
      );
    }
    } finally {
      setPastingPaperMeta(false);
    }
  }

  async function onSummarizePdf() {
    if (!file) {
      setError("先にPDFを選択してください");
      return;
    }
    setError(null);
    setSummarizing(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/api/tests/upload/summarize", {
        method: "POST",
        body: fd,
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
      setAutoFillNote("PDFの内容を要約し、説明欄に反映しました。必要に応じて編集してください。");
    } finally {
      setSummarizing(false);
    }
  }


  if (ready === null) {
    return (
      <div className="mx-auto max-w-xl space-y-3">
        <h1 className="text-2xl font-semibold text-zinc-950">PDFアップロード</h1>
        <p className="text-sm text-zinc-600">読み込み中...</p>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="mx-auto max-w-xl space-y-3">
        <h1 className="text-2xl font-semibold text-zinc-950">PDFアップロード</h1>
        <p className="text-sm text-zinc-600">
          この機能はログインが必要です。{" "}
          <Link className="underline" href="/auth/login">
            ログイン
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-950">PDFアップロード</h1>
        <p className="mt-2 text-sm text-zinc-600">
          資料の種類に応じて必要な項目を入力してください。取り込み後、過去問（学校）または論文の一覧に表示されます。
          画像のみのスキャンPDFはテキストが取れないことがあります。可能なら、ブラウザで文字を選択できる「テキスト付きPDF」をご利用ください。
        </p>
      </div>

      <form
        onSubmit={(e) => void onSubmit(e)}
        className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
      >
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-700">タイトル</span>
          <input
            className="w-full rounded-md border border-zinc-200 px-3 py-2"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </label>

        <label className="block space-y-1 text-sm">
          <span className="text-zinc-700">説明（任意）</span>
          <div className="mb-1 flex justify-end">
            <button
              type="button"
              onClick={() => void onSummarizePdf()}
              disabled={
                !file || summarizing || autoFilling || loading || pastingPaperMeta
              }
              className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {summarizing ? "要約中..." : "PDF内容を要約"}
            </button>
          </div>
          <textarea
            className="min-h-[90px] w-full rounded-md border border-zinc-200 px-3 py-2"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <label className="block space-y-1 text-sm">
          <span className="text-zinc-700">資料の種類</span>
          <select
            className="w-full rounded-md border border-zinc-200 px-3 py-2"
            value={documentType}
            onChange={(e) =>
              setDocumentType(e.target.value as "past_exam" | "paper")
            }
          >
            <option value="paper">論文</option>
            <option value="past_exam">過去問</option>
          </select>
        </label>

        {documentType === "past_exam" ? (
          <PastExamFormFields
            schoolName={schoolName}
            onSchoolName={setSchoolName}
            examDepartment={examDepartment}
            onExamDepartment={setExamDepartment}
            examSubject={examSubject}
            onExamSubject={setExamSubject}
            examPeriod={examPeriod}
            onExamPeriod={setExamPeriod}
          />
        ) : (
          <>
            <div className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/60 p-4">
              <p className="text-xs font-medium text-zinc-800">
                SciSpace などからコピーしたメタ情報（任意）
              </p>
              <textarea
                className="min-h-[100px] w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-xs text-zinc-800"
                placeholder={
                  "例:\nTitle: …\n10.1234/example\n著者名, …\n2025-Journal Name"
                }
                value={paperMetadataPaste}
                onChange={(e) => setPaperMetadataPaste(e.target.value)}
              />
              <button
                type="button"
                onClick={() => void applyPaperMetadataPaste()}
                disabled={
                  !paperMetadataPaste.trim() ||
                  loading ||
                  autoFilling ||
                  pastingPaperMeta
                }
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pastingPaperMeta ? "反映中..." : "貼り付けから項目に反映"}
              </button>
              <p className="text-[11px] leading-relaxed text-zinc-600">
                タイトル・発表年・掲載・DOI・著者に反映します。TL;DR や説明文は上の説明欄へ。著者名はカンマ区切りで分割し、ピックリストの選択肢にも登録します。業界・発表年は任意です。
              </p>
            </div>
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

        <label className="block space-y-1 text-sm">
          <span className="text-zinc-700">PDF</span>
          <input
            type="file"
            accept="application/pdf"
            className="w-full text-sm"
            onChange={(e) => {
              void onPickFile(e.target.files?.[0] ?? null);
            }}
            required
          />
        </label>

        {autoFilling ? (
          <p className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
            PDFを解析して項目を自動入力しています...
          </p>
        ) : autoFillNote ? (
          <p className="whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
            {autoFillNote}
          </p>
        ) : null}

        {error ? (
          <p className="whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {loading ? "アップロード中..." : "アップロードして取り込み"}
        </button>
      </form>
    </div>
  );
}
