"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function AuthBar() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      setEmail(data.user?.email ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user.email ?? null);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  async function signOut() {
    await supabase.auth.signOut();
    router.refresh();
  }

  if (email) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="max-w-[220px] truncate text-zinc-600">{email}</span>
        <button
          type="button"
          className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-zinc-900 hover:bg-zinc-50"
          onClick={() => void signOut()}
        >
          ログアウト
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Link className="hover:text-zinc-950" href="/auth/login">
        ログイン
      </Link>
      <Link
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-white hover:bg-zinc-800"
        href="/auth/signup"
      >
        新規登録
      </Link>
    </div>
  );
}
