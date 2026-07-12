import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** The static, non-secret payload the gittensory_miner_ping tool always returns, independent of input. */
export const MINER_PING_STATUS: { status: "ok"; tool: "gittensory_miner_ping" };

/**
 * Build the miner MCP server with its single gittensory_miner_ping health-check tool registered. No I/O
 * and no AMS-state reads, so a test can drive it over an in-memory transport.
 */
export function createMinerMcpServer(): McpServer;
