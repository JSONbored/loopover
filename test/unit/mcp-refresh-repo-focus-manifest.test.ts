import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

const REPO = "owner/widgets";

async function connect(env: Env, identity?: AuthIdentity): Promise<Client> {
  const server = (identity ? new LoopoverMcp(env, identity) : new LoopoverMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-refresh-repo-focus-manifest-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

// #9299 — refresh COUNTERPART to the read-only loopover_get_repo_focus_manifest (#7808). Mirrors POST
// /v1/repos/:owner/:repo/focus-manifest/refresh: same loadRepoFocusManifest(..., { refresh: true }) +
// compileFocusManifestPolicy pair, same { repoFullName, manifest, policy } shape, and the write-access boundary
// the REST route enforces (requireRepoManageAccess ≈ requireRepoWriteAccess) — stricter than the read tool.
describe("MCP loopover_refresh_repo_focus_manifest (#9299)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers under the maintainer category, paired with its read sibling", async () => {
    const client = await connect(createTestEnv(), { kind: "static", actor: "api" } as AuthIdentity);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "loopover_refresh_repo_focus_manifest");
    expect(tool).toBeDefined();
    expect(tool?.description ?? "").toMatch(/refresh/i);
    expect((tool?._meta as { category?: string } | undefined)?.category).toBe("maintainer");
    await client.close();
  });

  it("forces a fresh GitHub load (refresh: true) that bypasses the cache and returns manifest + policy", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" } }, 555);
    // Seed a stale api_record a NON-refresh read WOULD return (wantedPaths cached/**), so the assertion below
    // proves the tool ignored the cache and served the live file instead.
    await upsertRepoFocusManifest(env, REPO, { wantedPaths: ["cached/**"] });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("raw.githubusercontent.com") && url.endsWith("/.loopover.yml")) {
        fetched.push(url);
        return new Response(JSON.stringify({ wantedPaths: ["live/**"] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const client = await connect(env, { kind: "static", actor: "api" } as AuthIdentity);
    const result = await client.callTool({ name: "loopover_refresh_repo_focus_manifest", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    // The live raw file WAS fetched — a cached (refresh: false) read would never have hit GitHub.
    expect(fetched.length).toBeGreaterThan(0);
    const data = result.structuredContent as { repoFullName: string; manifest: { wantedPaths: string[] }; policy: unknown };
    expect(data.repoFullName).toBe(REPO);
    // ...and the LIVE content ("live/**"), not the stale cache ("cached/**"), is what came back.
    expect(data.manifest.wantedPaths).toEqual(["live/**"]);
    expect(data.policy).toBeDefined();
    await client.close();
  });

  it("denies a static MCP-token caller when the repo is not in MCP_ACTUATION_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_ACTUATION_REPO_ALLOWLIST: "" });
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" } }, 555);
    const client = await connect(env); // default identity: { kind: "static", actor: "mcp" }
    const result = await client.callTool({ name: "loopover_refresh_repo_focus_manifest", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/MCP_ACTUATION_REPO_ALLOWLIST/);
    await client.close();
  });

  it("rejects a read-only session without write access — distinct from the read tool's weaker boundary", async () => {
    const env = createTestEnv();
    const { session } = await createSessionForGitHubUser(env, { login: "reader1", id: 7 });
    const client = await connect(env, { kind: "session", actor: "reader1", session });
    const result = await client.callTool({ name: "loopover_refresh_repo_focus_manifest", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/write access is required/i);
    await client.close();
  });
});
