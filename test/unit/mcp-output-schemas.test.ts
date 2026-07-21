import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { persistSignalSnapshot, upsertBounty, upsertIssueFromGitHub, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, updatePullRequestSlopAssessment, persistUpstreamRulesetSnapshot } from "../../src/db/repositories";
import { writeLiveOverride, writeShadowOverride, type StorageEnv } from "../../src/review/auto-apply";
import type { AuthIdentity } from "../../src/auth/security";
import { LoopoverMcp } from "../../src/mcp/server";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { REPO_OUTCOME_PATTERNS_SIGNAL } from "../../src/services/repo-outcome-patterns";
import { createTestEnv } from "../helpers/d1";

// Tools that ship an MCP-native output schema so modern clients can validate/render responses.
const TOOLS_WITH_OUTPUT_SCHEMA = [
  "loopover_get_repo_context",
  "loopover_get_maintainer_noise",
  "loopover_get_activation_preview",
  "loopover_get_live_gate_thresholds",
  "loopover_get_gate_config_effective",
  "loopover_get_label_audit",
  "loopover_get_maintainer_lane",
  "loopover_get_repo_onboarding_pack",
  "loopover_get_registration_readiness",
  "loopover_get_config_recommendation",
  "loopover_get_burden_forecast",
  "loopover_get_repo_outcome_patterns",
  "loopover_get_outcome_calibration",
  "loopover_get_contributor_profile",
  "loopover_get_decision_pack",
  "loopover_monitor_open_prs",
  "loopover_explain_repo_decision",
  "loopover_get_issue_quality",
  "loopover_validate_linked_issue",
  "loopover_check_before_start",
  "loopover_find_opportunities",
  "loopover_retrieve_issue_context",
  "loopover_lint_pr_text",
  "loopover_validate_config",
  "loopover_get_registry_changes",
  "loopover_get_registry_snapshot",
  "loopover_get_upstream_drift",
  "loopover_get_upstream_ruleset",
  "loopover_local_status",
  "loopover_remediation_plan",
  "loopover_explain_score_breakdown",
  "loopover_get_eligibility_plan",
  "loopover_simulate_open_pr_pressure",
  "loopover_get_gate_precision",
  "loopover_get_skipped_pr_audit",
];

async function connectTestClient(env: Env = createTestEnv(), identity?: AuthIdentity) {
  const mcpServer = new LoopoverMcp(env, identity).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "loopover-output-schema-test", version: "0.1.0" }, { capabilities: {} });
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


  it("keeps draft PR body MCP text free of private scoring taxonomy", async () => {
    const mcp = new LoopoverMcp(createTestEnv()) as unknown as {
      analyzeLocalBranch: () => Promise<unknown>;
      draftPrBody(input: Record<string, unknown>): Promise<{ summary: string; data: Record<string, unknown> }>;
      toolResult(payload: { summary: string; data: Record<string, unknown> }): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> };
    };
    mcp.analyzeLocalBranch = async () => ({
      repoFullName: "octo/demo",
      prPacket: {
        titleSuggestion: "Fix cache refresh race",
        bodySections: [{ heading: "Changed Paths", lines: ["- src/cache.ts (modified, +12/-3)"] }],
        validationSummary: {
          passed: 1,
          failed: 0,
          notRun: 0,
          commands: [{ command: "npm run test:ci", status: "passed", summary: "all green" }],
        },
        publicSafeWarnings: [],
      },
      baseFreshness: {
        status: "fresh",
        changedFileCount: 1,
        testFileCount: 0,
        warnings: [],
        recommendation: undefined,
      },
      manifestGuidance: { present: false, publicNextSteps: [] },
      preflight: { linkedIssues: [42], collisions: [], reviewBurden: "low" },
    });

    const payload = await mcp.draftPrBody({});
    const result = mcp.toolResult(payload);
    const visibleText = result.content[0]?.text ?? "";
    expect(visibleText).not.toMatch(/private scoreability|score preview|scenario projections|risk signals|score-gate blockers|branch eligibility gate|ranked next actions/i);
    expect(JSON.stringify(result.structuredContent)).not.toMatch(/private scoreability|score preview|risk signals|score-gate blockers|branch eligibility gate|ranked next actions/i);
    expect(visibleText).toContain("internal analysis context omitted");
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

    const repoContext = byName.get("loopover_get_repo_context");
    const repoContextProps = Object.keys((repoContext?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(repoContextProps).toEqual(expect.arrayContaining(["repoFullName", "lane", "queueHealth", "configQuality"]));

    const upstream = byName.get("loopover_get_upstream_drift");
    const upstreamProps = Object.keys((upstream?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(upstreamProps).toEqual(expect.arrayContaining(["status", "highestSeverity"]));

    const localStatus = byName.get("loopover_local_status");
    const localStatusProps = Object.keys((localStatus?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(localStatusProps).toEqual(expect.arrayContaining(["apiAvailable", "supportedEndpoint"]));

    const registryChanges = byName.get("loopover_get_registry_changes");
    const registryChangesProps = Object.keys((registryChanges?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(registryChangesProps).toEqual(expect.arrayContaining(["currentSnapshotId", "previousSnapshotId", "addedRepos", "removedRepos", "changedRepos", "summary"]));
    expect(registryChangesProps).not.toEqual(expect.arrayContaining(["previous", "current", "added", "removed", "changed", "warnings"]));

    const registrySnapshot = byName.get("loopover_get_registry_snapshot");
    const registrySnapshotProps = Object.keys((registrySnapshot?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(registrySnapshotProps).toEqual(expect.arrayContaining(["id", "repoCount", "repositories", "error"]));

    const upstreamRuleset = byName.get("loopover_get_upstream_ruleset");
    const upstreamRulesetProps = Object.keys((upstreamRuleset?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(upstreamRulesetProps).toEqual(expect.arrayContaining(["id", "activeModel", "registryRepoCount", "payload", "error"]));

    const liveGate = byName.get("loopover_get_live_gate_thresholds");
    const liveGateProps = Object.keys((liveGate?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(liveGateProps).toEqual(expect.arrayContaining(["repoFullName", "confidence_floor", "scope_cap_files", "scope_cap_lines", "error"]));

    const gateConfigEffective = byName.get("loopover_get_gate_config_effective");
    const gateConfigEffectiveProps = Object.keys((gateConfigEffective?.outputSchema?.properties ?? {}) as Record<string, unknown>);
    expect(gateConfigEffectiveProps).toEqual(
      expect.arrayContaining(["status", "repoFullName", "effective", "shadowPending"]),
    );
  });

  it("preserves the full tool inventory while adding output schemas", async () => {
    const { client } = await connectTestClient();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));

    // A representative slice of tools without output schemas remains intact.
    expect(names.has("loopover_preflight_pr")).toBe(true);
    expect(names.has("loopover_agent_plan_next_work")).toBe(true);
    expect(names.has("loopover_compare_pr_variants")).toBe(true);
  });
});

// ── Structured content validates against the declared schema ─────────────────────

describe("MCP tool calls return schema-valid structured content", () => {
  it("loopover_local_status returns validated structured content", async () => {
    const { client } = await connectTestClient();
    const result = await client.callTool({ name: "loopover_local_status", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.apiAvailable).toBe(true);
    expect(data.supportedEndpoint).toBe("/v1/local/branch-analysis");
  });

  it("loopover_get_upstream_drift returns validated structured content", async () => {
    const { client } = await connectTestClient();
    const result = await client.callTool({ name: "loopover_get_upstream_drift", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(["current", "drift_detected", "stale", "unavailable"]).toContain(data.status);
  });

  it("loopover_get_registry_changes returns validated structured content", async () => {
    const env = createTestEnv();
    await seedRegistryChangeSnapshots(env);
    const { client } = await connectTestClient(env);
    const result = await client.callTool({ name: "loopover_get_registry_changes", arguments: {} });
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

  it("loopover_get_registry_snapshot returns the latest snapshot when one exists (#7803)", async () => {
    const env = createTestEnv();
    await seedRegistryChangeSnapshots(env);
    const { client } = await connectTestClient(env);
    const result = await client.callTool({ name: "loopover_get_registry_snapshot", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      repoCount: 3,
      source: { kind: "raw-github", url: "fixture://current-registry" },
    });
    expect((result.structuredContent as { repositories: unknown[] }).repositories).toHaveLength(3);
    expect(JSON.stringify(result.structuredContent)).not.toContain("registry_snapshot_not_found");
  });

  it("loopover_get_registry_snapshot returns a normal not-found result when empty (#7803)", async () => {
    const { client } = await connectTestClient(createTestEnv());
    const result = await client.callTool({ name: "loopover_get_registry_snapshot", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ error: "registry_snapshot_not_found" });
  });

  it("loopover_get_upstream_ruleset returns the latest ruleset when one exists (#7807)", async () => {
    const env = createTestEnv();
    await seedUpstreamRulesetSnapshot(env);
    const { client } = await connectTestClient(env);
    const result = await client.callTool({ name: "loopover_get_upstream_ruleset", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      id: "fixture-upstream-ruleset",
      activeModel: "pending_saturation_model",
      registryRepoCount: 1,
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("upstream_ruleset_not_found");
  });

  it("loopover_get_upstream_ruleset returns a normal not-found result when empty (#7807)", async () => {
    const { client } = await connectTestClient(createTestEnv());
    const result = await client.callTool({ name: "loopover_get_upstream_ruleset", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ error: "upstream_ruleset_not_found" });
  });

  it("loopover_get_repo_context returns validated structured content", async () => {
    const { client } = await connectTestClient();
    const result = await client.callTool({ name: "loopover_get_repo_context", arguments: { owner: "octo", repo: "demo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.repoFullName).toBe("octo/demo");
  });

  // Regression test for #2455: api/internal static identities are operator-only Worker secrets (never handed to
  // end users, unlike the shared LOOPOVER_MCP_TOKEN), so canAccessRepo must remain unconditionally trusted for
  // them even with MCP_READ_REPO_ALLOWLIST unset — mirroring the existing api/internal-trusted tests for the
  // write-side MCP_ACTUATION_REPO_ALLOWLIST guards.
  it("loopover_get_repo_context trusts the api static identity unconditionally, regardless of MCP_READ_REPO_ALLOWLIST (#2455)", async () => {
    const { client } = await connectTestClient(createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" }), { kind: "static", actor: "api" });
    const result = await client.callTool({ name: "loopover_get_repo_context", arguments: { owner: "octo", repo: "demo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.repoFullName).toBe("octo/demo");
  });

  // Regression test for #2455: the shared, end-user-obtainable LOOPOVER_MCP_TOKEN must not read an arbitrary
  // repo's context by default.
  it("loopover_get_repo_context forbids the static mcp identity without an MCP_READ_REPO_ALLOWLIST wildcard/scoped opt-in (#2455)", async () => {
    const { client } = await connectTestClient(createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" }));
    const result = await client.callTool({ name: "loopover_get_repo_context", arguments: { owner: "octo", repo: "demo" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/cannot access this repository/i);
  });

  it("loopover_get_repo_context allows the static mcp identity once the repo is explicitly allowlisted (#2455)", async () => {
    const { client } = await connectTestClient(createTestEnv({ MCP_READ_REPO_ALLOWLIST: "octo/demo" }));
    const result = await client.callTool({ name: "loopover_get_repo_context", arguments: { owner: "octo", repo: "demo" } });
    expect(result.isError).toBeFalsy();
  });

  it("loopover_get_maintainer_noise returns a structured noise triage report for a repo", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    await upsertPullRequestFromGitHub(env, "octo/demo", { number: 1, title: "misc cleanup and various refactors", state: "open", user: { login: "alice" }, body: "" });
    const { client } = await connectTestClient(env);
    const result = await client.callTool({ name: "loopover_get_maintainer_noise", arguments: { owner: "octo", repo: "demo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.repoFullName).toBe("octo/demo");
    expect(typeof data.score).toBe("number");
    expect(typeof data.level).toBe("string");
    expect(Array.isArray(data.noiseSources)).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });

  it("loopover_get_activation_preview returns a structured activation preview for a repo (#7799)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    await upsertPullRequestFromGitHub(env, "octo/demo", { number: 1, title: "misc cleanup and various refactors", state: "open", user: { login: "alice" }, body: "" });
    const { client } = await connectTestClient(env);
    const result = await client.callTool({ name: "loopover_get_activation_preview", arguments: { owner: "octo", repo: "demo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.repoFullName).toBe("octo/demo");
    expect(typeof data.evaluatedCount).toBe("number");
    expect(typeof data.aiReviewConfigured).toBe("boolean");
    expect(Array.isArray(data.samples)).toBe(true);
    expect(Array.isArray(data.findingCodeCounts)).toBe(true);
    expect(typeof data.summary).toBe("string");
    expect(JSON.stringify(data)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });

  it("loopover_get_live_gate_thresholds returns authoritative thresholds when a live override exists (#7801)", async () => {
    const env = createTestEnv();
    await writeLiveOverride(env as unknown as StorageEnv, "octo/demo", { confidenceFloor: 0.91, scopeCap: { files: 8, lines: 250 } });
    const { client } = await connectTestClient(env);
    const result = await client.callTool({ name: "loopover_get_live_gate_thresholds", arguments: { owner: "octo", repo: "demo" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      repoFullName: "octo/demo",
      confidence_floor: 0.91,
      scope_cap_files: 8,
      scope_cap_lines: 250,
    });
  });

  it("loopover_get_live_gate_thresholds returns a normal not-found result when empty (#7801)", async () => {
    const { client } = await connectTestClient(createTestEnv());
    const result = await client.callTool({ name: "loopover_get_live_gate_thresholds", arguments: { owner: "octo", repo: "demo" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ error: "live_gate_thresholds_not_found", repoFullName: "octo/demo" });
  });

  it("loopover_get_live_gate_thresholds denies mcp callers outside the read allowlist (#7801)", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    await writeLiveOverride(env as unknown as StorageEnv, "octo/demo", { confidenceFloor: 0.9 });
    const { client } = await connectTestClient(env);
    const result = await client.callTool({ name: "loopover_get_live_gate_thresholds", arguments: { owner: "octo", repo: "demo" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "forbidden", repoFullName: "octo/demo" });
  });

  it("loopover_get_gate_config_effective returns empty thresholds when no override is stored (#7800)", async () => {
    const { client } = await connectTestClient(createTestEnv());
    const result = await client.callTool({
      name: "loopover_get_gate_config_effective",
      arguments: { owner: "octo", repo: "demo" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      repoFullName: "octo/demo",
      effective: { confidenceFloor: null, scopeCap: { files: null, lines: null } },
      shadowPending: false,
    });
  });

  it("loopover_get_gate_config_effective returns live override values and shadowPending (#7800)", async () => {
    const env = createTestEnv();
    const storageEnv = env as unknown as StorageEnv;
    await writeLiveOverride(storageEnv, "octo/demo", {
      confidenceFloor: 0.9,
      scopeCap: { files: 12, lines: 400 },
    });
    await writeShadowOverride(storageEnv, "octo/demo", { confidenceFloor: 0.8 }, "2099-01-01T00:00:00.000Z");
    const { client } = await connectTestClient(env);
    const result = await client.callTool({
      name: "loopover_get_gate_config_effective",
      arguments: { owner: "octo", repo: "demo" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      repoFullName: "octo/demo",
      effective: { confidenceFloor: 0.9, scopeCap: { files: 12, lines: 400 } },
      shadowPending: true,
    });
  });

  it("loopover_get_gate_config_effective denies mcp callers outside the read allowlist (#7800)", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    const { client } = await connectTestClient(env);
    const result = await client.callTool({
      name: "loopover_get_gate_config_effective",
      arguments: { owner: "octo", repo: "demo" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "forbidden", repoFullName: "octo/demo" });
  });

  it("loopover_get_activation_preview denies cached member-only session access (#7799)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "private-repo", full_name: "victim-org/private-repo", private: true, owner: { login: "victim-org" }, default_branch: "main" });
    const { client } = await connectTestClient(env, {
      kind: "session",
      actor: "read-only-member",
      session: {
        id: "session-read-only-member",
        tokenHash: "hash",
        login: "read-only-member",
        scopes: [],
        expiresAt: "2999-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      },
    });

    const result = await client.callTool({ name: "loopover_get_activation_preview", arguments: { owner: "victim-org", repo: "private-repo" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("maintainer access is required");
    expect(result.structuredContent).toBeUndefined();
  });

  it("loopover_get_maintainer_noise denies cached member-only session access", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "private-repo", full_name: "victim-org/private-repo", private: true, owner: { login: "victim-org" }, default_branch: "main" });
    await upsertPullRequestFromGitHub(env, "victim-org/private-repo", {
      number: 7,
      title: "cached member evidence",
      state: "open",
      user: { login: "read-only-member" },
      author_association: "MEMBER",
      body: "",
    });
    const { client } = await connectTestClient(env, {
      kind: "session",
      actor: "read-only-member",
      session: {
        id: "session-read-only-member",
        tokenHash: "hash",
        login: "read-only-member",
        scopes: [],
        expiresAt: "2999-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      },
    });

    const result = await client.callTool({ name: "loopover_get_maintainer_noise", arguments: { owner: "victim-org", repo: "private-repo" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("maintainer access is required");
    expect(result.structuredContent).toBeUndefined();
  });

  it("loopover_get_label_audit returns a structured label-policy audit for a repo", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    const { client } = await connectTestClient(env);
    const result = await client.callTool({ name: "loopover_get_label_audit", arguments: { owner: "octo", repo: "demo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.repoFullName).toBe("octo/demo");
    expect(typeof data.trustedPipelineReady).toBe("boolean");
    expect(Array.isArray(data.suspiciousConfiguredLabels)).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });

  it("loopover_get_maintainer_lane returns a structured lane triage report for a repo", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    await upsertPullRequestFromGitHub(env, "octo/demo", { number: 1, title: "Fix retry backoff", state: "open", user: { login: "alice" }, body: "" });
    const { client } = await connectTestClient(env);
    const result = await client.callTool({ name: "loopover_get_maintainer_lane", arguments: { owner: "octo", repo: "demo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.repoFullName).toBe("octo/demo");
    expect(typeof data.maintainerCutConfigured).toBe("boolean");
    expect(data.lane).toBeTruthy();
    expect(data.contributorIntakeHealth).toBeTruthy();
    expect(JSON.stringify(data)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });

  it("loopover_get_repo_onboarding_pack returns a structured preview for an installed repo", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" } }, 501);
    await env.DB.prepare("UPDATE repositories SET is_registered = 1 WHERE full_name = ?").bind("octo/demo").run();
    // Onboarding-pack previews require a maintainer/owner/operator session or a trusted static identity --
    // the shared static "mcp" identity (connectTestClient's default) is unconditionally rejected here, unlike
    // most other read tools, since LOOPOVER_MCP_TOKEN is an end-user-obtainable CLI credential (see
    // requireRepoOnboardingPackAccess, src/mcp/server.ts).
    const { client } = await connectTestClient(env, { kind: "static", actor: "api" });
    const result = await client.callTool({ name: "loopover_get_repo_onboarding_pack", arguments: { owner: "octo", repo: "demo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({
      repoFullName: "octo/demo",
      accepted: true,
      policySource: "policy_compiler",
      preview: { previewOnly: true, publicSafe: true },
    });
  });

  it("loopover_validate_linked_issue reports multiplier eligibility for an uncached issue", async () => {
    const { client } = await connectTestClient();
    const result = await client.callTool({ name: "loopover_validate_linked_issue", arguments: { owner: "octo", repo: "demo", issueNumber: 1 } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.status).toBe("ok");
    expect(data.repoFullName).toBe("octo/demo");
    expect(data.issueNumber).toBe(1);
    expect(data.found).toBe(false);
    expect(data.multiplierWouldApply).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });

  it("loopover_validate_linked_issue reports the multiplier would apply for a clean open issue", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    await upsertIssueFromGitHub(env, "octo/demo", { number: 5, title: "Fix flaky retry backoff", state: "open", user: { login: "reporter" }, labels: [], body: "Reproduction steps and expected behaviour are described in detail." });
    const { client } = await connectTestClient(env);
    const result = await client.callTool({
      name: "loopover_validate_linked_issue",
      arguments: { owner: "octo", repo: "demo", issueNumber: 5, plannedChange: { title: "Fix retry backoff", changedFiles: ["src/queue.ts"] } },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.found).toBe(true);
    expect(data.multiplierWouldApply).toBe(true);
    expect(data.multiplierStatus).toBe("validated");
    expect(data.blockingReason).toBeUndefined();
  });

  it("loopover_check_before_start returns a recommendation for a clean repo", async () => {
    const { client } = await connectTestClient();
    const result = await client.callTool({ name: "loopover_check_before_start", arguments: { owner: "octo", repo: "demo", issueNumber: 1 } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.status).toBe("ok");
    expect(data.repoFullName).toBe("octo/demo");
    expect(["go", "raise", "avoid"]).toContain(data.recommendation);
    expect(data.found).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });

  it("loopover_remediation_plan returns validated structured content", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    const { client } = await connectTestClient(env);
    const result = await client.callTool({
      name: "loopover_remediation_plan",
      arguments: {
        login: "octo",
        repoFullName: "octo/demo",
        branchName: "feat/demo",
        title: "Demo branch",
        changedFiles: [{ path: "src/demo.ts", additions: 10, deletions: 1 }],
        validation: [{ command: "npm test", status: "failed" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.repoFullName).toBe("octo/demo");
    expect(data.login).toBe("octo");
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.summary).toBe("string");
  });

  it("loopover_explain_score_breakdown returns validated structured content", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    const { client } = await connectTestClient(env);
    const result = await client.callTool({
      name: "loopover_explain_score_breakdown",
      arguments: {
        repoFullName: "octo/demo",
        contributorLogin: "octo",
        sourceTokenScore: 40,
        totalTokenScore: 60,
        sourceLines: 80,
        openPrCount: 0,
        credibility: 1,
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.repoFullName).toBe("octo/demo");
    expect(Array.isArray(data.components)).toBe(true);
    expect(data.highestLeverageLever).toBeTruthy();
  });

  it("loopover_explain_score_breakdown applies trusted open-issue counts", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    for (const number of [1, 2, 3]) {
      await upsertIssueFromGitHub(env, "octo/demo", {
        number,
        title: `Open contributor issue ${number}`,
        state: "open",
        user: { login: "alice" },
        labels: [],
        body: "Issue body",
      });
    }
    await upsertIssueFromGitHub(env, "octo/other", {
      number: 99,
      title: "Other repo issue",
      state: "open",
      user: { login: "alice" },
      labels: [],
      body: "Issue body",
    });
    await upsertIssueFromGitHub(env, "octo/demo", {
      number: 4,
      title: "Closed contributor issue",
      state: "closed",
      user: { login: "alice" },
      labels: [],
      body: "Issue body",
    });

    const { client } = await connectTestClient(env);
    const result = await client.callTool({
      name: "loopover_explain_score_breakdown",
      arguments: {
        repoFullName: "octo/demo",
        contributorLogin: "alice",
        sourceTokenScore: 40,
        totalTokenScore: 60,
        sourceLines: 80,
        openPrCount: 0,
        credibility: 1,
      },
    });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.effectiveEstimatedScore).toBe(0);
    expect(data.gateHighlights).toEqual(
      expect.arrayContaining([expect.objectContaining({ gate: "open_issue_threshold" })]),
    );
  });

  it("loopover_explain_score_breakdown requires contributorLogin", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    const { client } = await connectTestClient(env);
    const result = await client.callTool({
      name: "loopover_explain_score_breakdown",
      arguments: { repoFullName: "octo/demo", sourceTokenScore: 40, totalTokenScore: 60, sourceLines: 80 },
    });
    expect(result.isError).toBe(true);
  });

  it("loopover_get_eligibility_plan returns validated structured content", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    const { client } = await connectTestClient(env);
    const result = await client.callTool({
      name: "loopover_get_eligibility_plan",
      arguments: {
        repoFullName: "octo/demo",
        linkedIssueMode: "none",
        sourceTokenScore: 40,
        totalTokenScore: 60,
        sourceLines: 80,
        credibility: 1,
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.eligible).toBe(true); // not_required + confirmed branch is eligible (#7809)
    expect(data.linkedIssueStatus).toBe("not_required");
    expect(data.branchEligibilityStatus).toBe("not_required");
    expect(Array.isArray(data.blockers)).toBe(true);
    expect(Array.isArray(data.cleanupPaths)).toBe(true);
    expect(typeof data.publicSummary).toBe("string");
  });

  it("loopover_lint_pr_text returns a deterministic verdict and fixes", async () => {
    const { client } = await connectTestClient();
    const weak = await client.callTool({ name: "loopover_lint_pr_text", arguments: { commitMessages: ["wip"], prBody: "" } });
    expect(weak.isError).toBeFalsy();
    const weakData = weak.structuredContent as Record<string, unknown>;
    expect(weakData.verdict).toBe("weak");
    expect(Array.isArray(weakData.fixes)).toBe(true);
    expect(JSON.stringify(weakData)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);

    const strong = await client.callTool({
      name: "loopover_lint_pr_text",
      arguments: {
        commitMessages: ["feat(api): add cursor pagination to the labels endpoint for large repositories"],
        prBody: "Adds cursor-based pagination to the labels endpoint so labels beyond the first cached page are returned. Tested with vitest.",
        linkedIssue: 160,
      },
    });
    expect((strong.structuredContent as Record<string, unknown>).verdict).toBe("strong");
  });

  it("loopover_validate_config returns normalized manifest fields and status arms", async () => {
    const { client } = await connectTestClient();
    const ok = await client.callTool({
      name: "loopover_validate_config",
      arguments: { content: "wantedPaths:\n  - src/\n" },
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ status: "ok", present: true, warnings: [] });
    expect((ok.structuredContent as Record<string, unknown>).normalized).toMatchObject({ wantedPaths: ["src/"] });

    const warn = await client.callTool({
      name: "loopover_validate_config",
      arguments: { content: "gate:\n  pack: not-real\n  enabled: true\n" },
    });
    expect(warn.isError).toBeFalsy();
    expect((warn.structuredContent as Record<string, unknown>).status).toBe("warn");

    const error = await client.callTool({
      name: "loopover_validate_config",
      arguments: { content: "{ not: valid json" },
    });
    expect(error.isError).toBeFalsy();
    expect((error.structuredContent as Record<string, unknown>).status).toBe("error");
    expect(JSON.stringify(error.structuredContent)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });

  it("loopover_get_repo_outcome_patterns reports not-found, computed, and cached outcomes", async () => {
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

    const missing = await client.callTool({ name: "loopover_get_repo_outcome_patterns", arguments: { owner: "ghost", repo: "missing" } });
    expect(missing.isError).toBeFalsy();
    expect(missing.structuredContent).toMatchObject({ status: "not_found", repoFullName: "ghost/missing" });

    const computed = await client.callTool({ name: "loopover_get_repo_outcome_patterns", arguments: { owner: "owner", repo: "computed" } });
    expect(computed.isError).toBeFalsy();
    expect(computed.structuredContent).toMatchObject({ status: "ready", source: "computed", repoFullName: "owner/computed" });

    const cached = await client.callTool({ name: "loopover_get_repo_outcome_patterns", arguments: { owner: "owner", repo: "cached" } });
    expect(cached.isError).toBeFalsy();
    expect(cached.structuredContent).toMatchObject({ status: "ready", source: "snapshot", freshness: "fresh", repoFullName: "owner/cached" });
  });

  it("loopover_get_outcome_calibration returns structured slop calibration for a repo", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    await upsertPullRequestFromGitHub(env, "octo/demo", {
      number: 1,
      title: "merged clean",
      state: "closed",
      user: { login: "alice" },
      merged_at: "2026-06-01T00:00:00.000Z",
    });
    await updatePullRequestSlopAssessment(env, "octo/demo", 1, { slopRisk: 0, slopBand: "clean" });
    const { client } = await connectTestClient(env);
    const result = await client.callTool({
      name: "loopover_get_outcome_calibration",
      arguments: { owner: "octo", repo: "demo", windowDays: 30 },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.repoFullName).toBe("octo/demo");
    expect(data.windowDays).toBe(30);
    expect(data.slop).toBeTruthy();
    expect(data.recommendations).toBeTruthy();
    expect(Array.isArray(data.signals)).toBe(true);
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

    for (const name of ["loopover_local_status", "loopover_get_upstream_drift", "loopover_get_upstream_ruleset", "loopover_get_registry_changes", "loopover_get_registry_snapshot"]) {
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

async function seedUpstreamRulesetSnapshot(env: Env) {
  await persistUpstreamRulesetSnapshot(env, {
    id: "fixture-upstream-ruleset",
    sourceRepo: "entrius/gittensor",
    sourceRef: "test",
    commitSha: "fixture-commit",
    sourceSnapshotIds: [],
    activeModel: "pending_saturation_model",
    registryRepoCount: 1,
    totalEmissionShare: 0.01,
    semanticHash: "fixture-semantic-hash",
    payload: {
      registry: {
        repoCount: 1,
        totalEmissionShare: 0.01,
        repositories: [],
      },
    },
    warnings: [],
    generatedAt: "2026-05-30T00:00:00.000Z",
  });
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

function stubMcpSchemaValidationNetwork(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (/^https:\/\/api\.github\.com\/users\/[^/]+\/repos(?:\?|$)/.test(url)) {
      return Response.json([{ language: "TypeScript" }]);
    }
    if (/^https:\/\/api\.github\.com\/users\/[^/?#]+(?:[?#]|$)/.test(url)) {
      return Response.json({
        login: "oktofeesh1",
        name: "Okto",
        public_repos: 1,
        followers: 1,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2026-06-14T00:00:00Z",
      });
    }
    if (url === "https://api.gittensor.io/miners") return Response.json([]);
    if (url.startsWith("https://raw.githubusercontent.com/")) return new Response("not found", { status: 404 });
    return Response.json({}, { status: 404 });
  });
}

// ── #550: the previously-unschematized tools are now call-tested so a future schema/type mismatch
//    (which surfaces as an "Output validation error" → isError) can't slip through CI. ─────────────
describe("MCP output schemas validate on real tool calls (#550)", () => {
  it("every newly-schematized tool returns schema-valid structured content", async () => {
    stubMcpSchemaValidationNetwork();
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
      ["loopover_preflight_pr", { repoFullName: "octo/demo", title: "Add pagination" }],
      ["loopover_preflight_local_diff", { repoFullName: "octo/demo", title: "Add pagination" }],
      ["loopover_explain_review_risk", { repoFullName: "octo/demo", title: "Add pagination" }],
      ["loopover_preview_local_pr_score", { repoFullName: "octo/demo" }],
      ["loopover_compare_pr_variants", { variants: [{ repoFullName: "octo/demo" }] }],
      ["loopover_get_bounty_advisory", { id: "octo/demo#1" }],
      ["loopover_preflight_current_branch", local],
      ["loopover_preview_current_branch_score", local],
      ["loopover_rank_local_next_actions", local],
      ["loopover_explain_local_blockers", local],
      ["loopover_prepare_pr_packet", local],
      ["loopover_draft_pr_body", local],
      ["loopover_compare_local_variants", { variants: [local] }],
      ["loopover_agent_plan_next_work", { login: "oktofeesh1" }],
      ["loopover_agent_explain_next_action", { login: "oktofeesh1" }],
      ["loopover_agent_prepare_pr_packet", local],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name} errored: ${JSON.stringify(result.content)}`).toBeFalsy();
      expect(result.structuredContent, `${name} missing structuredContent`).toBeDefined();
    }

    // Stateful agent run lifecycle: start_run mints a run, get_run reads it back.
    const started = await client.callTool({ name: "loopover_agent_start_run", arguments: { objective: "Ship a PR", actorLogin: "oktofeesh1" } });
    expect(started.isError, `agent_start_run errored: ${JSON.stringify(started.content)}`).toBeFalsy();
    const runId = (started.structuredContent as { run?: { id?: string } }).run?.id;
    expect(runId).toBeDefined();
    const fetched = await client.callTool({ name: "loopover_agent_get_run", arguments: { runId } });
    expect(fetched.isError, `agent_get_run errored: ${JSON.stringify(fetched.content)}`).toBeFalsy();
    expect(fetched.structuredContent).toBeDefined();
    vi.unstubAllGlobals();
  }, 30_000);
});

// ── Slop oracle blunting (#mcp-slop-blunt) ────────────────────────────────────

function mockRateLimiter(status: number, body: Record<string, unknown> = {}): NonNullable<Env["RATE_LIMITER"]> {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({
      async fetch(_url: string, _init?: RequestInit) {
        return Response.json(body, { status });
      },
    }),
  } as unknown as NonNullable<Env["RATE_LIMITER"]>;
}

async function callSlopTool(env: Env, toolName: string, args: Record<string, unknown>) {
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client.callTool({ name: toolName, arguments: args });
}

describe("MCP slop oracle blunting", () => {
  const slopArgs = { changedFiles: [{ path: "src/foo.ts", additions: 5 }] };

  it("omits the exact slopRisk score and rubric from loopover_check_slop_risk response", async () => {
    const result = await callSlopTool(createTestEnv(), "loopover_check_slop_risk", slopArgs);
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).not.toHaveProperty("slopRisk");
    expect(data).not.toHaveProperty("rubric");
    expect(data).toHaveProperty("band");
    expect(data).toHaveProperty("findings");
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).not.toMatch(/\/100/);
  });

  it("omits the exact slopRisk score and rubric from loopover_check_issue_slop response", async () => {
    const result = await callSlopTool(createTestEnv(), "loopover_check_issue_slop", { title: "Fix bug", body: "Description." });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).not.toHaveProperty("slopRisk");
    expect(data).not.toHaveProperty("rubric");
    expect(data).toHaveProperty("band");
  });

  it("skips the tool rate-limit when RATE_LIMITER is absent (test/local env)", async () => {
    // createTestEnv() has no RATE_LIMITER — enforceToolRateLimit must return early without throwing.
    const result = await callSlopTool(createTestEnv(), "loopover_check_slop_risk", slopArgs);
    expect(result.isError).toBeFalsy();
  });

  it("allows the call when the tool rate-limit returns 200", async () => {
    const env = createTestEnv({ RATE_LIMITER: mockRateLimiter(200, { allowed: true, remaining: 19 }) });
    const result = await callSlopTool(env, "loopover_check_slop_risk", slopArgs);
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Record<string, unknown>).band).toBeDefined();
  });

  it("returns an error when the tool rate-limit returns 429", async () => {
    const env = createTestEnv({ RATE_LIMITER: mockRateLimiter(429, { retryAfterSeconds: 42 }) });
    const result = await callSlopTool(env, "loopover_check_slop_risk", slopArgs);
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toMatch(/rate limit exceeded/i);
  });
});
