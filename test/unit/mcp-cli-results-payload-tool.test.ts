import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildResultsPayload, type IterationResult } from "../../src/results-payload";

// #6752: the local mirror of loopover_build_results_payload. Like its same-tier sibling loopover_check_slop_risk,
// it composes IN-PROCESS from @loopover/engine — no API round-trip — so results composition works fully offline.
// The point of these tests is cross-surface PARITY: the stdio tool must return exactly what the pure
// buildResultsPayload returns for identical input (the same function /v1/loop/results-payload delegates to).
const bin = join(process.cwd(), "packages/loopover-mcp/dist/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-results-payload-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    // Pure + in-process: a black-holed API URL proves no round-trip happens.
    env: { ...process.env, LOOPOVER_CONFIG_DIR: configDir, LOOPOVER_TOKEN: "session-token", LOOPOVER_API_URL: "http://127.0.0.1:1", LOOPOVER_API_TIMEOUT_MS: "1000" },
  });
  client = new Client({ name: "results-payload-test", version: "0.0.1" });
  await client.connect(transport);
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

describe("loopover_build_results_payload stdio mirror (#6752)", () => {
  it("registers the tool alongside its same-tier check_slop_risk sibling", async () => {
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    expect(names).toContain("loopover_build_results_payload");
    expect(names).toContain("loopover_check_slop_risk");
  });

  it("matches the pure composer for every input shape — offline, with no API reachable", async () => {
    const cases: IterationResult[] = [
      { repoFullName: "acme/widgets", prNumber: 42, title: "Opened", status: "open" },
      { repoFullName: "acme/widgets", prNumber: 42, title: "Merged", status: "merged" },
      { repoFullName: "acme/widgets", prNumber: 42, title: "Closed", status: "closed" },
      { repoFullName: "acme/widgets", prNumber: 7, title: "Status omitted defaults to open" },
      { repoFullName: "acme/widgets", title: "prNumber absent entirely" },
      { repoFullName: "acme/widgets", prNumber: null, title: "prNumber null" },
      { repoFullName: "acme/widgets", prNumber: 9, title: "Empty changed set", changedFiles: [] },
      { repoFullName: "acme/widgets", prNumber: 9, title: "Counts omitted", changedFiles: [{ path: "README.md" }] },
      {
        repoFullName: "acme/widgets",
        prNumber: 9,
        title: "Over the preview cap",
        changedFiles: Array.from({ length: 12 }, (_, i) => ({ path: `src/f${i}.ts`, additions: i, deletions: 1 })),
      },
    ];
    for (const args of cases) {
      const result = await client.callTool({ name: "loopover_build_results_payload", arguments: args });
      expect(result.isError, JSON.stringify(args)).toBeFalsy();
      // PARITY: identical to what the REST route returns, because both call this same function.
      expect((result as { structuredContent?: unknown }).structuredContent, JSON.stringify(args)).toEqual(
        JSON.parse(JSON.stringify(buildResultsPayload(args))),
      );
    }
  });

  it("rejects invalid input (zod input-schema validation)", async () => {
    for (const args of [
      {},
      { title: "missing repoFullName" },
      { repoFullName: "", title: "empty repoFullName" },
      { repoFullName: "acme/widgets" },
      { repoFullName: "acme/widgets", title: 7 },
      { repoFullName: "acme/widgets", title: "bad status", status: "reopened" },
      { repoFullName: "acme/widgets", title: "bad prNumber", prNumber: 1.5 },
      { repoFullName: "acme/widgets", title: "bad changedFiles", changedFiles: [{ additions: 1 }] },
    ]) {
      const rejected = await client.callTool({ name: "loopover_build_results_payload", arguments: args }).then(
        (r) => Boolean(r.isError),
        () => true,
      );
      expect(rejected, `${JSON.stringify(args)} should be rejected`).toBe(true);
    }
  });
});
