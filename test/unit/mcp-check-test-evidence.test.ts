import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new LoopoverMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-test-evidence-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

type Result = { classification: string; changedFileCount: number; codeFileCount: number; testFileCount: number; guidance: string[] };

describe("MCP loopover_check_test_evidence (#2235)", () => {
  it("flags code changes with no tests as absent (no source/auth needed)", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "loopover_check_test_evidence", arguments: { changedPaths: ["src/a.ts", "src/b.ts"] } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Result;
    expect(data.classification).toBe("absent");
    expect(data.codeFileCount).toBe(2);
    expect(data.testFileCount).toBe(0);
    expect(data.guidance.join(" ")).toMatch(/no test evidence/i);
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|reward|payout|trust score/i);
  });

  it("classifies a well-tested change as strong", async () => {
    const client = await connect();
    // 1 test / 2 total = 0.5 → strong
    const result = await client.callTool({ name: "loopover_check_test_evidence", arguments: { changedPaths: ["src/a.ts"], testFiles: ["test/a.test.ts"] } });
    const data = result.structuredContent as Result;
    expect(data.classification).toBe("strong");
    expect(data.testFileCount).toBe(1);
    expect(data.guidance.join(" ")).toMatch(/strong/i);
  });

  it("classifies a lightly-tested change as adequate", async () => {
    const client = await connect();
    // 1 test / 5 total = 0.2 → adequate
    const result = await client.callTool({ name: "loopover_check_test_evidence", arguments: { changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "test/a.test.ts"] } });
    const data = result.structuredContent as Result;
    expect(data.classification).toBe("adequate");
    expect(data.guidance.join(" ")).toMatch(/adequate/i);
  });

  it("classifies a barely-tested change as weak", async () => {
    const client = await connect();
    // 1 test / 6 total ≈ 0.17 → weak
    const result = await client.callTool({ name: "loopover_check_test_evidence", arguments: { changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"], testFiles: ["test/a.test.ts"] } });
    const data = result.structuredContent as Result;
    expect(data.classification).toBe("weak");
    expect(data.guidance.join(" ")).toMatch(/weak/i);
  });

  it("treats a docs-only change as not applicable (no code files)", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "loopover_check_test_evidence", arguments: { changedPaths: ["README.md", "docs/guide.md"] } });
    const data = result.structuredContent as Result;
    expect(data.codeFileCount).toBe(0);
    expect(data.guidance.join(" ")).toMatch(/does not apply/i);
  });
});
