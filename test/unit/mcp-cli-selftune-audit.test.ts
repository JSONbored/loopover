import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7798: in-process coverage for the `maintain selftune-audit` CLI dispatcher AND the
// loopover_get_selftune_override_audit stdio tool in packages/loopover-mcp/bin/loopover-mcp.ts. Same #7764
// entrypoint-guard pattern as mcp-cli-plan-issues — import the committed .ts, call the exported maintainCli /
// hold the exported `server`, so v8/Codecov attributes the new dispatcher and registerStdioTool lines.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  maintainCli: (args: string[]) => Promise<void>;
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const capturedRequests: Array<{ url: string; method: string }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-selftune-audit-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/selftune/overrides/audit")) {
        capturedRequests.push({ url: request.url ?? "", method: request.method ?? "GET" });
      }
    },
  });
  // The bin reads LOOPOVER_API_URL at module load, so set the env BEFORE importing (hence the dynamic import).
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

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

describe("bin maintain selftune-audit CLI (in-process, #7798)", () => {
  it.each(MODULES)("lists the audit trail newest first, rendering detail-bearing and detail-less events — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const out = await captureStdout(() => mod.maintainCli(["selftune-audit", "--repo", "owner/repo"]));
    expect(capturedRequests[0]!.url).toBe("/v1/repos/owner/repo/selftune/overrides/audit");
    expect(out).toMatch(/Self-tune override audit for owner\/repo: 2 event\(s\)\./);
    // A detail-bearing event renders its payload; a detail-less event renders without a trailing blob.
    expect(out).toMatch(/- 2026-06-02T00:00:00\.000Z promoted \{"confidenceFloor":0\.91\}/);
    expect(out).toMatch(/- 2026-06-01T00:00:00\.000Z shadow_written$/m);
  });

  it.each(MODULES)("--limit forwards as ?limit and caps the rows — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const out = await captureStdout(() => mod.maintainCli(["selftune-audit", "--repo", "owner/repo", "--limit", "1"]));
    expect(capturedRequests[0]!.url).toBe("/v1/repos/owner/repo/selftune/overrides/audit?limit=1");
    expect(out).toMatch(/Self-tune override audit for owner\/repo: 1 event\(s\)\./);
  });

  it.each(MODULES)("emits machine-readable JSON with --json — %s", async (specifier) => {
    const mod = loaded.get(specifier)!;
    const out = await captureStdout(() => mod.maintainCli(["selftune-audit", "--repo", "owner/repo", "--json"]));
    const payload = JSON.parse(out) as { repoFullName: string; audit: Array<{ eventType: string }> };
    expect(payload.repoFullName).toBe("owner/repo");
    expect(payload.audit.map((event) => event.eventType)).toEqual(["promoted", "shadow_written"]);
  });

  it.each(MODULES)("renders zero events for a payload without audit rows — %s", async (specifier) => {
    // owner/bare's fixture responds without an `audit` key, exercising the CLI's defensive fallback the same
    // way a real disabled/empty deployment would.
    const mod = loaded.get(specifier)!;
    const out = await captureStdout(() => mod.maintainCli(["selftune-audit", "--repo", "owner/bare"]));
    expect(out).toMatch(/Self-tune override audit for owner\/bare: 0 event\(s\)\./);
    expect(out).not.toMatch(/^- /m);
  });

  it.each(MODULES)("falls through past selftune-audit to the unknown-subcommand error — %s", async (specifier) => {
    const mod = loaded.get(specifier)!;
    // Exercises the false side of `subcommand === "selftune-audit"` and the updated unknown-subcommand throw.
    await expect(mod.maintainCli(["not-a-real-subcommand", "--repo", "owner/repo"])).rejects.toThrow(/Unknown maintain subcommand.*selftune-audit/);
  });

  it.each(MODULES)("documents selftune-audit in the maintain --help output — %s", async (specifier) => {
    const mod = loaded.get(specifier)!;
    const out = await captureStdout(() => mod.maintainCli(["--help"]));
    expect(out).toContain("selftune-audit [--limit N]");
    expect(out).toContain("self-tune override audit trail");
  });
});

describe("bin loopover_get_selftune_override_audit stdio tool (in-process, #7798)", () => {
  it.each(MODULES)("registers and proxies GET .../selftune/overrides/audit with and without limit — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "selftune-audit-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "loopover_get_selftune_override_audit");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/override audit trail/i);

      const result = await client.callTool({
        name: "loopover_get_selftune_override_audit",
        arguments: { owner: "owner", repo: "repo" },
      });
      expect(result.isError).toBeFalsy();
      expect(capturedRequests[0]!).toEqual({ url: "/v1/repos/owner/repo/selftune/overrides/audit", method: "GET" });
      expect(JSON.stringify(result)).toContain("shadow_written");

      const capped = await client.callTool({
        name: "loopover_get_selftune_override_audit",
        arguments: { owner: "owner", repo: "repo", limit: 1 },
      });
      expect(capped.isError).toBeFalsy();
      expect(capturedRequests[1]!.url).toBe("/v1/repos/owner/repo/selftune/overrides/audit?limit=1");
      const cappedText = JSON.stringify(capped);
      expect(cappedText).toContain("promoted");
      expect(cappedText).not.toContain("shadow_written");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
