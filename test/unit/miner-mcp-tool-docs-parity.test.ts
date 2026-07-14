import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MCP_BIN_PATH = join(process.cwd(), "packages/gittensory-miner/bin/loopover-miner-mcp.js");
const README_PATH = join(process.cwd(), "packages/gittensory-miner/README.md");
const CODING_AGENT_DRIVER_DOC_PATH = join(process.cwd(), "packages/gittensory-miner/docs/coding-agent-driver.md");

/** Every `server.registerTool("gittensory_miner_...", ...)` name in the real MCP bin -- the source of truth
 *  this test pins the README's "MCP server" section against, so the two can never silently drift (#5162). */
function registeredMinerMcpToolNames(): string[] {
  const source = readFileSync(MCP_BIN_PATH, "utf8");
  const names = [...source.matchAll(/server\.registerTool\(\s*\n?\s*"(gittensory_miner_\w+)"/g)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined);
  expect(names.length).toBeGreaterThan(0);
  return names;
}

describe("miner MCP tool documentation parity (#5162)", () => {
  it("documents every registered tool in the README, and documents nothing else", () => {
    const registered = registeredMinerMcpToolNames();
    const readme = readFileSync(README_PATH, "utf8");
    const mcpSection = readme.slice(readme.indexOf("## MCP server"), readme.indexOf("## Version check"));

    for (const name of registered) {
      expect(mcpSection).toContain(`\`${name}\``);
    }

    const documented = [...mcpSection.matchAll(/`(gittensory_miner_\w+)`/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);
    for (const name of documented) {
      expect(registered).toContain(name);
    }
  });

  it("documents the excluded-column safety property for the ledger/governor tools", () => {
    const readme = readFileSync(README_PATH, "utf8");
    const mcpSection = readme.slice(readme.indexOf("## MCP server"), readme.indexOf("## Version check"));
    expect(mcpSection).toContain("payload_json");
  });

  it("relates AMS's local MCP tools to the hosted gittensory-mcp tools", () => {
    const readme = readFileSync(README_PATH, "utf8");
    const mcpSection = readme.slice(readme.indexOf("## MCP server"), readme.indexOf("## Version check"));
    expect(mcpSection).toContain("local SQLite");
    expect(mcpSection).toContain("hosted");
  });

  it("is cross-referenced from the coding-agent-driver doc", () => {
    const doc = readFileSync(CODING_AGENT_DRIVER_DOC_PATH, "utf8");
    expect(doc).toContain("../README.md#mcp-server");
  });
});
