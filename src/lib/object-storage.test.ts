import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import {
  isPayloadTooLargeError,
  PayloadTooLargeError,
  putObject,
  resetObjectStorageConfigForTests,
  setR2ClientForTests,
} from "./object-storage.ts";

function createMockS3Client(onCommand?: (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => void): S3Client {
  const client = new S3Client({
    region: "auto",
    endpoint: "https://example.com",
    credentials: { accessKeyId: "mock-key", secretAccessKey: "mock-secret" },
  });
  client.send = (async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    if (onCommand) onCommand(cmd);
    const name = cmd.constructor.name;
    if (name === "CreateMultipartUploadCommand") {
      return { UploadId: "mock-upload-id" };
    }
    if (name === "UploadPartCommand") {
      return { ETag: `"mock-etag-${cmd.input.PartNumber}"` };
    }
    if (name === "CompleteMultipartUploadCommand") {
      return { Location: "https://example.com/mock-bucket/mock-key" };
    }
    if (name === "AbortMultipartUploadCommand") {
      return {};
    }
    if (name === "PutObjectCommand") {
      return {};
    }
    return {};
  }) as typeof client.send;
  return client;
}

test("R2 public URL はキーの各セグメントをURLエンコードする", async () => {
  const previous = { ...process.env };
  process.env.R2_ENDPOINT = "https://example.invalid";
  process.env.R2_ACCESS_KEY_ID = "key";
  process.env.R2_SECRET_ACCESS_KEY = "secret";
  process.env.R2_BUCKET_NAME = "bucket";
  process.env.R2_PUBLIC_BASE_URL = "https://files.example.com/root/";

  const storage = await import("./object-storage.ts");
  storage.resetObjectStorageConfigForTests();
  assert.equal(
    await storage.createObjectReadUrl("user name/file #1.pdf"),
    "https://files.example.com/root/user%20name/file%20%231.pdf",
  );

  process.env = previous;
  storage.resetObjectStorageConfigForTests();
});

test("putObject: 40MB 相当のストリームを @aws-sdk/lib-storage のマルチパートで正常に R2 送信する", async () => {
  resetObjectStorageConfigForTests();

  const chunkSize = 1024 * 1024; // 1MB
  const totalChunks = 40;
  let chunksGenerated = 0;
  const commandNames: string[] = [];
  let capturedCreateInput: Record<string, unknown> = {};

  const mockClient = createMockS3Client((cmd) => {
    commandNames.push(cmd.constructor.name);
    if (cmd.constructor.name === "CreateMultipartUploadCommand") {
      capturedCreateInput = cmd.input;
    }
  });

  setR2ClientForTests(mockClient);

  async function* sourceGenerator() {
    for (let i = 0; i < totalChunks; i++) {
      chunksGenerated++;
      yield new Uint8Array(chunkSize);
    }
  }

  const stream = Readable.from(sourceGenerator());
  const maxBytes = 45 * 1024 * 1024; // 45MB
  const totalBytes = totalChunks * chunkSize; // 40MB

  await putObject("tests/user1/test-slide.pdf", stream, "application/pdf", {
    maxBytes,
    contentLength: totalBytes,
  });

  assert.equal(capturedCreateInput.Key, "tests/user1/test-slide.pdf");
  assert.equal(capturedCreateInput.ContentType, "application/pdf");
  assert.equal(chunksGenerated, 40);

  // S3 multipart flow: CreateMultipartUpload -> UploadPart (複数) -> CompleteMultipartUpload
  assert.equal(commandNames[0], "CreateMultipartUploadCommand");
  assert.ok(commandNames.filter((n) => n === "UploadPartCommand").length >= 8); // 40MB / 5MB = 8 parts
  assert.equal(commandNames[commandNames.length - 1], "CompleteMultipartUploadCommand");

  resetObjectStorageConfigForTests();
});

test("putObject: 40MB 相当のストリームで上限超過時に中断し AbortMultipartUploadCommand を呼ぶ", async () => {
  resetObjectStorageConfigForTests();

  const chunkSize = 1024 * 1024; // 1MB
  const totalChunks = 40;
  let chunksGenerated = 0;
  const commandNames: string[] = [];

  const mockClient = createMockS3Client((cmd) => {
    commandNames.push(cmd.constructor.name);
  });

  setR2ClientForTests(mockClient);

  async function* sourceGenerator() {
    for (let i = 0; i < totalChunks; i++) {
      chunksGenerated++;
      yield new Uint8Array(chunkSize);
    }
  }

  const stream = Readable.from(sourceGenerator());
  const maxBytes = 20 * 1024 * 1024; // 20MB (40MB より小さい)

  await assert.rejects(
    async () => {
      await putObject("tests/user1/test-video.mp4", stream, "video/mp4", {
        maxBytes,
      });
    },
    (err: unknown) => {
      assert.ok(isPayloadTooLargeError(err));
      assert.ok(err instanceof PayloadTooLargeError);
      assert.equal(err.maxBytes, maxBytes);
      assert.ok(err.bytesRead > maxBytes);
      return true;
    },
  );

  // 40MB 全部を生成せず、20MB 超過直後（22チャンク前後）で中断されたことを確認
  assert.ok(chunksGenerated <= 23, `chunksGenerated should be around 22, got ${chunksGenerated}`);
  // アップロードが中断されたため AbortMultipartUploadCommand が発行されることを確認
  assert.ok(commandNames.includes("AbortMultipartUploadCommand"));

  resetObjectStorageConfigForTests();
});

test("putObject: declared contentLength が maxBytes を超える場合はストリームを読まずに即座に中断する", async () => {
  resetObjectStorageConfigForTests();

  let chunksGenerated = 0;
  const mockClient = createMockS3Client();

  setR2ClientForTests(mockClient);

  async function* sourceGenerator() {
    chunksGenerated++;
    yield new Uint8Array(1024);
  }

  const stream = Readable.from(sourceGenerator());
  const maxBytes = 10 * 1024 * 1024;

  await assert.rejects(
    async () => {
      await putObject("tests/user1/test.pdf", stream, "application/pdf", {
        maxBytes,
        contentLength: 20 * 1024 * 1024,
      });
    },
    (err: unknown) => {
      assert.ok(isPayloadTooLargeError(err));
      return true;
    },
  );

  assert.equal(chunksGenerated, 0);

  resetObjectStorageConfigForTests();
});

test("putObject: Web ReadableStream で上限超過時に underlying stream がキャンセルされマルチパートが中断される", async () => {
  resetObjectStorageConfigForTests();

  let cancelled = false;
  let generated = 0;
  const chunkSize = 1024 * 1024; // 1MB
  const commandNames: string[] = [];

  const webStream = new ReadableStream({
    pull(controller) {
      if (generated >= 40) {
        controller.close();
        return;
      }
      generated++;
      controller.enqueue(new Uint8Array(chunkSize));
    },
    cancel() {
      cancelled = true;
    },
  });

  const mockClient = createMockS3Client((cmd) => {
    commandNames.push(cmd.constructor.name);
  });

  setR2ClientForTests(mockClient);

  const maxBytes = 15 * 1024 * 1024; // 15MB

  await assert.rejects(
    async () => {
      await putObject("tests/user1/test-web.mp4", webStream, "video/mp4", {
        maxBytes,
      });
    },
    (err: unknown) => {
      assert.ok(isPayloadTooLargeError(err));
      return true;
    },
  );

  assert.equal(cancelled, true);
  assert.ok(generated <= 18, `generated chunks should be around 16, got ${generated}`);
  assert.ok(commandNames.includes("AbortMultipartUploadCommand"));

  resetObjectStorageConfigForTests();
});

test("putObject: Uint8Array は PutObjectCommand で直接送信され上限判定も動作する", async () => {
  resetObjectStorageConfigForTests();

  let receivedBytes = 0;
  let putObjectCommandCount = 0;
  const mockClient = createMockS3Client((cmd) => {
    if (cmd.constructor.name === "PutObjectCommand") {
      putObjectCommandCount++;
      const b = cmd.input.Body as Uint8Array;
      receivedBytes = b.byteLength;
    }
  });

  setR2ClientForTests(mockClient);

  const buf = new Uint8Array([1, 2, 3, 4, 5]);
  await putObject("tests/user1/small.pdf", buf, "application/pdf", {
    maxBytes: 10,
  });
  assert.equal(receivedBytes, 5);
  assert.equal(putObjectCommandCount, 1);

  await assert.rejects(
    async () => {
      await putObject("tests/user1/small.pdf", buf, "application/pdf", {
        maxBytes: 3,
      });
    },
    (err: unknown) => {
      assert.ok(isPayloadTooLargeError(err));
      return true;
    },
  );

  resetObjectStorageConfigForTests();
});
