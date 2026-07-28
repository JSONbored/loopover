import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listToolDefinitions } from "@loopover/contract/tools";

const README_PATH = join(process.cwd(), "packages/loopover-miner/README.md");
const CODING_AGENT_DRIVER_DOC_PATH = join(process.cwd(), "packages/loopover-miner/docs/coding-agent-driver.md");

/**
 * Every miner-locality tool name from `@loopover/contract` -- the source of truth this test pins
 * the README's "MCP server" section against (#5162, #9536).
 *
 * Previously regex-scraped `server.registerTool("loopover_miner_...", ...)` calls out of the
 * *compiled* dist bundle, which meant (a) it needed a fresh `npm run build:miner` to see a real
 * change and (b) any reformatting of the registration call (the exact pattern #9517's own
 * investigation flagged as fragile in the sibling stdio-completion test) silently broke the guard
 * instead of the code. The registry removes both failure modes: it is the same list every server
 * registers from, read directly, no build step and no regex between this test and reality.
 */
function registeredMinerMcpToolNames(): string[] {
  const names = listToolDefinitions({ locality: ["miner"] }).map((tool) => tool.name);
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

    const documented = [...mcpSection.matchAll(/`(loopover_miner_\w+)`/g)]
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

  it("relates AMS's local MCP tools to the hosted loopover-mcp tools", () => {
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
