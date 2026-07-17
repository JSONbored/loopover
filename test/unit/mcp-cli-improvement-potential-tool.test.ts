import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #6748: the CLI mirror of loopover_check_improvement_potential. It PROXIES to
// POST /v1/lint/improvement-potential (buildStructuralImprovementAssessment lives app-side in
// src/signals/improvement.ts, not @loopover/engine), so the route is the single source of truth for scoring.
// The bin cannot import from src/, so its zod shape is a hand-mirror of the tool's — these tests pin that
// mirror: valid payloads reach the route, and every bound the real schema enforces is enforced here too.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");
let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let captured: Array<{ url: string; method: string }>;

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-improvement-"));
  captured = [];
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url?.includes("/lint/improvement-potential")) captured.push({ url: request.url ?? "", method: request.method ?? "" });
    },
  });
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: { ...process.env, LOOPOVER_CONFIG_DIR: configDir, LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", LOOPOVER_API_TIMEOUT_MS: "5000" },
  });
  client = new Client({ name: "improvement-tool-test", version: "0.0.1" });
  await client.connect(transport);
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

describe("loopover_check_improvement_potential stdio mirror (#6748)", () => {
  it("registers alongside its check_slop_risk counterpart", async () => {
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    expect(names).toContain("loopover_check_improvement_potential");
    expect(names).toContain("loopover_check_slop_risk");
  });

  it("proxies a full payload to POST /v1/lint/improvement-potential and returns the score", async () => {
    const result = await client.callTool({
      name: "loopover_check_improvement_potential",
      arguments: {
        changedFiles: [{ path: "src/a.ts", additions: 20, deletions: 60 }],
        testFiles: ["test/a.test.ts"],
        patchCoverageDeltaPercent: 4.5,
        complexityDeltas: [{ file: "src/a.ts", line: 10, name: "handler", before: 14, after: 6, delta: -8 }],
        duplicationDeltas: [{ file: "src/a.ts", line: 30, duplicateOfLine: 12, lines: 9 }],
      },
    });
    expect(result.isError).toBeFalsy();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("POST");
    const text = JSON.stringify(result);
    expect(text).toContain("moderate");
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward estimate/i);
  });

  it("accepts an empty payload — every field is optional on the tool's shape", async () => {
    const result = await client.callTool({ name: "loopover_check_improvement_potential", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(captured).toHaveLength(1);
  });

  it("enforces the real schema's bounds itself, before any API call", async () => {
    for (const args of [
      { changedFiles: [{ path: "" }] },
      { changedFiles: [{ path: "src/a.ts", additions: -1 }] },
      { complexityDeltas: [{ file: "src/a.ts", line: 0, name: "f", before: 1, after: 1, delta: 0 }] },
      { duplicationDeltas: [{ file: "src/a.ts", line: 1, duplicateOfLine: 1, lines: 0 }] },
      { patchCoverageDeltaPercent: "lots" },
    ]) {
      const rejected = await client.callTool({ name: "loopover_check_improvement_potential", arguments: args }).then((r) => Boolean(r.isError), () => true);
      expect(rejected, JSON.stringify(args)).toBe(true);
    }
    expect(captured).toHaveLength(0);
  });
});
