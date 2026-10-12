import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getObjectMetadata,
  putObject,
} from "../src/lib/object-storage.ts";
import {
  notebooklmSlidePdfStoragePath,
  notebooklmVideoMp4StoragePath,
} from "../src/lib/test-notebooklm-material-paths.ts";

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

type Source = {
  label: string;
  list(): Promise<Array<{ path: string; object: SupabaseObject }>>;
  read(path: string): Promise<Uint8Array>;
  remove?(path: string): Promise<void>;
};

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} には値が必要です`);
  return value;
}

let supabaseClient: SupabaseClient | null = null;

function supabase(): SupabaseClient {
  supabaseClient ??= createClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return supabaseClient;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PipelineState = { filename?: string; eduShareTestId?: string; eduShareTestUrl?: string };

/**
 * paper-pipeline の作業フォルダ（PAPER_WORK_DIR）を読む。
 * 各論文フォルダの state.json にあるテスト ID から R2 のキーを組み立てる。
 */
function workDirSource(dir: string, userId: string): Source {
  const root = resolve(dir);
  const localByKey = new Map<string, string>();
  return {
    label: `work dir ${root}`,
    list: async () => {
      const files: Array<{ path: string; object: SupabaseObject }> = [];
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const paperDir = join(root, entry.name);
        let state: PipelineState;
        try {
          state = JSON.parse(await readFile(join(paperDir, "state.json"), "utf8")) as PipelineState;
        } catch {
          console.warn(`skipped (state.json なし): ${entry.name}`);
          continue;
        }
        const testId = state.eduShareTestId || state.eduShareTestUrl?.split("/tests/")[1]?.split(/[/?#]/)[0] || "";
        if (!UUID.test(testId)) {
          console.warn(`skipped (テスト ID なし): ${entry.name}`);
          continue;
        }
        const candidates: Array<[string, string]> = [
          [state.filename ?? "", `${userId}/${testId}.pdf`],
          ["slides.pdf", notebooklmSlidePdfStoragePath(userId, testId)],
          ["video.mp4", notebooklmVideoMp4StoragePath(userId, testId)],
        ];
        for (const [name, key] of candidates) {
          const local = name ? join(paperDir, name) : "";
          const info = local ? await stat(local).catch(() => null) : null;
          if (!info?.isFile()) {
            console.warn(`missing: ${entry.name}/${name || "(PDF 名なし)"}`);
            continue;
          }
          if (localByKey.has(key)) {
            console.warn(`duplicate (同じテスト ID): ${entry.name}/${name}`);
            continue;
          }
          localByKey.set(key, local);
          files.push({ path: key, object: { name, metadata: { size: info.size } } });
        }
      }
      return files;
    },
    read: async (path) => {
      const local = localByKey.get(path);
      if (!local) throw new Error("手元のファイルが見つかりません");
      return new Uint8Array(await readFile(local));
    },
  };
}

function supabaseSource(): Source {
  return {
    label: "Supabase pdfs",
    list: () => listAll(),
    read: async (path) => {
      const { data, error } = await supabase().storage.from("pdfs").download(path);
      if (error || !data) throw new Error(error?.message || "download returned no body");
      return new Uint8Array(await data.arrayBuffer());
    },
    remove: async (path) => {
      const { error } = await supabase().storage.from("pdfs").remove([path]);
      if (error) throw new Error(`コピー済みですが削除に失敗しました: ${error.message}`);
    },
  };
}

async function listAll(prefix = ""): Promise<Array<{ path: string; object: SupabaseObject }>> {
  const files: Array<{ path: string; object: SupabaseObject }> = [];
  const directories: string[] = [];
  const limit = 1_000;

  for (let offset = 0; ; offset += limit) {
    const { data, error } = await supabase().storage.from("pdfs").list(prefix, {
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
  const dryRun = process.argv.includes("--dry-run");
  const workDir = argValue("--from-work-dir");
  const userId = argValue("--user-id");
  if (workDir && deleteSource) {
    throw new Error("--from-work-dir と --delete-source は同時に使えません");
  }
  if (workDir && !(userId && UUID.test(userId))) {
    throw new Error("--from-work-dir には --user-id <tests.uploaded_by の UUID> が必要です");
  }
  const source = workDir && userId ? workDirSource(workDir, userId) : supabaseSource();
  const files = await source.list();
  const sourceByPath = new Map(files.map((entry) => [entry.path, entry.object]));
  let copied = 0;
  let skipped = 0;
  let deleted = 0;
  let totalBytes = 0;
  const failures: string[] = [];

  console.log(`${source.label}: ${files.length} objects`);
  for (const { path, object } of files) {
    try {
      const destination = canonicalDestination(path);
      const canonicalSource = sourceByPath.get(destination);
      const sourceObject = destination !== path && canonicalSource ? canonicalSource : object;
      const expectedSize = sourceObject.metadata?.size;
      const mapping = destination === path ? path : `${path} -> ${destination}`;
      if (dryRun) {
        totalBytes += expectedSize ?? 0;
        console.log(`dry-run: ${mapping} (${expectedSize ?? "?"} bytes)`);
        continue;
      }
      const existing = await getObjectMetadata(destination);
      if (existing.exists && expectedSize != null && existing.size === expectedSize) {
        skipped += 1;
      } else {
        const downloadPath = destination !== path && canonicalSource ? destination : path;
        const bytes = await source.read(downloadPath);
        await putObject(destination, bytes, contentTypeFor(downloadPath, sourceObject));
        const migrated = await getObjectMetadata(destination);
        if (!migrated.exists || (migrated.size != null && migrated.size !== bytes.byteLength)) {
          throw new Error("R2へのコピー後のサイズ検証に失敗しました");
        }
        copied += 1;
      }

      if (deleteSource && source.remove) {
        await source.remove(path);
        deleted += 1;
      }
      console.log(`${deleteSource ? "migrated+deleted" : "migrated"}: ${mapping}`);
    } catch (error) {
      const message = `${path}: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(message);
      console.error(`failed: ${message}`);
    }
  }

  if (dryRun) console.log(`dry-run total: ${(totalBytes / 1024 ** 3).toFixed(2)} GB`);
  console.log(
    `done: copied=${copied} already-in-r2=${skipped} deleted-from-supabase=${deleted} failed=${failures.length}`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

await main();
