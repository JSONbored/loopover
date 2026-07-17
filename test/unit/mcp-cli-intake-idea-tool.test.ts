import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTaskGraph, validateIdeaSubmission } from "../../src/idea-intake";

// #6755: the local mirror of loopover_intake_idea. Like its same-tier sibling loopover_check_slop_risk, it
// computes IN-PROCESS from @loopover/engine — no API round-trip — so idea intake works fully offline. The point
// of these tests is cross-surface PARITY: the stdio tool must return exactly what the pure bridge returns for
// identical input (the same functions /v1/loop/intake-idea delegates to), including the actionable error list.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

const VALID = { id: "idea-1", title: "Retry uploads on 5xx", body: "Uploads fail silently on 5xx.", targetRepo: "acme/widgets" };

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-intake-idea-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    // Pure + in-process: a black-holed API URL proves no round-trip happens.
    env: { ...process.env, LOOPOVER_CONFIG_DIR: configDir, LOOPOVER_TOKEN: "session-token", LOOPOVER_API_URL: "http://127.0.0.1:1", LOOPOVER_API_TIMEOUT_MS: "1000" },
  });
  client = new Client({ name: "intake-idea-test", version: "0.0.1" });
  await client.connect(transport);
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

describe("loopover_intake_idea stdio mirror (#6755)", () => {
  it("registers the tool alongside its same-tier check_slop_risk sibling", async () => {
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    expect(names).toContain("loopover_intake_idea");
    expect(names).toContain("loopover_check_slop_risk");
  });

  it("matches the pure bridge for every accepted shape — offline, with no API reachable", async () => {
    const cases: unknown[] = [
      VALID,
      { ...VALID, priority: "high" },
      { ...VALID, constraints: ["no new deps"], acceptanceHints: ["covered by a unit test"] },
      { ...VALID, decomposition: [{ key: "a", title: "Only issue", body: "Body." }] },
      { ...VALID, decomposition: [{ key: "a", title: "First", body: "Body." }, { key: "b", title: "Second", body: "Body.", dependsOn: ["a"] }] },
    ];
    for (const args of cases) {
      const result = await client.callTool({ name: "loopover_intake_idea", arguments: args as Record<string, unknown> });
      expect(result.isError, JSON.stringify(args)).toBeFalsy();
      const validated = validateIdeaSubmission(args);
      expect(validated.ok, JSON.stringify(args)).toBe(true);
      if (!validated.ok) continue;
      const graph = buildTaskGraph(validated.idea, (args as { decomposition?: never }).decomposition);
      // PARITY: identical to what the REST route returns, because both call these same functions.
      expect((result as { structuredContent?: unknown }).structuredContent, JSON.stringify(args)).toEqual(
        JSON.parse(JSON.stringify({ ok: true, verdict: graph.rubric.verdict, taskGraph: graph })),
      );
    }
  });

  it("returns the engine's actionable error list — not a silent failure — for a malformed submission", async () => {
    for (const [args, expectedError] of [
      [{}, "id_required"],
      [{ ...VALID, targetRepo: "not-a-repo" }, "target_repo_malformed"],
      [{ ...VALID, priority: "urgent" }, "priority_invalid"],
    ] as Array<[Record<string, unknown>, string]>) {
      const result = await client.callTool({ name: "loopover_intake_idea", arguments: args });
      expect(result.isError, JSON.stringify(args)).toBeFalsy();
      expect((result as { structuredContent?: { ok: boolean; errors: string[] } }).structuredContent, JSON.stringify(args)).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([expectedError]),
      });
    }
  });

  it("rejects schema-invalid input (zod input-schema validation)", async () => {
    for (const args of [{ ...VALID, title: 7 }, { ...VALID, constraints: [7] }, { ...VALID, decomposition: [{ key: "a", title: "Missing body" }] }]) {
      const rejected = await client.callTool({ name: "loopover_intake_idea", arguments: args as Record<string, unknown> }).then(
        (r) => Boolean(r.isError),
        () => true,
      );
      expect(rejected, `${JSON.stringify(args)} should be rejected`).toBe(true);
    }
  });
});
