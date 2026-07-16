import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// #6149: the 8 miner write-tools are PURE local-execution spec builders (loopover never performs the write);
// each returns a { action, command, boundary } spec the caller runs with its OWN gh/git creds. These tests
// drive the real local stdio server and assert the composed spec, plus a zod-rejection failure path per tool.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-write-tools-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    // Write-tools are pure and never call the API, but the stdio server still needs a config dir + token to boot.
    env: { ...process.env, LOOPOVER_CONFIG_DIR: configDir, LOOPOVER_TOKEN: "session-token", LOOPOVER_API_TIMEOUT_MS: "5000" },
  });
  client = new Client({ name: "write-tools-test", version: "0.0.1" });
  await client.connect(transport);
});

afterEach(async () => {
  await client.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

const WRITE_TOOLS = [
  "loopover_open_pr",
  "loopover_file_issue",
  "loopover_apply_labels",
  "loopover_post_eligibility_comment",
  "loopover_create_branch",
  "loopover_delete_branch",
  "loopover_generate_tests",
  "loopover_file_follow_up_issue",
];

function spec(result: unknown): { action: string; command: string; boundary: string } {
  return (result as { structuredContent?: unknown }).structuredContent as { action: string; command: string; boundary: string };
}

describe("loopover-mcp write-tools (#6149)", () => {
  it("registers all 8 write-tools on the local stdio server", async () => {
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const name of WRITE_TOOLS) expect(names, `missing ${name}`).toContain(name);
  });

  it("loopover_open_pr composes a gh pr create spec (loopover never performs the write)", async () => {
    const result = await client.callTool({
      name: "loopover_open_pr",
      arguments: { repoFullName: "acme/widgets", base: "main", head: "feat-x", title: "Add X", body: "Body" },
    });
    expect(result.isError).toBeFalsy();
    const s = spec(result);
    expect(s.action).toBe("open_pr");
    expect(s.command).toContain("gh pr create --repo 'acme/widgets'");
    expect(s.command).toContain("--head 'feat-x'");
    expect(JSON.stringify(result)).not.toMatch(/wallet|hotkey|coldkey|reward estimate/i);
  });

  it("loopover_file_issue composes a gh issue create spec", async () => {
    const result = await client.callTool({
      name: "loopover_file_issue",
      arguments: { repoFullName: "acme/widgets", title: "Bug", body: "desc", labels: ["bug"] },
    });
    expect(result.isError).toBeFalsy();
    expect(spec(result).action).toBe("file_issue");
    expect(spec(result).command).toContain("gh issue create --repo 'acme/widgets'");
  });

  it("loopover_apply_labels composes a gh issue edit --add-label spec", async () => {
    const result = await client.callTool({
      name: "loopover_apply_labels",
      arguments: { repoFullName: "acme/widgets", number: 7, labels: ["bug", "help wanted"] },
    });
    expect(result.isError).toBeFalsy();
    expect(spec(result).action).toBe("apply_labels");
    expect(spec(result).command).toContain("gh issue edit 7 --repo 'acme/widgets'");
    expect(spec(result).command).toContain("--add-label");
  });

  it("loopover_post_eligibility_comment composes a gh issue comment spec", async () => {
    const result = await client.callTool({
      name: "loopover_post_eligibility_comment",
      arguments: { repoFullName: "acme/widgets", number: 7, body: "context" },
    });
    expect(result.isError).toBeFalsy();
    expect(spec(result).action).toBe("post_eligibility_comment");
    expect(spec(result).command).toContain("gh issue comment 7 --repo 'acme/widgets'");
  });

  it("loopover_create_branch composes a git switch -c spec", async () => {
    const result = await client.callTool({ name: "loopover_create_branch", arguments: { branch: "feat-x", base: "main" } });
    expect(result.isError).toBeFalsy();
    expect(spec(result).action).toBe("create_branch");
    expect(spec(result).command).toContain("git switch -c 'feat-x'");
  });

  it("loopover_delete_branch composes a git branch -D spec", async () => {
    const result = await client.callTool({ name: "loopover_delete_branch", arguments: { branch: "feat-x", remote: true } });
    expect(result.isError).toBeFalsy();
    expect(spec(result).action).toBe("delete_branch");
    expect(spec(result).command).toContain("git branch -D 'feat-x'");
  });

  it("loopover_generate_tests composes a boundary-safe test-scaffold spec for the detected framework", async () => {
    const result = await client.callTool({
      name: "loopover_generate_tests",
      arguments: { repoFullName: "acme/widgets", targetFiles: ["src/x.ts"], framework: "vitest" },
    });
    expect(result.isError).toBeFalsy();
    expect(spec(result).action).toBe("generate_tests");
    expect(spec(result).command).toContain("vitest");
  });

  it("loopover_file_follow_up_issue composes a follow-up gh issue create spec", async () => {
    const result = await client.callTool({
      name: "loopover_file_follow_up_issue",
      arguments: { repoFullName: "acme/widgets", path: "src/x.ts", finding: "possible leak" },
    });
    expect(result.isError).toBeFalsy();
    expect(spec(result).action).toBe("file_issue");
    expect(spec(result).command).toContain("gh issue create --repo 'acme/widgets'");
    expect(spec(result).command).toContain("Follow up");
  });

  it("rejects invalid input for each write-tool (zod input-schema validation)", async () => {
    // One representative invalid payload per tool: a missing/blank required field the shape forbids.
    const invalid: Record<string, Record<string, unknown>> = {
      loopover_open_pr: { repoFullName: "acme/widgets", base: "main", head: "feat-x", title: "", body: "b" }, // title min(1)
      loopover_file_issue: { repoFullName: "ab", title: "T", body: "b" }, // repoFullName min(3)
      loopover_apply_labels: { repoFullName: "acme/widgets", number: 7, labels: [] }, // labels min(1)
      loopover_post_eligibility_comment: { repoFullName: "acme/widgets", number: 0, body: "b" }, // number positive
      loopover_create_branch: { base: "main" }, // branch required
      loopover_delete_branch: { branch: "" }, // branch min(1)
      loopover_generate_tests: { repoFullName: "acme/widgets", targetFiles: ["src/x.ts"], framework: "mocha" }, // not in enum
      loopover_file_follow_up_issue: { repoFullName: "acme/widgets", path: "src/x.ts" }, // finding required
    };
    for (const [name, args] of Object.entries(invalid)) {
      const outcome = await client.callTool({ name, arguments: args }).then(
        (r) => ({ threw: false, isError: Boolean(r.isError) }),
        () => ({ threw: true, isError: true }),
      );
      expect(outcome.isError, `${name} should reject invalid input`).toBe(true);
    }
  });
});
