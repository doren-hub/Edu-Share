import { createClient } from "@supabase/supabase-js";
import {
  getObjectMetadata,
  putObject,
} from "../src/lib/object-storage.ts";

type SupabaseObject = {
  id?: string | null;
  name: string;
  metadata?: { mimetype?: string; size?: number } | null;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}

function contentTypeFor(path: string, object: SupabaseObject): string {
  if (object.metadata?.mimetype) return object.metadata.mimetype;
  if (path.toLowerCase().endsWith(".pdf")) return "application/pdf";
  if (path.toLowerCase().endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

function canonicalDestination(path: string): string {
  const match = /^([^/]+)\/([^/]+)\/(notebooklm-(?:slide\.pdf|video\.mp4))$/.exec(path);
  return match ? `${match[1]}/${match[2]}-${match[3]}` : path;
}

const supabase = createClient(
  required("NEXT_PUBLIC_SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function listAll(prefix = ""): Promise<Array<{ path: string; object: SupabaseObject }>> {
  const files: Array<{ path: string; object: SupabaseObject }> = [];
  const directories: string[] = [];
  const limit = 1_000;

  for (let offset = 0; ; offset += limit) {
    const { data, error } = await supabase.storage.from("pdfs").list(prefix, {
      limit,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`Supabase の一覧取得に失敗しました (${prefix || "/"}): ${error.message}`);
    const rows = (data ?? []) as SupabaseObject[];
    for (const object of rows) {
      const path = prefix ? `${prefix}/${object.name}` : object.name;
      if (object.id || object.metadata) files.push({ path, object });
      else directories.push(path);
    }
    if (rows.length < limit) break;
  }

  for (const directory of directories) files.push(...(await listAll(directory)));
  return files;
}

async function main() {
  const deleteSource = process.argv.includes("--delete-source");
  const files = await listAll();
  const sourceByPath = new Map(files.map((entry) => [entry.path, entry.object]));
  let copied = 0;
  let skipped = 0;
  let deleted = 0;
  const failures: string[] = [];

  console.log(`Supabase pdfs: ${files.length} objects`);
  for (const { path, object } of files) {
    try {
      const destination = canonicalDestination(path);
      const canonicalSource = sourceByPath.get(destination);
      const sourceObject = destination !== path && canonicalSource ? canonicalSource : object;
      const expectedSize = sourceObject.metadata?.size;
      const existing = await getObjectMetadata(destination);
      if (existing.exists && expectedSize != null && existing.size === expectedSize) {
        skipped += 1;
      } else {
        const downloadPath = destination !== path && canonicalSource ? destination : path;
        const { data, error } = await supabase.storage.from("pdfs").download(downloadPath);
        if (error || !data) throw new Error(error?.message || "download returned no body");
        const bytes = new Uint8Array(await data.arrayBuffer());
        await putObject(destination, bytes, contentTypeFor(downloadPath, sourceObject));
        const migrated = await getObjectMetadata(destination);
        if (!migrated.exists || (migrated.size != null && migrated.size !== bytes.byteLength)) {
          throw new Error("R2へのコピー後のサイズ検証に失敗しました");
        }
        copied += 1;
      }

      if (deleteSource) {
        const { error } = await supabase.storage.from("pdfs").remove([path]);
        if (error) throw new Error(`コピー済みですが削除に失敗しました: ${error.message}`);
        deleted += 1;
      }
      const mapping = destination === path ? path : `${path} -> ${destination}`;
      console.log(`${deleteSource ? "migrated+deleted" : "migrated"}: ${mapping}`);
    } catch (error) {
      const message = `${path}: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(message);
      console.error(`failed: ${message}`);
    }
  }

  console.log(
    `done: copied=${copied} already-in-r2=${skipped} deleted-from-supabase=${deleted} failed=${failures.length}`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

await main();
