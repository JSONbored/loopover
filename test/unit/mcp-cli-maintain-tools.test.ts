import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

// #6152: the maintain CLI's REST surface, exposed as stdio tools. These assert the proxy contract -- that each
// tool reaches the endpoint its CLI subcommand already calls, with the same method and body -- rather than
// re-testing the endpoints themselves, which test/unit/mcp-cli-maintain.test.ts already covers via the CLI.
let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let configDir: string | null = null;
let capturedRequests: Array<{ url: string; method: string }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-maintain-tools-"));
  capturedRequests = [];
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      const url = request.url ?? "";
      if (/pending-actions|settings|gate-precision|outcome-calibration|automation-state/.test(url)) capturedRequests.push({ url, method: request.method ?? "GET" });
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
  client = new Client({ name: "maintain-tools-test", version: "0.0.1" });
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

const REPO = { owner: "owner", repo: "repo" };

/** Every #6152 tool (plus #7758's outcome-calibration sibling), with an argument set the fixture serves
 *  and a field its real payload carries. */
const MAINTAIN_TOOLS = [
  { name: "loopover_list_pending_actions", args: REPO, contains: "pa-1" },
  { name: "loopover_decide_pending_action", args: { ...REPO, id: "pa-1", decision: "accept" }, contains: "accepted" },
  { name: "loopover_set_agent_paused", args: { ...REPO, paused: true }, contains: "agentPaused" },
  { name: "loopover_set_action_autonomy", args: { ...REPO, action: "merge", level: "auto" }, contains: "autonomy" },
  { name: "loopover_get_gate_precision", args: REPO, contains: "falsePositiveRate" },
  { name: "loopover_get_outcome_calibration", args: REPO, contains: "positiveRate" },
  { name: "loopover_get_automation_state", args: REPO, contains: "permissionReadiness" },
] as const;

describe("loopover-mcp maintain stdio proxies (#6152)", () => {
  it("registers all 7 maintain tools in the stdio server tool list", async () => {
    await connect();
    const names = (await client!.listTools()).tools.map((tool) => tool.name);
    for (const tool of MAINTAIN_TOOLS) expect(names).toContain(tool.name);
  });

  it("lists all 7 maintain tools via `loopover-mcp tools --json` with non-empty descriptions", async () => {
    await connect();
    const payload = JSON.parse(run(["tools", "--json"])) as { tools: Array<{ name: string; description: string; category?: string }> };
    for (const tool of MAINTAIN_TOOLS) {
      const entry = payload.tools.find((t) => t.name === tool.name);
      expect(entry, `missing descriptor for ${tool.name}`).toBeTruthy();
      expect(entry!.description.trim().length).toBeGreaterThan(0);
    }
  });

  for (const tool of MAINTAIN_TOOLS) {
    it(`${tool.name} proxies to its REST endpoint and returns the payload`, async () => {
      await connect();
      const result = await client!.callTool({ name: tool.name, arguments: { ...tool.args } });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).toContain(tool.contains);
      expect(capturedRequests.length).toBeGreaterThan(0);
      for (const request of capturedRequests) expect(request.url).toContain("/v1/repos/owner/repo/");
    });

    // The fixture serves owner/repo only and 404s anything else, so an unregistered repo exercises the same
    // failure path a real caller hits without maintainer access to the target: an API error, surfaced as a tool
    // error rather than a silent empty success.
    it(`${tool.name} surfaces an API failure as a tool error`, async () => {
      await connect();
      const result = await client!.callTool({ name: tool.name, arguments: { ...tool.args, owner: "nobody", repo: "missing" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/404|not_found/);
    });
  }

  // GET /agent/pending-actions takes no query parameters and hardcodes status "pending" (src/api/routes.ts), so
  // this server cannot honour the `status` filter its remote counterpart offers. The tool therefore doesn't
  // advertise one: an agent reads the published schema to decide what to send, so a filter absent from the schema
  // is a filter it won't ask for -- and can't be told "ok" about. (An unknown key sent anyway is dropped by the
  // MCP layer before the handler, so it can never reach the URL either.)
  it("list_pending_actions advertises no status filter, which this server's route could not honour", async () => {
    await connect();
    const tool = (await client!.listTools()).tools.find((entry) => entry.name === "loopover_list_pending_actions");
    expect(tool, "loopover_list_pending_actions is not registered").toBeTruthy();
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(["owner", "repo"]);

    const result = await client!.callTool({ name: "loopover_list_pending_actions", arguments: { ...REPO, status: "rejected" } });
    expect(result.isError).toBeFalsy();
    for (const request of capturedRequests) expect(request.url).not.toContain("status=");
  });

  it("set_action_autonomy read-merge-writes so the other action classes survive", async () => {
    await connect();
    const result = await client!.callTool({ name: "loopover_set_action_autonomy", arguments: { ...REPO, action: "merge", level: "auto" } });
    expect(result.isError).toBeFalsy();
    // The fixture's stored autonomy is { label: "auto" }; a blind PUT of just `merge` would drop it.
    const payload = JSON.stringify(result);
    expect(payload).toContain("label");
    expect(payload).toContain("merge");
    expect(capturedRequests.map((request) => request.method)).toEqual(["GET", "PUT"]);
  });

  it("rejects an unknown action class and an unknown autonomy level before any API call", async () => {
    await connect();
    for (const args of [
      { ...REPO, action: "bogus", level: "auto" },
      { ...REPO, action: "merge", level: "bogus" },
    ]) {
      const result = await client!.callTool({ name: "loopover_set_action_autonomy", arguments: args });
      expect(result.isError).toBe(true);
    }
    expect(capturedRequests).toEqual([]);
  });
});
