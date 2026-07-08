import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-check-test-evidence-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

type TestEvidenceReport = {
  coverageBand: "strong" | "adequate" | "weak" | "absent";
  changedPathCount: number;
  testPathCount: number;
  hasCodeChanges: boolean;
  hasTestEvidence: boolean;
  guidance: string;
  summary: string;
};

async function check(args: { changedPaths: string[]; testFiles?: string[] }) {
  const client = await connect();
  const result = await client.callTool({ name: "gittensory_check_test_evidence", arguments: args });
  expect(result.isError).toBeFalsy();
  return result.structuredContent as TestEvidenceReport;
}

describe("MCP gittensory_check_test_evidence (#2235)", () => {
  it("registers with an outputSchema and needs no repo access", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "gittensory_check_test_evidence");
    expect(tool).toBeDefined();
    expect(tool?.outputSchema?.type).toBe("object");
  });

  it("reports absent coverage for a code-only diff with no tests", async () => {
    const data = await check({ changedPaths: ["src/foo.ts", "src/bar.ts"] });
    expect(data.coverageBand).toBe("absent");
    expect(data.changedPathCount).toBe(2);
    expect(data.testPathCount).toBe(0);
    expect(data.hasCodeChanges).toBe(true);
    expect(data.hasTestEvidence).toBe(false);
    expect(data.guidance).toMatch(/add at least one test/i);
    expect(data.summary).toContain("absent");
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|coldkey|reward|payout|trust score/i);
  });

  it("reports absent coverage but no code changes for a docs-only diff", async () => {
    const data = await check({ changedPaths: ["README.md", "docs/guide.md"] });
    expect(data.coverageBand).toBe("absent");
    expect(data.hasCodeChanges).toBe(false);
    expect(data.hasTestEvidence).toBe(false);
  });

  it("reports strong coverage for a balanced code+tests diff", async () => {
    const data = await check({ changedPaths: ["src/foo.ts", "src/foo.test.ts"] });
    expect(data.coverageBand).toBe("strong");
    expect(data.testPathCount).toBe(1);
    expect(data.hasCodeChanges).toBe(true);
    expect(data.hasTestEvidence).toBe(true);
    expect(data.guidance).toMatch(/no additional tests/i);
  });

  it("classifies the adequate and weak threshold bands from the changed-path ratio", async () => {
    const adequate = await check({ changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/a.test.ts"] });
    expect(adequate.coverageBand).toBe("adequate");

    const weak = await check({
      changedPaths: [
        "src/a.ts",
        "src/b.ts",
        "src/c.ts",
        "src/d.ts",
        "src/e.ts",
        "src/f.ts",
        "src/g.ts",
        "src/h.ts",
        "src/i.ts",
        "src/a.test.ts",
      ],
    });
    expect(weak.coverageBand).toBe("weak");
    expect(weak.guidance).toMatch(/weak/i);
  });

  it("folds explicit test paths into the band so coverage/guidance stay consistent with hasTestEvidence", async () => {
    const data = await check({ changedPaths: ["src/foo.ts"], testFiles: ["test/foo.test.ts"] });
    expect(data.hasCodeChanges).toBe(true);
    expect(data.hasTestEvidence).toBe(true);
    // The explicit test path must lift the band out of "absent" so guidance never contradicts hasTestEvidence.
    expect(data.coverageBand).toBe("strong");
    expect(data.guidance).toMatch(/no additional tests/i);
    expect(data.changedPathCount).toBe(2);
    expect(data.testPathCount).toBe(1);
  });

  it("dedupes a path listed in both changedPaths and testFiles so the ratio is not skewed", async () => {
    const data = await check({ changedPaths: ["src/a.ts", "src/a.test.ts"], testFiles: ["src/a.test.ts"] });
    expect(data.changedPathCount).toBe(2);
    expect(data.testPathCount).toBe(1);
    expect(data.coverageBand).toBe("strong");
  });
});
