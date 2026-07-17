import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #6150: the miner-auto-dev profile's plan-DAG + local-scorer + gate-prediction tools were listed in
// recommendedTools but never actually registered on the local stdio server. These tests drive the real
// stdio server and assert each tool's composed output, plus a zod-rejection failure path per pure tool
// and an API-failure path for the one HTTP-backed tool (loopover_predict_gate).
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

const PLAN_SCORER_TOOLS = ["loopover_run_local_scorer", "loopover_build_plan", "loopover_plan_status", "loopover_record_step_result", "loopover_predict_gate"];

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: unknown }).structuredContent as Record<string, unknown>;
}

describe("loopover-mcp plan-DAG + local-scorer + predict-gate tools (#6150) — pure tools", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let configDir: string;

  async function connect() {
    configDir = mkdtempSync(join(tmpdir(), "loopover-plan-scorer-tools-"));
    transport = new StdioClientTransport({
      command: "node",
      args: [bin, "--stdio"],
      // These 4 pure tools never call the API, but the stdio server still needs a config dir + token to boot.
      env: { ...process.env, LOOPOVER_CONFIG_DIR: configDir, LOOPOVER_TOKEN: "session-token", LOOPOVER_API_TIMEOUT_MS: "5000" },
    });
    client = new Client({ name: "plan-scorer-tools-test", version: "0.0.1" });
    await client.connect(transport);
  }

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  });

  it("registers all 5 tools on the local stdio server", async () => {
    await connect();
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const name of PLAN_SCORER_TOOLS) expect(names, `missing ${name}`).toContain(name);
  });

  it("loopover_run_local_scorer computes source/test/non-code token scores from changed-file metadata", async () => {
    await connect();
    const result = await client.callTool({
      name: "loopover_run_local_scorer",
      arguments: {
        changedFiles: [
          { path: "src/cache.ts", additions: 12, deletions: 2 },
          { path: "test/cache.test.ts", additions: 8, deletions: 0 },
          { path: "README.md", additions: 3, deletions: 0 },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = structured(result);
    expect(data.mode).toBe("external_command");
    expect(data.sourceTokenScore).toBe(14);
    expect(data.testTokenScore).toBe(8);
    expect(data.nonCodeTokenScore).toBe(3);
    expect(data.totalTokenScore).toBe(25);
  });

  it("loopover_run_local_scorer surfaces a validation-failure warning without changing the scores", async () => {
    await connect();
    const result = await client.callTool({
      name: "loopover_run_local_scorer",
      arguments: {
        changedFiles: [{ path: "src/cache.ts", additions: 5, deletions: 0 }],
        validation: [{ command: "npm test", status: "failed" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = structured(result);
    expect(data.sourceTokenScore).toBe(5);
    expect(data.warnings).toEqual(["Local validation reported failures — token scores describe the diff, not a passing build."]);
  });

  it("loopover_run_local_scorer rejects an empty changedFiles array (zod input-schema validation)", async () => {
    await connect();
    const outcome = await client.callTool({ name: "loopover_run_local_scorer", arguments: { changedFiles: [] } }).then(
      (r) => ({ threw: false, isError: Boolean(r.isError) }),
      () => ({ threw: true, isError: true }),
    );
    expect(outcome.isError).toBe(true);
  });

  it("loopover_build_plan normalizes raw steps into a validated DAG with ready steps", async () => {
    await connect();
    const result = await client.callTool({
      name: "loopover_build_plan",
      arguments: {
        steps: [
          { id: "a", title: "Step A" },
          { id: "b", title: "Step B", dependsOn: ["a"] },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = structured(result);
    const plan = data.plan as { steps: Array<{ id: string; status: string; attempts: number; maxAttempts: number }> };
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toMatchObject({ id: "a", status: "pending", attempts: 0, maxAttempts: 1 });
    expect(data.readySteps).toEqual([{ id: "a", title: "Step A" }]);
    expect((data.validation as { valid: boolean }).valid).toBe(true);
  });

  it("loopover_build_plan flags a dependency cycle as invalid, not a thrown error", async () => {
    await connect();
    const result = await client.callTool({
      name: "loopover_build_plan",
      arguments: {
        steps: [
          { id: "a", title: "Step A", dependsOn: ["b"] },
          { id: "b", title: "Step B", dependsOn: ["a"] },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = structured(result);
    const validation = data.validation as { valid: boolean; errors: string[] };
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("plan has a dependency cycle");
  });

  it("loopover_build_plan rejects an empty steps array (zod input-schema validation)", async () => {
    await connect();
    const outcome = await client.callTool({ name: "loopover_build_plan", arguments: { steps: [] } }).then(
      (r) => ({ threw: false, isError: Boolean(r.isError) }),
      () => ({ threw: true, isError: true }),
    );
    expect(outcome.isError).toBe(true);
  });

  it("loopover_plan_status returns progress + ready steps for an in-progress plan", async () => {
    await connect();
    const plan = {
      steps: [
        { id: "a", title: "Step A", dependsOn: [], status: "completed", attempts: 1, maxAttempts: 1 },
        { id: "b", title: "Step B", dependsOn: ["a"], status: "pending", attempts: 0, maxAttempts: 1 },
      ],
    };
    const result = await client.callTool({ name: "loopover_plan_status", arguments: { plan } });
    expect(result.isError).toBeFalsy();
    const data = structured(result);
    expect(data.progress).toMatchObject({ total: 2, completed: 1, pending: 1, status: "pending" });
    expect(data.readySteps).toEqual([{ id: "b", title: "Step B" }]);
  });

  it("loopover_plan_status rejects a plan with an unknown step status (zod input-schema validation)", async () => {
    await connect();
    const badPlan = { steps: [{ id: "a", title: "Step A", dependsOn: [], status: "bogus", attempts: 0, maxAttempts: 1 }] };
    const outcome = await client.callTool({ name: "loopover_plan_status", arguments: { plan: badPlan } }).then(
      (r) => ({ threw: false, isError: Boolean(r.isError) }),
      () => ({ threw: true, isError: true }),
    );
    expect(outcome.isError).toBe(true);
  });

  it("loopover_record_step_result records a completed step and advances readiness to the next step", async () => {
    await connect();
    const plan = {
      steps: [
        { id: "a", title: "Step A", dependsOn: [], status: "pending", attempts: 0, maxAttempts: 1 },
        { id: "b", title: "Step B", dependsOn: ["a"], status: "pending", attempts: 0, maxAttempts: 1 },
      ],
    };
    const result = await client.callTool({ name: "loopover_record_step_result", arguments: { plan, stepId: "a", outcome: "completed" } });
    expect(result.isError).toBeFalsy();
    const data = structured(result);
    const updatedPlan = data.plan as { steps: Array<{ id: string; status: string }> };
    expect(updatedPlan.steps.find((s) => s.id === "a")?.status).toBe("completed");
    expect(data.readySteps).toEqual([{ id: "b", title: "Step B" }]);
  });

  it("loopover_record_step_result retries a failed step until maxAttempts is exhausted, then marks it failed", async () => {
    await connect();
    const oneShotPlan = { steps: [{ id: "a", title: "Step A", dependsOn: [], status: "pending", attempts: 0, maxAttempts: 1 }] };
    const result = await client.callTool({ name: "loopover_record_step_result", arguments: { plan: oneShotPlan, stepId: "a", outcome: "failed", error: "boom" } });
    expect(result.isError).toBeFalsy();
    const data = structured(result);
    const updatedPlan = data.plan as { steps: Array<{ id: string; status: string; attempts: number; lastError: string | null }> };
    expect(updatedPlan.steps[0]).toMatchObject({ status: "failed", attempts: 1, lastError: "boom" });
    expect((data.progress as { status: string }).status).toBe("failed");
  });

  it("loopover_record_step_result rejects an unknown outcome value (zod input-schema validation)", async () => {
    await connect();
    const plan = { steps: [{ id: "a", title: "Step A", dependsOn: [], status: "pending", attempts: 0, maxAttempts: 1 }] };
    const outcome = await client.callTool({ name: "loopover_record_step_result", arguments: { plan, stepId: "a", outcome: "bogus" } }).then(
      (r) => ({ threw: false, isError: Boolean(r.isError) }),
      () => ({ threw: true, isError: true }),
    );
    expect(outcome.isError).toBe(true);
  });
});

describe("loopover-mcp loopover_predict_gate (#6150) — HTTP-backed", () => {
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;
  let configDir: string | null = null;
  let capturedRequests: Array<{ url: string; method: string; body: unknown }>;

  async function connect(options: { localBranchAnalysisStatus?: number } = {}) {
    configDir = mkdtempSync(join(tmpdir(), "loopover-predict-gate-"));
    capturedRequests = [];
    const apiUrl = await startFixtureServer({
      ...options,
      onApiRequest: (request) => {
        if (request.url === "/v1/local/branch-analysis") capturedRequests.push({ url: request.url, method: request.method ?? "POST", body: null });
      },
    });
    transport = new StdioClientTransport({
      command: "node",
      args: [bin, "--stdio"],
      env: { ...process.env, LOOPOVER_CONFIG_DIR: configDir, LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", LOOPOVER_API_TIMEOUT_MS: "5000" },
    });
    client = new Client({ name: "predict-gate-test", version: "0.0.1" });
    await client.connect(transport);
  }

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = null;
    transport = null;
    await closeFixtureServer();
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    configDir = null;
  });

  it("proxies to /v1/local/branch-analysis (metadata-only, no git context) and returns predictedGate", async () => {
    await connect();
    const result = await client!.callTool({
      name: "loopover_predict_gate",
      arguments: { login: "JSONbored", owner: "acme", repo: "widgets", title: "Add X", changedPaths: ["src/x.ts"] },
    });
    expect(result.isError).toBeFalsy();
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]!.url).toBe("/v1/local/branch-analysis");
    expect(capturedRequests[0]!.method).toBe("POST");
    const data = structured(result);
    expect(data).toMatchObject({ pack: "gittensor", conclusion: "advisory_pass", readinessScore: 72 });
  });

  it("surfaces an API failure as a tool error", async () => {
    await connect({ localBranchAnalysisStatus: 503 });
    const result = await client!.callTool({
      name: "loopover_predict_gate",
      arguments: { login: "JSONbored", owner: "acme", repo: "widgets", title: "Add X" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/503/);
  });

  it("rejects a missing required field (zod input-schema validation)", async () => {
    await connect();
    const outcome = await client!.callTool({ name: "loopover_predict_gate", arguments: { login: "JSONbored", owner: "acme", repo: "widgets" } }).then(
      (r) => ({ threw: false, isError: Boolean(r.isError) }),
      () => ({ threw: true, isError: true }),
    );
    expect(outcome.isError).toBe(true);
  });
});

describe("loopover-mcp loopover_explain_gate_disposition (#6740) — HTTP-backed", () => {
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;
  let configDir: string | null = null;
  let capturedRequests: Array<{ url: string; method: string; body: unknown }>;

  async function connect(options: { localBranchAnalysisStatus?: number; localBranchAnalysis?: Record<string, unknown> } = {}) {
    configDir = mkdtempSync(join(tmpdir(), "loopover-explain-gate-disposition-"));
    capturedRequests = [];
    const apiUrl = await startFixtureServer({
      ...options,
      onApiRequest: (request) => {
        if (request.url === "/v1/local/branch-analysis") capturedRequests.push({ url: request.url, method: request.method ?? "POST", body: null });
      },
    });
    transport = new StdioClientTransport({
      command: "node",
      args: [bin, "--stdio"],
      env: { ...process.env, LOOPOVER_CONFIG_DIR: configDir, LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", LOOPOVER_API_TIMEOUT_MS: "5000" },
    });
    client = new Client({ name: "explain-gate-disposition-test", version: "0.0.1" });
    await client.connect(transport);
  }

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = null;
    transport = null;
    await closeFixtureServer();
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    configDir = null;
  });

  it("registers on the local stdio server", async () => {
    await connect();
    const names = new Set((await client!.listTools()).tools.map((t) => t.name));
    expect(names).toContain("loopover_explain_gate_disposition");
  });

  it("proxies to /v1/local/branch-analysis then returns buildGateDispositions(predictedGate)", async () => {
    await connect({
      localBranchAnalysis: {
        predictedGate: {
          pack: "oss-anti-slop",
          conclusion: "failure",
          title: "Predicted gate: failure",
          summary: "Missing linked issue.",
          readinessScore: 40,
          blockers: [{ code: "missing_linked_issue", title: "Missing linked issue", detail: "Link an issue." }],
          warnings: [{ code: "missing_tests", title: "Missing tests", detail: "Add tests." }],
        },
      },
    });
    const result = await client!.callTool({
      name: "loopover_explain_gate_disposition",
      arguments: { login: "JSONbored", owner: "acme", repo: "widgets", title: "Add X", changedPaths: ["src/x.ts"] },
    });
    expect(result.isError).toBeFalsy();
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]!.url).toBe("/v1/local/branch-analysis");
    const data = structured(result);
    expect(data).toEqual({
      conclusion: "failure",
      pack: "oss-anti-slop",
      dispositions: [
        { rule: "missing_linked_issue", status: "block", reason: "Link an issue." },
        { rule: "missing_tests", status: "advisory", reason: "Add tests." },
      ],
    });
  });

  it("matches loopover_predict_gate's predictedGate dispositions for identical input (parity)", async () => {
    await connect();
    const args = { login: "JSONbored", owner: "acme", repo: "widgets", title: "Add X", changedPaths: ["src/x.ts"] };
    const predicted = structured(await client!.callTool({ name: "loopover_predict_gate", arguments: args }));
    const explained = structured(await client!.callTool({ name: "loopover_explain_gate_disposition", arguments: args }));
    expect(explained.conclusion).toBe(predicted.conclusion);
    expect(explained.pack).toBe(predicted.pack);
    expect(explained.dispositions).toEqual([]);
  });

  it("surfaces an API failure as a tool error", async () => {
    await connect({ localBranchAnalysisStatus: 503 });
    const result = await client!.callTool({
      name: "loopover_explain_gate_disposition",
      arguments: { login: "JSONbored", owner: "acme", repo: "widgets", title: "Add X" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/503/);
  });

  it("rejects a missing required field (zod input-schema validation)", async () => {
    await connect();
    const outcome = await client!.callTool({ name: "loopover_explain_gate_disposition", arguments: { login: "JSONbored", owner: "acme", repo: "widgets" } }).then(
      (r) => ({ threw: false, isError: Boolean(r.isError) }),
      () => ({ threw: true, isError: true }),
    );
    expect(outcome.isError).toBe(true);
  });
});

