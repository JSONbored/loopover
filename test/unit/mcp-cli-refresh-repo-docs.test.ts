import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7754: in-process coverage for the loopover_refresh_repo_docs stdio tool. Same #7764 entrypoint-guard
// pattern as mcp-cli-repo-focus-manifest -- import the .ts, hold the exported `server`, connect an
// InMemoryTransport so v8/Codecov attributes the registerStdioTool block (a subprocess spawn can't be
// instrumented). The tool is a thin POST proxy, so one call exercises the whole handler.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const refreshCalls: Array<{ url: string; method: string }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-refresh-repo-docs-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (r) => {
      if (r.url && r.url.includes("/repo-docs/refresh")) refreshCalls.push({ url: r.url ?? "", method: r.method ?? "" });
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

describe("bin loopover_refresh_repo_docs stdio tool (in-process, #7754)", () => {
  it.each(MODULES)("proxies POST .../repo-docs/refresh and returns the PR result — %s", async (specifier) => {
    refreshCalls.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "refresh-repo-docs-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find((entry) => entry.name === "loopover_refresh_repo_docs");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/repo-doc refresh|opens a pull request/i);

      const result = await client.callTool({ name: "loopover_refresh_repo_docs", arguments: { owner: "owner", repo: "repo" } });
      expect(result.isError).toBeFalsy();
      expect(refreshCalls).toEqual([{ url: "/v1/repos/owner/repo/repo-docs/refresh", method: "POST" }]);
      const text = JSON.stringify(result);
      expect(text).toContain("opened");
      expect(text).toContain("pullNumber");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
