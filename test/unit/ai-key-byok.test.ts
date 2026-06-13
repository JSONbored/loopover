import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { getDb } from "../../src/db/client";
import { repositoryAiKeys } from "../../src/db/schema";
import { decryptSecret, encryptSecret } from "../../src/utils/crypto";
import { deleteRepositoryAiKey, getDecryptedRepositoryAiKey, getRepositoryAiKeyStatus, upsertRepositoryAiKey } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const SECRET = "unit-test-encryption-secret-at-least-32-bytes-long";

describe("encryptSecret / decryptSecret (AES-256-GCM)", () => {
  it("round-trips a secret and produces a fresh IV each time", async () => {
    const a = await encryptSecret("sk-ant-supersecret", SECRET);
    const b = await encryptSecret("sk-ant-supersecret", SECRET);
    expect(a.iv).not.toBe(b.iv); // random IV per encryption
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.version).toBe(1);
    await expect(decryptSecret(a.ciphertext, a.iv, SECRET)).resolves.toBe("sk-ant-supersecret");
  });

  it("fails to decrypt with the wrong secret and throws without a key", async () => {
    const { ciphertext, iv } = await encryptSecret("sk-secret", SECRET);
    await expect(decryptSecret(ciphertext, iv, "a-different-secret-of-sufficient-length-here")).rejects.toThrow();
    await expect(encryptSecret("x", "")).rejects.toThrow("missing_encryption_secret");
    await expect(decryptSecret(ciphertext, iv, "")).rejects.toThrow("missing_encryption_secret");
  });
});

describe("repository BYOK key storage", () => {
  it("stores an encrypted key, exposes only secret-free status, and decrypts at call time", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await expect(getRepositoryAiKeyStatus(env, "acme/widgets")).resolves.toEqual({ configured: false });

    const status = await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-abc123XYZ7890", model: "claude-3-5-sonnet-latest", createdBy: "maintainer" });
    expect(status).toEqual({ configured: true, provider: "anthropic", last4: "7890", model: "claude-3-5-sonnet-latest" });

    // Status surface never includes the key or ciphertext.
    const fetched = await getRepositoryAiKeyStatus(env, "acme/widgets");
    expect(JSON.stringify(fetched)).not.toContain("sk-ant");
    expect(fetched).toMatchObject({ configured: true, last4: "7890" });

    // Decrypt only happens at call time.
    await expect(getDecryptedRepositoryAiKey(env, "acme/widgets")).resolves.toEqual({ provider: "anthropic", key: "sk-ant-abc123XYZ7890", model: "claude-3-5-sonnet-latest" });

    // The persisted row stores ciphertext, never the plaintext key.
    const row = await env.DB.prepare("select ciphertext, iv, last4 from repository_ai_keys where repo_full_name = ?").bind("acme/widgets").first<{ ciphertext: string; iv: string; last4: string }>();
    expect(row?.ciphertext).not.toContain("sk-ant");
    expect(row?.last4).toBe("7890");
  });

  it("replaces a key on re-set and removes it on delete", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-first0000", model: null });
    await upsertRepositoryAiKey(env, { repoFullName: "acme/widgets", provider: "openai", key: "sk-openai-second1111", model: null });
    await expect(getRepositoryAiKeyStatus(env, "acme/widgets")).resolves.toMatchObject({ configured: true, provider: "openai", last4: "1111" });
    await deleteRepositoryAiKey(env, "acme/widgets");
    await expect(getRepositoryAiKeyStatus(env, "acme/widgets")).resolves.toEqual({ configured: false });
    await expect(getDecryptedRepositoryAiKey(env, "acme/widgets")).resolves.toBeNull();
  });

  it("stores real ISO timestamps when created_at/updated_at are omitted (no literal default)", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const db = getDb(env.DB);
    await db.insert(repositoryAiKeys).values({ repoFullName: "acme/widgets", provider: "anthropic", ciphertext: "ct", iv: "iv", last4: "7890" });
    const [row] = await db.select().from(repositoryAiKeys).where(eq(repositoryAiKeys.repoFullName, "acme/widgets")).limit(1);
    expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row?.createdAt).not.toBe("CURRENT_TIMESTAMP");
  });

  it("refuses to store a key and cannot decrypt without the encryption secret", async () => {
    const noSecret = createTestEnv({});
    await expect(upsertRepositoryAiKey(noSecret, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-xyz" })).rejects.toThrow("missing_encryption_secret");
    // A row encrypted under SECRET cannot be decrypted when the env has no secret → null (falls back).
    const withSecret = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositoryAiKey(withSecret, { repoFullName: "acme/widgets", provider: "anthropic", key: "sk-ant-abc1234567" });
    const sameDbNoSecret = { ...withSecret, TOKEN_ENCRYPTION_SECRET: undefined } as unknown as Env;
    await expect(getDecryptedRepositoryAiKey(sameDbNoSecret, "acme/widgets")).resolves.toBeNull();
    // A row that cannot be decrypted (wrong secret) → null, not a throw.
    const wrongSecret = { ...withSecret, TOKEN_ENCRYPTION_SECRET: "totally-different-secret-32-bytes-min" } as unknown as Env;
    await expect(getDecryptedRepositoryAiKey(wrongSecret, "acme/widgets")).resolves.toBeNull();
  });
});

describe("BYOK API routes", () => {
  function authHeaders(env: Env) {
    return { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}`, "content-type": "application/json" };
  }

  it("POST stores, GET returns secret-free status, DELETE removes — key never echoed", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });

    const post = await app.request(
      "/v1/internal/repos/acme/widgets/ai-key",
      { method: "POST", headers: authHeaders(env), body: JSON.stringify({ provider: "anthropic", key: "sk-ant-route-key-7777", model: "claude-3-5-sonnet-latest" }) },
      env,
    );
    expect(post.status).toBe(200);
    const postBody = await post.json();
    expect(postBody).toMatchObject({ configured: true, provider: "anthropic", last4: "7777" });
    expect(JSON.stringify(postBody)).not.toContain("sk-ant");

    const get = await app.request("/v1/internal/repos/acme/widgets/ai-key", { headers: authHeaders(env) }, env);
    expect(await get.json()).toMatchObject({ configured: true, last4: "7777" });

    const del = await app.request("/v1/internal/repos/acme/widgets/ai-key", { method: "DELETE", headers: authHeaders(env) }, env);
    expect(await del.json()).toEqual({ configured: false });
    const getAfter = await app.request("/v1/internal/repos/acme/widgets/ai-key", { headers: authHeaders(env) }, env);
    expect(await getAfter.json()).toEqual({ configured: false });
  });

  it("rejects an invalid key payload and reports when encryption is unavailable", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const bad = await app.request("/v1/internal/repos/acme/widgets/ai-key", { method: "POST", headers: authHeaders(env), body: JSON.stringify({ provider: "anthropic", key: "short" }) }, env);
    expect(bad.status).toBe(400);

    // A key set without a model is valid; the stored model is null.
    const noModel = await app.request("/v1/internal/repos/acme/widgets/ai-key", { method: "POST", headers: authHeaders(env), body: JSON.stringify({ provider: "openai", key: "sk-openai-no-model-1234" }) }, env);
    expect(noModel.status).toBe(200);
    expect(await noModel.json()).toMatchObject({ configured: true, provider: "openai", model: null });

    const noSecretEnv = createTestEnv({});
    const unavailable = await app.request(
      "/v1/internal/repos/acme/widgets/ai-key",
      { method: "POST", headers: authHeaders(noSecretEnv), body: JSON.stringify({ provider: "openai", key: "sk-openai-valid-key-123456" }) },
      noSecretEnv,
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: "encryption_unavailable" });
  });
});
