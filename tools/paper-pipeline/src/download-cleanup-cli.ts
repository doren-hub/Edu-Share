import { parseArgs } from "node:util";
import { cleanupDownloads } from "./download-cleanup.ts";

// No browser, environment-file loader, or remote client imports.
try {
  const { values } = parseArgs({ options: {
    profile: { type: "string" }, work: { type: "string" },
    execute: { type: "boolean", default: false }, "pipeline-stopped": { type: "boolean", default: false },
  } });
  if (!values.profile || !values.work) throw new Error("Usage: download-cleanup --profile <chrome-profile> --work <work-root> [--execute --pipeline-stopped]");
  console.log(JSON.stringify({ dryRun: !values.execute, ...cleanupDownloads({ profile: values.profile,
    work: values.work, execute: values.execute, pipelineStopped: values["pipeline-stopped"] }) }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
