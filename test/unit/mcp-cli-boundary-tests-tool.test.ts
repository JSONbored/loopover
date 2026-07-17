import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #6750: the CLI mirror of loopover_suggest_boundary_tests. Unlike the check_slop_risk sibling it PROXIES to
// POST /v1/lint/boundary-tests rather than computing in-process, because the builders live app-side
// (src/signals/boundary-test-generation.ts depends on the app's AdvisoryFinding type), not in @loopover/engine.
// The route therefore stays the single source of truth; these tests pin the request the tool composes and its
// zod shape, and routes-boundary-tests.test.ts pins the verdict itself.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");
let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let captured: Array<{ url: string; method: string }>;

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-boundary-tests-"));
  captured = [];
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url?.includes("/lint/boundary-tests")) captured.push({ url: request.url ?? "", method: request.method ?? "" });
    },
  });
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: { ...process.env, LOOPOVER_CONFIG_DIR: configDir, LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", LOOPOVER_API_TIMEOUT_MS: "5000" },
  });
  client = new Client({ name: "boundary-tests-tool-test", version: "0.0.1" });
  await client.connect(transport);
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

describe("loopover_suggest_boundary_tests stdio mirror (#6750)", () => {
  it("registers alongside its same-tier check_slop_risk sibling", async () => {
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    expect(names).toContain("loopover_suggest_boundary_tests");
    expect(names).toContain("loopover_check_slop_risk");
  });

  it("proxies to POST /v1/lint/boundary-tests and returns the route's finding + spec", async () => {
    const result = await client.callTool({
      name: "loopover_suggest_boundary_tests",
      arguments: { changedFiles: [{ path: "src/a.ts" }], boundaryTouches: [{ path: "src/a.ts", kind: "array_index_bounds" }] },
    });
    expect(result.isError).toBeFalsy();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("POST");
    const text = JSON.stringify(result);
    expect(text).toContain("scaffold_boundary_tests");
    // Criteria/hints only — never generated test code, and nothing private.
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward estimate/i);
  });

  it("rejects invalid input (zod) before any API call", async () => {
    for (const args of [{}, { changedFiles: [{ path: "" }] }, { changedFiles: [{ path: "src/a.ts", extra: 1 }] }, { changedFiles: [{ path: "src/a.ts" }], boundaryTouches: [{ path: "src/a.ts", kind: "bogus" }] }]) {
      const rejected = await client.callTool({ name: "loopover_suggest_boundary_tests", arguments: args }).then((r) => Boolean(r.isError), () => true);
      expect(rejected, `${JSON.stringify(args)} should be rejected`).toBe(true);
    }
    expect(captured).toHaveLength(0);
  });
});
