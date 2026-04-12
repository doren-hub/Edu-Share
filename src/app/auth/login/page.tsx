"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient, describeSupabaseNetworkError } from "@/lib/supabase/client";
import { getPublicSupabaseEnvStatus } from "@/lib/supabase/public-env";

export default function LoginPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const env = getPublicSupabaseEnvStatus();
    if (!env.ok) {
      setError(env.message);
      return;
    }
    setLoading(true);
    let err: { message: string } | null = null;
    try {
      const res = await supabase.auth.signInWithPassword({
        email,
        password,
      });
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
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-950">ログイン</h1>
        <p className="mt-2 text-sm text-zinc-600">
          アカウントがない場合は{" "}
          <Link className="underline" href="/auth/signup">
            新規登録
          </Link>
        </p>
      </div>

      <form
        onSubmit={(e) => void onSubmit(e)}
        className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
      >
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
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {error ? (
          <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {loading ? "処理中..." : "ログイン"}
        </button>
      </form>
    </div>
  );
}
