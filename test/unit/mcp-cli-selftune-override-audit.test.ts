import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7798: in-process coverage for the loopover_get_selftune_override_audit stdio tool.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const capturedRequests: Array<{ url: string; method: string }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-selftune-audit-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/selftune/overrides/audit")) {
        capturedRequests.push({ url: request.url ?? "", method: request.method ?? "GET" });
      }
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

describe("bin loopover_get_selftune_override_audit stdio tool (in-process, #7798)", () => {
  it.each(MODULES)("registers and proxies GET .../selftune/overrides/audit — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "selftune-audit-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "loopover_get_selftune_override_audit");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/self-tune override audit/i);

      const unlimited = await client.callTool({
        name: "loopover_get_selftune_override_audit",
        arguments: { owner: "owner", repo: "repo" },
      });
      expect(capturedRequests.length).toBe(1);
      expect(capturedRequests[0]!.url).toContain("/v1/repos/owner/repo/selftune/overrides/audit");
      expect(capturedRequests[0]!.url).not.toContain("limit=");
      expect(capturedRequests[0]!.method).toBe("GET");
      expect(unlimited.isError).toBeFalsy();
      expect(JSON.stringify(unlimited)).toContain("override_promoted");

      capturedRequests.length = 0;
      const limited = await client.callTool({
        name: "loopover_get_selftune_override_audit",
        arguments: { owner: "owner", repo: "repo", limit: 1 },
      });
      expect(capturedRequests.length).toBe(1);
      expect(capturedRequests[0]!.url).toContain("limit=1");
      expect(limited.isError).toBeFalsy();
      const data = limited.structuredContent as { audit: unknown[] };
      expect(data.audit).toHaveLength(1);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
