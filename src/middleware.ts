import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // These handlers authenticate themselves and can refresh cookies. Excluding
  // them avoids Next's middleware body clone before their bounded JSON or streaming multipart readers.
  matcher: [
    "/((?!api/papers/[^/]+/ask/?$|api/tests/(?!upload/?$)[^/]+/?$|api/tests/[^/]+/material/(?:video|slide)/?$|api/quiz/[^/]+/submit/?$|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
