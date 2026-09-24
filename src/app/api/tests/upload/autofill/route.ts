import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPdfTextByPage } from "@/lib/pdf-text-by-page";
import { mergePicklistOptionsForSelect } from "@/lib/picklist-merge";
import { fetchPicklistOptionRows } from "@/lib/supabase/picklist-table";

export const runtime = "nodejs";

type DocType = "past_exam" | "paper";

function looksLikePdf(file: File): boolean {
  if (file.type === "application/pdf") return true;
  const name = file.name?.toLowerCase() ?? "";
  return file.type === "" && name.endsWith(".pdf");
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[()\[\]{}「」『』【】]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function guessDocType(seed: string): DocType {
  const s = seed.toLowerCase();
  const paperScore =
    (s.includes("論文") ? 2 : 0) +
    (s.includes("paper") ? 1 : 0) +
    (s.includes("journal") ? 1 : 0) +
    (s.includes("thesis") ? 1 : 0) +
    (s.includes("研究") ? 1 : 0);
  const examScore =
    (s.includes("過去問") ? 2 : 0) +
    (s.includes("入試") ? 1 : 0) +
    (s.includes("試験") ? 1 : 0) +
    (s.includes("問題") ? 1 : 0);
  return paperScore > examScore ? "paper" : "past_exam";
}

function pickBestOption(options: string[], haystackRaw: string): string {
  const hay = normalize(haystackRaw);
  let best = "";
  let bestLen = -1;
  for (const opt of options) {
    const key = normalize(opt);
    if (!key || key.length < 2) continue;
    if (hay.includes(key) && key.length > bestLen) {
      best = opt;
      bestLen = key.length;
    }
  }
  return best;
}

function fileNameToTitle(filename: string): string {
  return filename
    .replace(/\.pdf$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickYear(seed: string): string {
  const m = seed.match(/\b(19|20)\d{2}\b/);
  return m?.[0] ?? "";
}

function summarizeDescription(firstPageText: string): string {
  const oneLine = firstPageText.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return oneLine.slice(0, 180);
}

async function loadValues(
  category:
    | "school_name"
    | "department_name"
    | "exam_subject"
    | "exam_period"
    | "expert_name"
    | "paper_industry"
    | "publication_year",
  options?: { school?: string; department?: string },
): Promise<string[]> {
  const { rows } = await fetchPicklistOptionRows(category, options);
  return mergePicklistOptionsForSelect(rows, {
    category,
    departmentForMerge: options?.department,
  }).map((r) => r.value);
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "PDFファイルが必要です" }, { status: 400 });
  }
  if (!looksLikePdf(file)) {
    return NextResponse.json({ error: "PDFのみ対応しています" }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  let pages: string[] = [];
  try {
    pages = await extractPdfTextByPage(bytes);
  } catch {
    pages = [];
  }

  const title = fileNameToTitle(file.name) || "無題";
  const firstPage = pages[0] ?? "";
  const seed = `${file.name}\n${firstPage}\n${pages.slice(1, 2).join("\n")}`;
  const documentType = guessDocType(seed);

  const payload: Record<string, string | string[]> = {
    title,
    description: summarizeDescription(firstPage),
    document_type: documentType,
    school_name: "",
    exam_department: "",
    exam_subject: "",
    exam_period: "",
    expert_name: "",
    paper_authors: [],
    paper_venue: "",
    paper_doi: "",
    industries: [],
    publication_year: "",
  };

  if (documentType === "past_exam") {
    const schools = await loadValues("school_name");
    const school = pickBestOption(schools, seed);
    payload.school_name = school;

    const depts = await loadValues("department_name", { school });
    const dept = pickBestOption(depts, seed);
    payload.exam_department = dept;

    const [subjects, periods] = await Promise.all([
      loadValues("exam_subject", { school, department: dept }),
      loadValues("exam_period", { school, department: dept }),
    ]);
    payload.exam_subject = pickBestOption(subjects, seed);
    payload.exam_period = pickBestOption(periods, seed);
  } else {
    const [experts, industries, years] = await Promise.all([
      loadValues("expert_name"),
      loadValues("paper_industry"),
      loadValues("publication_year"),
    ]);
    const expert = pickBestOption(experts, seed);
    payload.expert_name = expert;
    payload.paper_authors = expert ? [expert] : [];
    const industry = pickBestOption(industries, seed);
    payload.industries = industry ? [industry] : [];
    const year = pickYear(seed);
    payload.publication_year =
      years.includes(year) ? year : pickBestOption(years, seed);
  }

  return NextResponse.json({ autofill: payload });
}

