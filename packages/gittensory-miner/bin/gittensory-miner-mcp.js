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
import { PLAN_STATUSES, openPlanStore } from "../lib/plan-store.js";
import { initGovernorLedger } from "../lib/governor-ledger.js";
import { collectStatus, runDoctorChecks } from "../lib/status.js";

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
//   - gittensory_miner_list_plans / gittensory_miner_get_plan (#5161): read-only access to the persisted
//     plan store via plan-store.js's listPlans/loadPlan (distinct from ORB's stateless gittensory_plan_status).
//   - gittensory_miner_get_governor_decisions (#5159): read-only governor decision-log projection via
//     governor-ledger.js's readGovernorDecisions -- an explicit named-column read that excludes payload_json.
//   - gittensory_miner_status (#5154): read-only status + doctor diagnostics via status.js's collectStatus/
//     runDoctorChecks (names/booleans/paths only -- never any env-var value, token, key, or credential).

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
 * `options.initEventLedger`, `options.initRunStateStore`, `options.openPlanStore`, `options.initGovernorLedger`,
 * `options.collectStatus`, `options.runDoctorChecks`, and `options.nowMs` are injection seams for tests (default
 * to the real stores/readers and the wall clock); the ping tool needs none. Each store-backed tool opens its
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
  server.registerTool(
    "gittensory_miner_list_plans",
    {
      description:
        "Read-only list of the miner's PERSISTED plan store (planId, plan DAG, status, updatedAt), optionally " +
        "filtered by status. Wraps plan-store.js's existing listPlans query -- no new logic, no mutation. NOTE: " +
        "this is the store-backed AMS plan store; it is distinct from ORB's stateless gittensory_plan_status " +
        "tool, which reads the caller's in-memory plan object rather than any persisted store.",
      inputSchema: {
        status: z.enum(PLAN_STATUSES).optional(),
      },
    },
    async ({ status }) => {
      const ownsStore = options.openPlanStore === undefined;
      const store = (options.openPlanStore ?? openPlanStore)();
      try {
        const filter = {};
        if (status !== undefined) filter.status = status;
        return { content: [{ type: "text", text: JSON.stringify(store.listPlans(filter)) }] };
      } finally {
        if (ownsStore) store.close();
      }
    },
  );
  server.registerTool(
    "gittensory_miner_get_plan",
    {
      description:
        "Read-only fetch of one persisted plan record by planId (the full plan DAG, status, updatedAt), or an " +
        "explicit { planId, found: false } for an unknown id. Wraps plan-store.js's existing loadPlan lookup -- " +
        "no mutation, no DAG/planning logic. Store-backed AMS plan store; distinct from ORB's stateless " +
        "gittensory_plan_status tool.",
      inputSchema: {
        planId: z.string().min(1),
      },
    },
    async ({ planId }) => {
      const ownsStore = options.openPlanStore === undefined;
      const store = (options.openPlanStore ?? openPlanStore)();
      try {
        const plan = store.loadPlan(planId);
        const result = plan === null ? { planId, found: false } : { found: true, plan };
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } finally {
        if (ownsStore) store.close();
      }
    },
  );
  server.registerTool(
    "gittensory_miner_get_governor_decisions",
    {
      description:
        "Read-only projection of the governor decision log: id, ts, eventType, repoFullName, actionClass, " +
        "decision, reason per row. This projection INTENTIONALLY EXCLUDES the internal/sensitive payload column " +
        "(reputation / self-plagiarism / budget state) by construction -- governor-ledger.js reads it with an " +
        "explicit named-column SELECT, never SELECT *. Optional repoFullName filter (the only filter the ledger " +
        "supports natively). Read-only; never writes to the ledger.",
      inputSchema: {
        repoFullName: z.string().min(1).optional(),
      },
    },
    async ({ repoFullName }) => {
      const ownsLedger = options.initGovernorLedger === undefined;
      const ledger = (options.initGovernorLedger ?? initGovernorLedger)();
      try {
        const filter = {};
        if (repoFullName !== undefined) filter.repoFullName = repoFullName;
        return { content: [{ type: "text", text: JSON.stringify(ledger.readGovernorDecisions(filter)) }] };
      } finally {
        if (ownsLedger) ledger.close();
      }
    },
  );
  server.registerTool(
    "gittensory_miner_status",
    {
      description:
        "Read-only miner status + doctor diagnostics. Returns { status, doctor }: status = package/engine versions " +
        "(+ skew), node version, state-dir path, config-file path, and the resolved coding-agent driver (provider " +
        "name, the model ENV-VAR NAME -- never its value -- and a CLI-present boolean); doctor = the same checks " +
        "`gittensory-miner doctor` runs (Docker/CLI presence, config validity, ...) as { name, ok, detail }. Reuses " +
        "collectStatus/runDoctorChecks so it can never drift from the CLI. Only names / booleans / paths -- never " +
        "any env-var value, token, key, or credential. Read-only; no writes or state changes.",
      inputSchema: {},
    },
    async () => {
      const status = (options.collectStatus ?? collectStatus)();
      const doctor = (options.runDoctorChecks ?? runDoctorChecks)();
      return { content: [{ type: "text", text: JSON.stringify({ status, doctor }) }] };
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
