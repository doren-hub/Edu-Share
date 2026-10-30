import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";

export class PayloadTooLargeError extends Error {
  readonly maxBytes: number;
  readonly bytesRead: number;

  constructor(maxBytes: number, bytesRead: number) {
    super(`Payload size exceeded limit of ${maxBytes} bytes (read ${bytesRead} bytes)`);
    this.name = "PayloadTooLargeError";
    this.maxBytes = maxBytes;
    this.bytesRead = bytesRead;
  }
}

export function isPayloadTooLargeError(error: unknown): error is PayloadTooLargeError {
  if (error instanceof PayloadTooLargeError) return true;
  if (error && typeof error === "object") {
    const e = error as { name?: string; cause?: unknown };
    if (e.name === "PayloadTooLargeError") return true;
    if (e.cause && isPayloadTooLargeError(e.cause)) return true;
  }
  return false;
}

export type PutObjectOptions = {
  contentLength?: number;
  maxBytes?: number;
};

export type PutObjectBody =
  | Uint8Array
  | Readable
  | ReadableStream<Uint8Array>
  | Blob;

export type ObjectMetadata = {
  exists: boolean;
  size: number | null;
  contentType: string | null;
};

type R2Config = {
  bucket: string;
  publicBaseUrl: string | null;
  client: S3Client;
};

let cachedConfig: R2Config | null = null;
let testClientOverride: S3Client | null = null;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}

function assertObjectKey(key: string): string {
  const normalized = key.trim();
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("..") ||
    normalized.includes("\\")
  ) {
    throw new Error("不正なオブジェクトキーです");
  }
  return normalized;
}

function getR2Config(): R2Config {
  if (testClientOverride) {
    return {
      bucket: process.env.R2_BUCKET_NAME?.trim() || "test-bucket",
      publicBaseUrl: process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || null,
      client: testClientOverride,
    };
  }
  if (cachedConfig) return cachedConfig;

  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const endpoint =
    process.env.R2_ENDPOINT?.trim() ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
  if (!endpoint) throw new Error("R2_ACCOUNT_ID または R2_ENDPOINT が未設定です");

  const client = new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    },
  });

  cachedConfig = {
    bucket: requiredEnv("R2_BUCKET_NAME"),
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || null,
    client,
  };
  return cachedConfig;
}

function encodedObjectKey(key: string): string {
  return assertObjectKey(key)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export async function putObject(
  key: string,
  body: PutObjectBody,
  contentType: string,
  options?: PutObjectOptions,
): Promise<void> {
  const cfg = getR2Config();
  const maxBytes = options?.maxBytes;
  let contentLength = options?.contentLength;

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    if (contentLength == null) {
      contentLength = body.size;
    }
  }

  if (contentLength != null && maxBytes != null && contentLength > maxBytes) {
    throw new PayloadTooLargeError(maxBytes, contentLength);
  }

  if (body instanceof Uint8Array) {
    if (maxBytes != null && body.byteLength > maxBytes) {
      throw new PayloadTooLargeError(maxBytes, body.byteLength);
    }
    await cfg.client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: assertObjectKey(key),
        Body: body,
        ContentType: contentType,
        CacheControl: "public, max-age=300",
        ContentLength: contentLength ?? body.byteLength,
      }),
    );
    return;
  }

  const rawStream: AsyncIterable<Uint8Array> =
    typeof Blob !== "undefined" && body instanceof Blob
      ? (body.stream() as unknown as AsyncIterable<Uint8Array>)
      : (body as AsyncIterable<Uint8Array>);

  let streamToSend: Readable;
  if (maxBytes != null) {
    let bytesRead = 0;
    async function* limitGenerator() {
      for await (const chunk of rawStream) {
        const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        bytesRead += u8.byteLength;
        if (bytesRead > maxBytes) {
          throw new PayloadTooLargeError(maxBytes, bytesRead);
        }
        yield u8;
      }
    }
    streamToSend = Readable.from(limitGenerator());
  } else {
    if (typeof (rawStream as ReadableStream).getReader === "function") {
      streamToSend = Readable.fromWeb(rawStream as import("node:stream/web").ReadableStream);
    } else {
      streamToSend = rawStream as Readable;
    }
  }

  const upload = new Upload({
    client: cfg.client,
    params: {
      Bucket: cfg.bucket,
      Key: assertObjectKey(key),
      Body: streamToSend,
      ContentType: contentType,
      CacheControl: "public, max-age=300",
    },
    partSize: 5 * 1024 * 1024,
    queueSize: 1,
  });

  try {
    await upload.done();
  } catch (err) {
    try {
      await upload.abort();
    } catch {
      // ignore abort cleanup failure
    }
    throw err;
  }
}

export async function getObjectBytes(key: string): Promise<Uint8Array> {
  const cfg = getR2Config();
  const result = await cfg.client.send(
    new GetObjectCommand({ Bucket: cfg.bucket, Key: assertObjectKey(key) }),
  );
  if (!result.Body) throw new Error("オブジェクトの本文が空です");
  return result.Body.transformToByteArray();
}

export async function getObjectMetadata(key: string): Promise<ObjectMetadata> {
  const cfg = getR2Config();
  try {
    const result = await cfg.client.send(
      new HeadObjectCommand({ Bucket: cfg.bucket, Key: assertObjectKey(key) }),
    );
    return {
      exists: true,
      size: typeof result.ContentLength === "number" ? result.ContentLength : null,
      contentType: result.ContentType ?? null,
    };
  } catch (error) {
    const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) {
      return { exists: false, size: null, contentType: null };
    }
    throw error;
  }
}

export async function deleteObjects(keys: Array<string | null | undefined>): Promise<void> {
  const unique = [...new Set(keys.map((key) => key?.trim()).filter((key): key is string => Boolean(key)))];
  if (unique.length === 0) return;
  const cfg = getR2Config();
  const result = await cfg.client.send(
    new DeleteObjectsCommand({
      Bucket: cfg.bucket,
      Delete: { Objects: unique.map((key) => ({ Key: assertObjectKey(key) })) },
    }),
  );
  if (result.Errors?.length) {
    throw new Error(
      result.Errors.map((error) => `${error.Key ?? "?"}: ${error.Message ?? error.Code ?? "削除失敗"}`).join(" / "),
    );
  }
}

export async function createObjectUploadUrl(
  key: string,
  contentType: string,
  expiresInSeconds = 15 * 60,
): Promise<string> {
  const cfg = getR2Config();
  return getSignedUrl(
    cfg.client,
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: assertObjectKey(key),
      ContentType: contentType,
    }),
    { expiresIn: expiresInSeconds },
  );
}

export async function createObjectReadUrl(
  key: string,
  expiresInSeconds = 60 * 60,
): Promise<string> {
  const cfg = getR2Config();
  if (cfg.publicBaseUrl) {
    return `${cfg.publicBaseUrl}/${encodedObjectKey(key)}`;
  }
  return getSignedUrl(
    cfg.client,
    new GetObjectCommand({ Bucket: cfg.bucket, Key: assertObjectKey(key) }),
    { expiresIn: expiresInSeconds },
  );
}

/** テストで環境変数を切り替える場合だけ使用する。 */
export function resetObjectStorageConfigForTests(): void {
  cachedConfig = null;
  testClientOverride = null;
}

/** テストで S3Client をモックする場合に使用する。 */
export function setR2ClientForTests(client: S3Client | null): void {
  testClientOverride = client;
}
