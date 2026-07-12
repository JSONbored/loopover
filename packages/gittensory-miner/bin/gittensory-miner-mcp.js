#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Minimal MCP stdio-server scaffold for @jsonbored/gittensory-miner (#5153). Mirrors the
// packages/gittensory-mcp harness (MCP SDK server + stdio transport) but ships exactly ONE trivial
// health-check tool -- gittensory_miner_ping -- returning a static status object. It reads NO AMS
// state and takes no arguments. Future AMS-state-reading tools (status/doctor, portfolio dashboard,
// claim-ledger listing) land as follow-up PRs on top of this scaffold.

// Read the version from this package's own package.json (always shipped) rather than a hand-synced
// literal, so a release bump never has a second place to forget -- same approach as the mcp harness.
const ownPackageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** The static, non-secret payload the ping tool always returns, independent of any input or AMS state. */
export const MINER_PING_STATUS = { status: "ok", tool: "gittensory_miner_ping" };

/**
 * Build the miner MCP server with its single health-check tool registered. No I/O and no AMS-state
 * reads, so a test can drive it over an in-memory transport without spawning a process or requiring
 * any on-disk state to exist.
 */
export function createMinerMcpServer() {
  const server = new McpServer({ name: "gittensory-miner", version: ownPackageJson.version });
  server.registerTool(
    "gittensory_miner_ping",
    {
      description:
        "Health check for the gittensory-miner MCP server. Returns a static status object confirming the " +
        "server is reachable. Reads no AMS state and takes no arguments.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(MINER_PING_STATUS) }] }),
  );
  return server;
}

// Start the stdio transport only when executed directly as the bin, not when imported by a test.
// realpathSync on both sides resolves the npm bin symlink so a global/npx install still matches.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath && invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  createMinerMcpServer()
    .connect(new StdioServerTransport())
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
