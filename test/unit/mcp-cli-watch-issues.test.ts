import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7763: in-process coverage for the loopover_watch_issues stdio tool. Same #7764 entrypoint-guard pattern as
// mcp-cli-repo-focus-manifest -- import the .ts, hold the exported `server`, connect an InMemoryTransport so
// v8/Codecov attributes the registerStdioTool block + the shared watchIssuesRequest helper (a subprocess spawn
// can't be instrumented). Drives all three actions (list=GET, watch=POST, unwatch=DELETE) end to end.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const watchGets: Array<{ method: string; url: string }> = [];
const watchWrites: Array<{ method: string; body: { repoFullName?: string; labels?: string[] } }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-watch-issues-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (r) => {
      if (r.method === "GET" && r.url && r.url.includes("/watches")) watchGets.push({ method: r.method ?? "", url: r.url ?? "" });
    },
    onWatchRequest: (req) => watchWrites.push(req),
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

async function connectClient(specifier: (typeof MODULES)[number], name: string) {
  const mod = loaded.get(specifier)!;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mod.server.connect(serverTransport);
  const client = new Client({ name, version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("bin loopover_watch_issues stdio tool (in-process, #7763)", () => {
  it.each(MODULES)("proxies list=GET, watch=POST (with/without labels), unwatch=DELETE — %s", async (specifier) => {
    watchGets.length = 0;
    watchWrites.length = 0;
    const client = await connectClient(specifier, "watch-issues-test");
    try {
      const tool = (await client.listTools()).tools.find((entry) => entry.name === "loopover_watch_issues");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/watch repos|grabbable/i);

      const list = await client.callTool({ name: "loopover_watch_issues", arguments: { login: "octocat", action: "list" } });
      expect(list.isError).toBeFalsy();
      expect(watchGets.at(-1)).toEqual({ method: "GET", url: "/v1/contributors/octocat/watches" });
      expect(JSON.stringify(list)).toContain("watching");

      const watch = await client.callTool({
        name: "loopover_watch_issues",
        arguments: { login: "octocat", action: "watch", repoFullName: "acme/widgets", labels: ["bug"] },
      });
      expect(watch.isError).toBeFalsy();
      expect(watchWrites.at(-1)).toEqual({ method: "POST", body: { repoFullName: "acme/widgets", labels: ["bug"] } });

      // No labels -> the shared helper omits the labels key entirely.
      await client.callTool({ name: "loopover_watch_issues", arguments: { login: "octocat", action: "watch", repoFullName: "acme/gadgets" } });
      expect(watchWrites.at(-1)).toEqual({ method: "POST", body: { repoFullName: "acme/gadgets" } });

      const unwatch = await client.callTool({
        name: "loopover_watch_issues",
        arguments: { login: "octocat", action: "unwatch", repoFullName: "acme/widgets" },
      });
      expect(unwatch.isError).toBeFalsy();
      expect(watchWrites.at(-1)).toEqual({ method: "DELETE", body: { repoFullName: "acme/widgets" } });
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it.each(MODULES)("errors (no request) when watch/unwatch is missing repoFullName — %s", async (specifier) => {
    watchWrites.length = 0;
    const client = await connectClient(specifier, "watch-issues-guard");
    try {
      const result = await client.callTool({ name: "loopover_watch_issues", arguments: { login: "octocat", action: "watch" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/requires repoFullName/i);
      expect(watchWrites).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it.each(MODULES)("errors when no login can be resolved from arg/session/env — %s", async (specifier) => {
    const savedLogin = process.env.LOOPOVER_LOGIN;
    const savedGh = process.env.GITHUB_LOGIN;
    delete process.env.LOOPOVER_LOGIN;
    delete process.env.GITHUB_LOGIN;
    const client = await connectClient(specifier, "watch-issues-nologin");
    try {
      const result = await client.callTool({ name: "loopover_watch_issues", arguments: { action: "list" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/No GitHub login|LOOPOVER_LOGIN/i);
    } finally {
      await client.close().catch(() => undefined);
      if (savedLogin !== undefined) process.env.LOOPOVER_LOGIN = savedLogin;
      if (savedGh !== undefined) process.env.GITHUB_LOGIN = savedGh;
    }
  });
});
