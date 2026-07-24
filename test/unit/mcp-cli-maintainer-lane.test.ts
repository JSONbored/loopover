import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/dist/bin/loopover-mcp.js");
const FORBIDDEN_PUBLIC_TERMS = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let apiUrl: string;
let capturedRequests: Array<{ url: string; method: string }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "gittensory-maintainer-lane-"));
  capturedRequests = [];
  apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url && request.url.includes("/intelligence")) {
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
  client = new Client({ name: "maintainer-lane-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("loopover_get_maintainer_lane stdio proxy", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("loopover_get_maintainer_lane");
  });

  it("proxies owner/repo to /v1/repos/:owner/:repo/intelligence via apiGet and returns the maintainer lane", async () => {
    const result = await client.callTool({ name: "loopover_get_maintainer_lane", arguments: { owner: "owner", repo: "repo" } });
    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toContain("/v1/repos/owner/repo/intelligence");
    expect(captured.method).toBe("GET");
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(text).toContain("maintainerLane");
    expect(text).toContain("owner/repo");
  });

  it("hits the SAME /intelligence route its sibling loopover_get_label_audit uses, extracting only its own field", async () => {
    // maintainerLane sits beside labelAudit in one buildRepoIntelligenceResponse payload; both tools are thin
    // extractions over the identical GET, so the mirrored surfaces must agree on the route and repo identity.
    const lane = await client.callTool({ name: "loopover_get_maintainer_lane", arguments: { owner: "owner", repo: "repo" } });
    const audit = await client.callTool({ name: "loopover_get_label_audit", arguments: { owner: "owner", repo: "repo" } });

    expect(capturedRequests.map((request) => request.url)).toEqual([
      expect.stringContaining("/v1/repos/owner/repo/intelligence"),
      expect.stringContaining("/v1/repos/owner/repo/intelligence"),
    ]);
    const laneContent = lane.structuredContent as Record<string, unknown> | undefined;
    const auditContent = audit.structuredContent as Record<string, unknown> | undefined;
    expect(laneContent?.repoFullName).toEqual(auditContent?.repoFullName);
    expect(laneContent?.generatedAt).toEqual(auditContent?.generatedAt);
    // Each tool surfaces only its own slice of the shared response.
    expect(laneContent).toHaveProperty("maintainerLane");
    expect(laneContent).not.toHaveProperty("labelAudit");
    expect(auditContent).toHaveProperty("labelAudit");
    expect(auditContent).not.toHaveProperty("maintainerLane");
  });
});
