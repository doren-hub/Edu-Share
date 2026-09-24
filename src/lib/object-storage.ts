import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  const cfg = getR2Config();
  await cfg.client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: assertObjectKey(key),
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=300",
    }),
  );
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
}
