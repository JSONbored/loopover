import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { persistSignalSnapshot, upsertBounty, upsertIssueFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { GittensoryMcp } from "../../src/mcp/server";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { REPO_OUTCOME_PATTERNS_SIGNAL } from "../../src/services/repo-outcome-patterns";
import { createTestEnv } from "../helpers/d1";

// Tools that ship an MCP-native output schema so modern clients can validate/render responses.
const TOOLS_WITH_OUTPUT_SCHEMA = [
  "gittensory_get_repo_context",
  "gittensory_get_burden_forecast",
  "gittensory_get_repo_outcome_patterns",
  "gittensory_get_contributor_profile",
  "gittensory_get_decision_pack",
  "gittensory_monitor_open_prs",
  "gittensory_explain_repo_decision",
  "gittensory_get_issue_quality",
  "gittensory_validate_linked_issue",
  "gittensory_check_before_start",
  "gittensory_lint_pr_text",
  "gittensory_get_registry_changes",
  "gittensory_get_upstream_drift",
  "gittensory_local_status",
];

async function connectTestClient(env: Env = createTestEnv()) {
  const mcpServer = new GittensoryMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "gittensory-output-schema-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, mcpServer };
}

// ── Output schema discovery ────────────────────────────────────────────────────

describe("MCP output schema discovery", () => {
  it("exposes an outputSchema for every covered tool in tools/list", async () => {
    const { client } = await connectTestClient();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const name of TOOLS_WITH_OUTPUT_SCHEMA) {
      const tool = byName.get(name);
      expect(tool, `expected tool "${name}" to be registered`).toBeDefined();
      expect(tool?.outputSchema, `expected tool "${name}" to expose an outputSchema`).toBeDefined();
      expect(tool?.outputSchema?.type).toBe("object");
    }
  });

  it("exposes an outputSchema on EVERY registered tool (#550)", async () => {
    const { client } = await connectTestClient();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const missing = tools.filter((tool) => tool.outputSchema === undefined || tool.outputSchema.type !== "object").map((tool) => tool.name);
    expect(missing, `tools missing a machine-validatable outputSchema: ${missing.join(", ")}`).toEqual([]);
  });

  it("output schemas declare documented top-level properties", async () => {
    const { client } = await connectTestClient();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const repoContext = byName.get("gittensory_get_repo_context");
    const repoContextProps = Object.keys((repoContext?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(repoContextProps).toEqual(expect.arrayContaining(["repoFullName", "lane", "queueHealth", "configQuality"]));

    const upstream = byName.get("gittensory_get_upstream_drift");
    const upstreamProps = Object.keys((upstream?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(upstreamProps).toEqual(expect.arrayContaining(["status", "highestSeverity"]));

    const localStatus = byName.get("gittensory_local_status");
    const localStatusProps = Object.keys((localStatus?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(localStatusProps).toEqual(expect.arrayContaining(["apiAvailable", "supportedEndpoint"]));

    const registryChanges = byName.get("gittensory_get_registry_changes");
    const registryChangesProps = Object.keys((registryChanges?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(registryChangesProps).toEqual(expect.arrayContaining(["currentSnapshotId", "previousSnapshotId", "addedRepos", "removedRepos", "changedRepos", "summary"]));
    expect(registryChangesProps).not.toEqual(expect.arrayContaining(["previous", "current", "added", "removed", "changed", "warnings"]));
  });

  it("preserves the full tool inventory while adding output schemas", async () => {
    const { client } = await connectTestClient();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));

    // A representative slice of tools without output schemas remains intact.
    expect(names.has("gittensory_preflight_pr")).toBe(true);
    expect(names.has("gittensory_agent_plan_next_work")).toBe(true);
    expect(names.has("gittensory_compare_pr_variants")).toBe(true);
  });
});

// ── Structured content validates against the declared schema ─────────────────────

describe("MCP tool calls return schema-valid structured content", () => {
  it("gittensory_local_status returns validated structured content", async () => {
    const { client } = await connectTestClient();
    const result = await client.callTool({ name: "gittensory_local_status", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.apiAvailable).toBe(true);
    expect(data.supportedEndpoint).toBe("/v1/local/branch-analysis");
  });

  it("gittensory_get_upstream_drift returns validated structured content", async () => {
    const { client } = await connectTestClient();
    const result = await client.callTool({ name: "gittensory_get_upstream_drift", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(["current", "drift_detected", "stale", "unavailable"]).toContain(data.status);
  });

  it("gittensory_get_registry_changes returns validated structured content", async () => {
    const env = createTestEnv();
    await seedRegistryChangeSnapshots(env);
    const { client } = await connectTestClient(env);
    const result = await client.callTool({ name: "gittensory_get_registry_changes", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toMatchObject({
      addedRepos: ["owner/added"],
      removedRepos: ["owner/removed"],
      currentSnapshotId: expect.any(String),
      previousSnapshotId: expect.any(String),
      summary: "1 added, 1 removed, 1 changed repo(s) between the latest registry snapshots.",
    });
    expect((result.structuredContent as Record<string, unknown>).changedRepos).toEqual([
      { repoFullName: "owner/changed", changes: ["emission_share 0.01 -> 0.02"] },
    ]);
  });

  it("gittensory_get_repo_context returns validated structured content", async () => {
    const { client } = await connectTestClient();
    const result = await client.callTool({ name: "gittensory_get_repo_context", arguments: { owner: "octo", repo: "demo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.repoFullName).toBe("octo/demo");
  });

  it("gittensory_validate_linked_issue reports multiplier eligibility for an uncached issue", async () => {
    const { client } = await connectTestClient();
    const result = await client.callTool({ name: "gittensory_validate_linked_issue", arguments: { owner: "octo", repo: "demo", issueNumber: 1 } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.status).toBe("ok");
    expect(data.repoFullName).toBe("octo/demo");
    expect(data.issueNumber).toBe(1);
    expect(data.found).toBe(false);
    expect(data.multiplierWouldApply).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });

  it("gittensory_validate_linked_issue reports the multiplier would apply for a clean open issue", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    await upsertIssueFromGitHub(env, "octo/demo", { number: 5, title: "Fix flaky retry backoff", state: "open", user: { login: "reporter" }, labels: [], body: "Reproduction steps and expected behaviour are described in detail." });
    const { client } = await connectTestClient(env);
    const result = await client.callTool({
      name: "gittensory_validate_linked_issue",
      arguments: { owner: "octo", repo: "demo", issueNumber: 5, plannedChange: { title: "Fix retry backoff", changedFiles: ["src/queue.ts"] } },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.found).toBe(true);
    expect(data.multiplierWouldApply).toBe(true);
    expect(data.multiplierStatus).toBe("validated");
    expect(data.blockingReason).toBeUndefined();
  });

  it("gittensory_check_before_start returns a recommendation for a clean repo", async () => {
    const { client } = await connectTestClient();
    const result = await client.callTool({ name: "gittensory_check_before_start", arguments: { owner: "octo", repo: "demo", issueNumber: 1 } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.status).toBe("ok");
    expect(data.repoFullName).toBe("octo/demo");
    expect(["go", "raise", "avoid"]).toContain(data.recommendation);
    expect(data.found).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });

  it("gittensory_lint_pr_text returns a deterministic verdict and fixes", async () => {
    const { client } = await connectTestClient();
    const weak = await client.callTool({ name: "gittensory_lint_pr_text", arguments: { commitMessages: ["wip"], prBody: "" } });
    expect(weak.isError).toBeFalsy();
    const weakData = weak.structuredContent as Record<string, unknown>;
    expect(weakData.verdict).toBe("weak");
    expect(Array.isArray(weakData.fixes)).toBe(true);
    expect(JSON.stringify(weakData)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);

    const strong = await client.callTool({
      name: "gittensory_lint_pr_text",
      arguments: {
        commitMessages: ["feat(api): add cursor pagination to the labels endpoint for large repositories"],
        prBody: "Adds cursor-based pagination to the labels endpoint so labels beyond the first cached page are returned. Tested with vitest.",
        linkedIssue: 160,
      },
    });
    expect((strong.structuredContent as Record<string, unknown>).verdict).toBe("strong");
  });

  it("gittensory_get_repo_outcome_patterns reports not-found, computed, and cached outcomes", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "computed", full_name: "owner/computed", private: false, owner: { login: "owner" }, default_branch: "main" });
    const generatedAt = new Date().toISOString();
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_OUTCOME_PATTERNS_SIGNAL,
      targetKey: "owner/cached",
      repoFullName: "owner/cached",
      payload: repoOutcomePatternsPayload("owner/cached", generatedAt) as unknown as Record<string, never>,
      generatedAt,
    });
    const { client } = await connectTestClient(env);

    const missing = await client.callTool({ name: "gittensory_get_repo_outcome_patterns", arguments: { owner: "ghost", repo: "missing" } });
    expect(missing.isError).toBeFalsy();
    expect(missing.structuredContent).toMatchObject({ status: "not_found", repoFullName: "ghost/missing" });

    const computed = await client.callTool({ name: "gittensory_get_repo_outcome_patterns", arguments: { owner: "owner", repo: "computed" } });
    expect(computed.isError).toBeFalsy();
    expect(computed.structuredContent).toMatchObject({ status: "ready", source: "computed", repoFullName: "owner/computed" });

    const cached = await client.callTool({ name: "gittensory_get_repo_outcome_patterns", arguments: { owner: "owner", repo: "cached" } });
    expect(cached.isError).toBeFalsy();
    expect(cached.structuredContent).toMatchObject({ status: "ready", source: "snapshot", freshness: "fresh", repoFullName: "owner/cached" });
  });
});

// ── Public/private safety ─────────────────────────────────────────────────────

describe("MCP output schemas do not declare private financial fields", () => {
  it("no output schema exposes wallet/hotkey/coldkey/financial property names", async () => {
    const { client } = await connectTestClient();
    const { tools } = await client.listTools();

    for (const tool of tools) {
      if (!tool.outputSchema) continue;
      const serialized = JSON.stringify(tool.outputSchema);
      expect(serialized, `tool "${tool.name}" output schema must not declare private fields`).not.toMatch(
        /hotkey|coldkey|wallet|mnemonic|alphaPerDay|taoPerDay|usdPerDay|rawTrust|privateReviewability/i,
      );
    }
  });

  it("structured content from public-safe tools never includes redacted financial keys", async () => {
    const { client } = await connectTestClient();

    for (const name of ["gittensory_local_status", "gittensory_get_upstream_drift", "gittensory_get_registry_changes"]) {
      const result = await client.callTool({ name, arguments: {} });
      const serialized = JSON.stringify(result.structuredContent ?? {});
      expect(serialized, `tool "${name}" structured content must not leak financial fields`).not.toMatch(
        /hotkey|coldkey|wallet|mnemonic|alphaPerDay|taoPerDay|usdPerDay/i,
      );
    }
  });
});

async function seedRegistryChangeSnapshots(env: Env) {
  await persistRegistrySnapshot(
    env,
    normalizeRegistryPayload(
      {
        "owner/removed": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        "owner/changed": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        "owner/stable": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
      },
      { kind: "raw-github", url: "fixture://old-registry" },
      "2026-05-24T00:00:00.000Z",
    ),
  );
  await persistRegistrySnapshot(
    env,
    normalizeRegistryPayload(
      {
        "owner/added": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        "owner/changed": { emission_share: 0.02, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
        "owner/stable": { emission_share: 0.01, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false },
      },
      { kind: "raw-github", url: "fixture://current-registry" },
      "2026-05-25T00:00:00.000Z",
    ),
  );
}

function repoOutcomePatternsPayload(repoFullName: string, generatedAt: string) {
  return {
    repoFullName,
    generatedAt,
    lane: "direct_pr",
    primaryLanguage: "TypeScript",
    sampleSize: 0,
    totals: { analyzed: 0, merged: 0, closedUnmerged: 0, openActive: 0, openStale: 0, maintainerLanePullRequests: 0, outsideContributorPullRequests: 0 },
    outsideContributorMergeRate: 0,
    maintainerLaneMergeRate: 0,
    dimensions: [],
    successPatterns: [],
    riskPatterns: [],
    evidenceCompleteness: { pullRequestsAnalyzed: 0, withFileDetail: 0, withReviewDetail: 0, withCheckDetail: 0, filesCompletenessRatio: 0, reviewsCompletenessRatio: 0, checksCompletenessRatio: 0, fullyDecidedWithDetail: 0, status: "missing" },
    findings: [],
    summary: "cached fixture",
  };
}

// ── #550: the previously-unschematized tools are now call-tested so a future schema/type mismatch
//    (which surfaces as an "Output validation error" → isError) can't slip through CI. ─────────────
describe("MCP output schemas validate on real tool calls (#550)", () => {
  it("every newly-schematized tool returns schema-valid structured content", async () => {
    const env = createTestEnv();
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "octo/demo": { emission_share: 0.02, issue_discovery_share: 0, label_multipliers: {}, trusted_label_pipeline: false } },
        { kind: "raw-github", url: "fixture://reg" },
        "2026-06-14T00:00:00.000Z",
      ),
    );
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    await upsertBounty(env, { id: "octo/demo#1", repoFullName: "octo/demo", issueNumber: 1, status: "active", payload: {} });
    const { client } = await connectTestClient(env);

    const local = { login: "oktofeesh1", repoFullName: "octo/demo" };
    const calls: Array<[string, Record<string, unknown>]> = [
      ["gittensory_preflight_pr", { repoFullName: "octo/demo", title: "Add pagination" }],
      ["gittensory_preflight_local_diff", { repoFullName: "octo/demo", title: "Add pagination" }],
      ["gittensory_explain_review_risk", { repoFullName: "octo/demo", title: "Add pagination" }],
      ["gittensory_preview_local_pr_score", { repoFullName: "octo/demo" }],
      ["gittensory_compare_pr_variants", { variants: [{ repoFullName: "octo/demo" }] }],
      ["gittensory_get_bounty_advisory", { id: "octo/demo#1" }],
      ["gittensory_preflight_current_branch", local],
      ["gittensory_preview_current_branch_score", local],
      ["gittensory_rank_local_next_actions", local],
      ["gittensory_explain_local_blockers", local],
      ["gittensory_prepare_pr_packet", local],
      ["gittensory_draft_pr_body", local],
      ["gittensory_compare_local_variants", { variants: [local] }],
      ["gittensory_agent_plan_next_work", { login: "oktofeesh1" }],
      ["gittensory_agent_explain_next_action", { login: "oktofeesh1" }],
      ["gittensory_agent_prepare_pr_packet", local],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name} errored: ${JSON.stringify(result.content)}`).toBeFalsy();
      expect(result.structuredContent, `${name} missing structuredContent`).toBeDefined();
    }

    // Stateful agent run lifecycle: start_run mints a run, get_run reads it back.
    const started = await client.callTool({ name: "gittensory_agent_start_run", arguments: { objective: "Ship a PR", actorLogin: "oktofeesh1" } });
    expect(started.isError, `agent_start_run errored: ${JSON.stringify(started.content)}`).toBeFalsy();
    const runId = (started.structuredContent as { run?: { id?: string } }).run?.id;
    expect(runId).toBeDefined();
    const fetched = await client.callTool({ name: "gittensory_agent_get_run", arguments: { runId } });
    expect(fetched.isError, `agent_get_run errored: ${JSON.stringify(fetched.content)}`).toBeFalsy();
    expect(fetched.structuredContent).toBeDefined();
  });
});
