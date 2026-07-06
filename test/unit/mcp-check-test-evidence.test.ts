import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildCheckTestEvidenceReport } from "../../src/mcp/check-test-evidence";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-test-evidence-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("buildCheckTestEvidenceReport (#2235)", () => {
  it("classifies code-only changes without tests as absent", () => {
    const report = buildCheckTestEvidenceReport({ changedPaths: ["src/auth.ts", "src/utils.ts"] });
    expect(report.classification).toBe("absent");
    expect(report.codeFileCount).toBe(2);
    expect(report.testFileCount).toBe(0);
    expect(report.docsOnly).toBe(false);
    expect(report.guidance[0]).toMatch(/Add focused regression tests/);
  });

  it("classifies code plus proportionally strong tests as strong", () => {
    const report = buildCheckTestEvidenceReport({
      changedPaths: ["src/a.ts", "src/b.ts", "test/a.test.ts", "test/b.test.ts"],
    });
    expect(report.classification).toBe("strong");
    expect(report.testFileCount).toBe(2);
  });

  it("classifies adequate and weak threshold bands", () => {
    const adequate = buildCheckTestEvidenceReport({
      changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "test/a.test.ts"],
    });
    expect(adequate.classification).toBe("adequate");

    const weak = buildCheckTestEvidenceReport({
      changedPaths: [...Array.from({ length: 9 }, (_, i) => `src/file${i}.ts`), "test/single.test.ts"],
    });
    expect(weak.classification).toBe("weak");
  });

  it("treats docs-only churn as not requiring dedicated test evidence", () => {
    const report = buildCheckTestEvidenceReport({ changedPaths: ["README.md", "docs/guide.md"] });
    expect(report.docsOnly).toBe(true);
    expect(report.codeFileCount).toBe(0);
    expect(report.classification).toBe("absent");
    expect(report.guidance[0]).toMatch(/docs-only churn/);
  });

  it("counts optional testPaths supplied separately from changedPaths", () => {
    const report = buildCheckTestEvidenceReport({
      changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
      testPaths: ["test/a.test.ts"],
    });
    expect(report.classification).toBe("adequate");
    expect(report.testFileCount).toBe(1);
  });
});

describe("MCP gittensory_check_test_evidence (#2235)", () => {
  it("registers the tool and returns a public-safe classification for code-only paths", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("gittensory_check_test_evidence");

    const result = await client.callTool({
      name: "gittensory_check_test_evidence",
      arguments: { changedPaths: ["src/api/routes.ts"] },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      classification: string;
      guidance: string[];
      docsOnly: boolean;
    };
    expect(data.classification).toBe("absent");
    expect(data.docsOnly).toBe(false);
    expect(data.guidance.length).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|reward|payout|trust score/i);
  });

  it("returns strong classification when code and tests are supplied together", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_check_test_evidence",
      arguments: {
        changedPaths: ["src/a.ts", "src/b.ts", "test/a.test.ts", "test/b.test.ts"],
      },
    });
    const data = result.structuredContent as { classification: string };
    expect(data.classification).toBe("strong");
  });

  it("returns docs-only guidance without requiring tests", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_check_test_evidence",
      arguments: { changedPaths: ["docs/miner-goal-spec.md"] },
    });
    const data = result.structuredContent as { docsOnly: boolean; guidance: string[] };
    expect(data.docsOnly).toBe(true);
    expect(data.guidance[0]).toMatch(/docs-only churn/);
  });
});
