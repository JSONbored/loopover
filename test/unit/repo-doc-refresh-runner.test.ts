import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLastRepoDocRefreshAttemptedAt, getLastRepoDocRefreshAttemptedAtBulk, performRepoDocRefresh } from "../../src/github/repo-doc-refresh-runner";
import { upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

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

async function seedInstalledEnabledRepo(env: ReturnType<typeof createTestEnv>): Promise<void> {
  await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" }, default_branch: "main" }, 555);
  await upsertRepoFocusManifest(env, REPO, { repoDocGeneration: { enabled: true } });
  await seedChunk(env, "src/widget.ts", "export function widget() {}");
  await seedChunk(env, "package.json", JSON.stringify({ scripts: { build: "tsc" } }));
}

const TOKEN_URL = /\/access_tokens$/;

describe("getLastRepoDocRefreshAttemptedAt (#3003)", () => {
  it("returns null when a repo has never been attempted", async () => {
    const env = createTestEnv();
    expect(await getLastRepoDocRefreshAttemptedAt(env, REPO)).toBeNull();
  });
});

describe("getLastRepoDocRefreshAttemptedAtBulk (#3202 — N+1 fix)", () => {
  it("returns an empty map without querying the DB for an empty repo list", async () => {
    const env = createTestEnv();
    expect(await getLastRepoDocRefreshAttemptedAtBulk(env, [])).toEqual(new Map());
  });

  it("resolves attempted repos in one call and omits a repo that was never attempted", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "attempted", full_name: "owner/attempted", private: false, owner: { login: "owner" } });
    // repoDocGeneration stays disabled -- performRepoDocRefresh still records an attempt marker on decline.
    const result = await performRepoDocRefresh(env, "owner/attempted");
    expect(result.opened).toBe(false);
    const attemptedAt = await getLastRepoDocRefreshAttemptedAt(env, "owner/attempted");

    const bulk = await getLastRepoDocRefreshAttemptedAtBulk(env, ["owner/attempted", "owner/never-attempted"]);
    expect(bulk.get("owner/attempted")?.generatedAt).toBe(attemptedAt);
    expect(bulk.has("owner/never-attempted")).toBe(false);
  });
});

describe("performRepoDocRefresh (#3003)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the repo's action mode, calls openRepoDocPullRequest, and records the attempt regardless of outcome", async () => {
    const env = envWithKey();
    await seedInstalledEnabledRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/") && method === "GET") return new Response("not found", { status: 404 });
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 91, html_url: "https://github.com/owner/widgets/pull/91" });
      return new Response("unexpected", { status: 500 });
    });

    expect(await getLastRepoDocRefreshAttemptedAt(env, REPO)).toBeNull();
    const result = await performRepoDocRefresh(env, REPO);
    expect(result).toEqual({ opened: true, reused: false, pullNumber: 91, url: "https://github.com/owner/widgets/pull/91", claudeMode: "symlink" });

    const attemptedAt = await getLastRepoDocRefreshAttemptedAt(env, REPO);
    expect(attemptedAt).not.toBeNull();
    expect(Number.isFinite(Date.parse(attemptedAt!))).toBe(true);
  });

  it("uses the requested repo name when no installed repository can be canonicalized", async () => {
    const env = createTestEnv();

    const result = await performRepoDocRefresh(env, "Owner/Missing");

    expect(result).toEqual({ opened: false, reason: "repository is not installed" });
    expect(await getLastRepoDocRefreshAttemptedAt(env, "Owner/Missing")).not.toBeNull();
  });

  it("records an attempt even when the repo declines (e.g. generation disabled)", async () => {
    const env = envWithKey();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" } }, 555);
    // repoDocGeneration is NOT enabled for this repo.
    const result = await performRepoDocRefresh(env, REPO);
    expect(result).toEqual({ opened: false, reason: "repo-doc generation is not enabled for this repository (.gittensory.yml repoDocGeneration.enabled)" });
    expect(await getLastRepoDocRefreshAttemptedAt(env, REPO)).not.toBeNull();
  });

  it("resolves agent-paused mode from repository settings before delegating (dry-run instances never write)", async () => {
    const env = envWithKey();
    await seedInstalledEnabledRepo(env);
    await upsertRepositorySettings(env, { repoFullName: REPO, agentPaused: true });
    let tokenMinted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) tokenMinted = true;
      return new Response("unexpected", { status: 500 });
    });
    const result = await performRepoDocRefresh(env, REPO);
    expect(result).toEqual({ opened: false, reason: 'repo-doc pull request not opened: action mode is "paused"' });
    expect(tokenMinted).toBe(false);
  });

  it("uses the stored repository casing for settings before opening repo-doc pull requests", async () => {
    const env = envWithKey();
    await seedInstalledEnabledRepo(env);
    await upsertRepositorySettings(env, { repoFullName: REPO, agentPaused: true });
    let tokenMinted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) tokenMinted = true;
      return new Response("unexpected", { status: 500 });
    });

    const result = await performRepoDocRefresh(env, "Owner/Widgets");

    expect(result).toEqual({ opened: false, reason: 'repo-doc pull request not opened: action mode is "paused"' });
    expect(tokenMinted).toBe(false);
    expect(await getLastRepoDocRefreshAttemptedAt(env, REPO)).not.toBeNull();
    expect(await getLastRepoDocRefreshAttemptedAt(env, "Owner/Widgets")).toBeNull();
  });
});
