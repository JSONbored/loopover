// #4775: MCP tool rename (gittensory_ -> loopover_). Every stdio tool now has a primary
// loopover_-prefixed name plus a thin, fully-working gittensory_-prefixed deprecated alias that
// shares the exact same handler. This suite verifies the acceptance criteria literally: calling a
// representative sample of tools by BOTH the old and new name produces IDENTICAL behavior (same
// result shape, same content), every legacy alias's description says it's deprecated and names its
// replacement, no primary loopover_ tool's description carries a deprecation notice, and the CLI's
// `tools --json` listing stays in lockstep with what the live server actually registers.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/gittensory-mcp.js");

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

describe("MCP tool rename (#4775) — discovery invariants", () => {
  beforeEach(async () => {
    const apiUrl = await startFixtureServer();
    await connect(apiUrl);
  });
  afterEach(disconnect);

  it("lists exactly 74 tools: 37 loopover_ primary names plus their 37 gittensory_ aliases", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const primary = names.filter((n) => n.startsWith("loopover_"));
    const legacy = names.filter((n) => n.startsWith("gittensory_"));
    expect(primary.length).toBe(37);
    expect(legacy.length).toBe(37);
    expect(names.length).toBe(74);
    // Every legacy alias has a corresponding primary name, and vice versa.
    const primarySuffixes = new Set(primary.map((n) => n.slice("loopover_".length)));
    const legacySuffixes = new Set(legacy.map((n) => n.slice("gittensory_".length)));
    expect([...legacySuffixes].sort()).toEqual([...primarySuffixes].sort());
  });

  it("every gittensory_ alias's description is marked deprecated and names its loopover_ replacement", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools.filter((t) => t.name.startsWith("gittensory_"))) {
      const replacement = `loopover_${tool.name.slice("gittensory_".length)}`;
      expect(tool.description ?? "", `${tool.name} description`).toMatch(/deprecated/i);
      expect(tool.description ?? "", `${tool.name} description should name ${replacement}`).toContain(replacement);
    }
  });

  it("no loopover_ primary tool's description carries a deprecation notice", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools.filter((t) => t.name.startsWith("loopover_"))) {
      expect(tool.description ?? "", `${tool.name} description`).not.toMatch(/deprecated/i);
    }
  });

  it("`gittensory-mcp tools --json` reports the same 74-tool count the live server registers", async () => {
    const { tools } = await client.listTools();
    const payload = JSON.parse(run(["tools", "--json"])) as { count: number; tools: Array<{ name: string }> };
    expect(payload.count).toBe(tools.length);
    expect(payload.count).toBe(74);
    expect([...payload.tools.map((t) => t.name)].sort()).toEqual([...tools.map((t) => t.name)].sort());
  });
});

describe("MCP tool rename (#4775) — old/new behavioral identity", () => {
  beforeEach(async () => {
    const apiUrl = await startFixtureServer();
    await connect(apiUrl);
  });
  afterEach(disconnect);

  // Representative sample spanning distinct tool categories: an authenticated API GET proxy
  // (repo intelligence), a source-free API POST self-check (slop risk), a no-argument API GET
  // (upstream drift), an API GET with a path parameter (agent run), pure local logic with no
  // network call (feasibility gate), and a tool with a validated Zod outputSchema (structured
  // local status).
  const cases: Array<{ label: string; newName: string; oldName: string; args: Record<string, unknown> }> = [
    { label: "repo intelligence (API GET proxy)", newName: "loopover_get_repo_context", oldName: "gittensory_get_repo_context", args: { owner: "owner", repo: "repo" } },
    { label: "slop-risk self-check (API POST, source-free)", newName: "loopover_check_slop_risk", oldName: "gittensory_check_slop_risk", args: { description: "fix a bug", changedFiles: [{ path: "src/x.ts", additions: 3, deletions: 1 }] } },
    { label: "upstream drift (no-argument API GET)", newName: "loopover_get_upstream_drift", oldName: "gittensory_get_upstream_drift", args: {} },
    { label: "agent run lookup (API GET with path param)", newName: "loopover_agent_get_run", oldName: "gittensory_agent_get_run", args: { runId: "run-1" } },
    { label: "feasibility gate (pure local logic, no network)", newName: "loopover_feasibility_gate", oldName: "gittensory_feasibility_gate", args: { claimStatus: "unclaimed", duplicateClusterRisk: "none", issueStatus: "ready" } },
    { label: "structured local status (validated outputSchema)", newName: "loopover_local_status_structured", oldName: "gittensory_local_status_structured", args: {} },
  ];

  it.each(cases)("$label: calling by the old name and the new name produces identical content", async ({ newName, oldName, args }) => {
    const viaNew = await client.callTool({ name: newName, arguments: args });
    const viaOld = await client.callTool({ name: oldName, arguments: args });

    expect(viaOld.isError).toBe(viaNew.isError);
    expect(viaOld.content).toEqual(viaNew.content);
    if (viaNew.structuredContent !== undefined || viaOld.structuredContent !== undefined) {
      expect(viaOld.structuredContent).toEqual(viaNew.structuredContent);
    }
  });

  it("local status (no outputSchema variant) also behaves identically under both names", async () => {
    const viaNew = await client.callTool({ name: "loopover_local_status", arguments: {} });
    const viaOld = await client.callTool({ name: "gittensory_local_status", arguments: {} });
    expect(viaOld.isError).toBe(viaNew.isError);
    expect(viaOld.content).toEqual(viaNew.content);
  });
});
