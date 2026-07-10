import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/gittensory-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "gittensory-feasibility-gate-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      GITTENSORY_CONFIG_DIR: configDir,
    },
  });
  client = new Client({ name: "feasibility-gate-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("gittensory_feasibility_gate stdio tool (#4270)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "gittensory_feasibility_gate");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("No API round-trip");
  });

  it("returns a go verdict for a clean, unclaimed, low-risk issue — with no network call", async () => {
    const result = await client.callTool({
      name: "gittensory_feasibility_gate",
      arguments: { claimStatus: "unclaimed", duplicateClusterRisk: "none", issueStatus: "ready" },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toEqual({
      verdict: "go",
      avoidReasons: [],
      raiseReasons: [],
      summary: "Go: no blocking feasibility signal detected.",
    });
  });

  it("returns an avoid verdict when the issue is already solved", async () => {
    const result = await client.callTool({
      name: "gittensory_feasibility_gate",
      arguments: { claimStatus: "solved", duplicateClusterRisk: "none", issueStatus: "ready" },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.verdict).toBe("avoid");
    expect(data.avoidReasons).toEqual(["claim_status_solved"]);
  });

  it("returns a raise verdict when found is explicitly false", async () => {
    const result = await client.callTool({
      name: "gittensory_feasibility_gate",
      arguments: { claimStatus: "unclaimed", duplicateClusterRisk: "none", issueStatus: "ready", found: false },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.verdict).toBe("raise");
    expect(data.raiseReasons).toEqual(["target_not_found"]);
  });

  it("rejects an invalid duplicateClusterRisk enum value", async () => {
    const result = await client.callTool({
      name: "gittensory_feasibility_gate",
      arguments: { claimStatus: "unclaimed", duplicateClusterRisk: "extreme", issueStatus: "ready" },
    });
    expect(result.isError).toBe(true);
  });

  it("never leaks private financial terminology in the response", async () => {
    const result = await client.callTool({
      name: "gittensory_feasibility_gate",
      arguments: { claimStatus: "claimed", duplicateClusterRisk: "high", issueStatus: "duplicate" },
    });
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/hotkey|coldkey|wallet|mnemonic|payout|reward/i);
  });
});
