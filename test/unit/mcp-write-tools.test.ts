import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new LoopoverMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-write-tools-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

type Spec = { action: string; description: string; command: string; boundary: string; inputs: Record<string, unknown> };

describe("MCP miner write-tools (#780)", () => {
  it("open_pr returns a local-execution spec; loopover performs no write", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_open_pr",
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
      { name: "loopover_file_issue", args: { repoFullName: "o/r", title: "T", body: "B", labels: ["bug"] }, expect: "gh issue create --repo 'o/r' --title 'T' --body 'B' --label 'bug'" },
      { name: "loopover_apply_labels", args: { repoFullName: "o/r", number: 7, labels: ["x"] }, expect: "gh issue edit 7 --repo 'o/r' --add-label 'x'" },
      { name: "loopover_post_eligibility_comment", args: { repoFullName: "o/r", number: 7, body: "hi" }, expect: "gh issue comment 7 --repo 'o/r' --body 'hi'" },
      { name: "loopover_create_branch", args: { branch: "feat/x", base: "main" }, expect: "git switch -c 'feat/x' 'main'" },
      { name: "loopover_delete_branch", args: { branch: "feat/x", remote: true }, expect: "git branch -D 'feat/x' && git push origin --delete 'feat/x'" },
      { name: "loopover_close_pr", args: { repoFullName: "o/r", number: 7 }, expect: "gh pr close 7 --repo 'o/r'" },
      {
        name: "loopover_close_pr",
        args: { repoFullName: "o/r", number: 7, comment: "dup" },
        expect: "gh pr close 7 --repo 'o/r' && gh pr comment 7 --repo 'o/r' --body 'dup'",
      },
    ];
    for (const testCase of cases) {
      const result = await client.callTool({ name: testCase.name, arguments: testCase.args });
      expect(result.isError, testCase.name).toBeFalsy();
      expect((result.structuredContent as Spec).command, testCase.name).toBe(testCase.expect);
    }
  });

  // #2315/#9492: buildSoftClaimSpec shipped in #2813 and was never registered as a tool — a silently dead
  // feature, invisible to coverage because its own unit test exercised the builder perfectly well. It is the
  // exact shape scripts/check-dead-source-files.ts now guards against; this test pins the wire-up itself.
  it("post_soft_claim returns a runnable comment spec, and its body carries the advisory (not-an-assignment) framing", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_post_soft_claim",
      arguments: { repoFullName: "o/r", number: 7, minerId: "miner-a", claimedAt: "2026-07-28T00:00:00.000Z", expiresAt: "2026-07-28T06:00:00.000Z" },
    });
    expect(result.isError).toBeFalsy();
    const spec = result.structuredContent as Spec;
    expect(spec.command).toContain("gh issue comment 7 --repo 'o/r'");
    // Reuses buildPostEligibilityCommentSpec's single-quote escaping rather than re-implementing it, so the
    // whole body arrives inside one quoted argument.
    expect(spec.command).toContain("miner-a");
    expect(spec.command).toContain("expires at 2026-07-28T06:00:00.000Z");
    expect(spec.command).toContain("not an assignment");
  });

  it("post_soft_claim omits the expiry sentence entirely when no expiresAt is supplied", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_post_soft_claim",
      arguments: { repoFullName: "o/r", number: 7, minerId: "miner-a", claimedAt: "2026-07-28T00:00:00.000Z" },
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Spec).command).not.toContain("expires at");
  });

  it("post_soft_claim rejects a non-ISO claimedAt rather than embedding it in a comment", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_post_soft_claim",
      arguments: { repoFullName: "o/r", number: 7, minerId: "miner-a", claimedAt: "yesterday" },
    });
    expect(result.isError).toBeTruthy();
  });

  // #2188 (boundary-safe test-generation slice of #1972).
  it("generate_tests returns a local-execution spec naming the framework and target files; loopover performs no write", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_generate_tests",
      arguments: { repoFullName: "o/r", targetFiles: ["src/widget.ts"], framework: "vitest", testDir: "test/unit/", criteria: ["cover the nullish branch"] },
    });
    expect(result.isError).toBeFalsy();
    const spec = result.structuredContent as Spec;
    expect(spec.action).toBe("generate_tests");
    expect(spec.description).toContain("vitest");
    expect(spec.description).toContain("src/widget.ts");
    expect(spec.boundary).toMatch(/your OWN GitHub credentials/i);
    expect(spec.boundary).toMatch(/never performs the write/i);
    expect(spec.inputs).toMatchObject({ repoFullName: "o/r", framework: "vitest", testDir: "test/unit/" });
  });

  it("generate_tests rejects a framework outside the detector's known set", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_generate_tests",
      arguments: { repoFullName: "o/r", targetFiles: ["src/widget.ts"], framework: "not-a-real-framework" },
    });
    expect(result.isError).toBeTruthy();
  });

  // #2177 (follow-up-issue slice of #1962).
  it("file_follow_up_issue composes a file_issue spec from a deferred finding, with and without a label", async () => {
    const client = await connect();
    const withLabel = await client.callTool({
      name: "loopover_file_follow_up_issue",
      arguments: { repoFullName: "o/r", path: "src/a.ts", line: 42, finding: "Null check missing before dereference.", label: "gittensor:bug" },
    });
    expect(withLabel.isError).toBeFalsy();
    const spec = withLabel.structuredContent as Spec;
    expect(spec.action).toBe("file_issue");
    expect(spec.command).toContain("Follow up: src/a.ts:42");
    expect(spec.command).toContain("--label 'gittensor:bug'");

    const withoutLabel = await client.callTool({
      name: "loopover_file_follow_up_issue",
      arguments: { repoFullName: "o/r", path: "src/a.ts", finding: "Null check missing." },
    });
    expect(withoutLabel.isError).toBeFalsy();
    expect((withoutLabel.structuredContent as Spec).command).not.toContain("--label");
  });
});
