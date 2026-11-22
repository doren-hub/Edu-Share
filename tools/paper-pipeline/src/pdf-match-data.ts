import { fork } from "node:child_process";
import { closeSync, fstatSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { MessageChannel, type MessagePort } from "node:worker_threads";

type PdfMetadata = {
  info?: { doi?: unknown; Subject?: unknown; Keywords?: unknown; Title?: unknown; Author?: unknown };
  metadata?: { _metadata?: Record<string, unknown> };
};

export type PdfMatchData = PdfMetadata & { text: string };
export type PdfMatchReply = { data: PdfMatchData | null } | { error: string };

type PdfWorker = { destroy(): void };
type PdfLoadingTask = {
  promise: Promise<{
    numPages: number;
    getMetadata(): Promise<PdfMetadata>;
    getPage(page: number): Promise<{
      getTextContent(options: {
        normalizeWhitespace: boolean;
        disableCombineTextItems: boolean;
      }): Promise<{ items: { str: string; transform: number[] }[] }>;
    }>;
  }>;
  destroy(): Promise<void>;
};

const require = createRequire(import.meta.url);
// Keep the PDF.js version and text formatting used by pdf-parse v1.
const pdfJsBuild = "pdf-parse/lib/pdf.js/v1.10.100/build";

async function pageText(doc: Awaited<PdfLoadingTask["promise"]>, page: number): Promise<string> {
  const pdfPage = await doc.getPage(page);
  const { items } = await pdfPage.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });
  let lastY: number | undefined;
  let text = "";
  for (const item of items) {
    const y = item.transform[5];
    if (lastY && lastY !== y) text += "\n";
    text += item.str;
    lastY = y;
  }
  return text;
}

export async function readPdfMatchData(bytes: Uint8Array): Promise<PdfMatchData> {
  if (bytes.length === 0) return { text: "" };
  // PDF.js 1.x assumes that the input covers its backing store. Only a
  // sliced in-memory input needs a copy; a file mapping is already aligned.
  const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? new Uint8Array(bytes.buffer)
    : Uint8Array.from(bytes);

  const pdfjs = require(`${pdfJsBuild}/pdf.js`) as {
    PDFWorker: { fromPort(port: MessagePort): PdfWorker };
    getDocument(options: { data: Uint8Array; worker: PdfWorker }): PdfLoadingTask;
  };
  const { WorkerMessageHandler } = require(`${pdfJsBuild}/pdf.worker.js`) as {
    WorkerMessageHandler: { initializeFromPort(port: MessagePort): void };
  };

  // PDF.js 1.x's default in-process worker clones its input. MessageChannel
  // shares the backing store of a filesystem-mapped SharedArrayBuffer instead.
  const { port1, port2 } = new MessageChannel();
  let worker: PdfWorker | undefined;
  let task: PdfLoadingTask | undefined;
  try {
    WorkerMessageHandler.initializeFromPort(port2);
    worker = pdfjs.PDFWorker.fromPort(port1);
    task = pdfjs.getDocument({ data, worker });
    const doc = await task.promise;
    const metadata = await doc.getMetadata().catch(() => undefined);
    let text = "";
    for (let page = 1; page <= Math.min(doc.numPages, 2); page++) {
      text += "\n\n" + await pageText(doc, page).catch(() => "");
    }
    return { ...metadata, text };
  } finally {
    try {
      await task?.destroy();
    } finally {
      worker?.destroy();
      port1.close();
      port2.close();
    }
  }
}

/** Use from the helper process so a truncated mapped file cannot crash the orchestrator. */
export async function readMappedPdfMatchData(path: string): Promise<PdfMatchData | null> {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return null;
    const mmap = require("@riaskov/mmap-io") as typeof import("@riaskov/mmap-io").default;
    const mapping = mmap.map(size, mmap.PROT_READ, mmap.MAP_PRIVATE, fd, 0, mmap.MADV_RANDOM);
    try {
      return await readPdfMatchData(new Uint8Array(mapping));
    } finally {
      mmap.unmap(mapping);
    }
  } finally {
    closeSync(fd);
  }
}

export function readPdfMatchDataFromPath(path: string): Promise<PdfMatchData | null> {
  const workerFile = import.meta.url.endsWith(".ts") ? "./pdf-match-worker.ts" : "./pdf-match-worker.js";
  return new Promise((resolve, reject) => {
    const child = fork(new URL(workerFile, import.meta.url), [path], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let reply: PdfMatchReply | undefined;
    child.once("message", (message: PdfMatchReply) => { reply = message; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && reply && "data" in reply) {
        resolve(reply.data);
      } else {
        reject(new Error(reply && "error" in reply ? reply.error : `PDF 解析プロセス終了: ${signal ?? code}`));
      }
    });
  });
}
