import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7755: in-process coverage for the loopover_generate_contributor_issue_drafts stdio tool. Same #7764
// entrypoint-guard pattern as mcp-cli-repo-focus-manifest -- import the .ts, hold the exported `server`,
// connect an InMemoryTransport so v8/Codecov attributes the registerStdioTool block (a subprocess spawn can't
// be instrumented). Verifies the create-safety forwarding: dry-run by default, explicit create only on request.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const draftBodies: Array<{ dryRun?: boolean; create?: boolean; limit?: number }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-generate-issue-drafts-"));
  const apiUrl = await startFixtureServer({ onIssueDraftRequest: (body) => draftBodies.push(body) });
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  for (const specifier of MODULES) {
    loaded.set(specifier, (await import(specifier)) as unknown as BinModule);
  }
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_API_TOKEN;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

describe("bin loopover_generate_contributor_issue_drafts stdio tool (in-process, #7755)", () => {
  it.each(MODULES)("dry-runs by default and only writes on explicit create+dryRun=false — %s", async (specifier) => {
    draftBodies.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "generate-issue-drafts-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find((entry) => entry.name === "loopover_generate_contributor_issue_drafts");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/issue drafts|dry-run/i);

      // Defaults: schema fills dryRun=true, create=false, limit=5 -> a safe preview.
      const preview = await client.callTool({ name: "loopover_generate_contributor_issue_drafts", arguments: { owner: "owner", repo: "repo" } });
      expect(preview.isError).toBeFalsy();
      expect(draftBodies.at(-1)).toEqual({ dryRun: true, create: false, limit: 5 });
      expect(JSON.stringify(preview)).toContain("Contributor issue drafts for owner/repo.");

      // Explicit write: only {create:true, dryRun:false} reaches the write path.
      const write = await client.callTool({
        name: "loopover_generate_contributor_issue_drafts",
        arguments: { owner: "owner", repo: "repo", create: true, dryRun: false, limit: 3 },
      });
      expect(write.isError).toBeFalsy();
      expect(draftBodies.at(-1)).toEqual({ dryRun: false, create: true, limit: 3 });
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
