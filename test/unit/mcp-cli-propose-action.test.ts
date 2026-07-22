import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7753: in-process coverage for the loopover_propose_action stdio tool. Same #7764 entrypoint-guard pattern as
// mcp-cli-repo-focus-manifest -- import the .ts, hold the exported `server`, connect an InMemoryTransport so
// v8/Codecov attributes the registerStdioTool block (a subprocess spawn CANNOT be instrumented -- earlier
// subprocess-only attempts at this exact tool were closed for 0% patch coverage).
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const proposeCalls: Array<{ url: string; method: string }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-propose-action-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (r) => {
      if (r.method === "POST" && r.url && r.url.includes("/agent/pending-actions")) proposeCalls.push({ url: r.url ?? "", method: r.method ?? "" });
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

describe("bin loopover_propose_action stdio tool (in-process, #7753)", () => {
  it.each(MODULES)("stages an action via POST .../agent/pending-actions, forwarding the body — %s", async (specifier) => {
    proposeCalls.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "propose-action-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find((entry) => entry.name === "loopover_propose_action");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/approval queue|NOT executed until approved/i);

      const result = await client.callTool({
        name: "loopover_propose_action",
        arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "label", reason: "needs triage", label: "bug" },
      });
      expect(result.isError).toBeFalsy();
      expect(proposeCalls).toEqual([{ url: "/v1/repos/owner/repo/agent/pending-actions", method: "POST" }]);
      // The fixture echoes the posted actionClass/pullNumber/reason, proving the body was serialized + forwarded.
      const data = result.structuredContent as { created?: boolean; action?: { actionClass?: string; pullNumber?: number; reason?: string } };
      expect(data.created).toBe(true);
      expect(data.action?.actionClass).toBe("label");
      expect(data.action?.pullNumber).toBe(7);
      expect(data.action?.reason).toBe("needs triage");
      expect(JSON.stringify(result)).toContain("Staged label on owner/repo#7 into the approval queue.");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
