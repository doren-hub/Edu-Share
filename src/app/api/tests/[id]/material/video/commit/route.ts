import { commitNotebooklmMaterial } from "@/lib/commit-notebooklm-material";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return commitNotebooklmMaterial("video", req, ctx);
}
