import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildGateDispositions } from "@loopover/engine";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeFixtureServer,
  run,
  startFixtureServer,
} from "./support/mcp-cli-harness";

// #6740: CLI stdio mirror of loopover_explain_gate_disposition — fetches predictedGate via the same
// /v1/local/branch-analysis route as loopover_predict_gate, then runs the shared buildGateDispositions
// locally so MCP and CLI agree by construction.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");
const FORBIDDEN_PUBLIC_TERMS =
  /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: unknown })
    .structuredContent as Record<string, unknown>;
}

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let capturedBodies: unknown[];

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-explain-gate-"));
  capturedBodies = [];
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (
        request.url?.includes("/v1/local/branch-analysis") &&
        request.method === "POST"
      ) {
        capturedBodies.push({ url: request.url, method: request.method });
      }
    },
  });
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_API_TIMEOUT_MS: "5000",
    },
  });
  client = new Client({ name: "explain-gate-cli-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_explain_gate_disposition stdio mirror (#6740)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain(
      "loopover_explain_gate_disposition",
    );
  });

  it("fetches predictedGate then returns buildGateDispositions parity with the engine export", async () => {
    const result = await client.callTool({
      name: "loopover_explain_gate_disposition",
      arguments: {
        login: "miner1",
        owner: "owner",
        repo: "repo",
        title: "Add retry handling",
      },
    });
    expect(capturedBodies.length).toBe(1);
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    const data = structured(result) as {
      conclusion: string;
      pack: string;
      dispositions: Array<{ rule: string; status: string; reason: string }>;
    };
    // Fixture predictedGate has one advisory warning; dispositions must match the pure engine export.
    const expected = buildGateDispositions({
      blockers: [],
      warnings: [
        {
          code: "missing_tests",
          title: "Missing tests",
          detail: "No test files accompany the changed paths.",
        },
      ],
    });
    expect(data).toMatchObject({
      conclusion: "advisory_pass",
      pack: "gittensor",
      dispositions: expected,
    });
  });

  it("lists the tool via loopover-mcp tools", () => {
    const payload = JSON.parse(run(["tools", "--json"])) as {
      tools: Array<{ name: string; description: string }>;
    };
    const tool = payload.tools.find(
      (entry) => entry.name === "loopover_explain_gate_disposition",
    );
    expect(tool?.description).toMatch(/per-rule dispositions/i);
    expect(tool?.description.trim().length).toBeGreaterThan(0);
  });
});
