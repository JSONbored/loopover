import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

const EIGHT_CURRENT_BRANCH_TOOLS = [
  "loopover_preflight_current_branch",
  "loopover_preview_current_branch_score",
  "loopover_rank_local_next_actions",
  "loopover_explain_local_blockers",
  "loopover_remediation_plan",
  "loopover_prepare_pr_packet",
  "loopover_draft_pr_body",
  "loopover_agent_prepare_pr_packet",
] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
let loaded: BinModule;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-current-branch-input-"));
  const apiUrl = await startFixtureServer();
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  process.env.LOOPOVER_LOGIN = "JSONbored";
  loaded = (await import("../../packages/loopover-mcp/bin/loopover-mcp")) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_API_TOKEN;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
  delete process.env.LOOPOVER_LOGIN;
});

async function connectClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await loaded.server.connect(serverTransport);
  const client = new Client({ name: "current-branch-input-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("REGRESSION: the stdio branch tools must not demand a login the CLI resolves itself", () => {
  it("advertises no required login or repoFullName on the eight current-branch tools", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      for (const toolName of EIGHT_CURRENT_BRANCH_TOOLS) {
        const tool = tools.find((entry) => entry.name === toolName);
        expect(tool, toolName).toBeDefined();
        const required = (tool!.inputSchema as { required?: string[] }).required ?? [];
        expect(required, toolName).not.toContain("login");
        expect(required, toolName).not.toContain("repoFullName");
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("accepts an empty argument object without schema rejection for login or repoFullName", async () => {
    const client = await connectClient();
    try {
      for (const toolName of EIGHT_CURRENT_BRANCH_TOOLS) {
        const result = await client.callTool({ name: toolName, arguments: {} });
        const serialized = JSON.stringify(result);
        expect(serialized, toolName).not.toMatch(/required property ['"]login['"]/i);
        expect(serialized, toolName).not.toMatch(/required property ['"]repoFullName['"]/i);
        expect(serialized, toolName).not.toMatch(/-32602.*login/i);
        expect(serialized, toolName).not.toMatch(/-32602.*repoFullName/i);
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
