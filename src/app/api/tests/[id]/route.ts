import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  legacyNotebooklmSlidePdfStoragePath,
  legacyNotebooklmVideoMp4StoragePath,
  notebooklmSlidePdfStoragePath,
  notebooklmVideoMp4StoragePath,
} from "@/lib/test-notebooklm-material-paths";
import { joinPaperAuthorsForSourceName } from "@/lib/paper-authors";
import { assertStoredPickWithOther } from "@/lib/picklist-parse";
import { mergePicklistOptionsForSelect } from "@/lib/picklist-merge";
import { fetchPicklistOptionRows } from "@/lib/supabase/picklist-table";

export const runtime = "nodejs";

function asTrimmedStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x).trim()).filter((s) => s.length > 0);
}

const patchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    source_name: z.string().min(1).max(200).optional(),
    document_type: z.enum(["past_exam", "paper"]).optional(),
    exam_department: z.string().min(1).max(120).nullable().optional(),
    exam_subject: z.string().min(1).max(120).nullable().optional(),
    exam_period: z.string().min(1).max(120).nullable().optional(),
    industry: z.string().max(120).nullable().optional(),
    publication_year: z.string().max(32).nullable().optional(),
    paper_authors: z.array(z.string().min(1).max(200)).max(24).optional(),
    paper_venue: z.string().max(400).nullable().optional(),
    paper_doi: z.string().max(200).nullable().optional(),
    /** NotebookLM のノートブック URL。空文字でクリア */
    notebooklm_notebook_url: z.string().max(2048).nullable().optional(),
    /** SciSpace のページ URL。空文字でクリア */
    scispace_project_url: z.string().max(2048).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: "更新する項目を1つ以上指定してください",
  });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: testId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON ボディが必要です" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "入力が不正です", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json(
      { error: "サーバー用の Supabase キーが未設定です" },
      { status: 500 },
    );
  }

  const { data: row, error: fetchErr } = await admin
    .from("tests")
    .select(
      "id, uploaded_by, document_type, exam_department, exam_subject, exam_period, source_name, industry, publication_year, paper_doi, paper_venue, paper_authors",
    )
    .eq("id", testId)
    .single();

  if (fetchErr || !row) {
    return NextResponse.json({ error: "テストが見つかりません" }, { status: 404 });
  }
  if (row.uploaded_by !== user.id) {
    return NextResponse.json(
      { error: "このテストの情報を変更できるのはアップロードしたユーザーのみです" },
      { status: 403 },
    );
  }

  const patch = parsed.data;

  if (patch.notebooklm_notebook_url !== undefined) {
    const raw = patch.notebooklm_notebook_url;
    if (raw === null || raw.trim() === "") {
      // handled below in updates
    } else {
      try {
        const u = new URL(raw.trim());
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return NextResponse.json(
            { error: "NotebookLM のリンクは http(s) の URL である必要があります" },
            { status: 400 },
          );
        }
      } catch {
        return NextResponse.json(
          { error: "NotebookLM のリンクが有効な URL ではありません" },
          { status: 400 },
        );
      }
    }
  }

  if (patch.scispace_project_url !== undefined) {
    const raw = patch.scispace_project_url;
    if (raw !== null && raw.trim() !== "") {
      try {
        const u = new URL(raw.trim());
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return NextResponse.json(
            { error: "SciSpace のリンクは http(s) の URL である必要があります" },
            { status: 400 },
          );
        }
      } catch {
        return NextResponse.json(
          { error: "SciSpace のリンクが有効な URL ではありません" },
          { status: 400 },
        );
      }
    }
  }

  const mergedDoc =
    patch.document_type ?? row.document_type ?? "past_exam";

  const mergedSourceName =
    patch.source_name !== undefined ? patch.source_name : row.source_name;
  const mergedDepartment =
    patch.exam_department !== undefined
      ? patch.exam_department
      : row.exam_department;
  const mergedSubject =
    patch.exam_subject !== undefined
      ? patch.exam_subject
      : row.exam_subject;
  const mergedPeriod =
    patch.exam_period !== undefined ? patch.exam_period : row.exam_period;
  const mergedIndustry =
    patch.industry !== undefined ? patch.industry : row.industry;
  const mergedYear =
    patch.publication_year !== undefined
      ? patch.publication_year
      : row.publication_year;

  const rowPaperAuthors = asTrimmedStringArray(row.paper_authors);
  const mergedPaperAuthors =
    patch.paper_authors !== undefined
      ? patch.paper_authors.map((s) => s.trim()).filter((s) => s.length > 0)
      : rowPaperAuthors;

  const mergedPaperVenue =
    patch.paper_venue !== undefined ? patch.paper_venue : row.paper_venue;
  const mergedPaperDoi =
    patch.paper_doi !== undefined ? patch.paper_doi : row.paper_doi;

  const docTypeChanged =
    patch.document_type !== undefined &&
    patch.document_type !== (row.document_type ?? "past_exam");

  const touchesPastMeta =
    docTypeChanged ||
    patch.exam_department !== undefined ||
    patch.exam_subject !== undefined ||
    patch.exam_period !== undefined ||
    patch.source_name !== undefined;

  const touchesPaperMeta =
    docTypeChanged ||
    patch.industry !== undefined ||
    patch.publication_year !== undefined ||
    patch.source_name !== undefined ||
    patch.paper_authors !== undefined ||
    patch.paper_venue !== undefined ||
    patch.paper_doi !== undefined;

  if (mergedDoc === "past_exam" && touchesPastMeta) {
    const name =
      typeof mergedSourceName === "string" ? mergedSourceName.trim() : "";
    const dep =
      typeof mergedDepartment === "string" ? mergedDepartment.trim() : "";
    const s =
      typeof mergedSubject === "string" ? mergedSubject.trim() : "";
    const p = typeof mergedPeriod === "string" ? mergedPeriod.trim() : "";
    if (!name || !dep || !s || !p) {
      return NextResponse.json(
        {
          error:
            "過去問では学校名・学科名・科目・テストの時期をすべて指定してください（資料の種類を変える場合も含む）",
        },
        { status: 400 },
      );
    }
  }

  let resolvedPaperAuthors: string[] | null = null;
  let resolvedIndustry: string | null = null;
  let resolvedYear: string | null = null;

  if (mergedDoc === "paper" && touchesPaperMeta) {
    if (mergedPaperAuthors.length === 0) {
      return NextResponse.json(
        {
          error:
            "論文では著者を1人以上指定してください（資料の種類を変える場合も含む）",
        },
        { status: 400 },
      );
    }
    const ind = String(mergedIndustry ?? "").trim();
    const yr = String(mergedYear ?? "").trim();

    const expRes = await fetchPicklistOptionRows("expert_name");
    const expVals = mergePicklistOptionsForSelect(expRes.rows, {
      category: "expert_name",
    }).map((r) => r.value);
    const seen = new Set<string>();
    const authorsOut: string[] = [];
    for (const raw of mergedPaperAuthors) {
      const r = assertStoredPickWithOther(raw, expVals, true, "著者");
      if (!r.ok) {
        return NextResponse.json({ error: r.message }, { status: 400 });
      }
      if (seen.has(r.value)) continue;
      seen.add(r.value);
      authorsOut.push(r.value);
    }
    resolvedPaperAuthors = authorsOut;

    if (ind) {
      const { rows: indRows } = await fetchPicklistOptionRows("paper_industry");
      const indVals = mergePicklistOptionsForSelect(indRows, {
        category: "paper_industry",
      }).map((r) => r.value);
      const indOk = assertStoredPickWithOther(ind, indVals, true, "業界");
      if (!indOk.ok) {
        return NextResponse.json({ error: indOk.message }, { status: 400 });
      }
      resolvedIndustry = indOk.value;
    } else {
      resolvedIndustry = null;
    }

    if (yr) {
      const { rows: yRows } = await fetchPicklistOptionRows("publication_year");
      const yVals = mergePicklistOptionsForSelect(yRows, {
        category: "publication_year",
      }).map((r) => r.value);
      const yOk = assertStoredPickWithOther(yr, yVals, false, "発表年");
      if (!yOk.ok) {
        return NextResponse.json({ error: yOk.message }, { status: 400 });
      }
      if (!/^\d{4}$/.test(yOk.value)) {
        return NextResponse.json(
          { error: "発表年は西暦4桁を選んでください" },
          { status: 400 },
        );
      }
      resolvedYear = yOk.value;
    } else {
      resolvedYear = null;
    }
  }

  const updates: Record<string, unknown> = {};
  if (patch.notebooklm_notebook_url !== undefined) {
    const raw = patch.notebooklm_notebook_url;
    updates.notebooklm_notebook_url =
      raw === null || raw.trim() === "" ? null : raw.trim();
  }
  if (patch.scispace_project_url !== undefined) {
    const raw = patch.scispace_project_url;
    updates.scispace_project_url =
      raw === null || raw.trim() === "" ? null : raw.trim();
  }
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.description !== undefined) {
    updates.description =
      patch.description === null || patch.description === ""
        ? null
        : patch.description;
  }
  if (patch.source_name !== undefined && mergedDoc === "past_exam") {
    updates.source_name = patch.source_name;
  }

  if (docTypeChanged && patch.document_type !== undefined) {
    updates.document_type = patch.document_type;
    updates.source_type =
      patch.document_type === "paper" ? "expert" : "school";
    if (patch.document_type === "paper") {
      updates.exam_department = null;
      updates.exam_subject = null;
      updates.exam_period = null;
    } else {
      updates.industry = null;
      updates.publication_year = null;
      updates.paper_doi = null;
      updates.paper_venue = null;
      updates.paper_authors = null;
    }
  }

  if (mergedDoc === "paper" && touchesPaperMeta) {
    if (resolvedPaperAuthors) {
      updates.paper_authors = resolvedPaperAuthors;
      updates.source_name = joinPaperAuthorsForSourceName(resolvedPaperAuthors);
    }
    updates.industry = resolvedIndustry;
    updates.publication_year = resolvedYear;
  }

  if (mergedDoc === "paper") {
    if (patch.paper_venue !== undefined) {
      const v = mergedPaperVenue;
      updates.paper_venue =
        v === null || (typeof v === "string" && v.trim() === "")
          ? null
          : String(v).trim();
    }
    if (patch.paper_doi !== undefined) {
      const v = mergedPaperDoi;
      updates.paper_doi =
        v === null || (typeof v === "string" && v.trim() === "")
          ? null
          : String(v).trim();
    }
  }

  if (mergedDoc === "past_exam") {
    if (patch.exam_department !== undefined) {
      updates.exam_department =
        patch.exam_department === null
          ? null
          : patch.exam_department.trim();
    }
    if (patch.exam_subject !== undefined) {
      updates.exam_subject =
        patch.exam_subject === null ? null : patch.exam_subject.trim();
    }
    if (patch.exam_period !== undefined) {
      updates.exam_period =
        patch.exam_period === null ? null : patch.exam_period.trim();
    }
  }

  const { data: updated, error: upErr } = await admin
    .from("tests")
    .update(updates)
    .eq("id", testId)
    .select(
      "id,title,description,source_type,source_name,document_type,exam_department,exam_subject,exam_period,industry,publication_year,paper_doi,paper_venue,paper_authors,processing_status",
    )
    .single();

  if (upErr || !updated) {
    return NextResponse.json(
      { error: upErr?.message || "更新に失敗しました" },
      { status: 500 },
    );
  }

  return NextResponse.json({ test: updated });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: testId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json(
      { error: "サーバー用の Supabase キーが未設定です" },
      { status: 500 },
    );
  }

  const { data: test, error: fetchErr } = await admin
    .from("tests")
    .select("id, uploaded_by, pdf_storage_path")
    .eq("id", testId)
    .single();

  if (fetchErr || !test) {
    return NextResponse.json({ error: "テストが見つかりません" }, { status: 404 });
  }
  if (test.uploaded_by !== user.id) {
    return NextResponse.json(
      { error: "このページを削除できるのはアップロードしたユーザーのみです" },
      { status: 403 },
    );
  }

  const pathsToRemove = [test.pdf_storage_path];
  if (test.uploaded_by) {
    pathsToRemove.push(
      notebooklmSlidePdfStoragePath(test.uploaded_by, testId),
      notebooklmVideoMp4StoragePath(test.uploaded_by, testId),
      legacyNotebooklmSlidePdfStoragePath(test.uploaded_by, testId),
      legacyNotebooklmVideoMp4StoragePath(test.uploaded_by, testId),
    );
  }

  await admin.storage.from("pdfs").remove(pathsToRemove);

  const { error: delErr } = await admin.from("tests").delete().eq("id", testId);
  if (delErr) {
    return NextResponse.json(
      { error: delErr.message || "削除に失敗しました" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
