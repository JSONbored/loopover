import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { openRepoDocPullRequest } from "../../src/github/repo-doc-pr";
import { upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import * as repositoriesModule from "../../src/db/repositories";
import * as repoDocRenderModule from "../../src/review/repo-doc-render";
import { renderRepoDocContent } from "../../src/review/repo-doc-render";
import { renderRepoSkillContent, repoSkillFilePath } from "../../src/review/repo-skill-render";
import { extractRepoProfile } from "../../src/review/repo-profile";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

function base64Utf8(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

const REPO = "owner/widgets";
const [PROJECT, CHUNK_REPO] = ["owner", "widgets"];

function generateRsaPrivateKeyPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey;
}

function envWithKey() {
  return createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
}

async function seedChunk(env: ReturnType<typeof createTestEnv>, path: string, text: string): Promise<void> {
  await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)").bind(`${path}::0`, PROJECT, CHUNK_REPO, path, 0, "code", text).run();
}

async function seedProfileData(env: ReturnType<typeof createTestEnv>): Promise<void> {
  await seedChunk(env, "src/widget.ts", "export function widget() {}");
  await seedChunk(env, "package.json", JSON.stringify({ scripts: { build: "tsc", test: "vitest run", lint: "eslint ." } }));
}

async function seedInstalledRepo(env: ReturnType<typeof createTestEnv>, options: { defaultBranch?: string } = {}): Promise<void> {
  await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" }, ...(options.defaultBranch !== undefined ? { default_branch: options.defaultBranch } : {}) }, 555);
}

// #3002: repo-doc generation is opt-in per repo via .gittensory.yml `repoDocGeneration:` -- defaults to fully
// disabled, so every test exercising behavior PAST that gate needs it explicitly enabled. Defaults `enabled` to
// true here (the common case for these tests) while letting callers override scope/allowOverwriteExisting.
async function seedRepoDocGenerationConfig(env: ReturnType<typeof createTestEnv>, repoFullName: string, overrides: { enabled?: boolean; scope?: string[]; allowOverwriteExisting?: boolean } = {}): Promise<void> {
  await upsertRepoFocusManifest(env, repoFullName, { repoDocGeneration: { enabled: true, ...overrides } });
}

// #3001: shouldGenerateRepoSkill needs 2 of 3 named signals. Seeds a strict linked-issue rule (settings +
// manifest) and 2 CI workflow files -- both in the SAME upsertRepoFocusManifest call as repoDocGeneration, since
// a second separate call would replace rather than merge with the first.
async function seedSkillTriggerRepo(env: ReturnType<typeof createTestEnv>, repoFullName: string, scope: string[] = ["agents", "skills"], overrides: { allowOverwriteExisting?: boolean } = {}): Promise<void> {
  await upsertRepositorySettings(env, { repoFullName, requireLinkedIssue: true });
  await upsertRepoFocusManifest(env, repoFullName, { linkedIssuePolicy: "required", repoDocGeneration: { enabled: true, scope, ...overrides } });
  await seedChunk(env, ".github/workflows/ci.yml", "name: CI\non: push\n");
  await seedChunk(env, ".github/workflows/lint.yml", "name: Lint\non: push\n");
}

// A fetch stub matching every candidate raw-content URL loadRepoFocusManifest's live fetcher tries when there is
// no persisted manifest snapshot -- returning a plain 404-shaped failure degrades it to the default (disabled)
// manifest, matching fetchRepoFocusManifestFile's own fail-safe "try the next candidate, then give up" behavior.
const MANIFEST_RAW_CONTENT_URL = /raw\.githubusercontent\.com/;

const TOKEN_URL = /\/access_tokens$/;

describe("openRepoDocPullRequest (#3000)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("declines when the repository is not installed", async () => {
    const result = await openRepoDocPullRequest(envWithKey(), REPO, "live");
    expect(result).toEqual({ opened: false, reason: "repository is not installed" });
  });

  it("declines when the repository is installed but carries no installation id", async () => {
    const env = envWithKey();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" } });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: false, reason: "repository is not installed" });
  });

  it("#3002: declines by default when repo-doc generation has no .gittensory.yml config at all", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (MANIFEST_RAW_CONTENT_URL.test(url)) return new Response("not found", { status: 404 });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: false, reason: "repo-doc generation is not enabled for this repository (.gittensory.yml repoDocGeneration.enabled)" });
  });

  it("#3002: declines when explicitly disabled via .gittensory.yml", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO, { enabled: false });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: false, reason: "repo-doc generation is not enabled for this repository (.gittensory.yml repoDocGeneration.enabled)" });
  });

  it("#3002: declines when enabled but scope excludes \"agents\"", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO, { scope: ["skills"] });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: false, reason: 'repo-doc generation scope does not include "agents" for this repository (.gittensory.yml repoDocGeneration.scope)' });
  });

  it("declines with the profile's own reason when the repo has no RAG index yet", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedRepoDocGenerationConfig(env, REPO);
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: false, reason: "no RAG index configured or populated for this repo yet" });
  });

  it("declines defensively if content rendering ever returns null for a present profile", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO);
    vi.spyOn(repoDocRenderModule, "renderRepoDocContent").mockReturnValueOnce(null);
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: false, reason: "no content rendered from profile" });
  });

  it("declines without minting an installation token or writing to GitHub when the action mode is not live", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO);
    let tokenMinted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) tokenMinted = true;
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "dry_run");
    expect(result).toEqual({ opened: false, reason: 'repo-doc pull request not opened: action mode is "dry_run"' });
    expect(tokenMinted).toBe(false);
  });

  it("returns the already-open PR without creating a new branch/commit", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO);
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      calls.push({ method: init?.method ?? "GET", url });
      if (url.includes("/pulls?") && (init?.method ?? "GET") === "GET") {
        return Response.json([{ number: 7, html_url: "https://github.com/owner/widgets/pull/7" }]);
      }
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    // REGRESSION: claudeMode must be "unknown" here, not a guessed "symlink" — this short-circuit never looks
    // at the existing PR's actual tree (that's the whole point of reusing it instead of rebuilding), so there
    // is no real signal for whether that PR's CLAUDE.md landed as a symlink or the copy fallback.
    expect(result).toEqual({ opened: true, reused: true, pullNumber: 7, url: "https://github.com/owner/widgets/pull/7", claudeMode: "unknown" });
    expect(calls.some((c) => c.url.includes("/git/trees"))).toBe(false);
  });

  it("opens a first-run pull request with a real CLAUDE.md symlink when the target tree accepts one", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO);
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/AGENTS.md") && method === "GET") return new Response("not found", { status: 404 });
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "new-tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "new-commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({ ref: "refs/heads/gittensory/repo-docs" });
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 42, html_url: "https://github.com/owner/widgets/pull/42" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: true, reused: false, pullNumber: 42, url: "https://github.com/owner/widgets/pull/42", claudeMode: "symlink" });

    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"));
    expect(treeCall?.body).toMatchObject({ base_tree: "base-tree-sha" });
    const tree = treeCall?.body.tree as Array<{ path: string; mode: string; content: string }>;
    expect(tree).toEqual([
      { path: "AGENTS.md", mode: "100644", type: "blob", content: expect.stringContaining("# AGENTS.md") },
      { path: "CLAUDE.md", mode: "120000", type: "blob", content: "AGENTS.md" },
    ]);

    const commitCall = calls.find((c) => c.url.endsWith("/git/commits"));
    expect(commitCall?.body).toMatchObject({ tree: "new-tree-sha", parents: ["base-commit-sha"] });

    const refCall = calls.find((c) => c.url.endsWith("/git/refs"));
    expect(refCall?.body).toMatchObject({ ref: "refs/heads/gittensory/repo-docs", sha: "new-commit-sha" });

    const prCall = calls.find((c) => c.url.endsWith("/repos/owner/widgets/pulls") && c.method === "POST");
    expect(prCall?.body).toMatchObject({ head: "gittensory/repo-docs", base: "main", title: "docs: generate AGENTS.md and CLAUDE.md from repo profile" });
    expect(prCall?.body.body as string).toContain("Gittensory opened this pull request");
  });

  it("falls back to a byte-identical CLAUDE.md copy when the target repo rejects a symlink tree entry", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO);
    let treeAttempts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/AGENTS.md") && method === "GET") return new Response("not found", { status: 404 });
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") {
        treeAttempts += 1;
        if (treeAttempts === 1) return new Response("symlinks unsupported", { status: 422 });
        return Response.json({ sha: "copy-tree-sha" });
      }
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "copy-commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 9, html_url: "https://github.com/owner/widgets/pull/9" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: true, reused: false, pullNumber: 9, url: "https://github.com/owner/widgets/pull/9", claudeMode: "copy" });
    expect(treeAttempts).toBe(2);
  });

  it("fetches the default branch from GitHub when the stored repository record has none", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env);
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO);
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.endsWith("/repos/owner/widgets") && method === "GET") return Response.json({ default_branch: "trunk" });
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/AGENTS.md") && method === "GET") return new Response("not found", { status: 404 });
      if (url.endsWith("/branches/trunk")) return Response.json({ commit: { sha: "c", commit: { tree: { sha: "t" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "ts" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "cs" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 3, html_url: "https://github.com/owner/widgets/pull/3" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: true, reused: false, pullNumber: 3, url: "https://github.com/owner/widgets/pull/3", claudeMode: "symlink" });
    expect(calls.some((c) => c === "GET https://api.github.com/repos/owner/widgets")).toBe(true);
  });

  it("#3004: treats a contents response with no string .content as first-run (generates fresh content)", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/AGENTS.md") && method === "GET") return Response.json([{ name: "AGENTS.md", type: "dir" }]);
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "new-tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "new-commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 61, html_url: "https://github.com/owner/widgets/pull/61" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: true, reused: false, pullNumber: 61, url: "https://github.com/owner/widgets/pull/61", claudeMode: "symlink" });
  });

  it("REGRESSION (#3004): reports no-change and creates no branch/commit/PR when the existing AGENTS.md is already current", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO);
    const profile = await extractRepoProfile(env, REPO);
    const currentContent = renderRepoDocContent(profile)!;
    let wroteAnything = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/AGENTS.md") && method === "GET") return Response.json({ content: base64Utf8(currentContent), encoding: "base64" });
      if (method === "POST") wroteAnything = true;
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: false, reason: "no meaningful change since the last generated AGENTS.md" });
    expect(wroteAnything).toBe(false);
  });

  it("#3004: rethrows (rather than treating as first-run) a non-404 failure while fetching the existing AGENTS.md", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/AGENTS.md") && method === "GET") return Response.json({ message: "rate limited" }, { status: 403 });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result.opened).toBe(false);
    expect((result as { opened: false; reason: string }).reason).toMatch(/rate limited/);
  });

  it("#3004: fails closed with a manual-review reason and creates no branch/commit/PR when the existing file has no marker block", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO);
    let wroteAnything = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/AGENTS.md") && method === "GET") return Response.json({ content: base64Utf8("# Hand-written AGENTS.md\n\nNo markers here.\n"), encoding: "base64" });
      if (method === "POST") wroteAnything = true;
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: false, reason: "AGENTS.md needs manual review before it can be refreshed: no generated-content marker block found" });
    expect(wroteAnything).toBe(false);
  });

  it("#3002: proceeds with a fresh wholesale generate (discarding the old hand-written content) when allowOverwriteExisting is set", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO, { allowOverwriteExisting: true });
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/AGENTS.md") && method === "GET") return Response.json({ content: base64Utf8("# Hand-written AGENTS.md\n\nNo markers here.\n"), encoding: "base64" });
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "overwrite-tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "overwrite-commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 71, html_url: "https://github.com/owner/widgets/pull/71" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: true, reused: false, pullNumber: 71, url: "https://github.com/owner/widgets/pull/71", claudeMode: "symlink" });
    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"));
    const agentsEntry = (treeCall?.body.tree as Array<{ path: string; content: string }>).find((entry) => entry.path === "AGENTS.md");
    expect(agentsEntry?.content).not.toContain("Hand-written AGENTS.md");
    expect(agentsEntry?.content).toContain("# AGENTS.md");
  });

  it("#3004: opens a refresh PR that preserves manual content outside the marker block", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO);
    const profile = await extractRepoProfile(env, REPO);
    const staleGeneratedSection = renderRepoDocContent(profile)!.replace("`npm run lint`", "an older lint command");
    const currentContent = `# Preamble the maintainer added.\n\n${staleGeneratedSection}\nAn appendix the maintainer added.\n`;
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/AGENTS.md") && method === "GET") return Response.json({ content: base64Utf8(currentContent), encoding: "base64" });
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "refresh-tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "refresh-commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 55, html_url: "https://github.com/owner/widgets/pull/55" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: true, reused: false, pullNumber: 55, url: "https://github.com/owner/widgets/pull/55", claudeMode: "symlink" });

    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"));
    const agentsEntry = (treeCall?.body.tree as Array<{ path: string; content: string }>).find((entry) => entry.path === "AGENTS.md");
    expect(agentsEntry?.content).toContain("# Preamble the maintainer added.");
    expect(agentsEntry?.content).toContain("An appendix the maintainer added.");
    expect(agentsEntry?.content).toContain("Lint: `npm run lint`");
    expect(agentsEntry?.content).not.toContain("an older lint command");
  });

  it("#3001: does not include a skill file when scope excludes \"skills\", even if the trigger would fire", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedSkillTriggerRepo(env, REPO, ["agents"]);
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/") && method === "GET") return new Response("not found", { status: 404 });
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 81, html_url: "https://github.com/owner/widgets/pull/81" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: true, reused: false, pullNumber: 81, url: "https://github.com/owner/widgets/pull/81", claudeMode: "symlink" });
    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"));
    expect((treeCall?.body.tree as Array<{ path: string }>).map((entry) => entry.path)).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(calls.some((c) => c.url.includes("SKILL.md"))).toBe(false);
  });

  it("#3001: does not include a skill file when scope includes \"skills\" but the trigger condition is not met", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO, { scope: ["agents", "skills"] });
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/") && method === "GET") return new Response("not found", { status: 404 });
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 82, html_url: "https://github.com/owner/widgets/pull/82" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result.opened).toBe(true);
    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"));
    expect((treeCall?.body.tree as Array<{ path: string }>).map((entry) => entry.path)).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("#3001: adds a first-run skill file to the SAME tree/commit/PR as AGENTS.md when the trigger fires and scope includes \"skills\"", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedSkillTriggerRepo(env, REPO);
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/") && method === "GET") return new Response("not found", { status: 404 });
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 83, html_url: "https://github.com/owner/widgets/pull/83" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: true, reused: false, pullNumber: 83, url: "https://github.com/owner/widgets/pull/83", claudeMode: "symlink" });

    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"));
    const tree = treeCall?.body.tree as Array<{ path: string; mode: string; content: string }>;
    expect(tree.map((entry) => entry.path)).toEqual(["AGENTS.md", "CLAUDE.md", repoSkillFilePath(REPO)]);
    const skillEntry = tree.find((entry) => entry.path === repoSkillFilePath(REPO));
    expect(skillEntry?.mode).toBe("100644");
    expect(skillEntry?.content).toContain("name: contributing-to-widgets");

    const prCall = calls.find((c) => c.url.endsWith("/repos/owner/widgets/pulls") && c.method === "POST");
    expect(prCall?.body.body as string).toContain(repoSkillFilePath(REPO));
  });

  it("#3001: opens a PR for a skill-only change even when AGENTS.md itself is unchanged", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedSkillTriggerRepo(env, REPO);
    const profile = await extractRepoProfile(env, REPO);
    const currentAgentsContent = renderRepoDocContent(profile)!;
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/AGENTS.md") && method === "GET") return Response.json({ content: base64Utf8(currentAgentsContent), encoding: "base64" });
      if (url.includes("/contents/") && method === "GET") return new Response("not found", { status: 404 });
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 84, html_url: "https://github.com/owner/widgets/pull/84" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result.opened).toBe(true);
    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"));
    const tree = treeCall?.body.tree as Array<{ path: string; content: string }>;
    expect(tree.map((entry) => entry.path)).toEqual(["AGENTS.md", "CLAUDE.md", repoSkillFilePath(REPO)]);
    // AGENTS.md's own content is reused byte-for-byte (no-change on that side), only the skill file is new.
    expect(tree.find((entry) => entry.path === "AGENTS.md")?.content).toBe(currentAgentsContent);
  });

  it("#3001: reports overall no-change when BOTH AGENTS.md and the skill file already match the last generated content", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedSkillTriggerRepo(env, REPO);
    const profile = await extractRepoProfile(env, REPO);
    const currentAgentsContent = renderRepoDocContent(profile)!;
    const currentSkillContent = renderRepoSkillContent(profile)!;
    let wroteAnything = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/AGENTS.md") && method === "GET") return Response.json({ content: base64Utf8(currentAgentsContent), encoding: "base64" });
      if (url.includes("/contents/") && method === "GET") return Response.json({ content: base64Utf8(currentSkillContent), encoding: "base64" });
      if (method === "POST") wroteAnything = true;
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: false, reason: "no meaningful change since the last generated AGENTS.md" });
    expect(wroteAnything).toBe(false);
  });

  it("#3001: excludes the skill file from this run (without failing the AGENTS.md refresh) when it looks hand-maintained and overwrite isn't allowed", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedSkillTriggerRepo(env, REPO);
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/AGENTS.md") && method === "GET") return new Response("not found", { status: 404 });
      if (url.includes("/contents/") && method === "GET") return Response.json({ content: base64Utf8("# Hand-written skill notes\n\nNo markers here.\n"), encoding: "base64" });
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 85, html_url: "https://github.com/owner/widgets/pull/85" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result.opened).toBe(true);
    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"));
    expect((treeCall?.body.tree as Array<{ path: string }>).map((entry) => entry.path)).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("#3001: overwrites a hand-maintained skill file with a fresh generate when allowOverwriteExisting is set", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedSkillTriggerRepo(env, REPO, ["agents", "skills"], { allowOverwriteExisting: true });
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/AGENTS.md") && method === "GET") return new Response("not found", { status: 404 });
      if (url.includes("/contents/") && method === "GET") return Response.json({ content: base64Utf8("# Hand-written skill notes\n\nNo markers here.\n"), encoding: "base64" });
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 86, html_url: "https://github.com/owner/widgets/pull/86" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result.opened).toBe(true);
    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"));
    const tree = treeCall?.body.tree as Array<{ path: string; content: string }>;
    const skillEntry = tree.find((entry) => entry.path === repoSkillFilePath(REPO));
    expect(skillEntry?.content).toContain("name: contributing-to-widgets");
    expect(skillEntry?.content).not.toContain("Hand-written skill notes");
  });

  it("reports a caught GitHub Error's message when both the symlink and copy tree attempts fail", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    await seedRepoDocGenerationConfig(env, REPO);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/AGENTS.md") && method === "GET") return new Response("not found", { status: 404 });
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "c", commit: { tree: { sha: "t" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ message: "tree rejected entirely" }, { status: 422 });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result.opened).toBe(false);
    expect((result as { opened: false; reason: string }).reason).toMatch(/tree rejected entirely/);
  });

  it("reports a generic message when a non-Error value is rejected partway through", async () => {
    const env = envWithKey();
    vi.spyOn(repositoriesModule, "getRepository").mockRejectedValueOnce("a non-Error rejection value");
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: false, reason: "unknown error opening repo-doc pull request" });
  });

  it("splits a bare repo name with no owner segment instead of throwing", async () => {
    const env = envWithKey();
    await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)").bind("bare::0", "", "widgets", "src/widget.ts", 0, "code", "export function widget() {}").run();
    await seedRepoDocGenerationConfig(env, "widgets");
    vi.spyOn(repositoriesModule, "getRepository").mockResolvedValueOnce({
      fullName: "widgets",
      owner: "",
      name: "widgets",
      installationId: 555,
      isInstalled: true,
      isRegistered: false,
      isPrivate: false,
      defaultBranch: "main",
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      calls.push(url);
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, "widgets", "live");
    expect(result.opened).toBe(false);
    expect(calls.some((url) => url.includes("/repos//widgets/pulls?"))).toBe(true);
  });
});
