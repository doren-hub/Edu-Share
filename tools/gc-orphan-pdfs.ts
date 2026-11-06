import { pathToFileURL } from "node:url";
import { S3Client, ListObjectsV2Command, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import { collectOrphanPdfs, type GcObject } from "../src/lib/pdf-object-gc.ts";

export function parseGcArguments(args: string[]) {
  const options = { execute: false, writersStopped: false, operator: "", approval: "" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--execute") options.execute = true;
    else if (arg === "--dry-run") { /* default */ }
    else if (arg === "--writers-stopped") options.writersStopped = true;
    else if (arg === "--operator" || arg === "--approval") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      options[arg === "--operator" ? "operator" : "approval"] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.includes("--dry-run") && options.execute) throw new Error("Conflicting modes");
  if (options.execute && (!options.writersStopped || !options.operator.trim() || !options.approval.trim())) {
    throw new Error("Execute requires --writers-stopped --operator NAME --approval OWNER-APPROVAL-REFERENCE");
  }
  return options;
}
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
export async function main(args = process.argv.slice(2)) {
  const options = parseGcArguments(args);
  // Intentionally no dotenv/.env.local loading. Operator supplies an approved
  // environment. Both service clients have bounded network timeouts.
  const admin = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }) },
  });
  const bucket = required("R2_BUCKET_NAME");
  const s3 = new S3Client({
    region: "auto", endpoint: required("R2_ENDPOINT"),
    credentials: { accessKeyId: required("R2_ACCESS_KEY_ID"), secretAccessKey: required("R2_SECRET_ACCESS_KEY") },
    requestHandler: { requestTimeout: 30_000, connectionTimeout: 10_000 },
  });
  try {
    const result = await collectOrphanPdfs({
      async *list() {
        let token: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
          for (const obj of page.Contents ?? []) {
            yield { key: obj.Key ?? "", lastModified: obj.LastModified?.toISOString() ?? "", etag: obj.ETag ?? "", size: obj.Size ?? NaN };
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
          if (page.IsTruncated && (!token || seen.has(token))) throw new Error("Incomplete R2 listing");
          if (token) seen.add(token);
        } while (token);
      },
      async head(key) {
        try {
          const obj = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
          return { key, lastModified: obj.LastModified?.toISOString() ?? "", etag: obj.ETag ?? "", size: obj.ContentLength ?? NaN };
        } catch (error) {
          if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
          throw error;
        }
      },
      async remove(obj: GcObject) {
        // All external writers must remain stopped throughout maintenance. R2
        // DeleteObject conditional headers are not assumed to be supported.
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.key }));
      },
      async rpc(name, args) {
        const { data, error } = await admin.rpc(name, args);
        if (error) throw new Error(`${name}: ${error.message}`);
        return data;
      },
      report: (event) => console.log(JSON.stringify(event)),
    }, options);
    console.log(JSON.stringify(result));
  } finally { s3.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "PDF GC failed"); process.exitCode = 1; });
}
