import busboy from "busboy";
import { Readable } from "node:stream";
import { isPayloadTooLargeError } from "./object-storage.ts";
import { sanitizeProcessingError } from "./sanitize-processing-error.ts";

export type ProcessMultipartFileOptions = {
  maxBytes: number;
  maxBytesMessage: string;
  missingFileMessage: string;
  invalidFormatMessage: string;
  fileValidator: (file: { filename: string; mimeType: string }) => boolean;
};

export type ProcessMultipartFileResult =
  | { ok: true; filename: string; mimeType: string }
  | { ok: false; status: number; error: string; details?: string };

export async function processMultipartFileUpload(
  req: Request,
  options: ProcessMultipartFileOptions,
  uploadFile: (fileStream: Readable, fileInfo: { filename: string; mimeType: string }) => Promise<void>,
): Promise<ProcessMultipartFileResult> {
  const declaredLength = Number(req.headers.get("content-length"));
  const MARGIN_BYTES = 64 * 1024;
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes + MARGIN_BYTES) {
    return {
      ok: false,
      status: 413,
      error: options.maxBytesMessage,
    };
  }

  const contentType = req.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return {
      ok: false,
      status: 400,
      error: options.missingFileMessage,
    };
  }

  if (!req.body) {
    return {
      ok: false,
      status: 400,
      error: options.missingFileMessage,
    };
  }

  const bb = busboy({ headers: { "content-type": contentType } });
  const reqStream = Readable.fromWeb(req.body as import("node:stream/web").ReadableStream);

  return await new Promise<ProcessMultipartFileResult>((resolve) => {
    let finished = false;
    let fileHandled = false;

    const cleanupAndResolve = (result: ProcessMultipartFileResult) => {
      if (finished) return;
      finished = true;
      try {
        reqStream.unpipe(bb);
        bb.on("error", () => {});
        reqStream.on("error", () => {});
        reqStream.destroy();
        bb.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    bb.on("file", async (name, fileStream, info) => {
      fileStream.on("error", () => {});
      if (name !== "file" || fileHandled) {
        fileStream.resume();
        return;
      }
      fileHandled = true;

      const fileInfo = {
        filename: info.filename || "",
        mimeType: info.mimeType || "",
      };

      if (!options.fileValidator(fileInfo)) {
        fileStream.resume();
        cleanupAndResolve({
          ok: false,
          status: 400,
          error: options.invalidFormatMessage,
        });
        return;
      }

      try {
        await uploadFile(fileStream, fileInfo);
        cleanupAndResolve({
          ok: true,
          filename: fileInfo.filename,
          mimeType: fileInfo.mimeType,
        });
      } catch (err) {
        if (isPayloadTooLargeError(err)) {
          cleanupAndResolve({
            ok: false,
            status: 413,
            error: options.maxBytesMessage,
          });
          return;
        }
        cleanupAndResolve({
          ok: false,
          status: 500,
          error: "R2へのアップロードに失敗しました",
          details: sanitizeProcessingError(err),
        });
      }
    });

    bb.on("close", () => {
      if (!fileHandled) {
        cleanupAndResolve({
          ok: false,
          status: 400,
          error: options.missingFileMessage,
        });
      }
    });

    bb.on("error", (err) => {
      cleanupAndResolve({
        ok: false,
        status: 500,
        error: "リクエストの解析に失敗しました",
        details: err instanceof Error ? err.message : String(err),
      });
    });

    reqStream.pipe(bb);
  });
}
