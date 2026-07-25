import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgressSnapshot, type LoopProgressState } from "../../src/loop-progress";

// #6753: the local mirror of loopover_build_progress_snapshot. Like its same-tier sibling
// loopover_check_slop_risk, it computes IN-PROCESS from @loopover/engine — no API round-trip — so
// progress composition works fully offline. The point of these tests is cross-surface PARITY: the
// stdio tool must return exactly what the pure buildProgressSnapshot returns for identical input
// (the same function /v1/loop/progress-snapshot delegates to).
const bin = join(process.cwd(), "packages/loopover-mcp/dist/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-progress-snapshot-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    // Pure + in-process: a black-holed API URL proves no round-trip happens.
    env: {
      ...process.env,
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_API_URL: "http://127.0.0.1:1",
      LOOPOVER_API_TIMEOUT_MS: "1000",
    },
  });
  client = new Client({ name: "progress-snapshot-test", version: "0.0.1" });
  await client.connect(transport);
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

describe("loopover_build_progress_snapshot stdio mirror (#6753)", () => {
  it("registers the tool alongside its same-tier check_slop_risk sibling", async () => {
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    expect(names).toContain("loopover_build_progress_snapshot");
    expect(names).toContain("loopover_check_slop_risk");
  });

  it("matches the pure builder for representative states — offline, with no API reachable", async () => {
    const cases: LoopProgressState[] = [
      { iteration: 0, phase: "queued", status: "running" },
      { iteration: 2, maxIterations: 5, phase: "coding", status: "running" },
      { iteration: 5, maxIterations: 5, phase: "done", status: "converged" },
      { iteration: 1, maxIterations: null, phase: "reviewing", status: "error" },
      {
        iteration: 3,
        maxIterations: 10,
        phase: "submitting",
        status: "abandoned",
        recentActivity: [{ step: "plan" }, { step: "code", detail: "wrote tests", at: "2026-07-17T00:00:00.000Z" }],
      },
    ];
    for (const args of cases) {
      const result = await client.callTool({ name: "loopover_build_progress_snapshot", arguments: args });
      expect(result.isError, JSON.stringify(args)).toBeFalsy();
      // PARITY: identical to what the REST route returns, because both call this same function.
      expect((result as { structuredContent?: unknown }).structuredContent, JSON.stringify(args)).toEqual(
        JSON.parse(JSON.stringify(buildProgressSnapshot(args))),
      );
    }
  });

  it("rejects invalid input (zod input-schema validation)", async () => {
    for (const args of [
      {},
      { iteration: 1, phase: "coding" },
      { iteration: 1, phase: "bogus", status: "running" },
      { iteration: 1.5, phase: "coding", status: "running" },
    ]) {
      const rejected = await client.callTool({ name: "loopover_build_progress_snapshot", arguments: args }).then(
        (r) => Boolean(r.isError),
        () => true,
      );
      expect(rejected, `${JSON.stringify(args)} should be rejected`).toBe(true);
    }
  });
});
