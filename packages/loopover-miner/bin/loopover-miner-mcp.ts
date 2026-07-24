#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CLAIM_STATUSES, openClaimLedger } from "../lib/claim-ledger.js";
import {
  type AuditFeedMcpFilterInput,
  collectEventLedgerAuditFeed,
  normalizeAuditFeedMcpFilter,
} from "../lib/event-ledger-cli.js";
import { initEventLedger, type EventLedger } from "../lib/event-ledger.js";
import { collectManageStatus, collectRunPortfolio } from "../lib/manage-status.js";
import { collectPortfolioDashboard } from "../lib/portfolio-dashboard.js";
import { initPortfolioQueueStore, type PortfolioQueueStore } from "../lib/portfolio-queue.js";
import { initRunStateStore, type RunStateStore } from "../lib/run-state.js";
import { PLAN_STATUSES, openPlanStore } from "../lib/plan-store.js";
import { initGovernorLedger } from "../lib/governor-ledger.js";
import { collectStatus, runDoctorChecks } from "../lib/status.js";
import { buildCalibrationReport } from "../lib/calibration.js";
import { toOutcomeRecords, toPredictionRecords } from "../lib/calibration-cli.js";
import { initPredictionLedger, type PredictionLedgerEntry } from "../lib/prediction-ledger.js";
import { loadMinerFileSecrets } from "../lib/env-file-indirection.js";
import { installCliSignalHandlers } from "../lib/process-lifecycle.js";
import { captureMinerErrorAndFlush, initMinerSentry } from "../lib/sentry.js";

// MCP stdio server for @loopover/miner (scaffold #5153). Mirrors the packages/loopover-mcp
// harness (MCP SDK server + stdio transport). Tools:
//   - loopover_miner_ping (#5153): trivial static health check, reads no AMS state.
//   - loopover_miner_get_portfolio_dashboard (#5155): read-only per-repo backlog dashboard, wrapping the
//     existing collectPortfolioDashboard aggregator (no new logic; same data as `queue dashboard --json`).
//   - loopover_miner_get_manage_status (#5822): read-only manage-phase status joining the portfolio queue, the
//     event ledger, and run-state via manage-status.js's collectManageStatus/collectRunPortfolio (no new join
//     logic; same { rows, runPortfolio } shape as `manage status --json`). Never calls GitHub, never mutates.
//   - loopover_miner_list_claims (#5156): read-only listing of the local claim ledger (optional repo/status
//     filter passed through to listClaims); exposes no claim/release mutation.
//   - loopover_miner_get_audit_feed (#5158): read-only metadata-only event-ledger audit feed via
//     collectEventLedgerAuditFeed() (same filters as `ledger list`; never returns payload_json).
//   - loopover_miner_get_run_state (#5160): read-only per-repo run-state via run-state.js's getRunState/
//     listRunStates (read-only analog of ORB's loopover_get_automation_state; no state-set mutation).
//   - loopover_miner_list_plans / loopover_miner_get_plan (#5161): read-only access to the persisted
//     plan store via plan-store.js's listPlans/loadPlan (distinct from ORB's stateless loopover_plan_status).
//   - loopover_miner_get_governor_decisions (#5159): read-only governor decision-log projection via
//     governor-ledger.js's readGovernorDecisions -- an explicit named-column read that excludes payload_json.
//   - loopover_miner_status (#5154): read-only status + doctor diagnostics via status.js's collectStatus/
//     runDoctorChecks (names/booleans/paths only -- never any env-var value, token, key, or credential).
//   - loopover_miner_get_calibration_report (#5821): read-only miner-local prediction-accuracy report, joining
//     the prediction ledger with observed pr_outcome events via calibration-cli.js's existing toPredictionRecords/
//     toOutcomeRecords mappers and calibration.js's buildCalibrationReport composer (no new join logic). Distinct
//     from ORB's hosted, maintainer-authenticated loopover_get_outcome_calibration tool.

// Read the version from this package's own package.json (always shipped) rather than a hand-synced
// literal, so a release bump never has a second place to forget. Self-referencing package import
// (requires the "exports" map in this package's own package.json) -- robust by construction to
// however this file is currently running, whether as the real source bin/loopover-miner-mcp.ts
// (imported in-process by test/unit/miner-mcp-*.test.ts) or the compiled dist/bin/loopover-miner-mcp.js
// (a real CLI invocation): import.meta.resolve walks up from THIS file's own location through
// node_modules the same way an external "@loopover/miner/..." import would, landing on the one real
// package.json either way -- no relative-path arithmetic to break if this file ever moves again.
// fileURLToPath (a plain string), not `new URL(...)` -- the repo-root tsconfig this file is also
// checked under (its type surface is imported by the MCP unit tests) resolves the global `URL` to a
// shape whose iterator lacks `[Symbol.dispose]`, which readFileSync's node typings reject.
const packageJsonPath = fileURLToPath(import.meta.resolve("@loopover/miner/package.json"));
const ownPackageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

/** Optional filters accepted by loopover_miner_get_audit_feed (#5158). */
const auditFeedInputSchema = {
  repoFullName: z.string().min(1).optional(),
  since: z.number().int().nonnegative().optional(),
  type: z.string().min(1).optional(),
};

/** The static, non-secret payload the ping tool always returns, independent of any input or AMS state. */
export const MINER_PING_STATUS = { status: "ok", tool: "loopover_miner_ping" };

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
  /** Override the status reader (defaults to status.js's collectStatus); injection seam for tests. */
  collectStatus?: () => unknown;
  /** Override the doctor-checks reader (defaults to status.js's runDoctorChecks); injection seam for tests. */
  runDoctorChecks?: () => unknown[];
  /**
   * Override the prediction-ledger opener (defaults to the real on-disk ledger); injection seam for tests. Typed
   * to the minimal read surface the calibration-report tool uses (never appendPrediction).
   */
  initPredictionLedger?: () => {
    readPredictions(filter?: { repoFullName?: string | null }): PredictionLedgerEntry[];
    close(): void;
  };
}

/**
 * Build the miner MCP server with its tools registered. `options.initPortfolioQueue`, `options.openClaimLedger`,
 * `options.initEventLedger`, `options.initRunStateStore`, `options.openPlanStore`, `options.initGovernorLedger`,
 * `options.collectStatus`, `options.runDoctorChecks`, and `options.nowMs` are injection seams for tests (default
 * to the real stores/readers and the wall clock); the ping tool needs none. Each store-backed tool opens its
 * store only when invoked and closes any store it opened.
 */
export function createMinerMcpServer(options: MinerMcpServerOptions = {}) {
  const server = new McpServer({ name: "loopover-miner", version: ownPackageJson.version });
  server.registerTool(
    "loopover_miner_ping",
    {
      description:
        "Health check for the loopover-miner MCP server. Returns a static status object confirming the " +
        "server is reachable. Reads no AMS state and takes no arguments.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(MINER_PING_STATUS) }] }),
  );
  server.registerTool(
    "loopover_miner_get_portfolio_dashboard",
    {
      description:
        "Read-only per-repo portfolio-queue backlog dashboard: status counts (queued/in_progress/done), totals, " +
        "and the oldest-queued age in ms. Wraps the existing collectPortfolioDashboard aggregator (no new logic) " +
        "-- the same data `loopover-miner queue dashboard --json` prints locally. Takes no arguments; mutates nothing.",
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
    "loopover_miner_get_manage_status",
    {
      description:
        "Read-only manage-phase status: the per-managed-PR rows `loopover-miner manage status` reports (branch, CI " +
        "state, gate verdict, outcome, last-polled-at, queue status/priority) plus the run-level portfolio view " +
        "(one row per tracked repo: run state, updated-at, PR count). Joins the portfolio queue, the append-only " +
        "event ledger, and run-state by reusing the existing collectManageStatus/collectRunPortfolio aggregators " +
        "-- no new join logic -- returning the same { rows, runPortfolio } shape `manage status --json` prints. " +
        "Read-only: never calls GitHub, never mutates local stores. Takes no arguments.",
      inputSchema: {},
    },
    async () => {
      const ownsPortfolioQueue = options.initPortfolioQueue === undefined;
      const ownsEventLedger = options.initEventLedger === undefined;
      const ownsRunStateStore = options.initRunStateStore === undefined;
      const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
      const eventLedger = (options.initEventLedger ?? initEventLedger)();
      const runStateStore = (options.initRunStateStore ?? initRunStateStore)();
      try {
        // The injection seams above are typed to the minimal read surface each tool touches (mirroring the
        // dashboard tool's `{ listQueue }` seam), but collectManageStatus/collectRunPortfolio's declared source
        // types name the full stores. Both aggregators only ever read (listQueue/getRunState/listRunStates) at
        // runtime -- exactly what the seam guarantees -- so widening the resolved stores back to the store types
        // the signatures ask for is sound; it never reaches a write/lifecycle method the minimal seam omits.
        const rows = collectManageStatus({
          portfolioQueue: portfolioQueue as PortfolioQueueStore,
          eventLedger,
        });
        const runPortfolio = collectRunPortfolio({
          portfolioQueue: portfolioQueue as PortfolioQueueStore,
          eventLedger,
          runStateStore: runStateStore as RunStateStore,
        });
        return { content: [{ type: "text", text: JSON.stringify({ rows, runPortfolio }) }] };
      } finally {
        if (ownsPortfolioQueue) portfolioQueue.close();
        if (ownsEventLedger) eventLedger.close();
        if (ownsRunStateStore) runStateStore.close();
      }
    },
  );
  server.registerTool(
    "loopover_miner_list_claims",
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
        const filter: { repoFullName?: string; status?: string } = {};
        if (repoFullName !== undefined) filter.repoFullName = repoFullName;
        if (status !== undefined) filter.status = status;
        return { content: [{ type: "text", text: JSON.stringify(ledger.listClaims(filter)) }] };
      } finally {
        if (ownsLedger) ledger.close();
      }
    },
  );
  server.registerTool(
    "loopover_miner_get_audit_feed",
    {
      description:
        "Read-only, metadata-only audit feed from the local append-only event ledger: eventType, repoFullName, " +
        "outcome, actor, detail, and createdAt per row. Wraps collectEventLedgerAuditFeed() (no new query logic) — " +
        "the same read filters as `loopover-miner ledger list` (--repo, --since, --type). Never returns " +
        "payload_json or other raw ledger columns; never writes to the ledger.",
      inputSchema: auditFeedInputSchema,
    },
    async (input) => {
      const ownsLedger = options.initEventLedger === undefined;
      const eventLedger = (options.initEventLedger ?? initEventLedger)();
      try {
        // zod's `.optional()` widens each field to `string | undefined`, whereas normalizeAuditFeedMcpFilter's
        // input type spells the same absent-field slot as `string | null`; the normalizer treats missing and
        // null identically, so narrowing the parsed input to that shape is exact, not a behavior change.
        const filter = normalizeAuditFeedMcpFilter((input ?? {}) as AuditFeedMcpFilterInput);
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
    "loopover_miner_get_run_state",
    {
      description:
        "Read-only per-repo miner run-state (idle/discovering/planning/preparing). Pass repoFullName for a single " +
        "repo (a null state means none has been recorded for it yet), or omit it to list every repo's state. The " +
        "read-only analog of ORB's loopover_get_automation_state; adds no state-set or mutation capability.",
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
    "loopover_miner_list_plans",
    {
      description:
        "Read-only list of the miner's PERSISTED plan store (planId, plan DAG, status, updatedAt), optionally " +
        "filtered by status. Wraps plan-store.js's existing listPlans query -- no new logic, no mutation. NOTE: " +
        "this is the store-backed AMS plan store; it is distinct from ORB's stateless loopover_plan_status " +
        "tool, which reads the caller's in-memory plan object rather than any persisted store.",
      inputSchema: {
        status: z.enum(PLAN_STATUSES).optional(),
      },
    },
    async ({ status }) => {
      const ownsStore = options.openPlanStore === undefined;
      const store = (options.openPlanStore ?? openPlanStore)();
      try {
        const filter: { status?: string } = {};
        if (status !== undefined) filter.status = status;
        return { content: [{ type: "text", text: JSON.stringify(store.listPlans(filter)) }] };
      } finally {
        if (ownsStore) store.close();
      }
    },
  );
  server.registerTool(
    "loopover_miner_get_plan",
    {
      description:
        "Read-only fetch of one persisted plan record by planId (the full plan DAG, status, updatedAt), or an " +
        "explicit { planId, found: false } for an unknown id. Wraps plan-store.js's existing loadPlan lookup -- " +
        "no mutation, no DAG/planning logic. Store-backed AMS plan store; distinct from ORB's stateless " +
        "loopover_plan_status tool.",
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
    "loopover_miner_get_governor_decisions",
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
        const filter: { repoFullName?: string } = {};
        if (repoFullName !== undefined) filter.repoFullName = repoFullName;
        return { content: [{ type: "text", text: JSON.stringify(ledger.readGovernorDecisions(filter)) }] };
      } finally {
        if (ownsLedger) ledger.close();
      }
    },
  );
  server.registerTool(
    "loopover_miner_status",
    {
      description:
        "Read-only miner status + doctor diagnostics. Returns { status, doctor }: status = package/engine versions " +
        "(+ skew), node version, state-dir path, config-file path, and the resolved coding-agent driver (provider " +
        "name, the model ENV-VAR NAME -- never its value -- and a CLI-present boolean); doctor = the same checks " +
        "`loopover-miner doctor` runs (Docker/CLI presence, config validity, ...) as { name, ok, detail }. Reuses " +
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
  server.registerTool(
    "loopover_miner_get_calibration_report",
    {
      description:
        "Read-only miner-local prediction-accuracy report: per-project merge/close precision, joining this " +
        "miner's own recorded gate predictions (prediction ledger) with the realized PR outcomes it later " +
        "observed (pr_outcome events). Wraps calibration-cli.js's existing toPredictionRecords/toOutcomeRecords " +
        "mappers and calibration.js's buildCalibrationReport composer -- no new join/scoring logic, no mutation. " +
        "Strictly local and offline; distinct from ORB's hosted, maintainer-authenticated " +
        "loopover_get_outcome_calibration tool, which reads a different (D1) data source. Takes no arguments.",
      inputSchema: {},
    },
    async () => {
      const ownsPredictionLedger = options.initPredictionLedger === undefined;
      const ownsEventLedger = options.initEventLedger === undefined;
      let predictionLedger;
      let eventLedger;
      try {
        predictionLedger = (options.initPredictionLedger ?? initPredictionLedger)();
        eventLedger = (options.initEventLedger ?? initEventLedger)();
        const report = buildCalibrationReport(
          toPredictionRecords(predictionLedger.readPredictions()),
          toOutcomeRecords(eventLedger.readEvents()),
        );
        return { content: [{ type: "text", text: JSON.stringify(report) }] };
      } finally {
        if (ownsPredictionLedger) predictionLedger?.close();
        if (ownsEventLedger) eventLedger?.close();
      }
    },
  );
  return server;
}

// Start the stdio transport only when executed directly as the bin, not when imported by a test.
// realpathSync on both sides resolves the npm bin symlink so a global/npx install still matches.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
/* v8 ignore start -- process entry point: this guard is specifically what makes it unreachable when the
 * module is imported (every existing MCP tool test does exactly that, per this file's own comment above), so
 * it can never be true in this test run's own process. createMinerMcpServer() itself is fully exercised by
 * those tests; this is only the top-level "am I actually invoked as the bin" wiring, mirroring
 * loopover-miner.js's identical exemption and src/server.ts's in codecov.yml. */
if (invokedPath && invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  // Previously this bin had NO crash safety net beyond the startup .catch() below -- an exception thrown while
  // handling an MCP tool call, after the server was already connected, had nowhere to go (#6011). Wire in the
  // same opt-in Sentry + signal/crash handling loopover-miner.js already gets, sharing process-lifecycle.js.
  try {
    loadMinerFileSecrets();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  await initMinerSentry(process.env);
  installCliSignalHandlers({ captureError: captureMinerErrorAndFlush });

  createMinerMcpServer()
    .connect(new StdioServerTransport())
    .catch(async (error) => {
      console.error(error);
      // Awaited so the captured event has a chance to actually reach Sentry before exit() tears the process
      // down -- a bare synchronous capture only queues it (#6011 follow-up).
      await captureMinerErrorAndFlush(error, { kind: "mcp_startup_connect_failed" });
      process.exit(1);
    });
}
/* v8 ignore stop */
