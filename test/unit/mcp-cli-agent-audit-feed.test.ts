import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7757: in-process coverage for the loopover_get_agent_audit_feed stdio tool. Same #7764 entrypoint-guard
// pattern as mcp-cli-repo-focus-manifest -- import the .ts, hold the exported `server`, connect an
// InMemoryTransport so v8/Codecov attributes the registerStdioTool block (a subprocess spawn can't be
// instrumented). Exercises both the with- and without-query-filter paths.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const auditGets: Array<{ url: string; method: string }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-agent-audit-feed-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (r) => {
      if (r.url && r.url.includes("/agent/audit-feed")) auditGets.push({ url: r.url ?? "", method: r.method ?? "GET" });
    },
  });
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

describe("bin loopover_get_agent_audit_feed stdio tool (in-process, #7757)", () => {
  it.each(MODULES)("proxies GET .../agent/audit-feed, forwarding since + limit — %s", async (specifier) => {
    auditGets.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "agent-audit-feed-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find((entry) => entry.name === "loopover_get_agent_audit_feed");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/agent audit feed|approval-queue/i);

      const filtered = await client.callTool({
        name: "loopover_get_agent_audit_feed",
        arguments: { owner: "owner", repo: "repo", since: "2026-05-01T00:00:00.000Z", limit: 5 },
      });
      expect(filtered.isError).toBeFalsy();
      const url = auditGets.at(-1)!.url;
      expect(url).toContain("/v1/repos/owner/repo/agent/audit-feed?");
      expect(url).toContain("since=2026-05-01T00%3A00%3A00.000Z");
      expect(url).toContain("limit=5");
      expect(JSON.stringify(filtered)).toContain("events");

      // No filters -> the query string is omitted entirely (query.size === 0 branch).
      const unfiltered = await client.callTool({ name: "loopover_get_agent_audit_feed", arguments: { owner: "owner", repo: "repo" } });
      expect(unfiltered.isError).toBeFalsy();
      expect(auditGets.at(-1)!.url).toBe("/v1/repos/owner/repo/agent/audit-feed");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
