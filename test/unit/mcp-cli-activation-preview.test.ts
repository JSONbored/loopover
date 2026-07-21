import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// (#7799, updated for #7764) In-process coverage of the stdio loopover_get_activation_preview proxy.
// After #7764 the bin only binds StdioServerTransport when launched as the process entrypoint; in-process
// importers get the exported `server` and must connect an InMemoryTransport themselves (same pattern as
// mcp-cli-plan-issues.test.ts / mcp-cli-registry-snapshot.test.ts). The pre-#7764 StdioServerTransport mock
// deadlocks once another file imports the bin first — that is what broke validate-tests on #7913.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

const FORBIDDEN_PUBLIC_TERMS =
  /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let tempDir = "";
const capturedRequests: Array<{ url: string; method: string }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-activation-preview-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/activation-preview")) {
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

describe("bin loopover_get_activation_preview stdio tool (in-process, #7799)", () => {
  it.each(MODULES)("registers and proxies GET .../activation-preview — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "activation-preview-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "loopover_get_activation_preview");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/activation preview/i);

      const result = await client.callTool({
        name: "loopover_get_activation_preview",
        arguments: { owner: "owner", repo: "repo" },
      });
      expect(capturedRequests.length).toBe(1);
      const captured = capturedRequests[0]!;
      expect(captured.url).toContain("/v1/repos/owner/repo/activation-preview");
      expect(captured.method).toBe("GET");
      expect(result.isError).toBeFalsy();
      const text = JSON.stringify(result);
      expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
      expect(text).toContain("owner/repo");
      expect(text).toContain("evaluatedCount");
      expect(text).toContain("enable_advisory");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
