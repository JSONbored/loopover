import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIdeaClaimPlanResult } from "../../src/idea-intake";

const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

// An unreachable API endpoint with a tight timeout: if the stdio tool ever regressed to proxying over HTTP
// (`apiPost("/v1/loop/plan-idea-claims", …)`) instead of computing in-process, every call below would error
// out against this dead address. Their success is what proves the local tool plans fully offline (#6756).
async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-plan-idea-claims-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...(process.env as Record<string, string>),
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_API_URL: "http://127.0.0.1:1",
      LOOPOVER_API_TIMEOUT_MS: "400",
    },
  });
  client = new Client({ name: "plan-idea-claims-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_plan_idea_claims stdio tool (#6756)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("advertises the in-process, no-round-trip behavior in the tool list", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "loopover_plan_idea_claims");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("no API round-trip");
  });

  it("plans a decomposition offline, matching the shared builder byte-for-byte (no network call)", async () => {
    const input = {
      id: "idea-P",
      title: "Add API key auth",
      body: "Authenticate the read API with a key.",
      targetRepo: "acme/widgets",
      decomposition: [
        { key: "issue-1", title: "Introduce API-key store", body: "validate keys" },
        { key: "issue-2", title: "Gate the read endpoints", body: "require a key", dependsOn: ["issue-1"] },
      ],
    };
    const result = await client.callTool({ name: "loopover_plan_idea_claims", arguments: input });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { ok: boolean; verdict: string; claimPlan: { claimable: { key: string }[]; deferred: { key: string }[] } };
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe("raise");
    expect(data.claimPlan.claimable.map((s) => s.key)).toEqual(["issue-1"]);
    expect(data.claimPlan.deferred.map((s) => s.key)).toEqual(["issue-2"]);
    // Output parity: the offline stdio result is exactly the shared pure builder's output for identical input.
    expect(result.structuredContent).toEqual(buildIdeaClaimPlanResult(input, input.decomposition));
  });

  it("returns an actionable error list offline for a malformed/empty submission", async () => {
    const input = { title: "no id/body", targetRepo: "not-a-slug" };
    const result = await client.callTool({ name: "loopover_plan_idea_claims", arguments: input });
    const data = result.structuredContent as { ok: boolean; errors: string[] };
    expect(data.ok).toBe(false);
    expect(data.errors).toEqual(expect.arrayContaining(["id_required", "body_required", "target_repo_malformed"]));
    expect(result.structuredContent).toEqual(buildIdeaClaimPlanResult(input, undefined));
  });
});
