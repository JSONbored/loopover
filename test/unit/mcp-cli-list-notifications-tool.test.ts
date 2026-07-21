import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7761: in-process coverage for the loopover_list_notifications stdio tool.
// Import .ts + InMemoryTransport so Codecov attributes the new registerStdioTool lines.
// Handler is intentionally branch-free (no ?? / ?. / ternaries) after #7763 patch-partials failure.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const capturedRequests: Array<{ url: string; method: string }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-list-notifications-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      const url = request.url ?? "";
      if (url.includes("/notifications") && !url.includes("/notifications/read")) {
        capturedRequests.push({ url, method: request.method ?? "GET" });
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

describe("bin loopover_list_notifications stdio tool (in-process, #7761)", () => {
  it.each(MODULES)("registers and proxies GET .../notifications — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "list-notifications-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "loopover_list_notifications");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/notifications|unread/i);

      const result = await client.callTool({
        name: "loopover_list_notifications",
        arguments: { login: "JSONbored" },
      });
      expect(result.isError).toBeFalsy();
      expect(capturedRequests).toEqual([
        { url: "/v1/contributors/JSONbored/notifications", method: "GET" },
      ]);
      const text = JSON.stringify(result);
      expect(text).toContain("unreadCount");
      expect(text).toContain("d-42");
      expect(text).toContain("LoopOver notifications for JSONbored.");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
