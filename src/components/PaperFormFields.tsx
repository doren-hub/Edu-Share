"use client";

import { PaperAuthorsPicklistList } from "@/components/PaperAuthorsPicklistList";
import { PaperIndustriesPicklistList } from "@/components/PaperIndustriesPicklistList";
import { PicklistField } from "@/components/PicklistField";

type Props = {
  /** 変更時に著者 Picklist を再マウントして候補を再取得する */
  authorsPicklistKey?: number;
  paperAuthors: string[];
  onPaperAuthors: (v: string[]) => void;
  paperVenue: string;
  onPaperVenue: (v: string) => void;
  paperDoi: string;
  onPaperDoi: (v: string) => void;
  industries: string[];
  onIndustries: (v: string[]) => void;
  publicationYear: string;
  onPublicationYear: (v: string) => void;
};

export function PaperFormFields({
  authorsPicklistKey = 0,
  paperAuthors,
  onPaperAuthors,
  paperVenue,
  onPaperVenue,
  paperDoi,
  onPaperDoi,
  industries,
  onIndustries,
  publicationYear,
  onPublicationYear,
}: Props) {
  return (
    <div className="space-y-4 rounded-lg border border-violet-200 bg-violet-50/40 p-4">
      <p className="text-xs font-medium text-violet-950">論文のメタ情報</p>

      <PaperAuthorsPicklistList
        key={authorsPicklistKey}
        values={paperAuthors}
        onChange={onPaperAuthors}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-700">掲載（任意）</span>
          <input
            className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
            value={paperVenue}
            onChange={(e) => onPaperVenue(e.target.value)}
            placeholder="例: ACM Computing Surveys"
            maxLength={400}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-700">DOI（任意）</span>
          <input
            className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-sm"
            value={paperDoi}
            onChange={(e) => onPaperDoi(e.target.value)}
            placeholder="例: 10.1145/3729215"
            maxLength={200}
            spellCheck={false}
          />
        </label>
      </div>

      <PaperIndustriesPicklistList
        values={industries}
        onChange={onIndustries}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <PicklistField
          category="publication_year"
          label="発表年（任意）"
          id="paper-year"
          value={publicationYear}
          onChange={onPublicationYear}
          allowOther={false}
          required={false}
        />
      </div>
    </div>
  );
}
