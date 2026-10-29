// Byte limits apply before UTF-8 decoding and JSON.parse (including unknown fields).
export const API_BODY_LIMITS = {
  paperAsk: 192 * 1024,
  testPatch: 128 * 1024,
  quizSubmit: 512 * 1024,
} as const;

type JsonResult =
  | { ok: true; data: unknown }
  | { ok: false; response: Response };

function tooLarge(): JsonResult {
  return {
    ok: false,
    response: Response.json({ error: "リクエスト本文が大きすぎます" }, { status: 413 }),
  };
}

/** Never trust Content-Length as the actual size. Do not buffer an unbounded body. */
export async function readBoundedJson(req: Request, maxBytes: number): Promise<JsonResult> {
  const declared = req.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    // Cancellation of a tee can wait for the other branch; never await it here.
    void req.body?.cancel().catch(() => {});
    return tooLarge();
  }

  const reader = req.body?.getReader();
  try {
    const bytes = new Uint8Array(maxBytes);
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > maxBytes - size) {
          void reader.cancel().catch(() => {});
          return tooLarge();
        }
        bytes.set(value, size);
        size += value.byteLength;
      }
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "有効な JSON ボディが必要です" }, { status: 400 }),
    };
  } finally {
    reader?.releaseLock();
  }
}
