"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  isExamMetaPicklistCategory,
  isSchoolScopedPicklistCategory,
  type PicklistCategory,
} from "@/lib/picklist-categories";
import {
  mergePicklistOptionsForSelect,
  type PicklistItem,
} from "@/lib/picklist-merge";
import {
  PICKLIST_OTHER_LABEL,
  finalizePickWithOther,
  isOtherBracketValue,
  parsePickWithOther,
} from "@/lib/picklist-parse";

const fieldClass =
  "w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900";

function buildOptionValueStrings(
  items: PicklistItem[],
  stored: string,
  allowOther: boolean,
): string[] {
  let base = items.map((i) => i.value);
  const s = stored.trim();
  const set = new Set(base);
  if (allowOther && !set.has(PICKLIST_OTHER_LABEL)) {
    base = [...base, PICKLIST_OTHER_LABEL];
    set.add(PICKLIST_OTHER_LABEL);
  }
  if (!s || set.has(s)) return base;
  if (allowOther && isOtherBracketValue(s)) return base;
  return [s, ...base];
}

export type PicklistFieldProps = {
  category: PicklistCategory;
  label: string;
  id?: string;
  value: string;
  onChange: (v: string) => void;
  allowOther: boolean;
  required?: boolean;
  className?: string;
  /** 学科・科目・テストの時期: 選択中の学校名（tests.source_name と同一表記）で候補を絞る */
  schoolFilterForOptions?: string;
  /** 学科・科目・時期を「選択肢の追加」するとき、学校名が入っていればその学校専用候補として登録 */
  scopeSchoolWhenAdding?: string;
  /** 科目・テストの時期: 選択中の学科（tests.exam_department と同一表記）。学科ごとに候補を分ける */
  departmentFilterForOptions?: string;
  /** 科目・時期の追加時、この学科専用として登録する値 */
  scopeDepartmentWhenAdding?: string;
};

export function PicklistField({
  category,
  label,
  id,
  value,
  onChange,
  allowOther,
  required,
  className,
  schoolFilterForOptions,
  scopeSchoolWhenAdding,
  departmentFilterForOptions,
  scopeDepartmentWhenAdding,
}: PicklistFieldProps) {
  const [items, setItems] = useState<PicklistItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [manageOpen, setManageOpen] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [manageBusy, setManageBusy] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  const [otherError, setOtherError] = useState<string | null>(null);

  const [selectChoice, setSelectChoice] = useState("");
  const [otherDraft, setOtherDraft] = useState("");
  const otherDirtyRef = useRef(false);
  const lastExternalValueRef = useRef(value);

  const displayItems = useMemo(
    () =>
      mergePicklistOptionsForSelect(items, {
        category,
        departmentForMerge:
          isExamMetaPicklistCategory(category)
            ? departmentFilterForOptions
            : undefined,
      }),
    [items, category, departmentFilterForOptions],
  );

  const optionStrings = useMemo(
    () => buildOptionValueStrings(displayItems, value, allowOther),
    [displayItems, value, allowOther],
  );

  const scopeTrim = scopeSchoolWhenAdding?.trim() ?? "";
  const deptTrim = scopeDepartmentWhenAdding?.trim() ?? "";
  const isExamScoped =
    isSchoolScopedPicklistCategory(category) &&
    isExamMetaPicklistCategory(category);

  /** 学校（＋科目・時期は学科）スコープの管理一覧 */
  const manageItems = useMemo(() => {
    if (!isSchoolScopedPicklistCategory(category)) {
      return items;
    }
    if (!scopeTrim) return [];
    return items.filter((row) => {
      const s = (row.scope_school_name ?? "").trim();
      if (!s) return true;
      if (s !== scopeTrim) return false;
      if (!isExamScoped) return true;
      const d = (row.scope_department_value ?? "").trim();
      if (!d) return true;
      return d === deptTrim;
    });
  }, [items, category, scopeTrim, deptTrim, isExamScoped]);

  const canDeleteRow = useCallback((row: PicklistItem) => {
    if (!isSchoolScopedPicklistCategory(category)) return true;
    return Boolean((row.scope_school_name ?? "").trim());
  }, [category]);

  const showScopedManage =
    !isSchoolScopedPicklistCategory(category) ||
    (Boolean(scopeTrim) && (!isExamScoped || Boolean(deptTrim)));

  useEffect(() => {
    if (!isSchoolScopedPicklistCategory(category)) return;
    if (!scopeTrim) setManageOpen(false);
    if (isExamScoped && !deptTrim) setManageOpen(false);
  }, [category, scopeTrim, deptTrim, isExamScoped]);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ category });
      if (
        isSchoolScopedPicklistCategory(category)
        && schoolFilterForOptions?.trim()
      ) {
        params.set("school", schoolFilterForOptions.trim());
      }
      if (
        isExamMetaPicklistCategory(category)
        && departmentFilterForOptions?.trim()
      ) {
        params.set("department", departmentFilterForOptions.trim());
      }
      const res = await fetch(`/api/picklists?${params}`, {
        credentials: "include",
      });
      const j = (await res.json().catch(() => ({}))) as {
        items?: PicklistItem[];
        error?: string;
        details?: string;
      };
      if (!res.ok) {
        const parts = [j.error, j.details].filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0,
        );
        throw new Error(parts.join("\n") || `読み込みに失敗しました（HTTP ${res.status}）`);
      }
      setItems(j.items ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "読み込みに失敗しました");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [category, schoolFilterForOptions, departmentFilterForOptions]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const optStr = buildOptionValueStrings(displayItems, value, allowOther);
    const p = parsePickWithOther(value, optStr, allowOther);

    if (lastExternalValueRef.current !== value) {
      lastExternalValueRef.current = value;
      otherDirtyRef.current = false;
      setSelectChoice(p.choice);
      setOtherDraft(p.other);
      setOtherError(null);
      return;
    }

    if (!otherDirtyRef.current) {
      setSelectChoice(p.choice);
      setOtherDraft(p.other);
    }
  }, [value, displayItems, allowOther]);

  function onSelectChange(next: string) {
    otherDirtyRef.current = false;
    setOtherError(null);
    setSelectChoice(next);
    if (!allowOther || next !== PICKLIST_OTHER_LABEL) {
      onChange(next);
      setOtherDraft("");
      return;
    }
    onChange(PICKLIST_OTHER_LABEL);
  }

  function onOtherBlur() {
    const r = finalizePickWithOther(selectChoice, otherDraft, label);
    if (!r.ok) {
      setOtherError(r.message);
      return;
    }
    setOtherError(null);
    if (r.value !== value) {
      flushSync(() => {
        onChange(r.value);
      });
    }
    otherDirtyRef.current = false;
  }

  async function addOption() {
    const v = newValue.trim();
    if (!v) return;
    if (isSchoolScopedPicklistCategory(category) && !scopeTrim) {
      setManageError("学校名を選んでから追加してください");
      return;
    }
    if (isExamMetaPicklistCategory(category) && !deptTrim) {
      setManageError("学科名を選んでから追加してください");
      return;
    }
    setManageBusy(true);
    setManageError(null);
    try {
      const body: Record<string, unknown> = { category, value: v };
      if (isSchoolScopedPicklistCategory(category)) {
        body.scope_school_name = scopeTrim;
      }
      if (isExamMetaPicklistCategory(category)) {
        body.scope_department_value = deptTrim;
      }
      const res = await fetch("/api/picklists", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { error?: string; details?: string };
      if (!res.ok) {
        const parts = [j.error, j.details].filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0,
        );
        throw new Error(parts.join("\n") || "追加に失敗しました");
      }
      setNewValue("");
      await reload();
    } catch (e) {
      setManageError(e instanceof Error ? e.message : "追加に失敗しました");
    } finally {
      setManageBusy(false);
    }
  }

  async function removeOption(rowId: string) {
    setManageBusy(true);
    setManageError(null);
    try {
      const res = await fetch(`/api/picklists/${rowId}`, {
        method: "DELETE",
        credentials: "include",
      });
      const j = (await res.json()) as { error?: string; details?: string };
      if (!res.ok) {
        const parts = [j.error, j.details].filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0,
        );
        throw new Error(parts.join("\n") || "削除に失敗しました");
      }
      await reload();
    } catch (e) {
      setManageError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setManageBusy(false);
    }
  }

  const showOtherInput =
    allowOther && selectChoice === PICKLIST_OTHER_LABEL;

  return (
    <div className={className ?? "space-y-1 text-sm"}>
      <label htmlFor={id} className="block text-zinc-700">
        {label}
      </label>
      {loadError ? (
        <p className="text-xs text-red-700">{loadError}</p>
      ) : null}
      <select
        id={id}
        className={fieldClass}
        disabled={loading}
        value={optionStrings.includes(selectChoice) ? selectChoice : ""}
        required={required && !showOtherInput}
        onChange={(e) => onSelectChange(e.target.value)}
      >
        <option value="">選択してください</option>
        {optionStrings.map((opt) => (
          <option key={opt} value={opt}>
            {category === "publication_year" ? `${opt}年` : opt}
          </option>
        ))}
      </select>
      {showOtherInput ? (
        <label className="mt-2 block space-y-1">
          <span className="text-xs text-zinc-600">{label}（その他の内容）</span>
          <input
            className={fieldClass}
            value={otherDraft}
            onChange={(e) => {
              otherDirtyRef.current = true;
              setOtherDraft(e.target.value);
            }}
            onBlur={onOtherBlur}
            maxLength={200}
            required={required}
          />
          {otherError ? (
            <span className="text-xs text-red-700">{otherError}</span>
          ) : null}
        </label>
      ) : null}

      {isSchoolScopedPicklistCategory(category) && !scopeTrim ? (
        <p className="mt-2 text-xs text-zinc-500">
          学校名を選ぶと、この学校だけの学科候補を追加・削除できます（他校には共有されません）。
          科目・テストの時期はさらに学科ごとに分かれます。
        </p>
      ) : null}
      {isExamScoped && scopeTrim && !deptTrim ? (
        <p className="mt-2 text-xs text-zinc-500">
          学科名を選ぶと、この学科だけの科目・テストの時期候補を追加・削除できます（他学科には共有されません）。
        </p>
      ) : null}

      {showScopedManage ? (
        <button
          type="button"
          className="mt-2 text-xs font-medium text-zinc-600 underline hover:text-zinc-900"
          onClick={() => setManageOpen((o) => !o)}
        >
          {manageOpen ? "選択肢の編集を閉じる" : "選択肢の追加・削除"}
        </button>
      ) : null}
      {manageOpen && showScopedManage ? (
        <div className="mt-2 space-y-3 rounded-md border border-zinc-200 bg-zinc-50/80 p-3 text-xs">
          <p className="text-zinc-600">
            {isExamScoped
              ? "全校共通・学校内全学科共通と、この学科専用の候補が表示されます。「この学科のみ」の行は他学科に共有されません。全校共通は削除できません。"
              : isSchoolScopedPicklistCategory(category)
                ? "全校共通と、この学校専用の候補が表示されます。追加した学校専用の行だけ削除できます（全校共通は削除できません）。他校の一覧には影響しません。"
                : "一覧から削除するか、入力して追加できます（ログインが必要です）。"}
          </p>
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {manageItems.length === 0 && isSchoolScopedPicklistCategory(category) ? (
              <li className="rounded bg-white px-2 py-2 text-zinc-500">
                候補がまだありません。下の入力から追加できます。
              </li>
            ) : null}
            {manageItems.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-2 rounded bg-white px-2 py-1.5"
              >
                <span className="min-w-0 truncate text-zinc-800">
                  {row.value}
                  {isSchoolScopedPicklistCategory(category) &&
                  !(row.scope_school_name ?? "").trim() ? (
                    <span className="ml-1.5 shrink-0 text-zinc-400">（全校共通）</span>
                  ) : isExamScoped &&
                    (row.scope_school_name ?? "").trim() &&
                    !(row.scope_department_value ?? "").trim() ? (
                    <span className="ml-1.5 shrink-0 text-zinc-400">（学校・全学科）</span>
                  ) : isExamScoped &&
                    (row.scope_department_value ?? "").trim() ? (
                    <span className="ml-1.5 shrink-0 text-zinc-400">（この学科のみ）</span>
                  ) : null}
                </span>
                {canDeleteRow(row) ? (
                  <button
                    type="button"
                    disabled={manageBusy}
                    className="shrink-0 text-red-700 hover:underline disabled:opacity-50"
                    onClick={() => void removeOption(row.id)}
                  >
                    削除
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <input
              className={`${fieldClass} min-w-[120px] flex-1`}
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="新しい候補"
              maxLength={200}
            />
            <button
              type="button"
              disabled={manageBusy || !newValue.trim()}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 hover:bg-zinc-50 disabled:opacity-50"
              onClick={() => void addOption()}
            >
              追加
            </button>
          </div>
          {manageError ? <p className="text-red-700">{manageError}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
