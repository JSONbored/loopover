import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MinerDiagnostics } from "../lib/status.js";

/** The static, non-secret payload the gittensory_miner_ping tool always returns, independent of input. */
export const MINER_PING_STATUS: { status: "ok"; tool: "gittensory_miner_ping" };

export interface MinerMcpServerOptions {
  /**
   * Override the portfolio-queue store opener (defaults to the real on-disk store); injection seam for tests.
   * Typed to the minimal read surface the dashboard tool uses, mirroring runPortfolioDashboard's own seam.
   */
  initPortfolioQueue?: () => { listQueue(repoFullName?: string | null): unknown[]; close(): void };
  /** Override the clock used for the oldest-queued age (defaults to Date.now()); injection seam for tests. */
  nowMs?: number;
  /** Override the status/doctor snapshot builder (defaults to collectMinerDiagnostics); injection seam for tests. */
  collectMinerDiagnostics?: (env?: Record<string, string | undefined>, cwd?: string) => MinerDiagnostics;
  /** Env passed to collectMinerDiagnostics when the real builder runs (defaults to process.env). */
  diagnosticsEnv?: Record<string, string | undefined>;
  /** cwd passed to collectMinerDiagnostics when the real builder runs (defaults to process.cwd()). */
  diagnosticsCwd?: string;
}

/**
 * Build the miner MCP server with its tools registered (gittensory_miner_ping,
 * gittensory_miner_get_portfolio_dashboard, gittensory_miner_status).
 * `options` supplies test injection seams; production callers pass nothing.
 */
export function createMinerMcpServer(options?: MinerMcpServerOptions): McpServer;
