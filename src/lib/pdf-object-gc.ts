import { randomUUID } from "node:crypto";

export type GcObject = { key: string; lastModified: string; etag: string; size: number };
export type GcOptions = {
  execute?: boolean;
  operator?: string;
  approval?: string;
  writersStopped?: boolean;
};
export type GcDependencies = {
  list: () => AsyncIterable<GcObject>;
  head: (key: string) => Promise<GcObject | null>;
  remove: (object: GcObject) => Promise<void>;
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  report: (event: Record<string, unknown>) => void;
};
export const GC_CANDIDATE = "unreferenced-source-pdf-older-than-seven-days";

/** No credentials or I/O at import time; all production operations are injected. */
export async function collectOrphanPdfs(deps: GcDependencies, options: GcOptions = {}) {
  const execute = options.execute === true;
  if (execute && (!options.operator?.trim() || !options.approval?.trim() || options.writersStopped !== true)) {
    throw new Error("Execute requires explicit owner approval, operator and stopped/drained writers");
  }
  const run = randomUUID();
  let fenced = false;
  let deleted = 0;
  try {
    if (execute) {
      await deps.rpc("begin_pdf_gc", { p_run: run, p_operator: options.operator, p_approval: options.approval });
      fenced = true;
      deps.report({ run, mode: "execute", fence: "active" });
    }
    for await (const object of deps.list()) {
      // Missing/invalid inventory metadata never becomes deletion authority.
      if (!object.etag || !Number.isFinite(Date.parse(object.lastModified)) || !Number.isFinite(object.size)) {
        deps.report({ ...object, reason: "incomplete-inventory", action: "skip" });
        continue;
      }
      const reason = await deps.rpc("pdf_gc_reason", { p_key: object.key, p_modified: object.lastModified });
      deps.report({ ...object, reason, action: reason === GC_CANDIDATE ? (execute ? "recheck" : "would-delete") : "skip" });
      if (!execute || reason !== GC_CANDIDATE) continue;
      const current = await deps.head(object.key);
      if (!current || current.etag !== object.etag || current.lastModified !== object.lastModified || current.size !== object.size) {
        deps.report({ key: object.key, action: "skip", reason: "object-changed-or-absent" });
        continue;
      }
      // Commit a permanent tombstone before R2 deletion. Later DB writes cannot
      // publish this key, including delayed old workers or a failed delete retry.
      await deps.rpc("reserve_pdf_gc_object", {
        p_run: run, p_key: object.key, p_modified: current.lastModified, p_etag: current.etag,
      });
      try {
        await deps.remove(current);
      } catch (error) {
        await deps.rpc("finish_pdf_gc_object", { p_run: run, p_key: object.key, p_deleted: false });
        throw error;
      }
      await deps.rpc("finish_pdf_gc_object", { p_run: run, p_key: object.key, p_deleted: true });
      deleted++;
      deps.report({ key: object.key, action: "deleted", run });
    }
    return { run: execute ? run : null, deleted };
  } finally {
    if (fenced) await deps.rpc("end_pdf_gc", { p_run: run });
  }
}
