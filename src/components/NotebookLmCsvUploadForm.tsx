"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type ExpectedMode = "quiz" | "flashcard";

async function postNotebookLmCsv(fd: FormData): Promise<{
  ok: boolean;
  error?: string;
  details?: string;
  testId?: string;
  updated?: boolean;
}> {
  const res = await fetch("/api/tests/upload/notebooklm-csv", {
    method: "POST",
    body: fd,
    credentials: "include",
  });
  const json = (await res.json().catch(() => null)) as
    | {
        error?: string;
        details?: string;
        testId?: string;
        updated?: boolean;
      }
    | null;
  if (!res.ok) {
    const base = json?.error || "CSVのアップロードに失敗しました";
    const detail = json?.details?.trim();
    return { ok: false, error: detail ? `${base}\n${detail}` : base };
  }
  return {
    ok: true,
    testId: json?.testId,
    updated: json?.updated,
  };
}

export function NotebookLmCsvUploadForm({
  defaultTitle,
  defaultDescription,
  /** 指定時は新規作成せず、このテストに CSV設問を反映する（同じページのまま） */
  existingTestId,
  /** 既存テストのみ。クイズ CSV プールの設問数（0 は未取り込み） */
  notebookLmQuizQuestionCount = 0,
  /** 既存テストのみ。単語帳 CSV プールの設問数（0 は未取り込み） */
  notebookLmVocabQuestionCount = 0,
}: {
  defaultTitle: string;
  defaultDescription: string | null;
  existingTestId?: string;
  notebookLmQuizQuestionCount?: number;
  notebookLmVocabQuestionCount?: number;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(
    existingTestId?.trim() ? defaultTitle : `${defaultTitle}（NotebookLM）`,
  );
  const [description, setDescription] = useState(defaultDescription ?? "");
  const quizInputRef = useRef<HTMLInputElement>(null);
  const vocabInputRef = useRef<HTMLInputElement>(null);
  const [quizFile, setQuizFile] = useState<File | null>(null);
  const [vocabFile, setVocabFile] = useState<File | null>(null);
  const [quizBusy, setQuizBusy] = useState(false);
  const [vocabBusy, setVocabBusy] = useState(false);
  const [quizError, setQuizError] = useState<string | null>(null);
  const [vocabError, setVocabError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function submitForMode(expectedMode: ExpectedMode, file: File | null) {
    const setBusy = expectedMode === "quiz" ? setQuizBusy : setVocabBusy;
    const setErr = expectedMode === "quiz" ? setQuizError : setVocabError;
    setErr(null);
    setNote(null);
    if (!file) {
      setErr("CSVファイルを選択してください");
      return;
    }
    const submitTitle = existingTestId?.trim()
      ? defaultTitle.trim()
      : title.trim();
    if (!submitTitle) {
      setErr("タイトルを入力してください");
      return;
    }

    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("expectedMode", expectedMode);
      fd.set("title", submitTitle);
      fd.set(
        "description",
        existingTestId?.trim()
          ? (defaultDescription ?? "").trim()
          : description.trim(),
      );
      if (existingTestId?.trim()) {
        fd.set("existingTestId", existingTestId.trim());
      }
      const result = await postNotebookLmCsv(fd);
      if (!result.ok) {
        setErr(result.error ?? "CSVのアップロードに失敗しました");
        return;
      }
      setNote(
        expectedMode === "quiz"
          ? "クイズ CSV を取り込みました。"
          : "単語帳（Flashcard）CSV を取り込みました。",
      );
      if (result.testId) {
        if (result.updated) {
          router.refresh();
        } else {
          router.push(`/tests/${result.testId}`);
          router.refresh();
        }
      }
      if (expectedMode === "quiz") {
        setQuizFile(null);
        if (quizInputRef.current) quizInputRef.current.value = "";
      } else {
        setVocabFile(null);
        if (vocabInputRef.current) vocabInputRef.current.value = "";
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "CSVのアップロードに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <h4 className="text-sm font-semibold text-zinc-900">NotebookLM CSV（設問プール）</h4>
      <p className="mt-1 text-xs text-zinc-600">
        クイズ用と単語帳用で列形式が異なります。取り込み先の欄に合った CSV を選んでください。一方だけ取り込んでも他方のデータは消えません。
      </p>

      {!existingTestId?.trim() ? (
        <div className="mt-3 space-y-3 border-b border-zinc-100 pb-3">
          <p className="text-xs font-medium text-zinc-800">
            NotebookLMのCSVから専用テストを作成
          </p>
          <label className="block space-y-1 text-xs">
            <span className="text-zinc-700">タイトル</span>
            <input
              className="w-full rounded border border-zinc-200 px-2 py-1.5 text-sm"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="text-zinc-700">説明（任意）</span>
            <textarea
              className="min-h-[72px] w-full rounded border border-zinc-200 px-2 py-1.5 text-sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </div>
      ) : null}

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-zinc-100 bg-zinc-50/80 p-3">
          <p className="text-xs font-medium text-zinc-800">クイズ（選択肢）</p>
          <p className="mt-0.5 text-xs leading-snug text-zinc-500">
            問題・選択肢 A〜E・正解などの列がある NotebookLM の<strong>クイズ</strong>
            形式 CSV 用です。
          </p>
          {existingTestId?.trim() ? (
            <p className="mt-1 text-xs text-zinc-600">
              {notebookLmQuizQuestionCount > 0
                ? `取り込み済み（${notebookLmQuizQuestionCount}問）`
                : "未取り込み"}
              {quizBusy ? "（処理中…）" : null}
            </p>
          ) : null}
          <input
            ref={quizInputRef}
            type="file"
            accept=".csv,text/csv"
            disabled={quizBusy}
            className="mt-2 block w-full text-xs text-zinc-700 file:mr-2 file:rounded file:border-0 file:bg-zinc-200 file:px-2 file:py-1"
            onChange={(e) => setQuizFile(e.target.files?.[0] ?? null)}
          />
          {quizError ? (
            <p
              className="mt-2 whitespace-pre-wrap break-words text-xs text-red-700"
              role="alert"
            >
              {quizError}
            </p>
          ) : null}
          <button
            type="button"
            disabled={quizBusy}
            onClick={() => void submitForMode("quiz", quizFile)}
            className="mt-2 rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-900 disabled:opacity-50"
          >
            {quizBusy
              ? "取り込み中…"
              : existingTestId?.trim()
                ? "クイズ CSV を取り込む"
                : "クイズ CSV でテスト作成"}
          </button>
        </div>

        <div className="rounded-md border border-zinc-100 bg-zinc-50/80 p-3">
          <p className="text-xs font-medium text-zinc-800">単語帳（Flashcard）</p>
          <p className="mt-0.5 text-xs leading-snug text-zinc-500">
            <strong>正面（問題）</strong>と<strong>背面（答案）</strong>
            の列がある単語帳／フラッシュカード形式 CSV 用です。取り込み後は他カードの裏面を混ぜた選択式で出題されます。
          </p>
          {existingTestId?.trim() ? (
            <p className="mt-1 text-xs text-zinc-600">
              {notebookLmVocabQuestionCount > 0
                ? `取り込み済み（${notebookLmVocabQuestionCount}問）`
                : "未取り込み"}
              {vocabBusy ? "（処理中…）" : null}
            </p>
          ) : null}
          <input
            ref={vocabInputRef}
            type="file"
            accept=".csv,text/csv"
            disabled={vocabBusy}
            className="mt-2 block w-full text-xs text-zinc-700 file:mr-2 file:rounded file:border-0 file:bg-zinc-200 file:px-2 file:py-1"
            onChange={(e) => setVocabFile(e.target.files?.[0] ?? null)}
          />
          {vocabError ? (
            <p
              className="mt-2 whitespace-pre-wrap break-words text-xs text-red-700"
              role="alert"
            >
              {vocabError}
            </p>
          ) : null}
          <button
            type="button"
            disabled={vocabBusy}
            onClick={() => void submitForMode("flashcard", vocabFile)}
            className="mt-2 rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-900 disabled:opacity-50"
          >
            {vocabBusy
              ? "取り込み中…"
              : existingTestId?.trim()
                ? "単語帳 CSV を取り込む"
                : "単語帳 CSV でテスト作成"}
          </button>
        </div>
      </div>

      {note ? <p className="mt-3 text-sm text-emerald-800">{note}</p> : null}
    </div>
  );
}
