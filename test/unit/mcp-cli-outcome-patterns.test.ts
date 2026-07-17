import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// Mirrors mcp-cli-pr-reviewability.test.ts's shape: drive the REAL stdio server over the MCP client and assert
// what reached the fixture API, so the proxy is pinned end-to-end rather than by unit-testing a closure.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");
const FORBIDDEN_PUBLIC_TERMS = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let capturedRequests: Array<{ url: string; method: string }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-outcome-patterns-"));
  capturedRequests = [];
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/outcome-patterns")) {
        capturedRequests.push({ url: request.url ?? "", method: request.method ?? "GET" });
      }
    },
  });
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_API_TIMEOUT_MS: "5000",
    },
  });
  client = new Client({ name: "outcome-patterns-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_get_repo_outcome_patterns stdio proxy (#6734)", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("loopover_get_repo_outcome_patterns");
  });

  it("proxies owner/repo to GET /v1/repos/:owner/:repo/outcome-patterns via apiGet", async () => {
    const result = await client.callTool({
      name: "loopover_get_repo_outcome_patterns",
      arguments: { owner: "owner", repo: "repo" },
    });
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toContain("/v1/repos/owner/repo/outcome-patterns");
    expect(captured.method).toBe("GET");
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("returns the route's payload unchanged — output parity with the REST/MCP surfaces", async () => {
    // The issue's parity requirement: the CLI must not reshape, filter or summarize what the route returns, so
    // the same input yields the same answer on every surface. Asserted field-by-field rather than by a
    // substring, since a proxy that dropped `freshness` or `evidenceComplete` would still "contain" the rest.
    const result = await client.callTool({
      name: "loopover_get_repo_outcome_patterns",
      arguments: { owner: "owner", repo: "repo" },
    });
    // structuredContent is the route's payload verbatim (toolResult copies `data` onto it), so this pins the
    // real contract rather than re-parsing the human-readable summary+JSON text block.
    expect(result.structuredContent).toMatchObject({
      repoFullName: "owner/repo",
      freshness: { computedAt: "2026-05-30T00:00:00.000Z", stale: false },
      evidenceComplete: true,
      accepted: [{ pattern: "small, single-purpose diffs with a linked issue", support: 12 }],
      rejected: [{ pattern: "unlinked drive-by refactors", support: 4 }],
    });
  });

  it("percent-encodes owner/repo into the path", async () => {
    // encodeURIComponent is what stops a crafted owner/repo from escaping its path segment.
    await client.callTool({
      name: "loopover_get_repo_outcome_patterns",
      arguments: { owner: "own er", repo: "re/po" },
    });
    expect(capturedRequests[0]?.url).toContain("/v1/repos/own%20er/re%2Fpo/outcome-patterns");
  });
});
