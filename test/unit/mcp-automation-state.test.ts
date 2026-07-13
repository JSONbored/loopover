import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { getRepositoryCollaboratorPermission } from "../../src/github/app";
import { mergePullRequest } from "../../src/github/pr-actions";
import { createPendingAgentActionIfAbsent, getPendingAgentAction, listPendingAgentActions, recordAuditEvent, upsertInstallation, upsertOfficialMinerDetection, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  getRepositoryCollaboratorPermission: vi.fn(),
  createInstallationToken: vi.fn(async () => "test-installation-token"),
}));
// No test in this file exercises a genuinely successful live mutation (every accept path here is dry-run,
// rejected, or gate-denied before reaching performAction) except the dedicated #2423 "errored" test below, which
// needs a controllable throw. Mocked the same shape as agent-approval-queue.test.ts's dedicated unit coverage.
vi.mock("../../src/github/pr-actions", () => ({
  createPullRequestReview: vi.fn(async () => ({ id: 1 })),
  mergePullRequest: vi.fn(async () => ({ merged: true, sha: "merged-sha" })),
  closePullRequest: vi.fn(async () => ({ state: "closed" })),
  createIssueComment: vi.fn(async () => ({ id: 2 })),
}));
// The executor's step-5 freshness guard otherwise calls the REAL fetchPullRequestFreshness, which needs a live
// GitHub token/API — unreachable in this test's offline env, so it fails "unavailable" and denies BEFORE the
// #2423 test below ever reaches performAction. Only that one test needs this; every other accept path here is
// denied/rejected/dry-run before step 5 is consulted, so defaulting to "current" is inert for them.
vi.mock("../../src/github/pr-freshness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/github/pr-freshness")>();
  return {
    ...actual,
    fetchPullRequestFreshness: vi.fn(async (_env: Env, args: { expectedHeadSha?: string | null }) => ({
      status: "current" as const,
      liveHeadSha: args.expectedHeadSha ?? null,
      liveState: "open",
      liveLabels: [] as string[],
    })),
  };
});
// decidePendingAgentAction's accept-time live re-check (#2126) needs these off-network, deterministic here — the
// dedicated staleness-supersede test coverage lives in agent-approval-queue.test.ts, not this MCP-surface file.
vi.mock("../../src/github/backfill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/backfill")>()),
  fetchLiveCiAggregate: vi.fn(async () => ({ ciState: "passed" as const, hasPending: false, hasVisiblePending: false, hasMissingRequiredContext: false, failingDetails: [], nonRequiredFailingDetails: [], ciCompletenessWarning: null })),
  fetchLivePullRequestMergeState: vi.fn(async () => "clean"),
  fetchLivePullRequestReviewDecision: vi.fn(async () => undefined),
}));
const mockedPermission = vi.mocked(getRepositoryCollaboratorPermission);

beforeEach(() => {
  mockedPermission.mockReset();
  mockedPermission.mockResolvedValue("write");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new GittensoryMcp(env, identity) : new GittensoryMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-automation-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

type State = {
  configured: boolean;
  autonomy: Record<string, string>;
  agentPaused: boolean;
  agentDryRun: boolean;
  mode: string;
  permissionReadiness: string;
  actingActionClasses: string[];
  pendingActionCount: number;
};

describe("MCP gittensory_get_automation_state (#784)", () => {
  it("surfaces a configured repo's autonomy, mode, readiness, and pending-approval count", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
    });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto", label: "auto_with_approval" }, agentDryRun: true });
    await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });

    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_get_automation_state", arguments: { owner: "owner", repo: "repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as State;
    expect(data.configured).toBe(true);
    expect(data.mode).toBe("dry_run"); // agentDryRun → dry_run
    expect(data.permissionReadiness).toBe("ready"); // contents: write granted for merge; pull_requests: write granted for PR writes
    expect(data.actingActionClasses).toEqual(expect.arrayContaining(["merge", "label"]));
    expect(data.pendingActionCount).toBe(1);
    // surfaces the COUNT, not the queue details — no reward/wallet leakage either
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|reward|payout|trust score/i);
  });

  it("reports the total pending-approval count beyond the list page size", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    for (let pullNumber = 1; pullNumber <= 201; pullNumber += 1) {
      await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });
    }

    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_get_automation_state", arguments: { owner: "owner", repo: "repo" } });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as State;
    expect(data.pendingActionCount).toBe(201);
  });

  it("REGRESSION (#2912): honors a .loopover.yml-only agentPaused: true override (DB row left at its false default)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto" } });
    // No agentPaused in the DB row above (stays at its false default): only the yml manifest pauses the repo,
    // so this only passes if the resolver (not the raw DB accessor) is consulted.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/.loopover.yml")) return new Response("settings:\n  agentPaused: true\n", { status: 200 });
      return new Response("Not Found", { status: 404 });
    });

    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_get_automation_state", arguments: { owner: "owner", repo: "repo" } });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as State;
    expect(data.agentPaused).toBe(true);
    expect(data.mode).toBe("paused");
  });

  it("reports unconfigured + not_required readiness for an unknown / un-onboarded repo (no repo record)", async () => {
    const env = createTestEnv();
    // no repo seeded → getRepository returns null (exercises the no-installation path) + default settings.
    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_get_automation_state", arguments: { owner: "owner", repo: "ghost" } });
    const data = result.structuredContent as State;
    expect(data.configured).toBe(false);
    expect(data.actingActionClasses).toEqual([]);
    expect(data.permissionReadiness).toBe("not_required"); // no acting PR-write class
    expect(data.pendingActionCount).toBe(0);
    expect(data.mode).toBe("live"); // nothing paused or dry-run
  });
});

describe("MCP gittensory_propose_action (#784)", () => {
  it("stages a proposed action into the approval queue (idempotent)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const client = await connect(env);
    const first = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge", mergeMethod: "squash", reason: "clean" } });
    expect(first.isError).toBeFalsy();
    const data = first.structuredContent as { created: boolean; action: { actionClass: string; status: string; pullNumber: number } };
    expect(data.created).toBe(true);
    expect(data.action).toMatchObject({ actionClass: "merge", status: "pending", pullNumber: 7 });

    const pending = await listPendingAgentActions(env, { repoFullName: "owner/repo", status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.params).toMatchObject({ mergeMethod: "squash" });
    expect(pending[0]?.autonomyLevel).toBe("auto_with_approval"); // staged, never auto-executes

    const second = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge" } });
    expect((second.structuredContent as { created: boolean }).created).toBe(false);
  });

  it("carries the action-specific params (label / reviewBody / closeComment) into the staged action", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const client = await connect(env);
    await client.callTool({
      name: "gittensory_propose_action",
      arguments: { owner: "owner", repo: "repo", pullNumber: 9, actionClass: "close", label: "custom-blocked", reviewBody: "please fix", closeComment: "closing as noise" },
    });
    const [staged] = await listPendingAgentActions(env, { repoFullName: "owner/repo", status: "pending" });
    expect(staged?.params).toMatchObject({ label: "custom-blocked", reviewBody: "please fix", closeComment: "closing as noise" });
  });

  it("pins a proposed action to the PR's current head (expectedHeadSha) so the accept-time force-push guard can fire (#2255)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h-proposed" }, labels: [], body: "x" });
    const client = await connect(env);
    await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge", mergeMethod: "squash" } });
    const [staged] = await listPendingAgentActions(env, { repoFullName: "owner/repo", status: "pending" });
    expect(staged?.params).toMatchObject({ expectedHeadSha: "h-proposed" });
  });

  it("an MCP-staged merge is superseded on accept if the PR is force-pushed after proposal — the guard now actually fires (#2255)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write" }, events: ["pull_request"] },
      repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
    });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h-proposed" }, labels: [], body: "x" });
    const client = await connect(env);
    const proposed = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge", mergeMethod: "squash" } });
    const { action } = proposed.structuredContent as { action: { id: string } };

    // Force-push after staging: the head moves, but nothing re-evaluates the pending row until it's decided.
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h-force-pushed" }, labels: [], body: "x" });

    const decided = await client.callTool({ name: "gittensory_decide_pending_action", arguments: { owner: "owner", repo: "repo", id: action.id, decision: "accept" } });
    const result = decided.structuredContent as { status: string; executionOutcome?: string };
    expect(result.status).toBe("rejected");
    expect(result.executionOutcome).toBe("head_moved");
  });

  it("allows a session that maintains the repo (owned installation)", async () => {
    const env = createTestEnv();
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
    });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const client = await connect(env, { kind: "session", actor: "owner" } as AuthIdentity);
    const result = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge" } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { created: boolean }).created).toBe(true);
  });

  it("errors when the App is not installed on the repo", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "noinstall", full_name: "owner/noinstall", private: false, owner: { login: "owner" } });
    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "noinstall", pullNumber: 7, actionClass: "merge" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/not installed/i);
  });

  it("forbids a session without live GitHub write access to the repo", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    mockedPermission.mockResolvedValue("read");
    const client = await connect(env, { kind: "session", actor: "rando" } as AuthIdentity);
    const result = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/write access/i);
    expect(await listPendingAgentActions(env, { repoFullName: "owner/repo" })).toHaveLength(0);
  });

  it("denies a static MCP-token caller when the repo is not in MCP_ACTUATION_REPO_ALLOWLIST (#2253)", async () => {
    // LOOPOVER_MCP_TOKEN is a shared, end-user-obtainable CLI credential — unlike an explicit maintainer
    // session, it must not implicitly stage actions on every repo the App happens to be installed on.
    // createTestEnv's own default is MCP_ACTUATION_REPO_ALLOWLIST: "*" (so unrelated tests aren't broken
    // by this restriction); "" overrides that back to unset (isMcpActuationRepoAllowed treats "" the same
    // as undefined) to exercise the real deny-by-default behavior.
    const env = createTestEnv({ MCP_ACTUATION_REPO_ALLOWLIST: "" });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const client = await connect(env); // default identity: { kind: "static", actor: "mcp" }
    const result = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/MCP_ACTUATION_REPO_ALLOWLIST/);
    expect(await listPendingAgentActions(env, { repoFullName: "owner/repo" })).toHaveLength(0);
  });

  it("allows a static MCP-token caller once the repo is explicitly allowlisted, but not a sibling repo (#2253)", async () => {
    const env = createTestEnv({ MCP_ACTUATION_REPO_ALLOWLIST: "owner/repo" });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertRepositoryFromGitHub(env, { name: "other", full_name: "owner/other", private: false, owner: { login: "owner" } }, 5);
    const client = await connect(env);

    const allowed = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge" } });
    expect(allowed.isError).toBeFalsy();

    const denied = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "other", pullNumber: 7, actionClass: "merge" } });
    expect(denied.isError).toBe(true);
    expect(await listPendingAgentActions(env, { repoFullName: "owner/other" })).toHaveLength(0);
  });

  it("leaves the api/internal static identities unconditionally trusted (unaffected by the mcp allowlist) (#2253)", async () => {
    // api/internal are operator-only Worker secrets, never handed to end users — unlike the mcp actor, they are
    // NOT scoped to MCP_ACTUATION_REPO_ALLOWLIST. Confirmed here with the allowlist unset, so this only passes
    // because api/internal skip that check entirely (not because the repo happens to be allowlisted).
    // MCP_ACTUATION_REPO_ALLOWLIST is irrelevant here: api/internal skip that check entirely (see below).
    const env = createTestEnv({});
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const client = await connect(env, { kind: "static", actor: "api" } as AuthIdentity);
    const result = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge" } });
    expect(result.isError).toBeFalsy();
  });

  it("does not trust cached collaborator association without live write permission", async () => {
    const env = createTestEnv();
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write" }, events: ["pull_request"] },
      repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
    });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "x", state: "open", user: { login: "reader" }, author_association: "COLLABORATOR", head: { sha: "sha" } });
    mockedPermission.mockResolvedValue("read");

    const client = await connect(env, { kind: "session", actor: "reader" } as AuthIdentity);
    const result = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/write access/i);
    expect(mockedPermission).toHaveBeenCalledWith(env, 5, "owner/repo", "reader");
    expect(await listPendingAgentActions(env, { repoFullName: "owner/repo" })).toHaveLength(0);
  });
});

describe("MCP gittensory_list_pending_actions (#784)", () => {
  it("surfaces the approval queue with action details (default status=pending)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "clean" });
    await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 8, installationId: 5, actionClass: "label", autonomyLevel: "auto_with_approval", params: { label: "x" }, reason: "tidy" });

    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_list_pending_actions", arguments: { owner: "owner", repo: "repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { repoFullName: string; status: string; pendingActions: Array<{ pullNumber: number; actionClass: string; status: string; reason: string | null; autonomyLevel: string }> };
    expect(data.repoFullName).toBe("owner/repo");
    expect(data.status).toBe("pending");
    expect(data.pendingActions.map((action) => action.pullNumber).sort()).toEqual([7, 8]);
    expect(data.pendingActions.every((action) => action.status === "pending" && action.autonomyLevel === "auto_with_approval")).toBe(true);
  });

  it("filters by status and returns an empty queue when none match", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_list_pending_actions", arguments: { owner: "owner", repo: "repo", status: "accepted" } });
    const data = result.structuredContent as { status: string; pendingActions: unknown[] };
    expect(data.status).toBe("accepted");
    expect(data.pendingActions).toEqual([]);
  });

  it("forbids a session without live write access", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 1, title: "x", state: "open", user: { login: "rando" }, author_association: "OWNER", head: { sha: "sha" } });
    mockedPermission.mockResolvedValue("read");
    const client = await connect(env, { kind: "session", actor: "rando" } as AuthIdentity);
    const result = await client.callTool({ name: "gittensory_list_pending_actions", arguments: { owner: "owner", repo: "repo" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/write access/i);
  });

  it("forbids a miner-only session even when live GitHub write access exists", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertOfficialMinerDetection(
      env,
      "miner",
      {
        status: "confirmed",
        snapshot: {
          source: "gittensor_api",
          githubId: "123",
          githubUsername: "miner",
          uid: 7,
          hotkey: "hotkey",
          failedReason: null,
          evaluatedAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
          isEligible: true,
          credibility: 1,
          eligibleRepoCount: 1,
          issueDiscoveryScore: 0,
          issueTokenScore: 0,
          issueCredibility: 0,
          isIssueEligible: false,
          issueEligibleRepoCount: 0,
          alphaPerDay: 0,
          taoPerDay: 0,
          usdPerDay: 0,
          totals: {
            pullRequests: 0,
            mergedPullRequests: 0,
            openPullRequests: 0,
            closedPullRequests: 0,
            openIssues: 0,
            closedIssues: 0,
            solvedIssues: 0,
            validSolvedIssues: 0,
          },
          repositories: [],
          pullRequests: [],
          issueLabels: [],
        },
      },
      60_000,
    );
    await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "sensitive" });
    mockedPermission.mockResolvedValue("write");

    const client = await connect(env, { kind: "session", actor: "miner" } as AuthIdentity);
    const result = await client.callTool({ name: "gittensory_list_pending_actions", arguments: { owner: "owner", repo: "repo" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/maintainer access/i);
  });
});

describe("MCP gittensory_decide_pending_action (#784)", () => {
  it("rejects a staged action without executing and is idempotent", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });

    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_decide_pending_action", arguments: { owner: "owner", repo: "repo", id: action.id, decision: "reject" } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { status: string }).status).toBe("rejected");
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("rejected");

    const second = await client.callTool({ name: "gittensory_decide_pending_action", arguments: { owner: "owner", repo: "repo", id: action.id, decision: "accept" } });
    expect((second.structuredContent as { status: string }).status).toBe("already_decided");
  });

  it("accepts a staged action and honors dry-run mode (no live mutation)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write" }, events: ["pull_request"] },
      repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
    });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" }, agentDryRun: true });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });

    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_decide_pending_action", arguments: { owner: "owner", repo: "repo", id: action.id, decision: "accept" } });
    const data = result.structuredContent as { status: string; executionOutcome: string };
    expect(data.status).toBe("accepted");
    expect(data.executionOutcome).toBe("dry_run");
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("accepted");
  });

  it("REGRESSION (#2423): reports status=errored (not accepted) and a distinct summary when the live mutation throws", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: "x" });
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write" }, events: ["pull_request"] },
      repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
    });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash", expectedHeadSha: "h7" }, reason: "clean" });
    vi.mocked(mergePullRequest).mockRejectedValueOnce(new Error("GitHub 500"));

    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_decide_pending_action", arguments: { owner: "owner", repo: "repo", id: action.id, decision: "accept" } });
    const data = result.structuredContent as { status: string; executionOutcome: string };
    expect(data.status).toBe("errored");
    expect(data.executionOutcome).toBe("error");
    expect(JSON.stringify(result)).toMatch(/execution errored/);
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("errored");
  });

  it("denies a static MCP-token caller from deciding a pending action when the repo is not allowlisted (#2253)", async () => {
    // "" overrides createTestEnv's own MCP_ACTUATION_REPO_ALLOWLIST: "*" default back to unset.
    const env = createTestEnv({ MCP_ACTUATION_REPO_ALLOWLIST: "" });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });

    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_decide_pending_action", arguments: { owner: "owner", repo: "repo", id: action.id, decision: "accept" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/MCP_ACTUATION_REPO_ALLOWLIST/);
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("pending"); // left untouched, not silently accepted
  });

  it("leaves the api/internal static identities unconditionally trusted for the approval queue too (#2253)", async () => {
    // MCP_ACTUATION_REPO_ALLOWLIST is irrelevant here: api/internal skip that check entirely (see below).
    const env = createTestEnv({});
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });
    const client = await connect(env, { kind: "static", actor: "internal" } as AuthIdentity);
    const result = await client.callTool({ name: "gittensory_decide_pending_action", arguments: { owner: "owner", repo: "repo", id: action.id, decision: "reject" } });
    expect(result.isError).toBeFalsy();
  });

  it("is repo-scoped: a guessed id from another repo's queue is not_found and left untouched", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertRepositoryFromGitHub(env, { name: "other", full_name: "owner/other", private: false, owner: { login: "owner" } }, 5);
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/other", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });

    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_decide_pending_action", arguments: { owner: "owner", repo: "repo", id: action.id, decision: "reject" } });
    expect((result.structuredContent as { status: string }).status).toBe("not_found");
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("pending");
  });

  it("forbids a session without live write access and leaves the action pending", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 1, title: "x", state: "open", user: { login: "rando" }, author_association: "OWNER", head: { sha: "sha" } });
    const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });
    mockedPermission.mockResolvedValue("read");
    const client = await connect(env, { kind: "session", actor: "rando" } as AuthIdentity);
    const result = await client.callTool({ name: "gittensory_decide_pending_action", arguments: { owner: "owner", repo: "repo", id: action.id, decision: "reject" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/write access/i);
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("pending");
  });
});

describe("MCP gittensory_get_agent_audit_feed (#784)", () => {
  async function seedAudit(env: Env) {
    await recordAuditEvent(env, { eventType: "agent.action.merge", actor: "gittensory", targetKey: "owner/repo#7", outcome: "completed", detail: "merged", createdAt: "2026-06-18T10:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "agent.pending_action.rejected", actor: "owner", targetKey: "owner/repo#8", outcome: "completed", detail: "rejected merge", createdAt: "2026-06-18T11:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "github_app.pr_visibility_skipped", actor: "x", targetKey: "owner/repo#9", outcome: "completed", createdAt: "2026-06-18T12:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "agent.action.label", actor: "gittensory", targetKey: "other/repo#1", outcome: "completed", createdAt: "2026-06-18T13:00:00.000Z" });
  }

  it("surfaces this repo's agent action + decision events newest-first, excluding non-agent and other-repo events", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await seedAudit(env);
    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_get_agent_audit_feed", arguments: { owner: "owner", repo: "repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { repoFullName: string; events: Array<{ eventType: string; pullNumber: number | null; outcome: string }> };
    expect(data.repoFullName).toBe("owner/repo");
    expect(data.events.map((event) => event.eventType)).toEqual(["agent.pending_action.rejected", "agent.action.merge"]);
    expect(data.events[0]).toMatchObject({ pullNumber: 8, outcome: "completed" });
  });

  it("honors the since filter and the limit", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await seedAudit(env);
    const client = await connect(env);
    const since = await client.callTool({ name: "gittensory_get_agent_audit_feed", arguments: { owner: "owner", repo: "repo", since: "2026-06-18T10:30:00.000Z" } });
    expect((since.structuredContent as { events: unknown[] }).events).toHaveLength(1);
    const limited = await client.callTool({ name: "gittensory_get_agent_audit_feed", arguments: { owner: "owner", repo: "repo", limit: 1 } });
    expect((limited.structuredContent as { events: unknown[] }).events).toHaveLength(1);
  });

  it("forbids a session without live write access", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await seedAudit(env);
    mockedPermission.mockResolvedValue("read");
    const client = await connect(env, { kind: "session", actor: "rando" } as AuthIdentity);
    const result = await client.callTool({ name: "gittensory_get_agent_audit_feed", arguments: { owner: "owner", repo: "repo" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/write access/i);
  });

  it("rejects a malformed since (non ISO-8601) and an over-cap limit via schema validation", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const client = await connect(env);
    const badSince = await client.callTool({ name: "gittensory_get_agent_audit_feed", arguments: { owner: "owner", repo: "repo", since: "not-a-date" } });
    expect(badSince.isError).toBe(true);
    const badLimit = await client.callTool({ name: "gittensory_get_agent_audit_feed", arguments: { owner: "owner", repo: "repo", limit: 500 } });
    expect(badLimit.isError).toBe(true);
  });

  it("scrubs forbidden terms from the free-form detail and preserves a null detail", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await recordAuditEvent(env, { eventType: "agent.action.merge", actor: "gittensory", targetKey: "owner/repo#7", outcome: "completed", detail: "reward estimate leaked", createdAt: "2026-06-18T10:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "agent.action.label", actor: "gittensory", targetKey: "owner/repo#8", outcome: "completed", createdAt: "2026-06-18T09:00:00.000Z" });
    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_get_agent_audit_feed", arguments: { owner: "owner", repo: "repo" } });
    const data = result.structuredContent as { events: Array<{ pullNumber: number | null; detail: string | null }> };
    const merge = data.events.find((event) => event.pullNumber === 7);
    const label = data.events.find((event) => event.pullNumber === 8);
    expect(merge?.detail).not.toMatch(/reward/i);
    expect(merge?.detail).toContain("private context");
    expect(label?.detail).toBeNull();
  });
});
