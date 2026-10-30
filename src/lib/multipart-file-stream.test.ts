import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import {
  processMultipartFileUpload,
} from "./multipart-file-stream.ts";
import {
  isPayloadTooLargeError,
  PayloadTooLargeError,
} from "./object-storage.ts";
import {
  looksLikeSlidePdf,
  looksLikeVideoMp4,
} from "./pdfs-bucket-upload.ts";

function createMultipartStream(
  boundary: string,
  filename: string,
  mimeType: string,
  totalChunks: number,
  chunkSize: number,
  onChunkYielded?: () => void,
): { stream: ReadableStream<Uint8Array>; getGeneratedCount: () => number } {
  let generated = 0;
  let sentHeader = false;
  let sentFooter = false;

  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentHeader) {
        sentHeader = true;
        controller.enqueue(header);
        return;
      }
      if (generated < totalChunks) {
        generated++;
        if (onChunkYielded) onChunkYielded();
        controller.enqueue(Buffer.alloc(chunkSize, "v"));
        return;
      }
      if (!sentFooter) {
        sentFooter = true;
        controller.enqueue(footer);
        controller.close();
      }
    },
  });

  return { stream, getGeneratedCount: () => generated };
}

test("multipart: 40MB 相当の動画ストリームをメモリに全展開せず正常に処理できる", async () => {
  const boundary = "---------------------------boundary1";
  const chunkSize = 1024 * 1024; // 1MB
  const totalChunks = 40; // 40MB
  const { stream, getGeneratedCount } = createMultipartStream(
    boundary,
    "movie.mp4",
    "video/mp4",
    totalChunks,
    chunkSize,
  );

  const req = new Request("http://localhost/api/tests/t1/material/video", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body: stream,
    // @ts-expect-error Node.js fetch duplex
    duplex: "half",
  });

  let receivedBytes = 0;
  let receivedChunks = 0;

  const result = await processMultipartFileUpload(
    req,
    {
      maxBytes: 200 * 1024 * 1024,
      maxBytesMessage: "動画は 200MB 以下にしてください",
      missingFileMessage: "動画ファイルが必要です",
      invalidFormatMessage: "動画は MP4 のみアップロードできます",
      fileValidator: looksLikeVideoMp4,
    },
    async (fileStream) => {
      for await (const chunk of fileStream) {
        receivedBytes += chunk.byteLength;
        receivedChunks++;
      }
    },
  );

  assert.equal(result.ok, true);
  assert.equal(receivedBytes, totalChunks * chunkSize);
  assert.equal(receivedChunks, 40);
  assert.equal(getGeneratedCount(), 40);
});

test("multipart: 40MB 相当のストリームで上限（20MB）超過時に途中で中断され 413 を返す", async () => {
  const boundary = "---------------------------boundary2";
  const chunkSize = 1024 * 1024; // 1MB
  const totalChunks = 40; // 40MB
  const maxBytes = 20 * 1024 * 1024; // 20MB 上限
  let chunksYielded = 0;

  const { stream, getGeneratedCount } = createMultipartStream(
    boundary,
    "movie.mp4",
    "video/mp4",
    totalChunks,
    chunkSize,
    () => {
      chunksYielded++;
    },
  );

  const req = new Request("http://localhost/api/tests/t1/material/video", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body: stream,
    // @ts-expect-error Node.js fetch duplex
    duplex: "half",
  });

  let receivedBytes = 0;

  const result = await processMultipartFileUpload(
    req,
    {
      maxBytes,
      maxBytesMessage: "動画は 20MB 以下にしてください",
      missingFileMessage: "動画ファイルが必要です",
      invalidFormatMessage: "動画は MP4 のみアップロードできます",
      fileValidator: looksLikeVideoMp4,
    },
    async (fileStream) => {
      async function* limitGen() {
        for await (const chunk of fileStream) {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > maxBytes) {
            throw new PayloadTooLargeError(maxBytes, receivedBytes);
          }
          yield chunk;
        }
      }
      for await (const _ of limitGen()) {
        // reading
      }
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 413);
    assert.equal(result.error, "動画は 20MB 以下にしてください");
  }

  // 40MB すべてを生成せず、20MB 超過後ただちに中断されたことを確認
  assert.ok(getGeneratedCount() <= 23, `Generated ${getGeneratedCount()} chunks, expected <= 23`);
  assert.ok(chunksYielded <= 23);
  assert.ok(receivedBytes <= 22 * chunkSize);
});

test("multipart: declared Content-Length が上限を超える場合はストリームを読まずに即座に 413 を返す", async () => {
  const boundary = "---------------------------boundary3";
  let chunksGenerated = 0;
  const { stream } = createMultipartStream(
    boundary,
    "slide.pdf",
    "application/pdf",
    10,
    1024 * 1024,
    () => {
      chunksGenerated++;
    },
  );

  const maxBytes = 45 * 1024 * 1024; // 45MB
  const declaredLength = 50 * 1024 * 1024; // 50MB

  const req = new Request("http://localhost/api/tests/t1/material/slide", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(declaredLength),
    },
    body: stream,
    // @ts-expect-error Node.js fetch duplex
    duplex: "half",
  });

  const result = await processMultipartFileUpload(
    req,
    {
      maxBytes,
      maxBytesMessage: "PDF は 45MB 以下にしてください",
      missingFileMessage: "PDFファイルが必要です",
      invalidFormatMessage: "スライドは PDF のみアップロードできます",
      fileValidator: looksLikeSlidePdf,
    },
    async () => {},
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 413);
    assert.equal(result.error, "PDF は 45MB 以下にしてください");
  }

  assert.equal(chunksGenerated, 0);
});

test("multipart: 形式不正（MP4以外の拡張子）のときは 400 を返す", async () => {
  const boundary = "---------------------------boundary4";
  const { stream } = createMultipartStream(
    boundary,
    "test.txt",
    "text/plain",
    1,
    100,
  );

  const req = new Request("http://localhost/api/tests/t1/material/video", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body: stream,
    // @ts-expect-error Node.js fetch duplex
    duplex: "half",
  });

  const result = await processMultipartFileUpload(
    req,
    {
      maxBytes: 200 * 1024 * 1024,
      maxBytesMessage: "動画は 200MB 以下にしてください",
      missingFileMessage: "動画ファイルが必要です",
      invalidFormatMessage: "動画は MP4 のみアップロードできます",
      fileValidator: looksLikeVideoMp4,
    },
    async () => {},
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.equal(result.error, "動画は MP4 のみアップロードできます");
  }
});

test("multipart: file フィールドが存在しない場合は 400 を返す", async () => {
  const boundary = "---------------------------boundary5";
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="other"\r\n\r\nhello\r\n--${boundary}--\r\n`,
  );

  const req = new Request("http://localhost/api/tests/t1/material/slide", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body: payload,
    // @ts-expect-error Node.js fetch duplex
    duplex: "half",
  });

  const result = await processMultipartFileUpload(
    req,
    {
      maxBytes: 45 * 1024 * 1024,
      maxBytesMessage: "PDF は 45MB 以下にしてください",
      missingFileMessage: "PDFファイルが必要です",
      invalidFormatMessage: "スライドは PDF のみアップロードできます",
      fileValidator: looksLikeSlidePdf,
    },
    async () => {},
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.equal(result.error, "PDFファイルが必要です");
  }
});
