"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ensureExpertNamePicklistOptions,
  ensurePublicationYearPicklistOption,
  splitAuthorNamesForPicklist,
} from "@/lib/ensure-expert-picklist-options";
import {
  looksLikeMisparsedAuthors,
  parsePaperMetadataPaste,
} from "@/lib/paper-metadata-paste";
import { fetchPicklistValues } from "@/lib/picklist-api";
import { assertStoredPickWithOther } from "@/lib/picklist-parse";

export type SciSpacePaperMetadataInitial = {
  title: string;
  paperAuthors: string[];
  paperVenue: string;
  paperDoi: string;
  industry: string;
  publicationYear: string;
};

export function SciSpacePaperMetadataPaste({
  testId,
  initialFields,
}: {
  testId: string;
  initialFields: SciSpacePaperMetadataInitial;
}) {
  const router = useRouter();
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function applyAndSave() {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const parsed = parsePaperMetadataPaste(paste);
      const mergedTitle = (parsed.title?.trim() && parsed.title.trim()) || initialFields.title;
      const mergedVenue = (parsed.venue?.trim() && parsed.venue.trim()) || initialFields.paperVenue.trim();
      const mergedDoi = (parsed.doi?.trim() && parsed.doi.trim()) || initialFields.paperDoi.trim();
      let mergedYear =
        (parsed.publicationYear?.trim() && parsed.publicationYear.trim()) ||
        initialFields.publicationYear.trim();
      if (mergedYear && !/^\d{4}$/.test(mergedYear)) {
        mergedYear = initialFields.publicationYear.trim();
      }

      let mergedAuthors = initialFields.paperAuthors;
      let picklistMsg: string | null = null;
      let authorsWarning: string | null = null;
      if (parsed.authors?.trim()) {
        const names = splitAuthorNamesForPicklist(parsed.authors);
        if (names.length > 0 && looksLikeMisparsedAuthors(names)) {
          authorsWarning =
            "著者の解析に失敗した可能性があるため、著者は変更せず既存の値を保持しました。貼り付け内容を確認するか、「資料情報」から著者を編集してください。";
        } else if (names.length > 0) {
          const { values, message } = await ensureExpertNamePicklistOptions(names);
          mergedAuthors = values;
          picklistMsg = message;
        }
      }
      if (parsed.authorsTruncated) {
        const n = parsed.truncatedAuthorsCount;
        authorsWarning =
          (authorsWarning ? `${authorsWarning}\n` : "") +
          `貼り付け元で著者が省略されています（他${n ?? "数"}名、"...+${n ?? "N"} More" 等の表記）。「資料情報」から不足分を追記してください。`;
      }
      const venueWarning = parsed.venueUncertain
        ? `掲載欄には「${parsed.venue}」を設定しますが、分野タグ等の可能性があり掲載誌名として未確認です。「資料情報」から確認・修正してください。`
        : null;

      const hadAnyParsed =
        Boolean(parsed.title?.trim()) ||
        Boolean(parsed.publicationYear?.trim()) ||
        Boolean(parsed.venue?.trim()) ||
        Boolean(parsed.doi?.trim()) ||
        Boolean(parsed.authors?.trim());
      if (!hadAnyParsed) {
        setError(
          "貼り付けから有効な項目を検出できませんでした。形式（Title: / DOI / 著者 / 年-掲載）を確認してください。",
        );
        return;
      }

      const authorsFiltered = mergedAuthors.map((a) => a.trim()).filter(Boolean);
      if (authorsFiltered.length === 0) {
        setError(
          "著者が未設定です。貼り付けに著者行を含めるか、「資料情報」から著者を登録してください。",
        );
        return;
      }

      const [expVals, indVals] = await Promise.all([
        fetchPicklistValues("expert_name"),
        fetchPicklistValues("paper_industry"),
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
      const industry = initialFields.industry.trim();
      if (industry) {
        const ind = assertStoredPickWithOther(industry, indVals, true, "業界");
        if (!ind.ok) {
          setError(ind.message);
          return;
        }
        industryPayload = ind.value;
      }
      let yearPayload: string | null = null;
      let yearEnsureNote: string | null = null;
      if (mergedYear) {
        if (/^\d{4}$/.test(mergedYear)) {
          const ensured = await ensurePublicationYearPicklistOption(mergedYear);
          if (!ensured.ok) {
            setError(ensured.message ?? "発表年を保存できませんでした");
            return;
          }
          if (ensured.message) yearEnsureNote = ensured.message;
        }
        const yearVals = await fetchPicklistValues("publication_year");
        const year = assertStoredPickWithOther(mergedYear, yearVals, false, "発表年");
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

      const payload = {
        title: mergedTitle,
        paper_authors: resolvedAuthors,
        paper_venue: mergedVenue === "" ? null : mergedVenue,
        paper_doi: mergedDoi === "" ? null : mergedDoi,
        industry: industryPayload,
        publication_year: yearPayload,
      };

      const res = await fetch(`/api/tests/${testId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(json?.error || "保存に失敗しました");
        return;
      }

      const base =
        "メタ情報を保存しました。貼り付けに発表年が含まれる場合はテストの発表年にも反映されます。業界は貼り付けでは変えず、既存の値がそのまま使われます。";
      const extras = [yearEnsureNote, picklistMsg]
        .filter(Boolean)
        .join("");
      const warnings = [venueWarning, authorsWarning].filter(Boolean).join("\n");
      setNote(
        [extras ? `${base}${extras}` : base, warnings].filter(Boolean).join("\n"),
      );
      setPaste("");
      router.refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "候補の取得に失敗しました。マイグレーション済みか確認してください。",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t border-sky-200/80 pt-4">
      <div className="rounded-md border border-sky-200/80 bg-white/70 p-3">
        <p className="text-xs font-medium text-sky-950">
          SciSpace などからコピーしたメタ情報（任意）
        </p>
        <p className="mt-1 text-xs text-sky-900/85">
          タイトル・発表年・掲載・DOI・著者を解析してテストに保存します。発表年は候補に無い西暦4桁でも自動で候補に追加してから保存します。著者名もピックリストの選択肢に登録します。業界は貼り付けからは変えず、必要なら「資料情報」から編集してください。
        </p>
        <textarea
          className="mt-2 min-h-[100px] w-full rounded-md border border-sky-200 bg-white px-3 py-2 font-mono text-xs text-zinc-800"
          placeholder={"例:\nTitle: …\n10.1234/example\n著者名, …\n2025-Journal Name"}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          disabled={busy}
        />
        <button
          type="button"
          onClick={() => void applyAndSave()}
          disabled={!paste.trim() || busy}
          className="mt-2 rounded-md border border-sky-300 bg-white px-3 py-1.5 text-xs font-medium text-sky-950 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "保存中…" : "貼り付けを反映して保存"}
        </button>
        {error ? (
          <p className="mt-2 whitespace-pre-wrap break-words text-xs text-red-700" role="alert">
            {error}
          </p>
        ) : null}
        {note ? (
          <p className="mt-2 whitespace-pre-wrap break-words text-xs text-sky-900">
            {note}
          </p>
        ) : null}
      </div>
    </div>
  );
}
