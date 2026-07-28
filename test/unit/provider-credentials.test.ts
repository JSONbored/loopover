import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { getDb } from "../../src/db/client";
import { providerCredentials } from "../../src/db/schema";
import { deleteProviderCredential, getDecryptedProviderCredential, getProviderCredentialStatus, upsertProviderCredential } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// Instance subscription-CLI credentials (#9543) -- the FLEET rotation path. Mirrors ai-key-byok.test.ts,
// which covers the per-repo BYOK table this deliberately reuses the crypto envelope from.

const SECRET = "unit-test-encryption-secret-at-least-32-bytes-long";
const TOKEN = "sk-ant-oat01-fleet-credential-value";

describe("provider credential storage (#9543)", () => {
  it("reports not-configured before anything is stored", async () => {
    const env = await createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await expect(getProviderCredentialStatus(env, "claude-code")).resolves.toEqual({ configured: false });
    await expect(getDecryptedProviderCredential(env, "claude-code")).resolves.toBeNull();
  });

  it("stores encrypted at rest and round-trips the plaintext", async () => {
    const env = await createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const status = await upsertProviderCredential(env, { provider: "claude-code", credential: TOKEN, updatedBy: "operator" });
    expect(status).toMatchObject({ configured: true, provider: "claude-code", last4: TOKEN.slice(-4), updatedBy: "operator" });

    // The stored row must never contain the plaintext anywhere.
    const [row] = await getDb(env.DB).select().from(providerCredentials).where(eq(providerCredentials.provider, "claude-code")).limit(1);
    expect(row!.ciphertext).not.toContain(TOKEN);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(row!.keyVersion).toBe(2);

    await expect(getDecryptedProviderCredential(env, "claude-code")).resolves.toBe(TOKEN);
  });

  it("trims the credential before storing it", async () => {
    const env = await createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertProviderCredential(env, { provider: "claude-code", credential: `  ${TOKEN}\n` });
    await expect(getDecryptedProviderCredential(env, "claude-code")).resolves.toBe(TOKEN);
  });

  it("replaces in place rather than accumulating rows", async () => {
    const env = await createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertProviderCredential(env, { provider: "claude-code", credential: TOKEN });
    await upsertProviderCredential(env, { provider: "claude-code", credential: "sk-ant-oat01-rotated-value" });
    const rows = await getDb(env.DB).select().from(providerCredentials);
    expect(rows).toHaveLength(1);
    await expect(getDecryptedProviderCredential(env, "claude-code")).resolves.toBe("sk-ant-oat01-rotated-value");
  });

  it("keeps providers isolated from each other", async () => {
    const env = await createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertProviderCredential(env, { provider: "claude-code", credential: TOKEN });
    await expect(getDecryptedProviderCredential(env, "codex")).resolves.toBeNull();
    await upsertProviderCredential(env, { provider: "codex", credential: "codex-credential" });
    await expect(getDecryptedProviderCredential(env, "claude-code")).resolves.toBe(TOKEN);
    await expect(getDecryptedProviderCredential(env, "codex")).resolves.toBe("codex-credential");
    // Status round-trips the provider back out of the row for BOTH providers, not just the default arm.
    await expect(getProviderCredentialStatus(env, "codex")).resolves.toMatchObject({ configured: true, provider: "codex" });
    await expect(getProviderCredentialStatus(env, "claude-code")).resolves.toMatchObject({ configured: true, provider: "claude-code" });
  });

  it("defaults updatedBy to null when no actor is supplied", async () => {
    const env = await createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await expect(upsertProviderCredential(env, { provider: "claude-code", credential: TOKEN })).resolves.toMatchObject({ updatedBy: null });
  });

  it("refuses to store anything in the clear when the encryption secret is missing", async () => {
    const env = await createTestEnv({});
    await expect(upsertProviderCredential(env, { provider: "claude-code", credential: TOKEN })).rejects.toThrow(/missing_encryption_secret/);
    expect(await getDb(env.DB).select().from(providerCredentials)).toHaveLength(0);
  });

  it("refuses an all-whitespace credential", async () => {
    const env = await createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await expect(upsertProviderCredential(env, { provider: "claude-code", credential: "   " })).rejects.toThrow(/empty_credential/);
  });

  it("returns null (never throws) when the encryption secret is unavailable at read time", async () => {
    const env = await createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertProviderCredential(env, { provider: "claude-code", credential: TOKEN });
    // A resolution failure must degrade to the next rung, not fail the review.
    await expect(getDecryptedProviderCredential({ ...env, TOKEN_ENCRYPTION_SECRET: undefined } as never, "claude-code")).resolves.toBeNull();
  });

  it("returns null when the stored row cannot be decrypted with the current secret", async () => {
    const env = await createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertProviderCredential(env, { provider: "claude-code", credential: TOKEN });
    await expect(getDecryptedProviderCredential({ ...env, TOKEN_ENCRYPTION_SECRET: "a-different-secret-at-least-32-bytes!!" } as never, "claude-code")).resolves.toBeNull();
  });

  it("delete clears the credential so resolution falls back to the file/env", async () => {
    const env = await createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertProviderCredential(env, { provider: "claude-code", credential: TOKEN });
    await deleteProviderCredential(env, "claude-code", "operator");
    await expect(getProviderCredentialStatus(env, "claude-code")).resolves.toEqual({ configured: false });
    await expect(getDecryptedProviderCredential(env, "claude-code")).resolves.toBeNull();
  });

  it("delete on an absent credential is a no-op", async () => {
    const env = await createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await expect(deleteProviderCredential(env, "claude-code")).resolves.toBeUndefined();
  });
});

describe("provider_credentials schema defaults (#9543)", () => {
  it("populates created_at and updated_at when a direct insert omits them", async () => {
    // The table's $defaultFn timestamps: upsertProviderCredential always supplies updated_at explicitly,
    // so this is the path that proves a row is still well-formed without it.
    const env = await createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await getDb(env.DB).insert(providerCredentials).values({ provider: "claude-code", ciphertext: "c", iv: "i", salt: null, keyVersion: 2, last4: "abcd", updatedBy: null });
    const [row] = await getDb(env.DB).select().from(providerCredentials).where(eq(providerCredentials.provider, "claude-code")).limit(1);
    expect(row!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("internal provider-credential routes (#9543)", () => {
  const auth = { Authorization: "Bearer internal-token", "content-type": "application/json" };
  const envFor = async () => createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, INTERNAL_JOB_TOKEN: "internal-token" });

  it("GET reports not-configured, then configured WITHOUT ever returning the credential", async () => {
    const env = await envFor();
    const app = createApp();
    const before = await app.request("/v1/internal/provider-credentials/claude-code", { headers: auth }, env);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ configured: false });

    const post = await app.request("/v1/internal/provider-credentials/claude-code", { method: "POST", headers: auth, body: JSON.stringify({ credential: TOKEN }) }, env);
    expect(post.status).toBe(200);

    const after = await app.request("/v1/internal/provider-credentials/claude-code", { headers: auth }, env);
    const body = await after.text();
    expect(body).not.toContain(TOKEN);
    expect(JSON.parse(body)).toMatchObject({ configured: true, last4: TOKEN.slice(-4) });
  });

  it("POST rejects a multi-line credential — the exact production footgun", async () => {
    const env = await envFor();
    const res = await createApp().request(
      "/v1/internal/provider-credentials/claude-code",
      { method: "POST", headers: auth, body: JSON.stringify({ credential: "# some-account\nsk-ant-oat01-real" }) },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_credential" });
    await expect(getProviderCredentialStatus(env, "claude-code")).resolves.toEqual({ configured: false });
  });

  it("POST rejects a comment, padded, or empty credential", async () => {
    const env = await envFor();
    const app = createApp();
    for (const credential of ["#sk-ant-x", "  sk-ant-x", "sk-ant-x  ", ""]) {
      const res = await app.request("/v1/internal/provider-credentials/claude-code", { method: "POST", headers: auth, body: JSON.stringify({ credential }) }, env);
      expect(res.status).toBe(400);
    }
  });

  it("POST rejects a malformed or missing body", async () => {
    const env = await envFor();
    const app = createApp();
    expect((await app.request("/v1/internal/provider-credentials/claude-code", { method: "POST", headers: auth, body: "not json" }, env)).status).toBe(400);
    expect((await app.request("/v1/internal/provider-credentials/claude-code", { method: "POST", headers: auth, body: JSON.stringify({}) }, env)).status).toBe(400);
  });

  it("rejects an unknown provider on every verb", async () => {
    const env = await envFor();
    const app = createApp();
    expect((await app.request("/v1/internal/provider-credentials/gpt-9", { headers: auth }, env)).status).toBe(400);
    expect((await app.request("/v1/internal/provider-credentials/gpt-9", { method: "POST", headers: auth, body: JSON.stringify({ credential: "x" }) }, env)).status).toBe(400);
    expect((await app.request("/v1/internal/provider-credentials/gpt-9", { method: "DELETE", headers: auth }, env)).status).toBe(400);
  });

  it("POST reports 503 rather than storing in the clear when encryption is unconfigured", async () => {
    const env = await createTestEnv({ INTERNAL_JOB_TOKEN: "internal-token" });
    const res = await createApp().request("/v1/internal/provider-credentials/claude-code", { method: "POST", headers: auth, body: JSON.stringify({ credential: TOKEN }) }, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "encryption_unavailable" });
  });

  it("does not swallow an unexpected storage failure as a credential error", async () => {
    // Only `missing_encryption_secret` is translated; anything else must propagate rather than be reported
    // as a 400/503 that would tell an operator the credential was the problem.
    const env = await envFor();
    await env.DB.prepare("DROP TABLE provider_credentials").run();
    const res = await createApp().request("/v1/internal/provider-credentials/claude-code", { method: "POST", headers: auth, body: JSON.stringify({ credential: TOKEN }) }, env);
    expect(res.status).toBe(500);
  });

  it("DELETE clears a stored credential", async () => {
    const env = await envFor();
    const app = createApp();
    await app.request("/v1/internal/provider-credentials/claude-code", { method: "POST", headers: auth, body: JSON.stringify({ credential: TOKEN }) }, env);
    const res = await app.request("/v1/internal/provider-credentials/claude-code", { method: "DELETE", headers: auth }, env);
    expect(res.status).toBe(200);
    await expect(getProviderCredentialStatus(env, "claude-code")).resolves.toEqual({ configured: false });
  });

  it("requires the internal job token", async () => {
    const env = await envFor();
    const res = await createApp().request("/v1/internal/provider-credentials/claude-code", {}, env);
    expect(res.status).toBe(401);
  });
});
