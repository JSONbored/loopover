#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CLAIM_STATUSES, openClaimLedger } from "../lib/claim-ledger.js";
import {
  collectEventLedgerAuditFeed,
  normalizeAuditFeedMcpFilter,
} from "../lib/event-ledger-cli.js";
import { initEventLedger } from "../lib/event-ledger.js";
import { collectPortfolioDashboard } from "../lib/portfolio-dashboard.js";
import { initPortfolioQueueStore } from "../lib/portfolio-queue.js";
import { initRunStateStore } from "../lib/run-state.js";

// MCP stdio server for @jsonbored/gittensory-miner (scaffold #5153). Mirrors the packages/gittensory-mcp
// harness (MCP SDK server + stdio transport). Tools:
//   - gittensory_miner_ping (#5153): trivial static health check, reads no AMS state.
//   - gittensory_miner_get_portfolio_dashboard (#5155): read-only per-repo backlog dashboard, wrapping the
//     existing collectPortfolioDashboard aggregator (no new logic; same data as `queue dashboard --json`).
//   - gittensory_miner_list_claims (#5156): read-only listing of the local claim ledger (optional repo/status
//     filter passed through to listClaims); exposes no claim/release mutation.
//   - gittensory_miner_get_audit_feed (#5158): read-only metadata-only event-ledger audit feed via
//     collectEventLedgerAuditFeed() (same filters as `ledger list`; never returns payload_json).
//   - gittensory_miner_get_run_state (#5160): read-only per-repo run-state via run-state.js's getRunState/
//     listRunStates (read-only analog of ORB's gittensory_get_automation_state; no state-set mutation).
// Remaining AMS-state-reading tools (status/doctor, governor ledger, plan store, etc.) land as follow-ups.

// Read the version from this package's own package.json (always shipped) rather than a hand-synced
// literal, so a release bump never has a second place to forget -- same approach as the mcp harness.
const ownPackageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Optional filters accepted by gittensory_miner_get_audit_feed (#5158). */
const auditFeedInputSchema = {
  repoFullName: z.string().min(1).optional(),
  since: z.number().int().nonnegative().optional(),
  type: z.string().min(1).optional(),
};

/** The static, non-secret payload the ping tool always returns, independent of any input or AMS state. */
export const MINER_PING_STATUS = { status: "ok", tool: "gittensory_miner_ping" };

/**
 * Build the miner MCP server with its tools registered. `options.initPortfolioQueue`, `options.openClaimLedger`,
 * `options.initEventLedger`, `options.initRunStateStore`, and `options.nowMs` are injection seams for tests
 * (default to the real stores and the wall clock); the ping tool needs none. Each store-backed tool opens its
 * store only when invoked and closes any store it opened.
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
    "gittensory_miner_list_claims",
    {
      description:
        "Read-only listing of the local claim ledger: which issues this miner has claimed (repo, issue number, " +
        "status, claimed-at, note). Optional repoFullName/status filters pass through to the existing listClaims " +
        "query. Exposes no claim/release mutation and no conflict-resolution logic.",
      inputSchema: {
        repoFullName: z.string().optional(),
        status: z.enum(CLAIM_STATUSES).optional(),
      },
    },
    async ({ repoFullName, status }) => {
      const ownsLedger = options.openClaimLedger === undefined;
      const ledger = (options.openClaimLedger ?? openClaimLedger)();
      try {
        const filter = {};
        if (repoFullName !== undefined) filter.repoFullName = repoFullName;
        if (status !== undefined) filter.status = status;
        return { content: [{ type: "text", text: JSON.stringify(ledger.listClaims(filter)) }] };
      } finally {
        if (ownsLedger) ledger.close();
      }
    },
  );
  server.registerTool(
    "gittensory_miner_get_audit_feed",
    {
      description:
        "Read-only, metadata-only audit feed from the local append-only event ledger: eventType, repoFullName, " +
        "outcome, actor, detail, and createdAt per row. Wraps collectEventLedgerAuditFeed() (no new query logic) — " +
        "the same read filters as `gittensory-miner ledger list` (--repo, --since, --type). Never returns " +
        "payload_json or other raw ledger columns; never writes to the ledger.",
      inputSchema: auditFeedInputSchema,
    },
    async (input) => {
      const ownsLedger = options.initEventLedger === undefined;
      const eventLedger = (options.initEventLedger ?? initEventLedger)();
      try {
        const filter = normalizeAuditFeedMcpFilter(input ?? {});
        const feed = collectEventLedgerAuditFeed(eventLedger, filter);
        return { content: [{ type: "text", text: JSON.stringify(feed) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      } finally {
        if (ownsLedger) eventLedger.close();
      }
    },
  );
  server.registerTool(
    "gittensory_miner_get_run_state",
    {
      description:
        "Read-only per-repo miner run-state (idle/discovering/planning/preparing). Pass repoFullName for a single " +
        "repo (a null state means none has been recorded for it yet), or omit it to list every repo's state. The " +
        "read-only analog of ORB's gittensory_get_automation_state; adds no state-set or mutation capability.",
      inputSchema: {
        repoFullName: z.string().min(1).optional(),
      },
    },
    async ({ repoFullName }) => {
      const ownsStore = options.initRunStateStore === undefined;
      const store = (options.initRunStateStore ?? initRunStateStore)();
      try {
        const result =
          repoFullName === undefined
            ? { states: store.listRunStates() }
            : { repoFullName, state: store.getRunState(repoFullName) };
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } finally {
        if (ownsStore) store.close();
      }
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
