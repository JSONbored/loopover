// #4777: retire every gittensory_-prefixed deprecated alias that #4775 left in place for one
// minor-version deprecation cycle. This suite pins the post-retirement shape: exactly the 37
// canonical loopover_-prefixed stdio tools are registered, none of their old gittensory_-prefixed
// alias names resolve anymore, no description carries a stale deprecation notice, and the CLI's
// `tools --json` listing stays in lockstep with what the live server actually registers.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

async function connect(apiUrl: string) {
  configDir = mkdtempSync(join(tmpdir(), "gittensory-rename-alias-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      GITTENSORY_CONFIG_DIR: configDir,
      GITTENSORY_API_URL: apiUrl,
      GITTENSORY_API_TIMEOUT_MS: "5000",
    },
  });
  client = new Client({ name: "rename-alias-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("MCP legacy alias retirement (#4777) — discovery invariants", () => {
  beforeEach(async () => {
    const apiUrl = await startFixtureServer();
    await connect(apiUrl);
  });
  afterEach(disconnect);

  it("lists exactly 37 loopover_ tools and zero gittensory_-prefixed aliases", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const primary = names.filter((n) => n.startsWith("loopover_"));
    const legacy = names.filter((n) => n.startsWith("gittensory_"));
    expect(primary.length).toBe(37);
    expect(legacy.length).toBe(0);
    expect(names.length).toBe(37);
  });

  it("no loopover_ tool's description carries a stale deprecation notice", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description ?? "", `${tool.name} description`).not.toMatch(/deprecated/i);
    }
  });

  it("`gittensory-mcp tools --json` reports the same 37-tool count the live server registers", async () => {
    const { tools } = await client.listTools();
    const payload = JSON.parse(run(["tools", "--json"])) as { count: number; tools: Array<{ name: string }> };
    expect(payload.count).toBe(tools.length);
    expect(payload.count).toBe(37);
    expect([...payload.tools.map((t) => t.name)].sort()).toEqual([...tools.map((t) => t.name)].sort());
  });
});

describe("MCP legacy alias retirement (#4777) — old names no longer resolve", () => {
  beforeEach(async () => {
    const apiUrl = await startFixtureServer();
    await connect(apiUrl);
  });
  afterEach(disconnect);

  // Representative sample spanning distinct tool categories (mirrors the pre-retirement suite's
  // coverage): an authenticated API GET proxy, a source-free API POST self-check, a no-argument
  // API GET, an API GET with a path parameter, and pure local logic with no network call.
  const retiredNames = [
    "gittensory_get_repo_context",
    "gittensory_check_slop_risk",
    "gittensory_get_upstream_drift",
    "gittensory_agent_get_run",
    "gittensory_feasibility_gate",
    "gittensory_local_status_structured",
    "gittensory_local_status",
  ];

  it.each(retiredNames)("calling the retired alias %s errors instead of falling through to the handler", async (oldName) => {
    const result = await client.callTool({ name: oldName, arguments: {} });
    expect(result.isError).toBe(true);
  });
});
