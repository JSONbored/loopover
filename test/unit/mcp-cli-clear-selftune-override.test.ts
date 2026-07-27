import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #9300: in-process coverage for loopover_clear_selftune_override in packages/loopover-mcp/bin/loopover-mcp.ts.
// Same entrypoint-guard pattern as mcp-cli-selftune-audit — import the committed .ts so v8/Codecov
// attributes the new registerStdioTool + apiDelete lines.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const capturedDeletes: Array<{ url: string; method: string; body: { confirm?: boolean } }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-clear-selftune-"));
  const apiUrl = await startFixtureServer({
    onClearSelftuneOverride: (body) => {
      capturedDeletes.push({
        url: "/v1/repos/owner/repo/selftune/overrides",
        method: "DELETE",
        body,
      });
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

describe("bin loopover_clear_selftune_override stdio tool (in-process, #9300)", () => {
  it.each(MODULES)("registers and proxies DELETE .../selftune/overrides with confirm:true — %s", async (specifier) => {
    capturedDeletes.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "clear-selftune-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "loopover_clear_selftune_override");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/clear.*self-tune.*override/i);

      const result = await client.callTool({
        name: "loopover_clear_selftune_override",
        arguments: { owner: "owner", repo: "repo", confirm: true },
      });
      expect(result.isError).toBeFalsy();
      expect(capturedDeletes).toEqual([
        {
          url: "/v1/repos/owner/repo/selftune/overrides",
          method: "DELETE",
          body: { confirm: true },
        },
      ]);
      expect(JSON.stringify(result)).toMatch(/Cleared the live self-tune gate override for owner\/repo/);
      expect(JSON.stringify(result)).toContain('"cleared":true');
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it.each(MODULES)("rejects missing or false confirm without calling DELETE — %s", async (specifier) => {
    capturedDeletes.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "clear-selftune-reject-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const missing = await client
        .callTool({
          name: "loopover_clear_selftune_override",
          arguments: { owner: "owner", repo: "repo" },
        })
        .then(
          (r) => ({ isError: Boolean(r.isError), text: JSON.stringify(r) }),
          (e: unknown) => ({ isError: true, text: String(e) }),
        );
      expect(missing.isError).toBe(true);

      const falsy = await client
        .callTool({
          name: "loopover_clear_selftune_override",
          arguments: { owner: "owner", repo: "repo", confirm: false },
        })
        .then(
          (r) => ({ isError: Boolean(r.isError), text: JSON.stringify(r) }),
          (e: unknown) => ({ isError: true, text: String(e) }),
        );
      expect(falsy.isError).toBe(true);

      // Schema rejection must never reach the REST route.
      expect(capturedDeletes).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
