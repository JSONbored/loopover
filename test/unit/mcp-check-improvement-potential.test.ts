import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new LoopoverMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-improvement-potential-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP loopover_check_improvement_potential (#4746)", () => {
  it("is registered with a non-empty description and an outputSchema", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "loopover_check_improvement_potential");
    expect(tool).toBeDefined();
    expect(tool?.description?.length ?? 0).toBeGreaterThan(0);
    expect(tool?.outputSchema).toBeDefined();
    expect(tool?.outputSchema?.type).toBe("object");
  });

  it("degrades to insufficient-signal when every input is omitted", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "loopover_check_improvement_potential", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { improvementScore: number; band: string; findings: unknown[] };
    expect(data).toEqual({ improvementScore: 0, band: "insufficient-signal", findings: [] });
  });

  it("still works from just changedFiles/tests/testFiles when complexityDeltas/duplicationDeltas are omitted", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_check_improvement_potential",
      arguments: {
        changedFiles: [
          { path: "src/widget.ts", additions: 20, deletions: 5 },
          { path: "test/unit/widget.test.ts", additions: 30, deletions: 0 },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { improvementScore: number; band: string; findings: Array<{ code: string }> };
    expect(data.band).toBe("minor");
    expect(data.findings.map((f) => f.code)).toEqual(["added_test_evidence"]);
    // complexityDeltas/duplicationDeltas were never supplied, yet this still produced a real (non-insufficient) band.
    expect(data.improvementScore).toBeGreaterThan(0);
  });

  it("reaches `significant` when both structural deltas are supplied, and does NOT blunt improvementScore", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_check_improvement_potential",
      arguments: {
        complexityDeltas: [{ file: "src/a.ts", line: 10, name: "foo", before: 12, after: 4, delta: -8 }],
        duplicationDeltas: [{ file: "src/b.ts", line: 5, duplicateOfLine: 55, lines: 9 }],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { improvementScore: number; band: string; findings: Array<{ code: string }> };
    expect(data.band).toBe("significant");
    // Unlike loopover_check_slop_risk (blunted by design, #mcp-slop-blunt), the raw score IS returned here —
    // improvementScore has no gate/blocker power, so there is nothing to protect from reverse-engineering.
    expect(data).toHaveProperty("improvementScore");
    expect(data.improvementScore).toBe(70);
    expect(data.findings.map((f) => f.code).sort()).toEqual(["reduced_complexity", "resolved_duplication"]);
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|coldkey|mnemonic|reward|payout|trust score/i);
  });

  it("combines a patch-coverage delta with duplication deltas into one aggregate score/band", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_check_improvement_potential",
      arguments: {
        patchCoverageDeltaPercent: 8,
        duplicationDeltas: [{ file: "src/c.ts", line: 3, duplicateOfLine: 30, lines: 6 }],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { improvementScore: number; band: string; findings: Array<{ code: string }> };
    expect(data.improvementScore).toBe(55);
    expect(data.band).toBe("moderate");
    expect(data.findings.map((f) => f.code).sort()).toEqual(["increased_patch_coverage", "resolved_duplication"]);
  });
});
