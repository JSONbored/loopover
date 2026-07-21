import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7764: the local stdio mirror of the remote loopover_plan_repo_issues tool. Asserts the proxy contract -- that
// the tool reaches POST /issue-plan-drafts/generate (the same route `maintain plan-issues` calls) with the goal +
// dry-run posture -- rather than re-testing the endpoint itself, which routes-issue-plan-draft.test.ts covers.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let configDir: string | null = null;
let planBodies: Array<{ goal?: string; dryRun?: boolean; create?: boolean; limit?: number; milestone?: unknown }>;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "loopover-plan-repo-issues-"));
  planBodies = [];
  const apiUrl = await startFixtureServer({ onIssuePlanRequest: (body) => planBodies.push(body) });
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
  client = new Client({ name: "plan-repo-issues-mirror-test", version: "0.0.1" });
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

describe("loopover_plan_repo_issues stdio mirror (#7764)", () => {
  it("registers the tool in the stdio server tool list, with owner/repo/goal in its schema", async () => {
    await connect();
    const tool = (await client!.listTools()).tools.find((entry) => entry.name === "loopover_plan_repo_issues");
    expect(tool, "loopover_plan_repo_issues is not registered").toBeTruthy();
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(["create", "dryRun", "goal", "limit", "milestone", "owner", "repo"]);
  });

  it("proxies a dry-run goal to POST /issue-plan-drafts/generate and returns the payload", async () => {
    await connect();
    const result = await client!.callTool({ name: "loopover_plan_repo_issues", arguments: { ...REPO, goal: "add pagination" } });
    expect(result.isError).toBeFalsy();
    // Schema defaults resolve dryRun:true / create:false before the handler forwards them.
    expect(planBodies[0]).toMatchObject({ goal: "add pagination", dryRun: true, create: false });
    expect(JSON.stringify(result)).toContain("proposed");
  });

  it("forwards create:true and a maintainer-supplied milestone", async () => {
    await connect();
    const result = await client!.callTool({
      name: "loopover_plan_repo_issues",
      arguments: { ...REPO, goal: "add pagination", create: true, dryRun: false, limit: 3, milestone: { title: "Wave 2", description: "Parity work" } },
    });
    expect(result.isError).toBeFalsy();
    expect(planBodies[0]).toMatchObject({ goal: "add pagination", create: true, dryRun: false, limit: 3, milestone: { title: "Wave 2", description: "Parity work" } });
  });

  it("surfaces an API failure as a tool error for a repo the fixture does not serve", async () => {
    await connect();
    const result = await client!.callTool({ name: "loopover_plan_repo_issues", arguments: { owner: "nobody", repo: "missing", goal: "x" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/404|not_found/);
  });
});
