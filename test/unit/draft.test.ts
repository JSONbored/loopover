import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildContributorMdx, processSubmitDraft, slugify } from "../../src/services/draft";
import { decryptDraftToken, encryptDraftToken, newDraftId, randomDraftToken, sha256Hex } from "../../src/utils/crypto";
import { createTestEnv } from "../helpers/d1";

const DRAFT_SECRET = "draft-token-encryption-secret-at-least-32b";

function draftEnv(overrides: Partial<Env> = {}): Env {
  return createTestEnv({
    REVIEWBOT_DRAFT: "true",
    GITHUB_OAUTH_CLIENT_ID: "Iv-test-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "test-oauth-client-secret",
    DRAFT_TOKEN_ENCRYPTION_SECRET: DRAFT_SECRET,
    ...overrides,
  });
}

const ORIGIN = "https://gittensory.aethereal.dev";

function jsonHeaders(): Record<string, string> {
  return { "content-type": "application/json", origin: ORIGIN };
}

const SAMPLE_FIELDS = {
  category: "skills",
  name: "Example Skill",
  description: "A helpful skill for testing the draft port.",
  tags: "testing, draft",
  safety_notes: "No destructive actions.",
  privacy_notes: "No personal data collected.",
};

describe("draft flow — flag OFF (REVIEWBOT_DRAFT unset/false)", () => {
  it("POST /v1/drafts returns 404 when the flag is off", async () => {
    const app = createApp();
    const env = createTestEnv(); // flag unset
    const res = await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }, env);
    expect(res.status).toBe(404);
  });

  it("GET /v1/drafts/:id returns 404 when the flag is off", async () => {
    const app = createApp();
    const env = createTestEnv({ REVIEWBOT_DRAFT: "false" });
    const res = await app.request("/v1/drafts/draft_does_not_exist", {}, env);
    expect(res.status).toBe(404);
  });

  it("GET /v1/drafts/auth/callback returns 404 when the flag is off", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/drafts/auth/callback?code=x&state=y.z", {}, env);
    expect(res.status).toBe(404);
  });

  it("flag-OFF writes nothing to the draft table", async () => {
    const app = createApp();
    const env = createTestEnv();
    await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }, env);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM submission_drafts").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("processSubmitDraft is a no-op when the flag is off", async () => {
    const env = createTestEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await processSubmitDraft(env, "draft_anything");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("draft endpoints — flag ON, public + unauthenticated", () => {
  it("creates a draft, persists an auth_required row, and returns an OAuth authorize URL (no API token needed)", async () => {
    const app = createApp();
    const env = draftEnv();
    const res = await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }, env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; draftId: string; statusUrl: string; authUrl: string; target: { category: string; slug: string; targetPath: string } };
    expect(body.ok).toBe(true);
    expect(body.draftId).toMatch(/^draft_/);
    expect(body.target).toMatchObject({ category: "skills", slug: "example-skill", targetPath: "content/skills/example-skill.mdx" });

    const authUrl = new URL(body.authUrl);
    expect(authUrl.origin + authUrl.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authUrl.searchParams.get("client_id")).toBe("Iv-test-client-id");
    // The callback URL is derived from the request origin (matches reviewbot). `app.request` with a
    // path-only URL resolves the origin to http://localhost, so the redirect_uri lives under it.
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://localhost/v1/drafts/auth/callback");
    expect(authUrl.searchParams.get("state")?.startsWith(`${body.draftId}.`)).toBe(true);

    const row = await env.DB.prepare("SELECT status, category, slug, target_path, branch_name, auth_state_hash FROM submission_drafts WHERE id = ?").bind(body.draftId).first<{
      status: string;
      category: string;
      slug: string;
      target_path: string;
      branch_name: string;
      auth_state_hash: string;
    }>();
    expect(row?.status).toBe("auth_required");
    expect(row?.target_path).toBe("content/skills/example-skill.mdx");
    expect(row?.auth_state_hash).toMatch(/^[0-9a-f]{64}$/);
    // The state hash matches sha256(state) carried in the authorize URL.
    const carriedState = authUrl.searchParams.get("state")?.split(".")[1] ?? "";
    expect(await sha256Hex(carriedState)).toBe(row?.auth_state_hash);
  });

  it("rejects an unsupported category with 400", async () => {
    const app = createApp();
    const env = draftEnv();
    const res = await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ ...SAMPLE_FIELDS, category: "not-a-category" }) }, env);
    expect(res.status).toBe(400);
  });

  it("rejects a non-JSON content-type with 415", async () => {
    const app = createApp();
    const env = draftEnv();
    const res = await app.request("/v1/drafts", { method: "POST", headers: { "content-type": "text/plain", origin: ORIGIN }, body: "x" }, env);
    expect(res.status).toBe(415);
  });

  it("returns 503 when the draft flow is not configured (missing encryption secret)", async () => {
    const app = createApp();
    const env = draftEnv({ DRAFT_TOKEN_ENCRYPTION_SECRET: "" });
    const res = await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }, env);
    expect(res.status).toBe(503);
  });

  it("GET /v1/drafts/:id round-trips the stored draft and redacts contact fields", async () => {
    const app = createApp();
    const env = draftEnv();
    const created = (await (await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ ...SAMPLE_FIELDS, contact_email: "person@example.com" }) }, env)).json()) as { draftId: string };
    const status = await app.request(`/v1/drafts/${created.draftId}`, {}, env);
    expect(status.status).toBe(200);
    const body = (await status.json()) as { ok: boolean; draft: { id: string; status: string; category: string; slug: string; fields: Record<string, unknown> } };
    expect(body.draft.id).toBe(created.draftId);
    expect(body.draft.status).toBe("auth_required");
    expect(body.draft.category).toBe("skills");
    expect(body.draft.fields.contact_email).toBe("[redacted]");
    expect(body.draft.fields.description).toBe(SAMPLE_FIELDS.description);
  });

  it("GET /v1/drafts/:id returns 404 for an unknown draft id", async () => {
    const app = createApp();
    const env = draftEnv();
    const res = await app.request("/v1/drafts/draft_missing", {}, env);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "not_found" });
  });

  it("auth callback rejects a forged/invalid state with 400 (CSRF guard)", async () => {
    const app = createApp();
    const env = draftEnv();
    const created = (await (await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }, env)).json()) as { draftId: string };
    const res = await app.request(`/v1/drafts/auth/callback?code=abc&state=${created.draftId}.wrong-state-token`, {}, env);
    expect(res.status).toBe(400);
  });

  it("auth callback rejects a missing state with 400", async () => {
    const app = createApp();
    const env = draftEnv();
    const res = await app.request("/v1/drafts/auth/callback?code=abc", {}, env);
    expect(res.status).toBe(400);
  });
});

describe("draft user-token crypto (AES-256-GCM single-string envelope)", () => {
  it("round-trips a token through encrypt -> decrypt", async () => {
    const token = "gho_user_access_token_value";
    const sealed = await encryptDraftToken(DRAFT_SECRET, token);
    expect(sealed.split(".")).toHaveLength(3);
    expect(sealed).not.toContain(token);
    expect(await decryptDraftToken(DRAFT_SECRET, sealed)).toBe(token);
  });

  it("uses a fresh salt + iv per encryption (ciphertexts differ for the same input)", async () => {
    const a = await encryptDraftToken(DRAFT_SECRET, "same");
    const b = await encryptDraftToken(DRAFT_SECRET, "same");
    expect(a).not.toBe(b);
    expect(await decryptDraftToken(DRAFT_SECRET, a)).toBe("same");
    expect(await decryptDraftToken(DRAFT_SECRET, b)).toBe("same");
  });

  it("fails to decrypt with the wrong secret", async () => {
    const sealed = await encryptDraftToken(DRAFT_SECRET, "secret-token");
    await expect(decryptDraftToken("a-different-secret-32-bytes-padding!!", sealed)).rejects.toThrow("Invalid encrypted payload.");
  });

  it("rejects a malformed envelope", async () => {
    await expect(decryptDraftToken(DRAFT_SECRET, "not-a-valid-envelope")).rejects.toThrow("Invalid encrypted payload.");
  });

  it("throws when the secret is missing", async () => {
    await expect(encryptDraftToken("", "x")).rejects.toThrow("missing_encryption_secret");
    await expect(decryptDraftToken("", "a.b.c")).rejects.toThrow("missing_encryption_secret");
  });

  it("randomDraftToken + newDraftId produce distinct url-safe values", () => {
    expect(randomDraftToken()).not.toBe(randomDraftToken());
    expect(randomDraftToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(newDraftId("draft")).toMatch(/^draft_[0-9a-f]+$/);
    expect(newDraftId("draft")).not.toBe(newDraftId("draft"));
  });
});

describe("draft D1 + token round-trip (direct on TestD1Database)", () => {
  it("persists a draft + encrypted token and reads them back", async () => {
    const env = draftEnv();
    const id = newDraftId("draft");
    const state = randomDraftToken();
    await env.DB.prepare(
      `INSERT INTO submission_drafts (id, status, category, slug, target_path, branch_name, base_ref, fields_json, auth_state_hash)
       VALUES (?, 'auth_required', ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, "skills", "example-skill", "content/skills/example-skill.mdx", "heyclaude/submit-skills-example-skill", "main", JSON.stringify(SAMPLE_FIELDS), await sha256Hex(state))
      .run();

    const sealed = await encryptDraftToken(DRAFT_SECRET, "gho_round_trip_token");
    await env.DB.prepare("INSERT INTO submission_user_tokens (draft_id, encrypted_token, expires_at) VALUES (?, ?, ?)")
      .bind(id, sealed, new Date(Date.now() + 60_000).toISOString())
      .run();

    const draftRow = await env.DB.prepare("SELECT id, status, slug, base_ref FROM submission_drafts WHERE id = ?").bind(id).first<{ id: string; status: string; slug: string; base_ref: string }>();
    expect(draftRow).toMatchObject({ id, status: "auth_required", slug: "example-skill", base_ref: "main" });

    const tokenRow = await env.DB.prepare("SELECT encrypted_token FROM submission_user_tokens WHERE draft_id = ?").bind(id).first<{ encrypted_token: string }>();
    expect(tokenRow?.encrypted_token).toBe(sealed);
    expect(await decryptDraftToken(DRAFT_SECRET, tokenRow!.encrypted_token)).toBe("gho_round_trip_token");
  });
});

describe("processSubmitDraft — error path without dragging in the GitHub engine", () => {
  it("marks the draft as error when the user token is unavailable", async () => {
    const env = draftEnv();
    const id = newDraftId("draft");
    await env.DB.prepare(
      `INSERT INTO submission_drafts (id, status, category, slug, target_path, branch_name, base_ref, fields_json)
       VALUES (?, 'queued', 'skills', 'x', 'content/skills/x.mdx', 'heyclaude/submit-skills-x', 'main', ?)`,
    )
      .bind(id, JSON.stringify(SAMPLE_FIELDS))
      .run();
    // No token row -> token_unavailable, set without any network call.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await processSubmitDraft(env, id);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const row = await env.DB.prepare("SELECT status, last_error FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row).toMatchObject({ status: "error", last_error: "token_unavailable" });
  });
});

describe("MDX builder + slug helpers (ported verbatim)", () => {
  it("slugify normalizes to a bounded kebab slug", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  Multiple   spaces  ")).toBe("multiple-spaces");
  });

  it("buildContributorMdx emits frontmatter + Safety/Privacy sections", () => {
    const config = { categories: ["skills"], branchPrefix: "heyclaude/submit" };
    const mdx = buildContributorMdx(SAMPLE_FIELDS, "octocat", "2026-06-22T00:00:00.000Z", config);
    expect(mdx.startsWith("---\n")).toBe(true);
    expect(mdx).toContain('category: "skills"');
    expect(mdx).toContain('slug: "example-skill"');
    expect(mdx).toContain("submittedBy: \"@octocat\"");
    expect(mdx).toContain("## Safety");
    expect(mdx).toContain("## Privacy");
  });
});
