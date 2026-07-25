import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const bin = join(process.cwd(), "packages/loopover-mcp/dist/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

// An unreachable API endpoint with a tight timeout: if the tool ever regressed to proxying over HTTP
// (`apiPost("/v1/lint/pr-text", …)`) instead of computing in-process, every call below would error out
// against this dead address. Their success is what proves the local tool runs fully offline (#6268).
async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-lint-pr-text-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...(process.env as Record<string, string>),
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_API_URL: "http://127.0.0.1:1",
      LOOPOVER_API_TIMEOUT_MS: "400",
    },
  });
  client = new Client({ name: "lint-pr-text-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_lint_pr_text stdio tool (#6268)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("advertises the in-process, no-round-trip behavior in the tool list", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "loopover_lint_pr_text");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("no API round-trip");
  });

  it("regression: returns a strong verdict computed in-process, with no network call", async () => {
    const result = await client.callTool({
      name: "loopover_lint_pr_text",
      arguments: {
        commitMessages: ["feat(mcp): compute lint-pr-text offline in the local CLI"],
        prBody: "Extracts the PR-text-lint rubric into a buildable engine module so the local tool runs in-process. Validated with npm run test:coverage.",
        linkedIssue: 6268,
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { verdict: string; score: number; fixes: string[] };
    expect(data.verdict).toBe("strong");
    expect(data.score).toBe(100);
    expect(data.fixes).toEqual([]);
  });

  it("surfaces a weak verdict with actionable fixes offline for low-effort text", async () => {
    const result = await client.callTool({
      name: "loopover_lint_pr_text",
      arguments: { commitMessages: ["wip"] },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { verdict: string; fixes: string[] };
    expect(data.verdict).toBe("weak");
    expect(data.fixes.length).toBeGreaterThan(0);
  });

  it("never leaks private financial terminology in the offline response", async () => {
    const result = await client.callTool({
      name: "loopover_lint_pr_text",
      arguments: { commitMessages: ["update"], prBody: "" },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).not.toMatch(/hotkey|coldkey|wallet|mnemonic|payout|reward|trust score/i);
  });
});
