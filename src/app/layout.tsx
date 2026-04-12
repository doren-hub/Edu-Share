import type { Metadata } from "next";
import Link from "next/link";
import { AuthBar } from "@/components/AuthBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "EduShare — 共有テスト",
  description: "PDF（過去問/論文）から生成する共有学習テスト",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className="min-h-dvh font-sans">
        <header className="border-b border-zinc-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4">
            <Link href="/" className="font-semibold tracking-tight">
              EduShare
            </Link>
            <nav className="flex flex-wrap items-center gap-4 text-sm text-zinc-700">
              <Link className="hover:text-zinc-950" href="/tests">
                テスト一覧
              </Link>
              <Link className="hover:text-zinc-950" href="/upload">
                アップロード
              </Link>
              <AuthBar />
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-10">{children}</main>
      </body>
    </html>
  );
}
