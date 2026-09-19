function write(stream: NodeJS.WriteStream, line: string): void {
  stream.write(`${line}\n`);
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
