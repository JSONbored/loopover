import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7808: in-process coverage for the loopover_get_repo_focus_manifest stdio tool in
// packages/loopover-mcp/bin/loopover-mcp.ts. The bin's stdio server is otherwise only exercised via
// subprocess spawn (mcp-cli-*.test.ts), which v8 cannot instrument -- #7764's entrypoint guard
// (isProcessEntrypoint) is what lets a test import the module without it binding stdin/hijacking argv,
// so the registered tool's apiGet-proxy body gets real Codecov-measured coverage. Only the committed .ts
// source is imported: since #7705 the compiled .js is a gitignored build artifact.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-focus-manifest-"));
  const apiUrl = await startFixtureServer();
  // The bin reads LOOPOVER_API_URL at module load, so set the env BEFORE importing (hence the dynamic import).
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "in-process-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = tempDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  for (const specifier of MODULES) {
    loaded.set(specifier, (await import(specifier)) as unknown as BinModule);
  }
});

afterAll(async () => {
  await closeFixtureServer();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_API_TOKEN;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

describe("bin loopover_get_repo_focus_manifest stdio tool (in-process, #7808)", () => {
  it.each(MODULES)("proxies GET /focus-manifest and returns the manifest + policy — %s", async (specifier) => {
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "focus-manifest-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "loopover_get_repo_focus_manifest",
        arguments: { owner: "owner", repo: "repo" },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("Focus manifest for owner/repo.");
      // The fixture's manifest/policy payload is proxied through verbatim.
      expect(text).toContain("focusPaths");
      expect(text).toContain("pathAllowlist");
      expect(text).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
    } finally {
      await client.close();
    }
  });
});
