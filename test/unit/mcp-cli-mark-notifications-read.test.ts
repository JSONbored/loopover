import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7762: in-process coverage for the loopover_mark_notifications_read stdio tool. Same #7764 entrypoint-guard
// pattern as mcp-cli-repo-focus-manifest -- import the .ts, hold the exported `server`, connect an
// InMemoryTransport so v8/Codecov attributes the registerStdioTool block (a subprocess spawn cannot be
// instrumented). The bin reuses postMarkNotificationsRead, so this drives the POST proxy end to end.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const markReadBodies: unknown[] = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-mark-notifications-read-"));
  const apiUrl = await startFixtureServer({ onMarkNotificationsRead: (body) => markReadBodies.push(body) });
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

describe("bin loopover_mark_notifications_read stdio tool (in-process, #7762)", () => {
  it.each(MODULES)("registers and proxies POST .../notifications/read, marking all read — %s", async (specifier) => {
    markReadBodies.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "mark-notifications-read-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "loopover_mark_notifications_read");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/notifications as read|clears the badge/i);

      // No ids -> mark every delivered notification read (empty POST body).
      const all = await client.callTool({
        name: "loopover_mark_notifications_read",
        arguments: { login: "JSONbored" },
      });
      expect(all.isError).toBeFalsy();
      expect(JSON.stringify(all)).toContain("marked");
      expect(markReadBodies).toEqual([{}]);

      // Explicit ids -> forwarded as { ids } in the POST body.
      const some = await client.callTool({
        name: "loopover_mark_notifications_read",
        arguments: { login: "JSONbored", ids: ["d1", "d2"] },
      });
      expect(some.isError).toBeFalsy();
      expect(markReadBodies[1]).toEqual({ ids: ["d1", "d2"] });
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it.each(MODULES)("errors (no request) when no login can be resolved from arg/session/env — %s", async (specifier) => {
    markReadBodies.length = 0;
    // Exercise the login ?? session ?? env fallback chain bottoming out, and the resulting throw.
    const savedLogin = process.env.LOOPOVER_LOGIN;
    const savedGh = process.env.GITHUB_LOGIN;
    delete process.env.LOOPOVER_LOGIN;
    delete process.env.GITHUB_LOGIN;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "mark-notifications-read-nologin", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "loopover_mark_notifications_read", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/No GitHub login|LOOPOVER_LOGIN/i);
      expect(markReadBodies).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
      if (savedLogin !== undefined) process.env.LOOPOVER_LOGIN = savedLogin;
      if (savedGh !== undefined) process.env.GITHUB_LOGIN = savedGh;
    }
  });
});
