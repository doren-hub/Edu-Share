import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/ と dist/ のどちらからでも同じ logs/ に保存する。
const defaultLogFile = fileURLToPath(new URL("../logs/pipeline.log", import.meta.url));
let fileOutputFailed = false;

function write(stream: NodeJS.WriteStream, line: string): void {
  const output = `${line}\n`;
  stream.write(output);
  const configured = process.env.PAPER_PIPELINE_LOG_FILE;
  if (configured === "off" || fileOutputFailed) return;
  const file = configured ? resolve(configured) : defaultLogFile;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, output, { encoding: "utf8", mode: 0o600 });
  } catch {
    fileOutputFailed = true;
    // パスや例外本文には秘密情報が含まれる可能性があるため出力しない。
    process.stderr.write(`[${new Date().toISOString()}] WARN ログファイルに書き込めません。今回のプロセスではファイル出力を停止します。\n`);
  }
}

/** Playwright の Call log（cookie 含む）を残さない */
export function firstLine(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (raw.split("\n")[0] ?? raw).slice(0, 400);
}

export function log(message: string): void {
  write(process.stdout, `[${new Date().toISOString()}] ${message}`);
}

export function warn(message: string): void {
  write(process.stderr, `[${new Date().toISOString()}] WARN ${message}`);
}

export function error(message: string): void {
  write(process.stderr, `[${new Date().toISOString()}] ERROR ${message}`);
}
