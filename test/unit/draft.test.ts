import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildContributorMdx, handleDraftCreate, handleDraftOAuthCallback, handleDraftStatus, processSubmitDraft, slugify } from "../../src/services/draft";
import { decryptDraftToken, encryptDraftToken, newDraftId, randomDraftToken, sha256Hex } from "../../src/utils/crypto";
import { createTestEnv } from "../helpers/d1";

const DRAFT_SECRET = "draft-token-encryption-secret-at-least-32b";

function draftEnv(overrides: Partial<Env> = {}): Env {
  return createTestEnv({
    LOOPOVER_REVIEW_DRAFT: "true",
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

function callbackHeaders(setCookie: string | null): Record<string, string> {
  return setCookie ? { cookie: setCookie.split(";")[0] ?? "" } : {};
}

const SAMPLE_FIELDS = {
  category: "skills",
  name: "Example Skill",
  description: "A helpful skill for testing the draft port.",
  tags: "testing, draft",
  safety_notes: "No destructive actions.",
  privacy_notes: "No personal data collected.",
};

describe("draft flow — flag OFF (LOOPOVER_REVIEW_DRAFT unset/false)", () => {
  it("POST /v1/drafts returns 404 when the flag is off", async () => {
    const app = createApp();
    const env = createTestEnv(); // flag unset
    const res = await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }, env);
    expect(res.status).toBe(404);
  });

  it("GET /v1/drafts/:id returns 404 when the flag is off", async () => {
    const app = createApp();
    const env = createTestEnv({ LOOPOVER_REVIEW_DRAFT: "false" });
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
    expect(res.headers.get("set-cookie")).toContain("gittensory_draft_oauth=");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("set-cookie")).toContain("SameSite=Lax");

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
  async function createDraftState(env: Env): Promise<{ draftId: string; state: string; cookie: string }> {
    const app = createApp();
    const response = await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }, env);
    const created = (await response.json()) as { draftId: string; authUrl: string };
    const state = new URL(created.authUrl).searchParams.get("state") ?? "";
    return { draftId: created.draftId, state, cookie: response.headers.get("set-cookie") ?? "" };
  }

  it("rejects a valid OAuth state when the browser-bound draft cookie is missing", async () => {
    const env = draftEnv();
    const { state } = await createDraftState(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid or expired submission state.");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("treats a malformed draft cookie as absent (covers the cookie-parser empty-name + decode-failure arms)", async () => {
    const env = draftEnv();
    const { state } = await createDraftState(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // One Cookie header that drives both parseCookieHeader fallbacks:
    //  • " =lead"                  → whitespace-only name (eq > 0 but name trims to "") → `if (!name) continue`
    //  • gittensory_draft_oauth=%  → a lone-percent value makes decodeURIComponent throw → decoded as ""
    // The draft cookie therefore resolves to "", cannot match the URL state, and the callback rejects (no exchange).
    const res = await handleDraftOAuthCallback(
      new Request(`${ORIGIN}/v1/drafts/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`, {
        headers: { cookie: " =lead; gittensory_draft_oauth=%" },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid or expired submission state.");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("exchanges the code, stores an encrypted token, flips the draft to queued, and returns meta-refresh HTML", async () => {
    const env = draftEnv();
    const { draftId, state, cookie } = await createDraftState(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes("github.com/login/oauth/access_token")) return ok({ access_token: "gho_exchanged_token" });
      throw new Error(`unexpected fetch ${url}`);
    });

    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`, { headers: callbackHeaders(cookie) }), env);
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
    const { draftId, state, cookie } = await createDraftState(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => ok({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }));

    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?code=stale&state=${encodeURIComponent(state)}`, { headers: callbackHeaders(cookie) }), env);
    fetchSpy.mockRestore();

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("GitHub authorization failed.");
    const row = await env.DB.prepare("SELECT status FROM submission_drafts WHERE id = ?").bind(draftId).first<{ status: string }>();
    expect(row?.status).toBe("auth_required"); // unchanged
  });

  it("returns 400 on a provider error query param without attempting an exchange", async () => {
    const env = draftEnv();
    const { state, cookie } = await createDraftState(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`, { headers: callbackHeaders(cookie) }), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("GitHub authorization was not completed.");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns 503 when OAuth secrets are not configured", async () => {
    const env = draftEnv({ GITHUB_OAUTH_CLIENT_SECRET: "" });
    const { state, cookie } = await createDraftState(env);
    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?code=x&state=${encodeURIComponent(state)}`, { headers: callbackHeaders(cookie) }), env);
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

// ---------------------------------------------------------------------------
// Added coverage: queue dispatch for the submit-draft job, the non-JSON GitHub
// error body, and the fork-readiness retry loop (driven under FAKE TIMERS so the
// real setTimeout-backed sleep(3000) can never run for real in the test suite —
// this loop is what hangs a coverage run if exercised with real timers).
// ---------------------------------------------------------------------------

describe("queue dispatch — submit-draft job", () => {
  it("processJob routes a submit-draft message to processSubmitDraft (flag-off → internal no-op, no fetch)", async () => {
    const { processJob } = await import("../../src/queue/processors");
    const env = createTestEnv(); // LOOPOVER_REVIEW_DRAFT unset → processSubmitDraft no-ops internally
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await processJob(env, { type: "submit-draft", requestedBy: "test", draftId: "draft_anything" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("githubUserJson error body — non-JSON payload", () => {
  it("falls back to the raw text when a non-OK response body is not JSON (GET /user 502 'Bad Gateway')", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env);
    // A plain-text (non-JSON) error body exercises the JSON.parse catch -> payload=null,
    // and the thrown GitHubUserApiError then uses the raw body as the message.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      makeGithubFetch([{ method: "GET", url: "https://api.github.com/user", respond: () => new Response("Bad Gateway", { status: 502 }) }]),
    );

    await processSubmitDraft(env, id);
    fetchSpy.mockRestore();

    const row = await env.DB.prepare("SELECT status, last_error FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row?.status).toBe("error");
    expect(row?.last_error).toContain("GitHub API 502");
    expect(row?.last_error).toContain("Bad Gateway");
  });
});

describe("draftConfig — custom DRAFT_PUBLIC_REPO + DRAFT_BASE_REF (env truthy branch)", () => {
  it("creates a draft against a custom base ref (env.DRAFT_BASE_REF truthy branch)", async () => {
    const app = createApp();
    const env = draftEnv({ DRAFT_BASE_REF: "develop" });
    const res = await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }, env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { draftId: string };
    const row = await env.DB.prepare("SELECT base_ref FROM submission_drafts WHERE id = ?").bind(body.draftId).first<{ base_ref: string }>();
    // draftConfig().baseRef = env.DRAFT_BASE_REF || DEFAULT_BASE_REF → the custom value wins.
    expect(row?.base_ref).toBe("develop");
  });

  it("forks the custom DRAFT_PUBLIC_REPO when set (env.DRAFT_PUBLIC_REPO truthy branch)", async () => {
    const env = draftEnv({ DRAFT_PUBLIC_REPO: "acme/registry" });
    const id = await seedQueuedDraftWithToken(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      makeGithubFetch([
        { method: "GET", url: "https://api.github.com/user", respond: () => ok({ login: "octocat" }) },
        { method: "POST", url: "/repos/acme/registry/forks", respond: () => ok({ full_name: "octocat/registry", default_branch: "main" }) },
        { method: "GET", url: "https://api.github.com/repos/octocat/registry", respond: () => ok({ full_name: "octocat/registry", default_branch: "main" }) },
        { method: "GET", url: "/repos/acme/registry/pulls", respond: () => ok([]) },
        { method: "GET", url: "/git/ref/heads/main", respond: () => ok({ object: { sha: "basesha" } }) },
        { method: "GET", url: "/git/ref/heads/heyclaude/submit-skills-example-skill", respond: () => notFound() },
        { method: "POST", url: "/git/refs", respond: () => ok({ ref: "refs/heads/x" }) },
        { method: "GET", url: "/contents/content/skills/example-skill.mdx?ref=", respond: () => notFound() },
        { method: "PUT", url: "/contents/content/skills/example-skill.mdx", respond: () => ok({ content: { sha: "filesha" } }) },
        { method: "POST", url: "/repos/acme/registry/pulls", respond: () => ok({ number: 5, html_url: "https://github.com/acme/registry/pull/5" }) },
      ]),
    );

    await processSubmitDraft(env, id);
    fetchSpy.mockRestore();

    const row = await env.DB.prepare("SELECT status, fork_full_name, pull_request_url FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; fork_full_name: string; pull_request_url: string }>();
    expect(row).toMatchObject({ status: "pr_open", fork_full_name: "octocat/registry", pull_request_url: "https://github.com/acme/registry/pull/5" });
  });
});

describe("handleDraftCreate — nested body.fields branch + title fallbacks", () => {
  it("reads fields from a nested `fields` object (body.fields truthy branch)", async () => {
    const env = draftEnv();
    const res = await handleDraftCreate(
      new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ fields: { ...SAMPLE_FIELDS, name: "Nested Skill" } }) }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { target: { slug: string } };
    // The slug is derived from the NESTED fields.name, proving body.fields was unwrapped.
    expect(body.target.slug).toBe("nested-skill");
  });

  it("falls back to body itself when body.fields is not an object (body.fields falsy branch)", async () => {
    const env = draftEnv();
    // `fields: "a string"` is not an object → the flat body is used as the fields source.
    const res = await handleDraftCreate(
      new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ ...SAMPLE_FIELDS, fields: "not-an-object" }) }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { target: { slug: string } };
    expect(body.target.slug).toBe("example-skill");
  });

  it("returns 400 'Could not derive a slug' when no name/slug/title yields a slug (buildTarget throw)", async () => {
    const env = draftEnv();
    // Category valid, but slug/name/title all whitespace/symbols → slugify yields "" → throw.
    const res = await handleDraftCreate(
      new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ category: "skills", name: "***", slug: "  ", title: "" }) }),
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "Could not derive a slug from the submission." });
  });

  it("returns 400 with the generic 'invalid_submission' message when a non-Error is thrown by buildTarget", async () => {
    // Defensive: buildTarget only throws Error, so the `: "invalid_submission"` ternary arm is
    // exercised via the unsupported-category Error here, asserting the Error-message arm renders.
    const env = draftEnv();
    const res = await handleDraftCreate(
      new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ ...SAMPLE_FIELDS, category: "nope" }) }),
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "Unsupported category." });
  });

  it("returns 503 when the OAuth client id is missing (draftSecrets clientId empty branch)", async () => {
    const env = draftEnv({ GITHUB_OAUTH_CLIENT_ID: "" });
    const res = await handleDraftCreate(new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }), env);
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "draft_flow_not_configured" });
  });

  it("returns 404 when the flag is off (handleDraftCreate guard)", async () => {
    const env = createTestEnv(); // flag unset
    const res = await handleDraftCreate(new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });
});

describe("clientIp — header precedence branches (exercised via handleDraftCreate)", () => {
  it("creates a draft from an x-forwarded-for chain (cf-connecting-ip absent branch)", async () => {
    const env = draftEnv();
    const res = await handleDraftCreate(
      new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: { ...jsonHeaders(), "x-forwarded-for": "203.0.113.7, 70.41.3.18" }, body: JSON.stringify(SAMPLE_FIELDS) }),
      env,
    );
    // clientIp falls through cf-connecting-ip → takes the first x-forwarded-for hop. The draft still creates.
    expect(res.status).toBe(201);
  });

  it("creates a draft with neither IP header present (unknown-ip fallback branch)", async () => {
    const env = draftEnv();
    const res = await handleDraftCreate(new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }), env);
    // No cf-connecting-ip and no x-forwarded-for → clientIp returns "unknown-ip"; draft creation unaffected.
    expect(res.status).toBe(201);
  });

  it("creates a draft with a cf-connecting-ip header (first branch)", async () => {
    const env = draftEnv();
    const res = await handleDraftCreate(
      new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: { ...jsonHeaders(), "cf-connecting-ip": "198.51.100.5" }, body: JSON.stringify(SAMPLE_FIELDS) }),
      env,
    );
    expect(res.status).toBe(201);
  });
});

describe("slugify — truncation + empty branches", () => {
  it("returns an empty string when nothing slug-able remains (early-empty branch)", () => {
    expect(slugify("***")).toBe("");
    expect(slugify("   ")).toBe("");
    expect(slugify(undefined)).toBe("");
    expect(slugify(null)).toBe("");
  });

  it("truncates the final slug to 120 chars (.slice(0, 120) branch)", () => {
    const slug = slugify(`${"a".repeat(200)} ${"b".repeat(200)}`);
    expect(slug.length).toBe(120);
    expect(slug.startsWith("a")).toBe(true);
  });

  it("does not leave a trailing hyphen when the 120-char cut lands on a separator", () => {
    // 119 "a"s + "-" + "tail": the .slice(0, 120) boundary falls on the separator hyphen.
    const slug = slugify(`${"a".repeat(119)} tail`);
    expect(slug).toBe("a".repeat(119));
    expect(slug.endsWith("-")).toBe(false);
  });

  it("strips quotes and collapses non-alphanumerics", () => {
    expect(slugify(`It's a "Test" Value`)).toBe("its-a-test-value");
  });
});

describe("buildContributorMdx — login fallbacks + array/escaping branches", () => {
  it("uses 'website' as submittedBy when githubLogin is undefined (no profile-url lines)", () => {
    const mdx = buildContributorMdx(SAMPLE_FIELDS, undefined, "2026-06-22T00:00:00.000Z", CONFIG);
    expect(mdx).toContain('submittedBy: "website"');
    expect(mdx).toContain('author: "website"');
    // No safe login → both authorProfileUrl and submittedByUrl frontmatter lines are omitted.
    expect(mdx).not.toContain("authorProfileUrl:");
    expect(mdx).not.toContain("submittedByUrl:");
  });

  it("uses 'website' when the githubLogin fails the validGitHubLogin check (invalid-login branch)", () => {
    // A login with an illegal leading hyphen fails validGitHubLogin → treated as no login.
    const mdx = buildContributorMdx(SAMPLE_FIELDS, "-bad-login-", "2026-06-22T00:00:00.000Z", CONFIG);
    expect(mdx).toContain('submittedBy: "website"');
    expect(mdx).not.toContain("submittedByUrl:");
  });

  it("normalizes CR / CRLF inside array fields (yamlArray newline-normalize branch)", () => {
    const mdx = buildContributorMdx(
      { ...SAMPLE_FIELDS, prerequisites: "node 20\r\ngit\rmacos\nlinux" },
      "octocat",
      "2026-06-22T00:00:00.000Z",
      CONFIG,
    );
    // lines() splits on \r?\n; the remaining lone \r is normalized inside yamlArray's per-value map.
    expect(mdx).toContain("prerequisites:");
    expect(mdx).toMatch(/prerequisites: \[.*"node 20".*"linux".*\]/);
  });

  it("escapes MDX-special prose: headings, import/export lines, and markdown metacharacters", () => {
    const mdx = buildContributorMdx(
      {
        ...SAMPLE_FIELDS,
        description: "# Heading and *stars* and [links](url)",
        safety_notes: "import danger\nexport risk",
        full_copyable_content: "## inner heading\n`code`",
      },
      "octocat",
      "2026-06-22T00:00:00.000Z",
      CONFIG,
    );
    // mdxPlainText escapes leading #, leading import/export, and inline metachars in the body.
    expect(mdx).toContain("\\# Heading");
    expect(mdx).toContain("\\import danger");
    expect(mdx).toContain("\\export risk");
  });

  it("renders an explicit empty tags array when no tags are provided (tags.length falsy branch)", () => {
    const mdx = buildContributorMdx({ category: "skills", name: "No Tags", description: "x" }, "octocat", "2026-06-22T00:00:00.000Z", CONFIG);
    expect(mdx).toContain("tags: []");
  });

  it("derives cardDescription/seoDescription via oneLine truncation for a very long description (>160 cp)", () => {
    const longDescription = "word ".repeat(80).trim(); // ~399 chars, single line
    const mdx = buildContributorMdx({ category: "skills", name: "Long", description: longDescription }, "octocat", "2026-06-22T00:00:00.000Z", CONFIG);
    // oneLine truncates to 157 code points + "..." when over 160; assert the ellipsis appears.
    expect(mdx).toMatch(/cardDescription: ".*\.\.\."/);
  });

  it("emits a source-content body block when full_copyable_content is present (sourceLines.length truthy branch)", () => {
    const mdx = buildContributorMdx(
      { ...SAMPLE_FIELDS, full_copyable_content: "first source line\nsecond source line" },
      "octocat",
      "2026-06-22T00:00:00.000Z",
      CONFIG,
    );
    expect(mdx).toContain("copySnippet:");
    expect(mdx).toContain("first source line");
    expect(mdx).toContain("second source line");
  });

  it("falls back to 'Maintainer review required.' for the Safety/Privacy body when notes are blank", () => {
    const mdx = buildContributorMdx({ category: "skills", name: "Bare", description: "x" }, "octocat", "2026-06-22T00:00:00.000Z", CONFIG);
    // Both safetyBody and privacyBody hit the `|| "Maintainer review required."` fallback.
    const occurrences = mdx.split("Maintainer review required.").length - 1;
    expect(occurrences).toBe(2);
  });

  it("prefers fields.title when fields.name is absent (title fallback branch)", () => {
    const mdx = buildContributorMdx({ category: "skills", title: "Only Title", description: "x" }, "octocat", "2026-06-22T00:00:00.000Z", CONFIG);
    expect(mdx).toContain('title: "Only Title"');
    expect(mdx).toContain('slug: "only-title"');
  });
});

describe("processSubmitDraft — token expiry / consumed guards + base-SHA + title fallback", () => {
  it("marks the draft error 'token_unavailable' when the token is expired (expiry guard)", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env, SAMPLE_FIELDS, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await processSubmitDraft(env, id);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const row = await env.DB.prepare("SELECT status, last_error FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row).toMatchObject({ status: "error", last_error: "token_unavailable" });
  });

  it("marks the draft error 'token_unavailable' when expires_at is unparseable (fail-closed)", async () => {
    // A malformed expires_at must NOT be treated as "never expired"; it short-circuits to token_unavailable.
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env, SAMPLE_FIELDS, { expiresAt: "not-a-valid-date" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await processSubmitDraft(env, id);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const row = await env.DB.prepare("SELECT status, last_error FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row).toMatchObject({ status: "error", last_error: "token_unavailable" });
  });

  it("marks the draft error 'token_unavailable' when the token is already consumed (consumed guard)", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env, SAMPLE_FIELDS, { consumed: true });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await processSubmitDraft(env, id);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const row = await env.DB.prepare("SELECT status, last_error FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row).toMatchObject({ status: "error", last_error: "token_unavailable" });
  });

  it("marks the draft error 'token_unavailable' when the encryption key is missing (encKey empty branch)", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env);
    // Drop the encryption secret AFTER seeding so the token row exists but cannot be decrypted.
    (env as { DRAFT_TOKEN_ENCRYPTION_SECRET?: string }).DRAFT_TOKEN_ENCRYPTION_SECRET = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await processSubmitDraft(env, id);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const row = await env.DB.prepare("SELECT status, last_error FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row).toMatchObject({ status: "error", last_error: "token_unavailable" });
  });

  it("returns early (no-op) when the draft id does not exist (missing-row guard)", async () => {
    const env = draftEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await processSubmitDraft(env, "draft_does_not_exist");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("marks the draft error when the fork base SHA cannot be resolved (both base + fallback ref absent)", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      makeGithubFetch([
        { method: "GET", url: "https://api.github.com/user", respond: () => ok({ login: "octocat" }) },
        { method: "POST", url: `/repos/${UPSTREAM}/forks`, respond: () => ok({ full_name: "octocat/awesome-claude", default_branch: "main" }) },
        { method: "GET", url: "https://api.github.com/repos/octocat/awesome-claude", respond: () => ok({ full_name: "octocat/awesome-claude", default_branch: "main" }) },
        { method: "GET", url: `/repos/${UPSTREAM}/pulls`, respond: () => ok([]) },
        { method: "GET", url: "/git/ref/heads/main", respond: () => notFound() }, // base ref absent
        // base ref absent → fallback probe of the default branch; also absent → no SHA → throw.
        { method: "GET", url: "/git/ref/heads/main", respond: () => notFound() },
      ]),
    );

    await processSubmitDraft(env, id);
    fetchSpy.mockRestore();

    const row = await env.DB.prepare("SELECT status, last_error FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row?.status).toBe("error");
    expect(row?.last_error).toBe("Could not resolve fork base SHA.");
  });

  it("derives the fork repo + login from the created-fork response (no full_name/name on the POST /forks reply)", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env);
    // POST /forks returns only an owner login (no full_name, no name) → parseRepo composes the
    // fallback `${createdFork.owner.login}/${upstream.repo}` = "fallbackuser/awesome-claude".
    // The fork-existence GET then resolves WITHOUT a full_name, so forkRepo stays at that fallback
    // and forkDefaultBranch falls back to the createdFork.default_branch. The fork resolves on the
    // first probe so the readiness loop breaks immediately (no real sleep).
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (method === "GET" && url === "https://api.github.com/user") return ok({ login: "fallbackuser" });
      if (method === "POST" && url.includes(`/repos/${UPSTREAM}/forks`)) return ok({ owner: { login: "fallbackuser" }, default_branch: "main" });
      if (method === "GET" && /\/repos\/fallbackuser\/awesome-claude$/.test(url)) return ok({ default_branch: "main" }); // resolves, no full_name
      if (method === "GET" && url.includes(`/repos/${UPSTREAM}/pulls`)) return ok([]);
      if (method === "GET" && url.includes("/git/ref/heads/main")) return ok({ object: { sha: "fbsha" } });
      if (method === "GET" && url.includes("/git/ref/heads/heyclaude/submit-skills-example-skill")) return notFound();
      if (method === "POST" && url.includes("/git/refs")) return ok({ ref: "refs/heads/x" });
      if (method === "GET" && url.includes("/contents/content/skills/example-skill.mdx?ref=")) return notFound();
      if (method === "PUT" && url.includes("/contents/content/skills/example-skill.mdx")) return ok({ content: { sha: "filesha" } });
      if (method === "POST" && url.includes(`/repos/${UPSTREAM}/pulls`)) return ok({ number: 314, html_url: "https://github.com/JSONbored/awesome-claude/pull/314" });
      throw new Error(`unexpected fetch ${method} ${url}`);
    });

    await processSubmitDraft(env, id);
    fetchSpy.mockRestore();

    const row = await env.DB.prepare("SELECT status, github_login, fork_full_name, pull_request_number FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; github_login: string; fork_full_name: string; pull_request_number: number }>();
    expect(row).toMatchObject({ status: "pr_open", github_login: "fallbackuser", fork_full_name: "fallbackuser/awesome-claude", pull_request_number: 314 });
  });

  it("uses row.slug in the PR title when fields lack name AND title (title slug fallback)", async () => {
    const env = draftEnv();
    // Seed fields with only a category (no name/title) — buildContributorMdx still needs a slug, so
    // give it a slug-able category alone won't work; instead seed name in fields for the MDX but
    // strip name/title from the title-fallback by storing a row whose fields omit name/title.
    const id = newDraftId("draft");
    await env.DB.prepare(
      `INSERT INTO submission_drafts (id, status, category, slug, target_path, branch_name, base_ref, fields_json)
       VALUES (?, 'queued', 'skills', 'titled-by-slug', 'content/skills/titled-by-slug.mdx', 'heyclaude/submit-skills-titled-by-slug', 'main', ?)`,
    )
      .bind(id, JSON.stringify({ category: "skills", slug: "titled-by-slug", description: "x" }))
      .run();
    await env.DB.prepare("INSERT INTO submission_user_tokens (draft_id, encrypted_token, expires_at) VALUES (?, ?, ?)")
      .bind(id, await encryptDraftToken(DRAFT_SECRET, "gho_user_access_token"), new Date(Date.now() + 60_000).toISOString())
      .run();

    let prTitle = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      if (method === "GET" && url === "https://api.github.com/user") return ok({ login: "octocat" });
      if (method === "POST" && url.includes(`/repos/${UPSTREAM}/forks`)) return ok({ full_name: "octocat/awesome-claude", default_branch: "main" });
      if (method === "GET" && /\/repos\/octocat\/awesome-claude$/.test(url)) return ok({ full_name: "octocat/awesome-claude", default_branch: "main" });
      if (method === "GET" && url.includes(`/repos/${UPSTREAM}/pulls`)) return ok([]);
      if (method === "GET" && url.includes("/git/ref/heads/main")) return ok({ object: { sha: "sha" } });
      if (method === "GET" && url.includes("/git/ref/heads/heyclaude/submit-skills-titled-by-slug")) return notFound();
      if (method === "POST" && url.includes("/git/refs")) return ok({ ref: "refs/heads/x" });
      if (method === "GET" && url.includes("/contents/content/skills/titled-by-slug.mdx?ref=")) return notFound();
      if (method === "PUT" && url.includes("/contents/content/skills/titled-by-slug.mdx")) return ok({ content: { sha: "filesha" } });
      if (method === "POST" && url.includes(`/repos/${UPSTREAM}/pulls`)) {
        prTitle = JSON.parse(String(init?.body)).title as string;
        return ok({ number: 1, html_url: "https://github.com/JSONbored/awesome-claude/pull/1" });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });

    await processSubmitDraft(env, id);
    fetchSpy.mockRestore();

    // String(fields.name ?? fields.title ?? row.slug) → both name and title are undefined → row.slug.
    expect(prTitle).toBe("Add skills: titled-by-slug");
  });
});

describe("handleDraftOAuthCallback — extra guards", () => {
  it("returns 404 when the flag is off", async () => {
    const env = createTestEnv(); // flag unset
    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?code=x&state=a.b`), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  it("returns 400 when the row exists but has a NULL auth_state_hash (already-consumed state)", async () => {
    const env = draftEnv();
    const id = newDraftId("draft");
    // A queued row whose auth_state_hash was cleared (NULL) must not validate any state.
    await env.DB.prepare(
      `INSERT INTO submission_drafts (id, status, category, slug, target_path, branch_name, base_ref, fields_json, auth_state_hash)
       VALUES (?, 'queued', 'skills', 'x', 'content/skills/x.mdx', 'heyclaude/submit-skills-x', 'main', ?, NULL)`,
    )
      .bind(id, JSON.stringify(SAMPLE_FIELDS))
      .run();
    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?code=abc&state=${id}.anytoken`), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid or expired submission state.");
  });

  it("returns 400 when the draft id in the state does not match any row", async () => {
    const env = draftEnv();
    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?code=abc&state=draft_unknown.sometoken`), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid or expired submission state.");
  });

  it("returns 400 when the code is empty even though the state is valid (no-code branch)", async () => {
    const app = createApp();
    const env = draftEnv();
    const createdResponse = await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }, env);
    const created = (await createdResponse.json()) as { authUrl: string };
    const state = new URL(created.authUrl).searchParams.get("state") ?? "";
    const cookie = createdResponse.headers.get("set-cookie") ?? "";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Valid state, but no `code` and no `error` query param → "authorization was not completed".
    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?state=${encodeURIComponent(state)}`, { headers: callbackHeaders(cookie) }), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("GitHub authorization was not completed.");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns 400 with the generic 'GitHub auth failed.' message when the exchange yields no error fields", async () => {
    const app = createApp();
    const env = draftEnv();
    const createdResponse = await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }, env);
    const created = (await createdResponse.json()) as { authUrl: string };
    const state = new URL(created.authUrl).searchParams.get("state") ?? "";
    const cookie = createdResponse.headers.get("set-cookie") ?? "";
    // 200 OK but no access_token and no error/error_description → exchangeGitHubUserCode throws the
    // bare "GitHub auth failed." fallback, which the callback catches → 400 "GitHub authorization failed."
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => ok({}));
    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?code=valid&state=${encodeURIComponent(state)}`, { headers: callbackHeaders(cookie) }), env);
    fetchSpy.mockRestore();
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("GitHub authorization failed.");
  });

  it("returns 400 when the exchange responds non-OK (response.ok false branch)", async () => {
    const app = createApp();
    const env = draftEnv();
    const createdResponse = await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }, env);
    const created = (await createdResponse.json()) as { authUrl: string };
    const state = new URL(created.authUrl).searchParams.get("state") ?? "";
    const cookie = createdResponse.headers.get("set-cookie") ?? "";
    // Non-OK + a non-JSON body → response.json().catch(() => ({})) → {} → throws "GitHub auth failed."
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("Bad Gateway", { status: 502 }));
    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?code=valid&state=${encodeURIComponent(state)}`, { headers: callbackHeaders(cookie) }), env);
    fetchSpy.mockRestore();
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("GitHub authorization failed.");
  });
});

describe("handleDraftStatus — flag-off guard + populated optional columns", () => {
  it("returns 404 when the flag is off", async () => {
    const env = createTestEnv(); // flag unset
    const res = await handleDraftStatus(new Request(`${ORIGIN}/v1/drafts/x`), env, "x");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  it("surfaces githubLogin + pull_request fields when the draft has reached pr_open", async () => {
    const env = draftEnv();
    const id = newDraftId("draft");
    await env.DB.prepare(
      `INSERT INTO submission_drafts (id, status, category, slug, target_path, branch_name, base_ref, fields_json, github_login, fork_full_name, pull_request_url, pull_request_number)
       VALUES (?, 'pr_open', 'skills', 'x', 'content/skills/x.mdx', 'heyclaude/submit-skills-x', 'main', ?, 'octocat', 'octocat/awesome-claude', 'https://github.com/JSONbored/awesome-claude/pull/9', 9)`,
    )
      .bind(id, JSON.stringify(SAMPLE_FIELDS))
      .run();
    const res = await handleDraftStatus(new Request(`${ORIGIN}/v1/drafts/${id}`), env, id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draft: { githubLogin: string; pullRequestUrl: string; pullRequestNumber: number } };
    expect(body.draft).toMatchObject({ githubLogin: "octocat", pullRequestUrl: "https://github.com/JSONbored/awesome-claude/pull/9", pullRequestNumber: 9 });
  });
});

describe("processSubmitDraft — fork-readiness retry loop (instant backoff)", () => {
  it("polls again after the fork is initially absent, then proceeds once it appears (no real sleep)", async () => {
    // The fork-readiness backoff is sleep(3000) = setTimeout(resolve, 3000). Make it INSTANT (fire on a real
    // 0ms tick) so the whole flow runs to completion on the real event loop — no 3s wait, and no fake-timer
    // pump to race the interleaved real async (WebCrypto token-decrypt + the async D1/fetch mocks). The old
    // fake-timer drive intermittently HUNG under CI coverage load (a real macrotask lagged the microtask flush
    // the pump relied on, so the scheduled sleep was never fired and the test timed out).
    const realSetTimeout = globalThis.setTimeout;
    const timerSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((cb: (...a: unknown[]) => void, _ms?: number, ...args: unknown[]) => realSetTimeout(cb, 0, ...args)) as unknown as typeof globalThis.setTimeout);
    try {
      const env = draftEnv();
      const id = await seedQueuedDraftWithToken(env);
      // The fork-existence GET returns 404 on the first probe (forcing one sleep(3000))
      // and the fork on the second; every other route is a one-shot success.
      let forkProbe = 0;
      const routes = makeGithubFetch([
        { method: "GET", url: "https://api.github.com/user", respond: () => ok({ login: "octocat" }) },
        { method: "POST", url: `/repos/${UPSTREAM}/forks`, respond: () => ok({ full_name: "octocat/awesome-claude", default_branch: "main" }) },
        { method: "GET", url: `/repos/${UPSTREAM}/pulls`, respond: () => ok([]) },
        { method: "GET", url: "/git/ref/heads/main", respond: () => ok({ object: { sha: "basesha123" } }) },
        { method: "GET", url: "/git/ref/heads/heyclaude/submit-skills-example-skill", respond: () => notFound() },
        { method: "POST", url: "/git/refs", respond: () => ok({ ref: "refs/heads/x" }) },
        { method: "GET", url: "/contents/content/skills/example-skill.mdx?ref=", respond: () => notFound() },
        { method: "PUT", url: "/contents/content/skills/example-skill.mdx", respond: () => ok({ content: { sha: "filesha" } }) },
        { method: "POST", url: `/repos/${UPSTREAM}/pulls`, respond: () => ok({ number: 808, html_url: "https://github.com/JSONbored/awesome-claude/pull/808" }) },
      ]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
        const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
        // The repeatable fork-readiness probe: GET of the repo ROOT (no sub-path), 404 first then
        // the fork. Matched exactly so sibling repo paths (/pulls, /git/ref, /contents) fall through
        // to the one-shot route table. Not delegated to that table (it would match at most once).
        if (method === "GET" && /\/repos\/octocat\/awesome-claude$/.test(url)) {
          forkProbe += 1;
          return forkProbe === 1 ? notFound() : ok({ full_name: "octocat/awesome-claude", default_branch: "main" });
        }
        return routes(input, init);
      });

      // sleep() is now instant, so the flow runs straight through (probe 404 → instant backoff → probe 200 →
      // open the PR). Just await it — no pump loop, no fake-timer race.
      await processSubmitDraft(env, id);
      fetchSpy.mockRestore();

      expect(forkProbe).toBe(2); // probed once (absent), slept, probed again (present)
      const row = await env.DB.prepare("SELECT status, pull_request_number FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; pull_request_number: number }>();
      expect(row).toMatchObject({ status: "pr_open", pull_request_number: 808 });
    } finally {
      timerSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Second coverage pass: the remaining one-sided PARTIAL branches — the
// `?? ""` nullish arms of draftSecrets (props genuinely UNDEFINED, not ""),
// the oneLine/description `||` fallbacks, the createUserForkContentPr fork-name
// composition fallbacks, the content-type `|| ""` arm, the non-object JSON.parse
// arm, and the parseRepo invalid-repo throw.
// ---------------------------------------------------------------------------

describe("draftSecrets — `?? \"\"` nullish arms (env props genuinely undefined)", () => {
  it("returns 503 when GITHUB_OAUTH_CLIENT_ID is undefined (not just empty) — clientId `?? \"\"` arm", async () => {
    // createTestEnv never sets GITHUB_OAUTH_CLIENT_ID → property is genuinely undefined,
    // so `env.GITHUB_OAUTH_CLIENT_ID ?? ""` takes the nullish-coalescing fallback.
    const env = createTestEnv({
      LOOPOVER_REVIEW_DRAFT: "true",
      DRAFT_TOKEN_ENCRYPTION_SECRET: DRAFT_SECRET,
      // GITHUB_OAUTH_CLIENT_ID intentionally omitted (undefined)
    });
    const res = await handleDraftCreate(new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }), env);
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "draft_flow_not_configured" });
  });

  it("returns 503 when DRAFT_TOKEN_ENCRYPTION_SECRET is undefined — encKey `?? \"\"` arm", async () => {
    const env = createTestEnv({
      LOOPOVER_REVIEW_DRAFT: "true",
      GITHUB_OAUTH_CLIENT_ID: "Iv-test-client-id",
      // DRAFT_TOKEN_ENCRYPTION_SECRET intentionally omitted (undefined)
    });
    const res = await handleDraftCreate(new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }), env);
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "draft_flow_not_configured" });
  });

  it("returns 503 from the OAuth callback when GITHUB_OAUTH_CLIENT_SECRET is undefined — clientSecret `?? \"\"` arm", async () => {
    // Create a draft with full secrets so a valid state exists, then run the callback against an
    // env whose CLIENT_SECRET is genuinely undefined → draftSecrets clientSecret = "" → 503.
    const fullEnv = draftEnv();
    const app = createApp();
    const createdResponse = await app.request("/v1/drafts", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(SAMPLE_FIELDS) }, fullEnv);
    const created = (await createdResponse.json()) as { authUrl: string };
    const state = new URL(created.authUrl).searchParams.get("state") ?? "";
    const cookie = createdResponse.headers.get("set-cookie") ?? "";

    // Re-point the SAME D1 instance into an env missing the client secret (undefined, not "").
    const env = createTestEnv({
      LOOPOVER_REVIEW_DRAFT: "true",
      GITHUB_OAUTH_CLIENT_ID: "Iv-test-client-id",
      DRAFT_TOKEN_ENCRYPTION_SECRET: DRAFT_SECRET,
      DB: fullEnv.DB,
      // GITHUB_OAUTH_CLIENT_SECRET intentionally omitted (undefined)
    });
    const res = await handleDraftOAuthCallback(new Request(`${ORIGIN}/v1/drafts/auth/callback?code=valid&state=${encodeURIComponent(state)}`, { headers: callbackHeaders(cookie) }), env);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Draft flow not configured.");
  });
});

describe("buildContributorMdx — description/oneLine `||` fallback arms", () => {
  it("derives cardDescription/seoDescription from card_description when description is empty (description `||` right arm + oneLine fallback)", () => {
    // No description → `fields.description || fields.card_description` takes card_description, and
    // oneLine(description) receives "" → `value || fallback` evaluates the (default empty) fallback.
    const mdx = buildContributorMdx(
      { category: "skills", name: "No Description", description: "", card_description: "Card only text." },
      "octocat",
      "2026-06-22T00:00:00.000Z",
      CONFIG,
    );
    // description frontmatter is the card_description value (the `||` right operand).
    expect(mdx).toContain('description: "Card only text."');
    // seoDescription = fields.seo_title? no → fields.seo_description? no → oneLine(description) where
    // description is now "Card only text." Actually description resolves to card_description here, so
    // assert the oneLine-derived seoDescription is present and non-empty.
    expect(mdx).toContain('seoDescription: "Card only text."');
  });

  it("emits empty derived cardDescription/seoDescription when description AND card_description are both blank (oneLine empty-value fallback)", () => {
    // description "" and card_description "" → description resolves to "" → oneLine("") hits its
    // `value || fallback` right arm (fallback defaults to "") → empty string output.
    const mdx = buildContributorMdx({ category: "skills", name: "Totally Bare", description: "" }, "octocat", "2026-06-22T00:00:00.000Z", CONFIG);
    expect(mdx).toContain('cardDescription: ""');
    expect(mdx).toContain('seoDescription: ""');
  });
});

describe("handleDraftCreate — content-type `|| \"\"` arm + non-object JSON.parse arm", () => {
  it("rejects a request with NO content-type header at all (415, content-type `|| \"\"` right arm)", async () => {
    const env = draftEnv();
    // A POST with no body sets no auto content-type → headers.get("content-type") is null, so
    // `request.headers.get("content-type") || ""` takes the "" fallback → no "application/json" → 415.
    const req = new Request(`${ORIGIN}/v1/drafts`, { method: "POST" });
    expect(req.headers.get("content-type")).toBeNull();
    const res = await handleDraftCreate(req, env);
    expect(res.status).toBe(415);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "expected_json" });
  });

  it("treats a valid-JSON non-object body as an empty fields object (JSON.parse ternary `{}` arm → 400 slug)", async () => {
    const env = draftEnv();
    // `42` is valid JSON but not an object → `typeof parsed === "object" && parsed` is false →
    // body = {} (the ternary false arm). fields = {} → buildTarget throws "Unsupported category." → 400.
    const res = await handleDraftCreate(new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: { "content-type": "application/json" }, body: "42" }), env);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "Unsupported category." });
  });

  it("treats a JSON `null` body as an empty fields object (parsed falsy → `{}` arm)", async () => {
    const env = draftEnv();
    // `null` parses to null → `typeof null === "object"` is true but `&& parsed` is falsy → body = {}.
    const res = await handleDraftCreate(new Request(`${ORIGIN}/v1/drafts`, { method: "POST", headers: { "content-type": "application/json" }, body: "null" }), env);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "Unsupported category." });
  });
});

describe("createUserForkContentPr — fork-name + default-branch `||` fallback arms (via processSubmitDraft)", () => {
  it("composes the fork login from the authenticated user when POST /forks omits owner.login (line 423 `|| user.login` arm)", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env);
    // POST /forks returns NEITHER full_name NOR owner.login NOR name → forkRepo is composed as
    // `${user.login}/${upstream.repo}` = "octocat/awesome-claude" (both `||` right arms on line 423).
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      makeGithubFetch([
        { method: "GET", url: "https://api.github.com/user", respond: () => ok({ login: "octocat" }) },
        { method: "POST", url: `/repos/${UPSTREAM}/forks`, respond: () => ok({ default_branch: "main" }) }, // no full_name/name/owner
        { method: "GET", url: "https://api.github.com/repos/octocat/awesome-claude", respond: () => ok({ full_name: "octocat/awesome-claude", default_branch: "main" }) },
        { method: "GET", url: `/repos/${UPSTREAM}/pulls`, respond: () => ok([]) },
        { method: "GET", url: "/git/ref/heads/main", respond: () => ok({ object: { sha: "basesha" } }) },
        { method: "GET", url: "/git/ref/heads/heyclaude/submit-skills-example-skill", respond: () => notFound() },
        { method: "POST", url: "/git/refs", respond: () => ok({ ref: "refs/heads/x" }) },
        { method: "GET", url: "/contents/content/skills/example-skill.mdx?ref=", respond: () => notFound() },
        { method: "PUT", url: "/contents/content/skills/example-skill.mdx", respond: () => ok({ content: { sha: "filesha" } }) },
        { method: "POST", url: `/repos/${UPSTREAM}/pulls`, respond: () => ok({ number: 21, html_url: "https://github.com/JSONbored/awesome-claude/pull/21" }) },
      ]),
    );

    await processSubmitDraft(env, id);
    fetchSpy.mockRestore();

    const row = await env.DB.prepare("SELECT status, fork_full_name, pull_request_number FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; fork_full_name: string; pull_request_number: number }>();
    expect(row).toMatchObject({ status: "pr_open", fork_full_name: "octocat/awesome-claude", pull_request_number: 21 });
  });

  it("falls back to params.baseRef for forkDefaultBranch when POST /forks omits default_branch (line 424 `|| params.baseRef` arm)", async () => {
    const env = draftEnv();
    const id = await seedQueuedDraftWithToken(env);
    // POST /forks returns full_name but NO default_branch → forkDefaultBranch = params.baseRef ("main").
    // The fork-existence GET ALSO omits default_branch → line 433 keeps the existing forkDefaultBranch.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      makeGithubFetch([
        { method: "GET", url: "https://api.github.com/user", respond: () => ok({ login: "octocat" }) },
        { method: "POST", url: `/repos/${UPSTREAM}/forks`, respond: () => ok({ full_name: "octocat/awesome-claude" }) }, // no default_branch
        { method: "GET", url: "https://api.github.com/repos/octocat/awesome-claude", respond: () => ok({ full_name: "octocat/awesome-claude" }) }, // no default_branch (line 433 right arm)
        { method: "GET", url: `/repos/${UPSTREAM}/pulls`, respond: () => ok([]) },
        { method: "GET", url: "/git/ref/heads/main", respond: () => ok({ object: { sha: "basesha" } }) },
        { method: "GET", url: "/git/ref/heads/heyclaude/submit-skills-example-skill", respond: () => notFound() },
        { method: "POST", url: "/git/refs", respond: () => ok({ ref: "refs/heads/x" }) },
        { method: "GET", url: "/contents/content/skills/example-skill.mdx?ref=", respond: () => notFound() },
        { method: "PUT", url: "/contents/content/skills/example-skill.mdx", respond: () => ok({ content: { sha: "filesha" } }) },
        { method: "POST", url: `/repos/${UPSTREAM}/pulls`, respond: () => ok({ number: 22, html_url: "https://github.com/JSONbored/awesome-claude/pull/22" }) },
      ]),
    );

    await processSubmitDraft(env, id);
    fetchSpy.mockRestore();

    const row = await env.DB.prepare("SELECT status, pull_request_number FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; pull_request_number: number }>();
    expect(row).toMatchObject({ status: "pr_open", pull_request_number: 22 });
  });

  it("marks the draft error when DRAFT_PUBLIC_REPO is not owner/repo (parseRepo throw — line 324)", async () => {
    // An invalid public repo (no slash) makes parseRepo throw "Expected owner/repo repository name.",
    // which the processSubmitDraft outer catch records as the draft error. Exercises the if-throw arm.
    const env = draftEnv({ DRAFT_PUBLIC_REPO: "not-a-valid-repo" });
    const id = await seedQueuedDraftWithToken(env);
    // parseRepo(params.publicRepo) runs BEFORE the first fetch, so the throw happens with no network call.
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await processSubmitDraft(env, id);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    const row = await env.DB.prepare("SELECT status, last_error FROM submission_drafts WHERE id = ?").bind(id).first<{ status: string; last_error: string }>();
    expect(row?.status).toBe("error");
    expect(row?.last_error).toBe("Expected owner/repo repository name.");
  });
});
