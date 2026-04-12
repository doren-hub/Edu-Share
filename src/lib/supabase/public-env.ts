export type PublicSupabaseEnv =
  | { ok: true; url: string; key: string }
  | { ok: false; message: string };

/**
 * 公開 Supabase 環境変数の状態（プレースホルダ・未設定を検出）
 */
export function getPublicSupabaseEnvStatus(): PublicSupabaseEnv {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const rawKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!rawUrl?.trim() || !rawKey?.trim()) {
    return {
      ok: false,
      message:
        "NEXT_PUBLIC_SUPABASE_URL または NEXT_PUBLIC_SUPABASE_ANON_KEY が未設定です。.env.local を確認してください。",
    };
  }
  const url = rawUrl.trim();
  const key = rawKey.trim();

  if (url.includes("YOUR_PROJECT") || url.toLowerCase().includes("your_project.supabase")) {
    return {
      ok: false,
      message:
        "NEXT_PUBLIC_SUPABASE_URL がサンプル（YOUR_PROJECT）のままです。Supabase ダッシュボードの Settings → API の Project URL（https://xxxx.supabase.co）に置き換え、開発サーバーを再起動してください。",
    };
  }

  if (key === "your_anon_key") {
    return {
      ok: false,
      message:
        "NEXT_PUBLIC_SUPABASE_ANON_KEY がサンプルのままです。Settings → API の anon public キーに置き換え、開発サーバーを再起動してください。",
    };
  }

  return { ok: true, url, key };
}

/** GoTrue / fetch がネットワーク失敗したときのブラウザ向けメッセージ */
export function describeSupabaseNetworkError(message: string): string {
  const m = message.trim();
  if (
    m === "Failed to fetch" ||
    m === "Load failed" ||
    m.includes("NetworkError when attempting to fetch resource")
  ) {
    return (
      "Supabase へ接続できませんでした。.env.local の Project URL と anon キーが正しいか、ネットワーク・VPN・広告ブロッカーを確認してください。" +
      " URL がサンプルのまま（YOUR_PROJECT）の場合は、実プロジェクトの URL に差し替えてください。"
    );
  }
  return message;
}
