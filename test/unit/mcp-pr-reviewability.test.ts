import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { persistSignalSnapshot, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new LoopoverMcp(env, identity) : new LoopoverMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-reviewability-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: "Add retry to the upload client",
    state: "open",
    user: { login: "contributor" },
    author_association: "CONTRIBUTOR",
    head: { sha: "abc123", ref: "contributor/attempt-1" },
    base: { ref: "main" },
    html_url: "https://github.com/owner/repo/pull/7",
    merged_at: null,
    draft: false,
    mergeable: true,
    body: "Closes #1",
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
    closed_at: null,
    labels: [{ name: "enhancement" }],
    ...overrides,
  };
}

async function seedRepo(env: Env) {
  await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" }, default_branch: "main" });
}

type ReviewabilityResponse = { status: string; source?: string; repoFullName?: string; generatedAt?: string; report?: { generatedAt?: string; pullNumber?: number } };

describe("MCP loopover_get_pr_reviewability (#6154)", () => {
  it("forbids the static mcp identity when the repo is outside MCP_READ_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_pr_reviewability", arguments: { owner: "owner", repo: "repo", number: 7 } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as ReviewabilityResponse).status).toBe("forbidden");
  });

  it("returns not_found when the repository or pull request is missing", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    // Repo present, PR absent → still not_found (the route requires both).
    await seedRepo(env);
    const result = await client.callTool({ name: "loopover_get_pr_reviewability", arguments: { owner: "owner", repo: "repo", number: 404 } });
    expect((result.structuredContent as ReviewabilityResponse).status).toBe("not_found");

    const noRepo = await connect(createTestEnv());
    const missingRepo = await noRepo.callTool({ name: "loopover_get_pr_reviewability", arguments: { owner: "owner", repo: "ghost", number: 7 } });
    expect((missingRepo.structuredContent as ReviewabilityResponse).status).toBe("not_found");
  });

  it("serves the persisted pr-reviewability snapshot before recomputing", async () => {
    const env = createTestEnv();
    await persistSignalSnapshot(env, {
      id: "reviewability-cached",
      signalType: "pr-reviewability",
      targetKey: "owner/repo#7",
      repoFullName: "owner/repo",
      generatedAt: "2026-05-30T00:00:00.000Z",
      // #9517: a persisted pr-reviewability snapshot is always a full PullRequestReviewability --
      // src/api/routes.ts's reviewability route persists the whole computed object, never a partial
      // one -- so the fixture matches that shape now that the tool validates it against a real
      // output schema instead of z.unknown().
      payload: {
        repoFullName: "owner/repo",
        pullNumber: 7,
        generatedAt: "2026-05-30T00:00:00.000Z",
        score: 0.5,
        action: "review_now",
        noiseSources: [],
        whyThisHelps: [],
        maintainerNextSteps: [],
        privateSummary: "cached",
      },
    });
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_pr_reviewability", arguments: { owner: "owner", repo: "repo", number: 7 } });
    const data = result.structuredContent as ReviewabilityResponse;
    expect(data.source).toBe("snapshot");
    expect(data.generatedAt).toBe("2026-05-30T00:00:00.000Z");
    expect(data.report?.pullNumber).toBe(7);
  });

  it("falls back to the payload timestamp for a snapshot row with an empty generated_at", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `insert into signal_snapshots (id, signal_type, target_key, repo_full_name, payload_json, generated_at)
       values ('reviewability-payload-generated', 'pr-reviewability', 'owner/repo#7', 'owner/repo', ?, '')`,
    )
      .bind(
        JSON.stringify({
          repoFullName: "owner/repo",
          pullNumber: 7,
          generatedAt: "2026-05-29T00:00:00.000Z",
          score: 0.5,
          action: "review_now",
          noiseSources: [],
          whyThisHelps: [],
          maintainerNextSteps: [],
          privateSummary: "payload",
        }),
      )
      .run();
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_pr_reviewability", arguments: { owner: "owner", repo: "repo", number: 7 } });
    const data = result.structuredContent as ReviewabilityResponse;
    expect(data.source).toBe("snapshot");
    expect(data.generatedAt).toBe("2026-05-29T00:00:00.000Z");
  });

  it("stamps a current timestamp when a snapshot has neither a row nor a payload generated_at", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `insert into signal_snapshots (id, signal_type, target_key, repo_full_name, payload_json, generated_at)
       values ('reviewability-no-generated', 'pr-reviewability', 'owner/repo#7', 'owner/repo', ?, '')`,
    )
      .bind(
        JSON.stringify({
          repoFullName: "owner/repo",
          pullNumber: 7,
          score: 0.5,
          action: "review_now",
          noiseSources: [],
          whyThisHelps: [],
          maintainerNextSteps: [],
          privateSummary: "no-timestamp",
        }),
      )
      .run();
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_pr_reviewability", arguments: { owner: "owner", repo: "repo", number: 7 } });
    const data = result.structuredContent as ReviewabilityResponse;
    expect(data.source).toBe("snapshot");
    expect(Date.parse(data.generatedAt ?? "")).not.toBeNaN();
  });

  it("computes reviewability from cached metadata for an open PR with a contributor", async () => {
    // Fail every outbound fetch fast so loadContributorFastContext degrades to its offline fallback
    // deterministically instead of reaching for the live GitHub/Gittensor APIs.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const env = createTestEnv();
    await seedRepo(env);
    await upsertPullRequestFromGitHub(env, "owner/repo", prPayload());
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_pr_reviewability", arguments: { owner: "owner", repo: "repo", number: 7 } });
    const data = result.structuredContent as ReviewabilityResponse;
    expect(result.isError).toBeFalsy();
    expect(data.source).toBe("computed");
    expect(data.repoFullName).toBe("owner/repo");
    expect(data.report?.pullNumber).toBe(7);
    expect(typeof data.generatedAt).toBe("string");
  });

  it("computes reviewability when the pull request has no author (skips contributor context)", async () => {
    const env = createTestEnv();
    await seedRepo(env);
    // No `user` on the payload → authorLogin null → the contributor-context branch is skipped, so no fetch runs.
    await upsertPullRequestFromGitHub(env, "owner/repo", prPayload({ number: 8, user: undefined, html_url: "https://github.com/owner/repo/pull/8" }));
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_pr_reviewability", arguments: { owner: "owner", repo: "repo", number: 8 } });
    const data = result.structuredContent as ReviewabilityResponse;
    expect(data.source).toBe("computed");
    expect(data.report?.pullNumber).toBe(8);
  });
});
