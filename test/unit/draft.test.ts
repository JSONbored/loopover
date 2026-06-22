import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildContributorMdx, handleDraftCreate, handleDraftOAuthCallback, handleDraftStatus, processSubmitDraft, slugify } from "../../src/services/draft";
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

// The module's SUPPORTED_CATEGORIES is not exported; buildContributorMdx only needs the
// submitted category present in config.categories. "skills" is the only one used here.
const SUPPORTED_FOR_TEST = ["skills"];

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

// ---------------------------------------------------------------------------
// Added coverage: the GitHub fork-PR primitives (via processSubmitDraft), the
// OAuth-callback success/error paths, the yamlScalar block-scalar branch, and
// the buildContributorMdx optional-frontmatter lines.
// ---------------------------------------------------------------------------

const CONFIG = { categories: SUPPORTED_FOR_TEST, branchPrefix: "heyclaude/submit" };

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function notFound(): Response {
  return new Response("", { status: 404 });
}

/**
 * Build a fetch stub that resolves a queued response per matched (method, urlSubstring).
 * Each route is matched at most once in declaration order so the same URL with different
 * intended responses across attempts works; an unmatched request fails the test loudly.
 */
function makeGithubFetch(routes: Array<{ method?: string; url: string; respond: () => Response | Promise<Response> }>) {
  const remaining = routes.map((route) => ({ ...route, used: false }));
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
    const match = remaining.find((route) => !route.used && url.includes(route.url) && (route.method ?? "GET").toUpperCase() === method);
    if (!match) {
      throw new Error(`unexpected fetch ${method} ${url}`);
    }
    match.used = true;
    return match.respond();
  };
}

async function seedQueuedDraftWithToken(
  env: Env,
  fields: Record<string, unknown> = SAMPLE_FIELDS,
  overrides: { expiresAt?: string; consumed?: boolean } = {},
): Promise<string> {
  const id = newDraftId("draft");
  const target = { category: "skills", slug: "example-skill", targetPath: "content/skills/example-skill.mdx", branchName: "heyclaude/submit-skills-example-skill" };
  await env.DB.prepare(
    `INSERT INTO submission_drafts (id, status, category, slug, target_path, branch_name, base_ref, fields_json)
     VALUES (?, 'queued', ?, ?, ?, ?, 'main', ?)`,
  )
    .bind(id, target.category, target.slug, target.targetPath, target.branchName, JSON.stringify(fields))
    .run();
  const sealed = await encryptDraftToken(DRAFT_SECRET, "gho_user_access_token");
  const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 60_000).toISOString();
  await env.DB.prepare("INSERT INTO submission_user_tokens (draft_id, encrypted_token, expires_at, consumed_at) VALUES (?, ?, ?, ?)")
    .bind(id, sealed, expiresAt, overrides.consumed ? new Date().toISOString() : null)
    .run();
  return id;
}

const UPSTREAM = "JSONbored/awesome-claude"; // DEFAULT_PUBLIC_REPO

describe("processSubmitDraft — fork-PR happy path + branches", () => {
  it("opens a new branch + file + PR and marks the draft pr_open, consuming the token", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      makeGithubFetch([
        { method: "GET", url: "https://api.github.com/user", respond: () => ok({ login: "octocat" }) },
        { method: "POST", url: `/repos/${UPSTREAM}/forks`, respond: () => ok({ full_name: "octocat/awesome-claude", default_branch: "main" }) },
        { method: "GET", url: "https://api.github.com/repos/octocat/awesome-claude", respond: () => ok({ full_name: "octocat/awesome-claude", default_branch: "main" }) },
        { method: "GET", url: `/repos/${UPSTREAM}/pulls`, respond: () => ok([]) },
        { method: "GET", url: "/git/ref/heads/main", respond: () => ok({ object: { sha: "basesha123" } }) },
        { method: "GET", url: "/git/ref/heads/heyclaude/submit-skills-example-skill", respond: () => notFound() },
        { method: "POST", url: "/git/refs", respond: () => ok({ ref: "refs/heads/x" }) },
        { method: "GET", url: "/contents/content/skills/example-skill.mdx?ref=", respond: () => notFound() },
        { method: "PUT", url: "/contents/content/skills/example-skill.mdx", respond: () => ok({ content: { sha: "filesha" } }) },
        { method: "POST", url: `/repos/${UPSTREAM}/pulls`, respond: () => ok({ number: 4242, html_url: "https://github.com/JSONbored/awesome-claude/pull/4242" }) },
      ]),
    );

    await processSubmitDraft(env, id);
    fetchSpy.mockRestore();

    const row = await env.DB.prepare("SELECT status, github_login, fork_full_name, pull_request_url, pull_request_number FROM submission_drafts WHERE id = ?").bind(id).first<{
      status: string;
      github_login: string;
      fork_full_name: string;
      pull_request_url: string;
      pull_request_number: number;
    }>();
    expect(row).toMatchObject({
      status: "pr_open",
      github_login: "octocat",
      fork_full_name: "octocat/awesome-claude",
      pull_request_url: "https://github.com/JSONbored/awesome-claude/pull/4242",
      pull_request_number: 4242,
    });
    const tok = await env.DB.prepare("SELECT consumed_at FROM submission_user_tokens WHERE draft_id = ?").bind(id).first<{ consumed_at: string | null }>();
    expect(tok?.consumed_at).toBeTruthy();
  });

  it("short-circuits to pr_open when an open PR already exists (no branch/file/create calls)", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      makeGithubFetch([
        { method: "GET", url: "https://api.github.com/user", respond: () => ok({ login: "octocat" }) },
        { method: "POST", url: `/repos/${UPSTREAM}/forks`, respond: () => ok({ full_name: "octocat/awesome-claude", default_branch: "main" }) },
        { method: "GET", url: "https://api.github.com/repos/octocat/awesome-claude", respond: () => ok({ full_name: "octocat/awesome-claude", default_branch: "main" }) },
        { method: "GET", url: `/repos/${UPSTREAM}/pulls`, respond: () => ok([{ number: 99, html_url: "https://github.com/JSONbored/awesome-claude/pull/99" }]) },
      ]),
    );

    await processSubmitDraft(env, id);
    fetchSpy.mockRestore();

    const row = await env.DB.prepare("SELECT status, pull_request_number, pull_request_url FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; pull_request_number: number; pull_request_url: string }>();
    expect(row).toMatchObject({ status: "pr_open", pull_request_number: 99, pull_request_url: "https://github.com/JSONbored/awesome-claude/pull/99" });
  });

  it("force-updates an existing branch (PATCH) instead of creating a new one", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env);
    let patched = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      makeGithubFetch([
        { method: "GET", url: "https://api.github.com/user", respond: () => ok({ login: "octocat" }) },
        { method: "POST", url: `/repos/${UPSTREAM}/forks`, respond: () => ok({ full_name: "octocat/awesome-claude", default_branch: "main" }) },
        { method: "GET", url: "https://api.github.com/repos/octocat/awesome-claude", respond: () => ok({ full_name: "octocat/awesome-claude", default_branch: "main" }) },
        { method: "GET", url: `/repos/${UPSTREAM}/pulls`, respond: () => ok([]) },
        { method: "GET", url: "/git/ref/heads/main", respond: () => ok({ object: { sha: "basesha123" } }) },
        { method: "GET", url: "/git/ref/heads/heyclaude/submit-skills-example-skill", respond: () => ok({ object: { sha: "oldsha" } }) },
        {
          method: "PATCH",
          url: "/git/refs/heads/heyclaude/submit-skills-example-skill",
          respond: () => {
            patched = true;
            return ok({ ref: "refs/heads/x" });
          },
        },
        { method: "GET", url: "/contents/content/skills/example-skill.mdx?ref=", respond: () => ok({ sha: "existingfilesha" }) },
        { method: "PUT", url: "/contents/content/skills/example-skill.mdx", respond: () => ok({ content: { sha: "filesha" } }) },
        { method: "POST", url: `/repos/${UPSTREAM}/pulls`, respond: () => ok({ number: 7, html_url: "https://github.com/JSONbored/awesome-claude/pull/7" }) },
      ]),
    );

    await processSubmitDraft(env, id);
    fetchSpy.mockRestore();

    expect(patched).toBe(true);
    const row = await env.DB.prepare("SELECT status, pull_request_number FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; pull_request_number: number }>();
    expect(row).toMatchObject({ status: "pr_open", pull_request_number: 7 });
  });

  it("falls back to the fork default branch SHA when the base ref is absent", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      makeGithubFetch([
        { method: "GET", url: "https://api.github.com/user", respond: () => ok({ login: "octocat" }) },
        { method: "POST", url: `/repos/${UPSTREAM}/forks`, respond: () => ok({ full_name: "octocat/awesome-claude", default_branch: "develop" }) },
        { method: "GET", url: "https://api.github.com/repos/octocat/awesome-claude", respond: () => ok({ full_name: "octocat/awesome-claude", default_branch: "develop" }) },
        { method: "GET", url: `/repos/${UPSTREAM}/pulls`, respond: () => ok([]) },
        { method: "GET", url: "/git/ref/heads/main", respond: () => notFound() }, // base ref missing
        { method: "GET", url: "/git/ref/heads/develop", respond: () => ok({ object: { sha: "devsha" } }) }, // fallback
        { method: "GET", url: "/git/ref/heads/heyclaude/submit-skills-example-skill", respond: () => notFound() },
        { method: "POST", url: "/git/refs", respond: () => ok({ ref: "refs/heads/x" }) },
        { method: "GET", url: "/contents/content/skills/example-skill.mdx?ref=", respond: () => notFound() },
        { method: "PUT", url: "/contents/content/skills/example-skill.mdx", respond: () => ok({ content: { sha: "filesha" } }) },
        { method: "POST", url: `/repos/${UPSTREAM}/pulls`, respond: () => ok({ number: 11, html_url: "https://github.com/JSONbored/awesome-claude/pull/11" }) },
      ]),
    );

    await processSubmitDraft(env, id);
    fetchSpy.mockRestore();

    const row = await env.DB.prepare("SELECT status, pull_request_number FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; pull_request_number: number }>();
    expect(row).toMatchObject({ status: "pr_open", pull_request_number: 11 });
  });

  it("marks the draft as error when the fork flow throws (GET /user 500 -> GitHubUserApiError)", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      makeGithubFetch([{ method: "GET", url: "https://api.github.com/user", respond: () => new Response(JSON.stringify({ message: "Server boom" }), { status: 500 }) }]),
    );

    await processSubmitDraft(env, id);
    fetchSpy.mockRestore();

    const row = await env.DB.prepare("SELECT status, last_error FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row?.status).toBe("error");
    expect(row?.last_error).toContain("GitHub API 500");
    // The token must NOT be consumed on failure.
    const tok = await env.DB.prepare("SELECT consumed_at FROM submission_user_tokens WHERE draft_id = ?").bind(id).first<{ consumed_at: string | null }>();
    expect(tok?.consumed_at).toBeNull();
  });

  it("re-throws (-> error) when a fork probe returns a non-null status (POST /forks 500)", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      makeGithubFetch([
        { method: "GET", url: "https://api.github.com/user", respond: () => ok({ login: "octocat" }) },
        // /forks null-statuses are [404, 422]; a 500 is NOT in that list, so githubUserJsonOrNull re-throws.
        { method: "POST", url: `/repos/${UPSTREAM}/forks`, respond: () => new Response(JSON.stringify({ message: "fork boom" }), { status: 500 }) },
      ]),
    );

    await processSubmitDraft(env, id);
    fetchSpy.mockRestore();

    const row = await env.DB.prepare("SELECT status, last_error FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row?.status).toBe("error");
    expect(row?.last_error).toContain("GitHub API 500");
  });

  it("parses malformed fields_json to {} on a queued draft (then fails the unsupported-category guard -> error)", async () => {
    const env = draftEnv();
    const id = newDraftId("draft");
    await env.DB.prepare(
      `INSERT INTO submission_drafts (id, status, category, slug, target_path, branch_name, base_ref, fields_json)
       VALUES (?, 'queued', 'skills', 'example-skill', 'content/skills/example-skill.mdx', 'heyclaude/submit-skills-example-skill', 'main', ?)`,
    )
      .bind(id, "{broken json")
      .run();
    await env.DB.prepare("INSERT INTO submission_user_tokens (draft_id, encrypted_token, expires_at) VALUES (?, ?, ?)")
      .bind(id, await encryptDraftToken(DRAFT_SECRET, "gho_user_access_token"), new Date(Date.now() + 60_000).toISOString())
      .run();
    // No GitHub call is made: buildContributorMdx -> buildTarget throws on the empty category before any fetch.
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await processSubmitDraft(env, id);
    fetchSpy.mockRestore();

    // The empty-fields {} from the parse-catch (line 658) is exercised; the downstream
    // unsupported-category guard then lands the draft in error via the outer catch.
    const row = await env.DB.prepare("SELECT status, last_error FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row?.status).toBe("error");
    expect(row?.last_error).toBe("Unsupported category.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns early without touching GitHub when the draft is already pr_open", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env);
    await env.DB.prepare("UPDATE submission_drafts SET status = 'pr_open' WHERE id = ?").bind(id).run();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await processSubmitDraft(env, id);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("handleDraftOAuthCallback — success + error paths", () => {
  async function createDraftState(env: Env): Promise<{ draftId: string; state: string }> {
    const app = createApp();
    const created = (await (await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }, env)).json()) as { draftId: string; authUrl: string };
    const state = new URL(created.authUrl).searchParams.get("state") ?? "";
    return { draftId: created.draftId, state };
  }

  it("exchanges the code, stores an encrypted token, flips the draft to queued, and returns meta-refresh HTML", async () => {
    const env = draftEnv();
    const { draftId, state } = await createDraftState(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes("github.com/login/oauth/access_token")) return ok({ access_token: "gho_exchanged_token" });
      throw new Error(`unexpected fetch ${url}`);
    });

    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`), env);
    fetchSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain(`url=/v1/drafts/${draftId}`);

    const row = await env.DB.prepare("SELECT status, auth_state_hash FROM submission_drafts WHERE id = ?").bind(draftId).first<{ status: string; auth_state_hash: string | null }>();
    expect(row?.status).toBe("queued");
    expect(row?.auth_state_hash).toBeNull();

    const tok = await env.DB.prepare("SELECT encrypted_token, expires_at FROM submission_user_tokens WHERE draft_id = ?").bind(draftId).first<{ encrypted_token: string; expires_at: string }>();
    expect(tok?.encrypted_token).toBeTruthy();
    expect(await decryptDraftToken(DRAFT_SECRET, tok!.encrypted_token)).toBe("gho_exchanged_token");
    expect(new Date(tok!.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("returns 400 when the token exchange returns an error (no access_token)", async () => {
    const env = draftEnv();
    const { draftId, state } = await createDraftState(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => ok({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }));

    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?code=stale&state=${encodeURIComponent(state)}`), env);
    fetchSpy.mockRestore();

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("GitHub authorization failed.");
    const row = await env.DB.prepare("SELECT status FROM submission_drafts WHERE id = ?").bind(draftId).first<{ status: string }>();
    expect(row?.status).toBe("auth_required"); // unchanged
  });

  it("returns 400 on a provider error query param without attempting an exchange", async () => {
    const env = draftEnv();
    const { state } = await createDraftState(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("GitHub authorization was not completed.");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns 503 when OAuth secrets are not configured", async () => {
    const env = draftEnv({ GITHUB_OAUTH_CLIENT_SECRET: "" });
    const { state } = await createDraftState(env);
    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?code=x&state=${encodeURIComponent(state)}`), env);
    expect(res.status).toBe(503);
  });
});

describe("handleDraftCreate / handleDraftStatus — edge branches", () => {
  it("rejects a body larger than 64KB with 413 too_large", async () => {
    const env = draftEnv();
    const big = "x".repeat(64 * 1024 + 1);
    const res = await handleDraftCreate(new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: { "content-type": "application/json" }, body: big }), env);
    expect(res.status).toBe(413);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "too_large" });
  });

  it("rejects a malformed JSON body with 400 invalid_json", async () => {
    const env = draftEnv();
    const res = await handleDraftCreate(new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" }), env);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_json" });
  });

  it("returns 200 with empty redacted fields when the stored fields_json is malformed", async () => {
    const env = draftEnv();
    const id = newDraftId("draft");
    await env.DB.prepare(
      `INSERT INTO submission_drafts (id, status, category, slug, target_path, branch_name, base_ref, fields_json)
       VALUES (?, 'auth_required', 'skills', 'x', 'content/skills/x.mdx', 'heyclaude/submit-skills-x', 'main', ?)`,
    )
      .bind(id, "{not valid json")
      .run();
    const res = await handleDraftStatus(new Request(`${ORIGIN}/v1/drafts/${id}`), env, id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; draft: { fields: Record<string, unknown> } };
    expect(body.ok).toBe(true);
    expect(body.draft.fields).toEqual({});
  });
});

describe("buildContributorMdx — block-scalar branch + optional frontmatter", () => {
  it("emits a YAML block scalar (|) for a multi-line description", () => {
    const mdx = buildContributorMdx({ ...SAMPLE_FIELDS, description: "first line\nsecond line\nthird line" }, "octocat", "2026-06-22T00:00:00.000Z", CONFIG);
    // Multi-line -> block scalar, each line indented by two spaces.
    expect(mdx).toContain("description: |\n  first line\n  second line\n  third line");
  });

  it("renders every optional frontmatter field when provided", () => {
    const mdx = buildContributorMdx(
      {
        category: "skills",
        name: "Full Skill",
        title: "Full Skill",
        description: "A complete submission exercising every optional field.",
        card_description: "Short card text.",
        seo_title: "Custom SEO Title",
        seo_description: "Custom SEO description.",
        author: "Jane Doe",
        tags: "alpha, beta",
        brand_name: "Acme",
        brand_domain: "acme.example",
        github_url: "https://github.com/acme/repo",
        docs_url: "https://docs.acme.example",
        website_url: "https://acme.example",
        download_url: "https://acme.example/dl",
        install_command: "npm i acme",
        usage_snippet: "acme run",
        config_snippet: "{ \"key\": \"value\" }",
        full_copyable_content: "line one\nline two",
        command_syntax: "/acme <arg>",
        trigger: "on demand",
        script_language: "bash",
        prerequisites: "node 20\ngit",
        tested_platforms: "macos\nlinux",
        skill_type: "automation",
        skill_level: "advanced",
        verification_status: "verified",
        verified_at: "2026-06-01",
        items: "one\ntwo",
        pricing_model: "free",
        disclosure: "No affiliation.",
        retrieval_sources: "https://src.example/a\nhttps://src.example/b",
        safety_notes: "Be careful.",
        privacy_notes: "No PII.",
      },
      "octocat",
      "2026-06-22T00:00:00.000Z",
      CONFIG,
    );
    for (const key of [
      "brandName:",
      "brandDomain:",
      "repoUrl:",
      "documentationUrl:",
      "websiteUrl:",
      "downloadUrl:",
      "installCommand:",
      "usageSnippet:",
      "configSnippet:",
      "copySnippet:",
      "commandSyntax:",
      "trigger:",
      "scriptLanguage:",
      "prerequisites:",
      "testedPlatforms:",
      "skillType:",
      "skillLevel:",
      "verificationStatus:",
      "verifiedAt:",
      "items:",
      "pricingModel:",
      "disclosure:",
      "retrievalSources:",
      "seoTitle:",
      "seoDescription:",
      "authorProfileUrl:",
      "submittedByUrl:",
    ]) {
      expect(mdx).toContain(key);
    }
    expect(mdx).toContain('author: "Jane Doe"');
  });
});
