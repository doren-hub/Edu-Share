"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient, describeSupabaseNetworkError } from "@/lib/supabase/client";
import { getPublicSupabaseEnvStatus } from "@/lib/supabase/public-env";
import type { UserRole } from "@/lib/types";

const roles: { value: UserRole; label: string }[] = [
  { value: "school_student", label: "学校生徒" },
  { value: "expert", label: "専門家" },
  { value: "certification", label: "資格勉強者" },
  { value: "general", label: "一般ユーザー" },
];

export default function SignupPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<UserRole>("general");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    const env = getPublicSupabaseEnvStatus();
    if (!env.ok) {
      setError(env.message);
      return;
    }
    setLoading(true);
    let err: { message: string } | null = null;
    let data: Awaited<ReturnType<typeof supabase.auth.signUp>>["data"];
    try {
      const res = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            role,
            display_name: displayName.trim() || email.split("@")[0],
          },
        },
      });
      data = res.data;
      err = res.error;
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : String(caught);
      setLoading(false);
      setError(describeSupabaseNetworkError(msg));
      return;
    }
    setLoading(false);
    if (err) {
      setError(describeSupabaseNetworkError(err.message));
      return;
    }
    if (!data.session) {
      setInfo(
        "確認メールを送信しました（プロジェクト設定により無効の場合は即ログインできます）。",
      );
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-950">新規登録</h1>
        <p className="mt-2 text-sm text-zinc-600">
          すでにアカウントがある場合は{" "}
          <Link className="underline" href="/auth/login">
            ログイン
          </Link>
        </p>
      </div>

      <form
        onSubmit={(e) => void onSubmit(e)}
        className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
      >
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-700">表示名</span>
          <input
            className="w-full rounded-md border border-zinc-200 px-3 py-2"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="例: 山田太郎"
          />
        </label>

        <label className="block space-y-1 text-sm">
          <span className="text-zinc-700">ユーザータイプ</span>
          <select
            className="w-full rounded-md border border-zinc-200 px-3 py-2"
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
          >
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1 text-sm">
          <span className="text-zinc-700">メール</span>
          <input
            className="w-full rounded-md border border-zinc-200 px-3 py-2"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-700">パスワード</span>
          <input
            className="w-full rounded-md border border-zinc-200 px-3 py-2"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </label>

        {error ? (
          <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </p>
        ) : null}
        {info ? (
          <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            {info}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {loading ? "処理中..." : "登録"}
        </button>
      </form>
    </div>
  );
}
