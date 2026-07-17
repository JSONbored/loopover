import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestEvidenceReport } from "../../src/signals/test-evidence";

// #6749: the local mirror of loopover_check_test_evidence. Like its same-tier sibling loopover_check_slop_risk
// it computes IN-PROCESS from @loopover/engine — no API round-trip — so coverage self-checks work offline. The
// point of these tests is cross-surface PARITY with the same buildTestEvidenceReport the route + MCP tool call.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");
let client: Client;
let transport: StdioClientTransport;
let configDir: string;

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-test-evidence-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    // Black-holed API URL: a residual round-trip would fail every case, proving the in-process claim.
    env: { ...process.env, LOOPOVER_CONFIG_DIR: configDir, LOOPOVER_TOKEN: "session-token", LOOPOVER_API_URL: "http://127.0.0.1:1", LOOPOVER_API_TIMEOUT_MS: "1000" },
  });
  client = new Client({ name: "test-evidence-tool-test", version: "0.0.1" });
  await client.connect(transport);
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

describe("loopover_check_test_evidence stdio mirror (#6749)", () => {
  it("registers alongside its same-tier check_slop_risk sibling", async () => {
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    expect(names).toContain("loopover_check_test_evidence");
    expect(names).toContain("loopover_check_slop_risk");
  });

  it("matches the shared builder for every arm — offline, with no API reachable", async () => {
    const cases = [
      { changedPaths: ["src/a.ts"] },
      { changedPaths: ["src/a.ts"], testFiles: ["test/a.test.ts"] },
      { changedPaths: ["src/a.ts"], tests: "ran `go test ./...` locally, no new file" },
      { changedPaths: ["README.md"] },
    ];
    for (const args of cases) {
      const result = await client.callTool({ name: "loopover_check_test_evidence", arguments: args });
      expect(result.isError, JSON.stringify(args)).toBeFalsy();
      expect((result as { structuredContent?: unknown }).structuredContent, JSON.stringify(args)).toEqual(
        JSON.parse(JSON.stringify(buildTestEvidenceReport(args))),
      );
    }
  });

  it("rejects invalid input (zod input-schema validation)", async () => {
    for (const args of [{}, { changedPaths: [] }, { changedPaths: "nope" }, { changedPaths: ["src/a.ts"], tests: 7 }]) {
      const rejected = await client.callTool({ name: "loopover_check_test_evidence", arguments: args }).then((r) => Boolean(r.isError), () => true);
      expect(rejected, `${JSON.stringify(args)} should be rejected`).toBe(true);
    }
  });
});
