import { parseArgs } from "node:util";
import { archivePaper, listArchive, restorePaper } from "./artifact-archive.ts";

// Deliberately independent of browser configuration and dotenv loading.
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      paper: { type: "string" }, root: { type: "string" }, provider: { type: "string" },
      execute: { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1 || !["archive", "list", "restore"].includes(positionals[0]!) || !values.paper) {
    throw new Error("Usage: artifact-archive <archive|list|restore> --paper <paper-directory> [--root <existing-directory>] [--provider <kind>] [--execute]");
  }
  const command = positionals[0];
  const result = command === "list" ? listArchive(values.paper) ?? null
    : command === "restore" ? restorePaper(values.paper, values.execute)
    : archivePaper({ paperDir: values.paper, root: values.root ?? process.env.PAPER_PIPELINE_ARCHIVE_ROOT ?? "",
        provider: values.provider ?? process.env.PAPER_PIPELINE_ARCHIVE_PROVIDER, execute: values.execute });
  console.log(JSON.stringify({ command, dryRun: command === "list" ? undefined : !values.execute, result }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
