import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-write-tools-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

type Spec = { action: string; command: string; boundary: string; inputs: Record<string, unknown> };

describe("MCP miner write-tools (#780)", () => {
  it("open_pr returns a local-execution spec; gittensory performs no write", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_open_pr",
      arguments: { repoFullName: "o/r", base: "main", head: "feat/x", title: "Add thing", body: "Body", draft: true },
    });
    expect(result.isError).toBeFalsy();
    const spec = result.structuredContent as Spec;
    expect(spec.action).toBe("open_pr");
    expect(spec.command).toBe("gh pr create --repo 'o/r' --base 'main' --head 'feat/x' --title 'Add thing' --body 'Body' --draft");
    expect(spec.boundary).toMatch(/your OWN GitHub credentials/i);
    expect(spec.boundary).toMatch(/never performs the write/i);
  });

  it("file_issue / apply_labels / post_eligibility_comment / branch helpers all return runnable specs", async () => {
    const client = await connect();
    const cases: Array<{ name: string; args: Record<string, unknown>; expect: string }> = [
      { name: "gittensory_file_issue", args: { repoFullName: "o/r", title: "T", body: "B", labels: ["bug"] }, expect: "gh issue create --repo 'o/r' --title 'T' --body 'B' --label 'bug'" },
      { name: "gittensory_apply_labels", args: { repoFullName: "o/r", number: 7, labels: ["x"] }, expect: "gh issue edit 7 --repo 'o/r' --add-label 'x'" },
      { name: "gittensory_post_eligibility_comment", args: { repoFullName: "o/r", number: 7, body: "hi" }, expect: "gh issue comment 7 --repo 'o/r' --body 'hi'" },
      { name: "gittensory_create_branch", args: { branch: "feat/x", base: "main" }, expect: "git switch -c 'feat/x' 'main'" },
      { name: "gittensory_delete_branch", args: { branch: "feat/x", remote: true }, expect: "git branch -D 'feat/x' && git push origin --delete 'feat/x'" },
    ];
    for (const testCase of cases) {
      const result = await client.callTool({ name: testCase.name, arguments: testCase.args });
      expect(result.isError, testCase.name).toBeFalsy();
      expect((result.structuredContent as Spec).command, testCase.name).toBe(testCase.expect);
    }
  });
});
