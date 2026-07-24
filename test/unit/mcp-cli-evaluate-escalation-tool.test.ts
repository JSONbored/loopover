import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateEscalation } from "../../src/loop-escalation";

// #6754: the local mirror of loopover_evaluate_escalation. Like its same-tier sibling loopover_check_slop_risk,
// it computes IN-PROCESS from @loopover/engine — no API round-trip — so escalation checks work fully offline.
// The point of these tests is cross-surface PARITY: the stdio tool must return exactly what the pure
// evaluateEscalation returns for identical input (the same function /v1/loop/evaluate-escalation delegates to).
const bin = join(process.cwd(), "packages/loopover-mcp/dist/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-eval-escalation-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    // Pure + in-process: a black-holed API URL proves no round-trip happens.
    env: { ...process.env, LOOPOVER_CONFIG_DIR: configDir, LOOPOVER_TOKEN: "session-token", LOOPOVER_API_URL: "http://127.0.0.1:1", LOOPOVER_API_TIMEOUT_MS: "1000" },
  });
  client = new Client({ name: "eval-escalation-test", version: "0.0.1" });
  await client.connect(transport);
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

describe("loopover_evaluate_escalation stdio mirror (#6754)", () => {
  it("registers the tool alongside its same-tier check_slop_risk sibling", async () => {
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    expect(names).toContain("loopover_evaluate_escalation");
    expect(names).toContain("loopover_check_slop_risk");
  });

  it("matches the pure evaluator for every precedence arm — offline, with no API reachable", async () => {
    const cases = [
      { runStatus: "running", killRequested: true },
      { runStatus: "error" },
      { runStatus: "running", healthStatus: "critical" },
      { runStatus: "abandoned" },
      { runStatus: "running", customerFlagged: true },
      { runStatus: "running", healthStatus: "degraded" },
      { runStatus: "running", healthStatus: "healthy" },
      { runStatus: "converged" },
    ] as const;
    for (const args of cases) {
      const result = await client.callTool({ name: "loopover_evaluate_escalation", arguments: args });
      expect(result.isError, JSON.stringify(args)).toBeFalsy();
      // PARITY: identical to what the REST route returns, because both call this same function.
      expect((result as { structuredContent?: unknown }).structuredContent, JSON.stringify(args)).toEqual(
        JSON.parse(JSON.stringify(evaluateEscalation(args))),
      );
    }
  });

  it("rejects invalid input (zod input-schema validation)", async () => {
    for (const args of [{}, { runStatus: "bogus" }, { runStatus: "running", healthStatus: "on-fire" }, { runStatus: "running", killRequested: "yes" }]) {
      const rejected = await client.callTool({ name: "loopover_evaluate_escalation", arguments: args }).then(
        (r) => Boolean(r.isError),
        () => true,
      );
      expect(rejected, `${JSON.stringify(args)} should be rejected`).toBe(true);
    }
  });
});
