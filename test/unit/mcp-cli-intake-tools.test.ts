import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/dist/bin/loopover-mcp.js");
// #6151: the maintainer-triage / repo-owner-intake profiles recommend these 4 tools; assert none leak
// miner-private reward internals through the local stdio proxy.
const FORBIDDEN_PUBLIC_TERMS = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let configDir: string | null = null;
let capturedRequests: Array<{ url: string; method: string }>;

async function connect(options: { intakeStatus?: number } = {}) {
  configDir = mkdtempSync(join(tmpdir(), "loopover-intake-tools-"));
  capturedRequests = [];
  const apiUrl = await startFixtureServer({
    ...options,
    onApiRequest: (request) => {
      const url = request.url ?? "";
      if (/issue-quality|registration-readiness|gittensor-config-recommendation|skipped-pr-audit/.test(url)) {
        capturedRequests.push({ url, method: request.method ?? "GET" });
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
  client = new Client({ name: "intake-tools-test", version: "0.0.1" });
  await client.connect(transport);
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = null;
  transport = null;
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  configDir = null;
});

const INTAKE_TOOLS = [
  {
    name: "loopover_get_issue_quality",
    args: { owner: "owner", repo: "repo" },
    endpoint: "/v1/repos/owner/repo/issue-quality",
    contains: "actionability",
  },
  {
    name: "loopover_get_registration_readiness",
    args: { owner: "owner", repo: "repo" },
    endpoint: "/v1/repos/owner/repo/registration-readiness",
    contains: "directPrLaneReady",
  },
  {
    name: "loopover_get_config_recommendation",
    args: { owner: "owner", repo: "repo" },
    endpoint: "/v1/repos/owner/repo/gittensor-config-recommendation",
    contains: "privateOnly",
  },
  {
    name: "loopover_get_skipped_pr_audit",
    args: {},
    endpoint: "/v1/app/skipped-pr-audit",
    contains: "remediation",
  },
] as const;

describe("loopover-mcp intake stdio proxies (#6151)", () => {
  it("registers all 4 intake tools in the stdio server tool list", async () => {
    await connect();
    const { tools } = await client!.listTools();
    const names = tools.map((tool) => tool.name);
    for (const tool of INTAKE_TOOLS) expect(names).toContain(tool.name);
  });

  it("lists all 4 intake tools via `loopover-mcp tools --json` with non-empty descriptions", async () => {
    await connect();
    const payload = JSON.parse(run(["tools", "--json"])) as {
      tools: Array<{ name: string; description: string }>;
    };
    for (const tool of INTAKE_TOOLS) {
      const entry = payload.tools.find((t) => t.name === tool.name);
      expect(entry, `missing descriptor for ${tool.name}`).toBeTruthy();
      expect(entry!.description.trim().length).toBeGreaterThan(0);
    }
  });

  for (const tool of INTAKE_TOOLS) {
    it(`${tool.name} proxies to its REST endpoint and returns the payload`, async () => {
      await connect();
      const result = await client!.callTool({ name: tool.name, arguments: tool.args });
      expect(result.isError).toBeFalsy();
      expect(capturedRequests.length).toBe(1);
      expect(capturedRequests[0]!.url).toContain(tool.endpoint);
      expect(capturedRequests[0]!.method).toBe("GET");
      const text = JSON.stringify(result);
      expect(text).toContain(tool.contains);
      expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    });

    it(`${tool.name} surfaces an API failure as a tool error`, async () => {
      await connect({ intakeStatus: 503 });
      const result = await client!.callTool({ name: tool.name, arguments: tool.args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/503/);
    });
  }
});
