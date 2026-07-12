import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EventLedger } from "../lib/event-ledger.js";

/** The static, non-secret payload the gittensory_miner_ping tool always returns, independent of input. */
export const MINER_PING_STATUS: { status: "ok"; tool: "gittensory_miner_ping" };

export interface MinerMcpServerOptions {
  /**
   * Override the portfolio-queue store opener (defaults to the real on-disk store); injection seam for tests.
   * Typed to the minimal read surface the dashboard tool uses, mirroring runPortfolioDashboard's own seam.
   */
  initPortfolioQueue?: () => { listQueue(repoFullName?: string | null): unknown[]; close(): void };
  /**
   * Override the claim-ledger opener (defaults to the real on-disk ledger); injection seam for tests. Typed to
   * the minimal read surface the list-claims tool uses.
   */
  openClaimLedger?: () => {
    listClaims(filter?: { repoFullName?: string | null; status?: string | null }): unknown[];
    close(): void;
  };
  /** Override the clock used for the oldest-queued age (defaults to Date.now()); injection seam for tests. */
  nowMs?: number;
  /** Override the event-ledger opener (defaults to initEventLedger); injection seam for tests. */
  initEventLedger?: () => EventLedger;
  /**
   * Override the run-state store opener (defaults to the real on-disk store); injection seam for tests. Typed to
   * the minimal read surface the run-state tool uses (never setRunState).
   */
  initRunStateStore?: () => {
    getRunState(repoFullName: string): unknown;
    listRunStates(): unknown[];
    close(): void;
  };
  /**
   * Override the plan-store opener (defaults to the real on-disk store); injection seam for tests. Typed to the
   * minimal read surface the plan tools use (never savePlan).
   */
  openPlanStore?: () => {
    loadPlan(planId: string): unknown;
    listPlans(filter?: { status?: string | null }): unknown[];
    close(): void;
  };
  /**
   * Override the governor-ledger opener (defaults to the real on-disk ledger); injection seam for tests. Typed
   * to the minimal read surface the decisions tool uses (the payload-excluding readGovernorDecisions).
   */
  initGovernorLedger?: () => {
    readGovernorDecisions(filter?: { repoFullName?: string | null }): unknown[];
    close(): void;
  };
}

/**
 * Build the miner MCP server with its tools registered (gittensory_miner_ping,
 * gittensory_miner_get_portfolio_dashboard, gittensory_miner_list_claims, gittensory_miner_get_audit_feed,
 * gittensory_miner_get_run_state, gittensory_miner_list_plans, gittensory_miner_get_plan,
 * gittensory_miner_get_governor_decisions). `options` supplies test injection seams; production callers pass nothing.
 */
export function createMinerMcpServer(options?: MinerMcpServerOptions): McpServer;
