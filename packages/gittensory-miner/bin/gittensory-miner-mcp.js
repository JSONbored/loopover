#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { collectPortfolioDashboard } from "../lib/portfolio-dashboard.js";
import { initPortfolioQueueStore } from "../lib/portfolio-queue.js";
import { collectMinerDiagnostics } from "../lib/status.js";

// MCP stdio server for @jsonbored/gittensory-miner (scaffold #5153). Mirrors the packages/gittensory-mcp
// harness (MCP SDK server + stdio transport). Tools:
//   - gittensory_miner_ping (#5153): trivial static health check, reads no AMS state.
//   - gittensory_miner_get_portfolio_dashboard (#5155): read-only per-repo backlog dashboard, wrapping the
//     existing collectPortfolioDashboard aggregator (no new logic; same data as `queue dashboard --json`).
//   - gittensory_miner_status (#5154): read-only status/doctor diagnostics via collectMinerDiagnostics()
//     (same fields as `status`/`doctor --json`; no secret values). Driver-info fields follow #5164.
// Remaining AMS-state-reading tools (claim-ledger listing, run-state, etc.) land as follow-ups.

// Read the version from this package's own package.json (always shipped) rather than a hand-synced
// literal, so a release bump never has a second place to forget -- same approach as the mcp harness.
const ownPackageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** The static, non-secret payload the ping tool always returns, independent of any input or AMS state. */
export const MINER_PING_STATUS = { status: "ok", tool: "gittensory_miner_ping" };

/**
 * Build the miner MCP server with its tools registered. `options.initPortfolioQueue` / `options.nowMs` are
 * injection seams for tests (default to the real portfolio-queue store and the wall clock); the ping tool needs
 * neither. The portfolio-dashboard tool opens the queue only when invoked and closes any store it opened.
 * `options.collectMinerDiagnostics` / `options.diagnosticsEnv` / `options.diagnosticsCwd` inject the status tool.
 */
export function createMinerMcpServer(options = {}) {
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
  server.registerTool(
    "gittensory_miner_get_portfolio_dashboard",
    {
      description:
        "Read-only per-repo portfolio-queue backlog dashboard: status counts (queued/in_progress/done), totals, " +
        "and the oldest-queued age in ms. Wraps the existing collectPortfolioDashboard aggregator (no new logic) " +
        "-- the same data `gittensory-miner queue dashboard --json` prints locally. Takes no arguments; mutates nothing.",
      inputSchema: {},
    },
    async () => {
      const ownsQueue = options.initPortfolioQueue === undefined;
      const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
      try {
        const summary = collectPortfolioDashboard({ portfolioQueue }, { nowMs: options.nowMs ?? Date.now() });
        return { content: [{ type: "text", text: JSON.stringify(summary) }] };
      } finally {
        if (ownsQueue) portfolioQueue.close();
      }
    },
  );
  server.registerTool(
    "gittensory_miner_status",
    {
      description:
        "Read-only miner status/doctor diagnostics: state-dir path, engine-version skew, Docker/Claude/Codex CLI " +
        "presence booleans, config validity, and the full doctor check list. Wraps collectMinerDiagnostics() " +
        "(no new logic) — the same data `gittensory-miner status --json` and `doctor --json` expose locally. " +
        "Returns env-var names and booleans only, never secret values. Takes no arguments; mutates nothing.",
      inputSchema: {},
    },
    async () => {
      const diagnostics = (options.collectMinerDiagnostics ?? collectMinerDiagnostics)(
        options.diagnosticsEnv ?? process.env,
        options.diagnosticsCwd ?? process.cwd(),
      );
      return { content: [{ type: "text", text: JSON.stringify(diagnostics) }] };
    },
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
