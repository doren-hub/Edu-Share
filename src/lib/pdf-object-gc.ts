import { randomUUID } from "node:crypto";

export type GcObject = { key: string; lastModified: string; etag: string; size: number };
export type GcOptions = {
  maxObjects?: number;
  startAfter?: string;
  execute?: boolean;
  operator?: string;
  approval?: string;
  writersStopped?: boolean;
};
export type GcDependencies = {
  list: (startAfter?: string) => AsyncIterable<GcObject>;
  head: (key: string) => Promise<GcObject | null>;
  remove: (object: GcObject) => Promise<void>;
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  report: (event: Record<string, unknown>) => void;
};
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SOURCE_PDF = new RegExp(`^${UUID}/${UUID}(-${UUID})?\\.pdf$`);
export const DEFAULT_GC_MAX_OBJECTS = 10_000;
export const GC_CANDIDATE = "unreferenced-source-pdf-older-than-seven-days";

/** No credentials or I/O at import time; all production operations are injected. */
export async function collectOrphanPdfs(deps: GcDependencies, options: GcOptions = {}) {
  const maxObjects = options.maxObjects ?? DEFAULT_GC_MAX_OBJECTS;
  if (!Number.isSafeInteger(maxObjects) || maxObjects < 1 || maxObjects > 100_000) {
    throw new Error("maxObjects must be an integer from 1 to 100000");
  }
  const execute = options.execute === true;
  if (execute && (!options.operator?.trim() || !options.approval?.trim() || options.writersStopped !== true)) {
    throw new Error("Execute requires explicit owner approval, operator and stopped/drained writers");
  }
  const run = randomUUID();
  let fenced = false;
  let deleted = 0;
  let scanned = 0;
  let lastKey = options.startAfter ?? null;
  let limited = false;
  try {
    if (execute) {
      await deps.rpc("begin_pdf_gc", { p_run: run, p_operator: options.operator, p_approval: options.approval });
      fenced = true;
      deps.report({ run, mode: "execute", fence: "active" });
    }
    for await (const object of deps.list(options.startAfter)) {
      // Count all entries, including exclusions. No extra page/RPC is fetched
      // after the limit; exactly-full inventories conservatively need a resume.
      scanned++;
      lastKey = object.key;
      processObject: {
        // Missing/invalid inventory metadata never becomes deletion authority.
        if (!object.etag || !Number.isFinite(Date.parse(object.lastModified)) || !Number.isFinite(object.size)) {
          deps.report({ ...object, reason: "incomplete-inventory", action: "skip" });
          break processObject;
        }
        if (!SOURCE_PDF.test(object.key)) {
          deps.report({ ...object, reason: "outside-source-pdf-namespace", action: "skip" });
          break processObject;
        }
        // Local age is only an exclusion optimization. DB time remains the final
        // authority for every candidate, including immediately before retirement.
        if (Date.parse(object.lastModified) > Date.now() - 7 * 86400000) {
          deps.report({ ...object, reason: "within-seven-day-grace", action: "skip" });
          break processObject;
        }
        const reason = await deps.rpc("pdf_gc_reason", { p_key: object.key, p_modified: object.lastModified });
        deps.report({ ...object, reason, action: reason === GC_CANDIDATE ? (execute ? "recheck" : "would-delete") : "skip" });
        if (!execute || reason !== GC_CANDIDATE) break processObject;
        const current = await deps.head(object.key);
        if (!current || current.etag !== object.etag || current.lastModified !== object.lastModified || current.size !== object.size) {
          deps.report({ key: object.key, action: "skip", reason: "object-changed-or-absent" });
          break processObject;
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
      limited = scanned >= maxObjects;
      if (limited) break;
    }
    return { run: execute ? run : null, deleted, scanned, limited, resumeAfter: limited ? lastKey : null };
  } finally {
    if (fenced) await deps.rpc("end_pdf_gc", { p_run: run });
  }
}
