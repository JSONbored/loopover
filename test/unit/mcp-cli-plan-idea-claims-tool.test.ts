import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaimPlan, buildTaskGraph, claimPlanTargetRepo, validateIdeaSubmission } from "../../src/idea-intake";

// #6756: the local mirror of loopover_plan_idea_claims. Like its same-tier sibling loopover_check_slop_risk,
// it computes IN-PROCESS from @loopover/engine — no API round-trip — so claim planning works fully offline.
// Cross-surface PARITY: the stdio tool must return exactly what the pure handler returns for identical input
// (the same functions /v1/loop/plan-idea-claims delegates to).
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

const VALID = {
  id: "idea-1",
  title: "Retry uploads on 5xx",
  body: "Uploads fail silently on 5xx.",
  targetRepo: "acme/widgets",
};

function expectedPayload(body: unknown) {
  const validated = validateIdeaSubmission(body);
  if (!validated.ok) return { ok: false as const, errors: validated.errors };
  const graph = buildTaskGraph(validated.idea, (body as { decomposition?: never }).decomposition);
  const claimPlan = buildClaimPlan(graph, claimPlanTargetRepo(validated.idea.targetRepo));
  return { ok: true as const, verdict: claimPlan.graphVerdict, claimPlan };
}

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-plan-idea-claims-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_API_URL: "http://127.0.0.1:1",
      LOOPOVER_API_TIMEOUT_MS: "1000",
    },
  });
  client = new Client({ name: "plan-idea-claims-test", version: "0.0.1" });
  await client.connect(transport);
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

describe("loopover_plan_idea_claims stdio mirror (#6756)", () => {
  it("registers the tool alongside its same-tier check_slop_risk sibling", async () => {
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    expect(names).toContain("loopover_plan_idea_claims");
    expect(names).toContain("loopover_check_slop_risk");
  });

  it("matches the pure handler for accepted shapes — offline, with no API reachable", async () => {
    const cases: unknown[] = [
      VALID,
      { ...VALID, priority: "high" },
      {
        ...VALID,
        decomposition: [
          { key: "a", title: "First", body: "Body." },
          { key: "b", title: "Second", body: "Body.", dependsOn: ["a"] },
        ],
      },
    ];
    for (const args of cases) {
      const result = await client.callTool({ name: "loopover_plan_idea_claims", arguments: args as Record<string, unknown> });
      expect(result.isError, JSON.stringify(args)).toBeFalsy();
      expect((result as { structuredContent?: unknown }).structuredContent, JSON.stringify(args)).toEqual(
        JSON.parse(JSON.stringify(expectedPayload(args))),
      );
    }
  });

  it("returns the engine's actionable error list for a malformed submission", async () => {
    const result = await client.callTool({ name: "loopover_plan_idea_claims", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result as { structuredContent?: unknown }).structuredContent).toEqual(
      JSON.parse(JSON.stringify(expectedPayload({}))),
    );
  });

  it("rejects schema-invalid input (zod)", async () => {
    const rejected = await client
      .callTool({ name: "loopover_plan_idea_claims", arguments: { ...VALID, decomposition: "nope" } })
      .then((r) => Boolean(r.isError), () => true);
    expect(rejected).toBe(true);
  });
});
