import type { SupabaseClient } from "@supabase/supabase-js";
import {
  countBookmarkMemberships,
  normalizeBookmarkListName,
  sortByCreatedDesc,
  sortByUpdatedDesc,
} from "@/lib/bookmark-name";

export type BookmarkMarks = {
  signedIn: boolean;
  testIds: string[];
  counts: Record<string, number>;
};

export type BookmarkListItem = {
  testId: string;
  createdAt: string;
  title: string;
  documentType: "paper" | "past_exam";
  sourceName: string;
  visible: boolean;
};

export type BookmarkList = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  items: BookmarkListItem[];
};

type TestEmbed = {
  id: string;
  title: string;
  document_type: string | null;
  source_name: string;
};

type ItemEmbed = {
  test_id: string;
  created_at: string;
  tests: TestEmbed | TestEmbed[] | null;
};

type ListEmbed = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  bookmark_list_items: ItemEmbed[] | null;
};

function oneTest(tests: ItemEmbed["tests"]): TestEmbed | null {
  if (!tests) return null;
  return Array.isArray(tests) ? (tests[0] ?? null) : tests;
}

export function mapBookmarkLists(rows: ListEmbed[]): BookmarkList[] {
  const lists = rows.map((row) => {
    const items = sortByCreatedDesc(
      (row.bookmark_list_items ?? []).map((item) => {
        const test = oneTest(item.tests);
        const documentType = test?.document_type === "paper" ? "paper" : "past_exam";
        return {
          testId: item.test_id,
          createdAt: item.created_at,
          title: test?.title ?? "（表示できない教材）",
          documentType,
          sourceName: test?.source_name ?? "",
          visible: Boolean(test),
        } satisfies BookmarkListItem;
      }),
    );
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items,
    } satisfies BookmarkList;
  });
  return sortByUpdatedDesc(lists);
}

const LIST_SELECT = `
  id,
  name,
  created_at,
  updated_at,
  bookmark_list_items (
    test_id,
    created_at,
    tests ( id, title, document_type, source_name )
  )
`;

export function humanizeBookmarkDbError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("bookmark_lists_user_name") || m.includes("duplicate key")) {
    return "同じ名前のリストが既にあります";
  }
  if (m.includes("bookmark_lists_name_len") || m.includes("check constraint")) {
    return "リスト名を1〜80文字で入力してください";
  }
  if (
    m.includes("bookmark_lists") &&
    (m.includes("does not exist") ||
      m.includes("schema cache") ||
      m.includes("could not find the table"))
  ) {
    return (
      "bookmark_lists がありません。Supabase の SQL Editor で " +
      "supabase/migrations/025_bookmark_lists.sql を実行してください。"
    );
  }
  return "";
}

export async function loadBookmarkLists(
  supabase: SupabaseClient,
): Promise<{ lists: BookmarkList[]; error: string | null }> {
  const { data, error } = await supabase
    .from("bookmark_lists")
    .select(LIST_SELECT)
    .order("updated_at", { ascending: false });

  if (error) {
    return {
      lists: [],
      error: humanizeBookmarkDbError(error.message) || "ブックマークを読み込めませんでした",
    };
  }
  return { lists: mapBookmarkLists((data ?? []) as unknown as ListEmbed[]), error: null };
}

export async function loadBookmarkMarks(supabase: SupabaseClient): Promise<BookmarkMarks> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { signedIn: false, testIds: [], counts: {} };

  const { data, error } = await supabase.from("bookmark_list_items").select("test_id");
  if (error || !data) return { signedIn: true, testIds: [], counts: {} };
  const counts = countBookmarkMemberships(data.map((row) => String(row.test_id)));
  return {
    signedIn: true,
    testIds: Object.keys(counts),
    counts,
  };
}

export async function loadBookmarkListById(
  supabase: SupabaseClient,
  id: string,
): Promise<{ list: BookmarkList | null; error: string | null }> {
  const { data, error } = await supabase
    .from("bookmark_lists")
    .select(LIST_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return {
      list: null,
      error: humanizeBookmarkDbError(error.message) || "ブックマークを読み込めませんでした",
    };
  }
  if (!data) return { list: null, error: null };
  const [list] = mapBookmarkLists([data as unknown as ListEmbed]);
  return { list: list ?? null, error: null };
}

export { normalizeBookmarkListName };
