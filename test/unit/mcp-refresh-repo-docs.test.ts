import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

const REPO = "owner/widgets";
const [PROJECT, CHUNK_REPO] = ["owner", "widgets"];
const TOKEN_URL = /\/access_tokens$/;

function generateRsaPrivateKeyPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey;
}

function envWithKey(overrides: Record<string, string> = {}) {
  return createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), ...overrides });
}

async function seedChunk(env: ReturnType<typeof createTestEnv>, path: string, text: string): Promise<void> {
  await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)").bind(`${path}::0`, PROJECT, CHUNK_REPO, path, 0, "code", text).run();
}

async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new GittensoryMcp(env, identity) : new GittensoryMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-refresh-repo-docs-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP gittensory_refresh_repo_docs (#3003)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens a repo-doc pull request for an enabled, eligible repo", async () => {
    const env = envWithKey();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" }, default_branch: "main" }, 555);
    await upsertRepoFocusManifest(env, REPO, { repoDocGeneration: { enabled: true } });
    await seedChunk(env, "src/widget.ts", "export function widget() {}");
    await seedChunk(env, "package.json", JSON.stringify({ scripts: { build: "tsc" } }));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/") && method === "GET") return new Response("not found", { status: 404 });
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 101, html_url: "https://github.com/owner/widgets/pull/101" });
      return new Response("unexpected", { status: 500 });
    });

    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_refresh_repo_docs", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ opened: true, reused: false, pullNumber: 101, url: "https://github.com/owner/widgets/pull/101" });
  });

  it("reports the already-open PR when one exists on the repo-doc branch", async () => {
    const env = envWithKey();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" }, default_branch: "main" }, 555);
    await upsertRepoFocusManifest(env, REPO, { repoDocGeneration: { enabled: true } });
    await seedChunk(env, "src/widget.ts", "export function widget() {}");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      if (url.includes("/pulls?") && method === "GET") return Response.json([{ number: 55, html_url: "https://github.com/owner/widgets/pull/55" }]);
      return new Response("unexpected", { status: 500 });
    });

    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_refresh_repo_docs", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ opened: true, reused: true, pullNumber: 55, url: "https://github.com/owner/widgets/pull/55" });
  });

  it("succeeds the tool call but reports opened: false when repo-doc generation is not enabled", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" } }, 555);
    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_refresh_repo_docs", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ opened: false, reason: "repo-doc generation is not enabled for this repository (.gittensory.yml repoDocGeneration.enabled)" });
  });

  it("denies a static MCP-token caller when the repo is not in MCP_ACTUATION_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_ACTUATION_REPO_ALLOWLIST: "" });
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" } }, 555);
    const client = await connect(env); // default identity: { kind: "static", actor: "mcp" }
    const result = await client.callTool({ name: "gittensory_refresh_repo_docs", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/MCP_ACTUATION_REPO_ALLOWLIST/);
  });

  it("leaves the api static identity unconditionally trusted (unaffected by the mcp allowlist)", async () => {
    const env = createTestEnv({ MCP_ACTUATION_REPO_ALLOWLIST: "" });
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" } }, 555);
    const client = await connect(env, { kind: "static", actor: "api" } as AuthIdentity);
    const result = await client.callTool({ name: "gittensory_refresh_repo_docs", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ opened: false });
  });
});
