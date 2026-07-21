import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7756: in-process coverage for the loopover_get_repo_onboarding_pack stdio tool.
// Same #7764 entrypoint-guard pattern as mcp-cli-repo-focus-manifest — import the .ts, hold the exported
// `server`, connect an InMemoryTransport so v8/Codecov attributes the registerStdioTool block (a subprocess
// spawn cannot be instrumented). Drives GET {repoBase}/onboarding-pack/preview end to end, covering both
// sides of the `refresh === true` query ternary.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const capturedRequests: Array<{ url: string; method: string }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-repo-onboarding-pack-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/onboarding-pack/preview")) {
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

describe("bin loopover_get_repo_onboarding_pack stdio tool (in-process, #7756)", () => {
  it.each(MODULES)("registers and proxies GET .../onboarding-pack/preview without a refresh query — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "repo-onboarding-pack-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "loopover_get_repo_onboarding_pack");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/onboarding pack|preview-only|not published/i);

      // refresh omitted -> the else side of `refresh === true`: no query string appended.
      const result = await client.callTool({
        name: "loopover_get_repo_onboarding_pack",
        arguments: { owner: "owner", repo: "repo" },
      });
      expect(capturedRequests.length).toBe(1);
      const captured = capturedRequests[0]!;
      expect(captured.url).toBe("/v1/repos/owner/repo/onboarding-pack/preview");
      expect(captured.url).not.toContain("refresh");
      expect(captured.method).toBe("GET");
      expect(result.isError).toBeFalsy();
      const text = JSON.stringify(result);
      expect(text).toContain("onboarding pack preview for owner/repo");
      expect(text).toContain("preview-only, not published");
      expect(text).toContain("Contributor onboarding");
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it.each(MODULES)("forwards ?refresh=true when refresh is true — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "repo-onboarding-pack-refresh", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      // refresh: true -> the true side of `refresh === true`: ?refresh=true appended.
      const result = await client.callTool({
        name: "loopover_get_repo_onboarding_pack",
        arguments: { owner: "owner", repo: "repo", refresh: true },
      });
      expect(capturedRequests.length).toBe(1);
      const captured = capturedRequests[0]!;
      expect(captured.url).toBe("/v1/repos/owner/repo/onboarding-pack/preview?refresh=true");
      expect(captured.method).toBe("GET");
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).toContain("onboarding pack preview for owner/repo");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
