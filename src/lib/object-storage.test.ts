import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  isPayloadTooLargeError,
  PayloadTooLargeError,
  putObject,
  resetObjectStorageConfigForTests,
  setR2ClientForTests,
} from "./object-storage.ts";

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

test("putObject: 40MB 相当のストリームをメモリに全展開せず正常に R2 送信する", async () => {
  resetObjectStorageConfigForTests();

  const chunkSize = 1024 * 1024; // 1MB
  const totalChunks = 40;
  let chunksGenerated = 0;
  let receivedBytes = 0;
  let receivedChunks = 0;
  let capturedCommand: {
    Bucket?: string;
    Key?: string;
    ContentType?: string;
    ContentLength?: number;
    CacheControl?: string;
  } = {};

  const mockClient = {
    send: async (cmd: { input: Record<string, unknown> }) => {
      capturedCommand = {
        Bucket: cmd.input.Bucket as string,
        Key: cmd.input.Key as string,
        ContentType: cmd.input.ContentType as string,
        ContentLength: cmd.input.ContentLength as number,
        CacheControl: cmd.input.CacheControl as string,
      };
      const stream = cmd.input.Body as AsyncIterable<Uint8Array>;
      for await (const chunk of stream) {
        receivedBytes += chunk.byteLength;
        receivedChunks++;
      }
      return {};
    },
  } as unknown as S3Client;

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

  assert.equal(capturedCommand.Key, "tests/user1/test-slide.pdf");
  assert.equal(capturedCommand.ContentType, "application/pdf");
  assert.equal(capturedCommand.ContentLength, totalBytes);
  assert.equal(receivedBytes, totalBytes);
  assert.equal(receivedChunks, 40);
  assert.equal(chunksGenerated, 40);

  resetObjectStorageConfigForTests();
});

test("putObject: 40MB 相当のストリームで上限超過時にストリームを中断し PayloadTooLargeError を投げる", async () => {
  resetObjectStorageConfigForTests();

  const chunkSize = 1024 * 1024; // 1MB
  const totalChunks = 40;
  let chunksGenerated = 0;
  let receivedBytes = 0;

  const mockClient = {
    send: async (cmd: { input: Record<string, unknown> }) => {
      const stream = cmd.input.Body as AsyncIterable<Uint8Array>;
      for await (const chunk of stream) {
        receivedBytes += chunk.byteLength;
      }
      return {};
    },
  } as unknown as S3Client;

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

  // 40MB 全部を生成せず、20MB 超過直後（21チャンク目）で中断されたことを確認
  assert.ok(chunksGenerated <= 22, `chunksGenerated should be around 21, got ${chunksGenerated}`);
  assert.ok(receivedBytes <= 22 * chunkSize);

  resetObjectStorageConfigForTests();
});

test("putObject: declared contentLength が maxBytes を超える場合はストリームを読まずに即座に中断する", async () => {
  resetObjectStorageConfigForTests();

  let chunksGenerated = 0;
  const mockClient = {
    send: async () => ({}),
  } as unknown as S3Client;

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

test("putObject: Web ReadableStream で上限超過時に underlying stream がキャンセルされる", async () => {
  resetObjectStorageConfigForTests();

  let cancelled = false;
  let generated = 0;
  const chunkSize = 1024 * 1024; // 1MB

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

  const mockClient = {
    send: async (cmd: { input: Record<string, unknown> }) => {
      const stream = cmd.input.Body as AsyncIterable<Uint8Array>;
      for await (const _ of stream) {
        // reading
      }
      return {};
    },
  } as unknown as S3Client;

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
  assert.ok(generated <= 17, `generated chunks should be around 16, got ${generated}`);

  resetObjectStorageConfigForTests();
});

test("putObject: Uint8Array も既存どおり正常に送信・上限超過判定できる", async () => {
  resetObjectStorageConfigForTests();

  let receivedBytes = 0;
  const mockClient = {
    send: async (cmd: { input: Record<string, unknown> }) => {
      const b = cmd.input.Body as Uint8Array;
      receivedBytes = b.byteLength;
      return {};
    },
  } as unknown as S3Client;

  setR2ClientForTests(mockClient);

  const buf = new Uint8Array([1, 2, 3, 4, 5]);
  await putObject("tests/user1/small.pdf", buf, "application/pdf", {
    maxBytes: 10,
  });
  assert.equal(receivedBytes, 5);

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
