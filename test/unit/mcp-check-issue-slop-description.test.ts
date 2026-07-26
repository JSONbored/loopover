import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #8907: the stdio loopover_check_issue_slop tool description used to promise "slopRisk (0-100), band,
// findings, and the rubric", but the /v1/lint/issue-slop route strips the response to {band, findings}
// by design (#6990). Import the bin .ts + InMemoryTransport so the assertion reads the actual registered
// description, guarding the fix against a future regression.
const MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
let mod: BinModule;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-issue-slop-desc-"));
  const apiUrl = await startFixtureServer();
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  mod = (await import(MODULE)) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_API_TOKEN;
  delete process.env.LOOPOVER_API_TIMEOUT_MS;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

describe("bin loopover_check_issue_slop description (#8907)", () => {
  it("describes the {band, findings} response shape without stale slopRisk/rubric claims", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "issue-slop-desc-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "loopover_check_issue_slop");
      expect(tool).toBeDefined();
      const description = tool?.description ?? "";
      expect(description).toContain("band and findings");
      expect(description).not.toContain("slopRisk");
      expect(description).not.toContain("the rubric");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
