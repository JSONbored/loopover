import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7760: in-process coverage for the stdio loopover_get_contributor_profile tool AND the exported
// contributorProfileCli, both in packages/loopover-mcp/bin/loopover-mcp.ts. The bin is otherwise only exercised
// via subprocess spawn (the sibling mcp-cli-contributor-profile.test.ts), which v8 cannot instrument -- the
// isProcessEntrypoint guard is what lets a test import the module without it hijacking argv / binding stdin, so
// the shared getContributorProfile call + the new stdio handler get real Codecov-measured coverage. Same shape
// as mcp-cli-plan-issues.test.ts / mcp-cli-activation-preview.test.ts. Only the committed .ts source is imported.
const MODULES = ["../../packages/loopover-mcp/bin/loopover-mcp.ts"] as const;

type BinModule = {
  contributorProfileCli: (options: { login?: string; json?: boolean }) => Promise<void>;
  server: { connect: (transport: unknown) => Promise<void> };
};

let tempDir = "";
const capturedRequests: Array<{ url: string; method: string }> = [];
const loaded = new Map<string, BinModule>();

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "loopover-contributor-profile-inprocess-"));
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/profile")) {
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
  delete process.env.LOOPOVER_API_TIMEOUT_MS;
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

describe("bin loopover_get_contributor_profile stdio tool (in-process, #7760)", () => {
  it.each(MODULES)("registers and proxies GET /v1/contributors/:login/profile — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "contributor-profile-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "loopover_get_contributor_profile");
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/contributor profile/i);

      const result = await client.callTool({
        name: "loopover_get_contributor_profile",
        arguments: { login: "octocat" },
      });
      expect(capturedRequests.length).toBe(1);
      const captured = capturedRequests[0]!;
      expect(captured.url).toContain("/v1/contributors/octocat/profile");
      expect(captured.method).toBe("GET");
      expect(result.isError).toBeFalsy();
      // structuredContent is the raw API payload; the summary line is the remote tool's fixed sentence.
      expect(result.structuredContent).toMatchObject({ login: "octocat" });
      const text = JSON.stringify(result);
      expect(text).toContain("LoopOver contributor profile for octocat.");
      expect(text).toContain("3 registered repos; 12 merged PRs; strongest in review-tooling.");
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it.each(MODULES)("url-encodes the login in the proxied path — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mod.server.connect(serverTransport);
    const client = new Client({ name: "contributor-profile-encode-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      await client.callTool({ name: "loopover_get_contributor_profile", arguments: { login: "a b/c" } });
      expect(capturedRequests.at(-1)!.url).toContain("/v1/contributors/a%20b%2Fc/profile");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe("bin contributor-profile CLI (in-process, #7760)", () => {
  it.each(MODULES)("shares getContributorProfile with the stdio tool: prints the header + API summary — %s", async (specifier) => {
    capturedRequests.length = 0;
    const mod = loaded.get(specifier)!;
    const out = await captureStdout(() => mod.contributorProfileCli({ login: "octocat" }));
    expect(capturedRequests.at(-1)!.url).toBe("/v1/contributors/octocat/profile");
    expect(out).toMatch(/LoopOver contributor profile for octocat\./);
    expect(out).toContain("3 registered repos; 12 merged PRs; strongest in review-tooling.");
  });

  it.each(MODULES)("--json re-serializes the same payload the shared call returned — %s", async (specifier) => {
    const mod = loaded.get(specifier)!;
    const out = await captureStdout(() => mod.contributorProfileCli({ login: "octocat", json: true }));
    const payload = JSON.parse(out) as { login: string; summary: string };
    expect(payload).toMatchObject({ login: "octocat", summary: "3 registered repos; 12 merged PRs; strongest in review-tooling." });
  });
});
