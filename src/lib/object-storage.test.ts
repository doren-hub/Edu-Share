import assert from "node:assert/strict";
import { test } from "node:test";

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
