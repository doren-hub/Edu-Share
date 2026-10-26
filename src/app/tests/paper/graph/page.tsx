import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PaperGlobalGraphClient } from "@/components/PaperGlobalGraphClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "論文全体グラフ｜EduShare",
  description: "登録されている全論文の内容類似度と共著者ネットワークの全体グラフです。",
};

function PaperGlobalGraphFallback() {
  return (
    <div className="space-y-6">
      <div className="h-28 animate-pulse rounded-2xl bg-zinc-100" />
      <div className="h-96 animate-pulse rounded-2xl bg-zinc-100" />
    </div>
  );
}

export default function PaperGlobalGraphPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div>
          <Link
            href="/tests/paper"
            className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-800"
          >
            ← 論文一覧に戻る
          </Link>
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium tracking-wide text-violet-800">
            論文
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-950">
            論文全体グラフ
          </h1>
        </div>
        <p className="max-w-2xl text-sm text-zinc-600">
          登録されている論文同士の「内容の近さ（上位5件）」と「共著者」の関係を一覧で俯瞰できる全体ネットワークです。業界や発表年でノードを絞り込め、各ノードをクリックすると論文詳細に移動できます。
        </p>
      </header>

      <Suspense fallback={<PaperGlobalGraphFallback />}>
        <PaperGlobalGraphClient />
      </Suspense>
    </div>
  );
}
