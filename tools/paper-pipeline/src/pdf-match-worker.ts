import { firstLine } from "./log.ts";
import { readMappedPdfMatchData, type PdfMatchReply } from "./pdf-match-data.ts";

async function readPdf(path: string): Promise<PdfMatchReply> {
  try {
    return { data: await readMappedPdfMatchData(path) };
  } catch (error) {
    return { error: firstLine(error) };
  }
}

const path = process.argv[2];
if (process.send && path) {
  process.send(await readPdf(path));
}
