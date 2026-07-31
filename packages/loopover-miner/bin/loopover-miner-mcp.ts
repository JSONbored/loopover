#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpTelemetryErrorCode } from "@loopover/contract";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// #9536: every tool's schemas come from the shared contract instead of being declared here. The
// remote and stdio servers already register from the same package (#9517/#9518) -- this closes the
// gap that made AMS the one server with no structured output and no shared source of truth.
import { z } from "zod";
import {
  projectToolDefinition,
  type ToolContract,
  minerPingTool,
  minerPortfolioDashboardTool,
  minerManageStatusTool,
  minerListClaimsTool,
  minerAuditFeedTool,
  minerGetRunStateTool,
  minerListPlansTool,
  minerGetPlanTool,
  minerGovernorDecisionsTool,
  minerStatusTool,
  minerCalibrationReportTool,
  minerDoctorTool,
  minerMetricsSnapshotTool,
  minerGovernorPauseTool,
  minerGovernorResumeTool,
  minerQueueReleaseTool,
  minerQueueRequeueTool,
  minerClaimReleaseTool,
  minerDenyHooksDecideTool,
  minerRunMigrationsTool,
  minerPurgeRepoTool,
} from "@loopover/contract/tools";
import {
  MinerListClaimsInput,
  MinerAuditFeedInput,
  MinerGetRunStateInput,
  MinerListPlansInput,
  MinerGetPlanInput,
  MinerGovernorDecisionsInput,
} from "@loopover/contract/tools";
import { openClaimLedger } from "../lib/claim-ledger.js";
import { recordMinerDispatchTelemetry } from "../lib/mcp-dispatch-telemetry.js";
import { type AuditFeedMcpFilterInput, collectEventLedgerAuditFeed, normalizeAuditFeedMcpFilter } from "../lib/event-ledger-cli.js";
import { initEventLedger, type EventLedger } from "../lib/event-ledger.js";
import { collectManageStatus, collectRunPortfolio } from "../lib/manage-status.js";
import { collectPortfolioDashboard } from "../lib/portfolio-dashboard.js";
import { initPortfolioQueueStore, type PortfolioQueueStore } from "../lib/portfolio-queue.js";
import { initRunStateStore, type RunStateStore } from "../lib/run-state.js";
import { openPlanStore } from "../lib/plan-store.js";
import { initGovernorLedger } from "../lib/governor-ledger.js";
import { collectStatus, runDoctorChecks } from "../lib/status.js";
import { collectMinerPredictionMetrics } from "@loopover/engine";
import { collectPredictionMetricRows } from "../lib/metrics-cli.js";
import { dispatchChatAction, type ChatActionRefusalStatus } from "../lib/chat-action-dispatch.js";
import {
  MINER_CLAIM_RELEASE_ACTION,
  MINER_DENY_HOOKS_DECIDE_ACTION,
  MINER_PURGE_REPO_ACTION,
  MINER_QUEUE_RELEASE_ACTION,
  MINER_QUEUE_REQUEUE_ACTION,
  MINER_RUN_MIGRATIONS_ACTION,
  registerMinerOpsChatActions,
  type MinerOpsActions,
} from "../lib/chat-miner-ops-actions.js";
import { createMinerOpsActions } from "../lib/miner-ops-actions.js";
import { GOVERNOR_PAUSE_CHAT_ACTION, GOVERNOR_RESUME_CHAT_ACTION, registerGovernorChatActions } from "../lib/chat-governor-actions.js";
import { buildCalibrationReport } from "../lib/calibration.js";
import { toOutcomeRecords, toPredictionRecords } from "../lib/calibration-cli.js";
import { initPredictionLedger, type PredictionLedgerEntry } from "../lib/prediction-ledger.js";
import { loadMinerFileSecrets } from "../lib/env-file-indirection.js";
import { installCliSignalHandlers } from "../lib/process-lifecycle.js";
import { captureMinerErrorAndFlush, initMinerSentry } from "../lib/sentry.js";
import { captureMinerPostHogErrorAndFlush, initMinerPostHog } from "../lib/posthog.js";

// MCP stdio server for @loopover/miner (scaffold #5153). Mirrors the packages/loopover-mcp
// harness (MCP SDK server + stdio transport). All 11 tools are read-only over local state; none
// call GitHub or mutate a store. Name, description, category, and both schemas for each one now
// come from @loopover/contract/tools (#9536) rather than being declared here -- see miner.ts in
// that package for what each tool actually reads (portfolio queue, event ledger, run-state store,
// plan store, governor ledger, claim ledger, prediction ledger).

/**
 * Every tool's declared error code, closed by construction: `getToolErrorCode` narrows unknown
 * thrown values to this set rather than passing a caller/store-derived string through, matching the
 * `code`/`message` shape @loopover/contract's shared `toolErrorFields` describes.
 */
/**
 * Each way a dispatch can refuse, as the closed telemetry code for it (#9659).
 *
 * A `Record` over the status union rather than a lookup with a fallback: adding a dispatch status without
 * deciding what it means to a caller then fails the build, which is the only reason a mapping between two
 * closed vocabularies is safe to write down at all.
 */
const DISPATCH_REFUSAL_CODES: Record<ChatActionRefusalStatus, McpTelemetryErrorCode> = {
  disabled: "not_configured",
  unknown_action: "not_found",
  invalid_params: "invalid_input",
  handler_error: "upstream_error",
};

function toolErrorCode(error: unknown): McpTelemetryErrorCode {
  // A local SQLite store failing to open (missing file, corrupted file, permissions) is the one
  // failure mode every store-backed tool below can actually hit; anything else is unclassified.
  return error instanceof Error && /not found|not a database|permission|ENOENT/i.test(error.message) ? "store_unavailable" : "unknown_error";
}

/**
 * Register one tool from its contract entry (#9655).
 *
 * Two defects this replaces, both invisible by reading a single call site:
 *
 * 1. Every config passed `SomeSchema.shape`. The SDK accepts a raw shape and re-wraps it in a plain
 *    `z.object`, which DISCARDS the catchall -- and every miner output is a `looseObject`, so each one
 *    was advertised and enforced as `additionalProperties: false` and any field the payload carried
 *    beyond the modelled set came back as a -32602 the caller could do nothing about. #9762 fixed this
 *    class on the other two servers and added a guard, but the guard's roots did not include this
 *    directory, so all 21 registrations here kept the defect it exists to prevent.
 *
 * 2. No config carried `title` or `annotations`, so one contract entry produced a differently
 *    advertised tool depending on which server you asked. `projectToolDefinition` applies the
 *    registry's defaults, which is where that decision belongs.
 */
function registerMinerTool<TInput extends z.ZodObject, TOutput extends z.ZodObject>(
  server: McpServer,
  contract: ToolContract<TInput, TOutput>,
  handler: ToolCallback<TInput>,
): void {
  const advertised = projectToolDefinition(contract);
  server.registerTool<TOutput, TInput>(
    contract.name,
    {
      title: advertised.title,
      description: advertised.description,
      annotations: advertised.annotations,
      // The schema OBJECTS, never their `.shape` -- see above.
      inputSchema: contract.input,
      outputSchema: contract.output,
      _meta: { category: advertised.category },
    },
    handler,
  );
}

/**
 * Build a tool result carrying BOTH the text block and `structuredContent` (#9536: none of these
 * tools returned structuredContent before this migration). `structuredContent` must be a JSON
 * object per the MCP spec, so a handler whose real return value is a bare array supplies `text`
 * separately to keep the text block byte-identical to what every current consumer already parses --
 * only `structuredContent` gains the object wrapper an output schema requires.
 */
function minerToolResult(
  structuredContent: object,
  text: unknown = structuredContent,
): { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown> } {
  return { content: [{ type: "text", text: JSON.stringify(text) }], structuredContent: structuredContent as Record<string, unknown> };
}

/** A handler's real result, plus the original (possibly array-shaped) text payload when it differs
 *  from the object `structuredContent` requires. */
type MinerToolRun<T extends object> = T | { structured: T; text: unknown };

function isTextOverride<T extends object>(value: MinerToolRun<T>): value is { structured: T; text: unknown } {
  return "structured" in value && "text" in value;
}

/**
 * The unified error envelope (#9536). Before this, only loopover_miner_get_audit_feed caught a
 * store failure and returned `isError: true`; the other ten threw, so the same class of failure
 * surfaced as a clean structured result from one tool and a raw protocol error from the rest. Every
 * tool below routes its store access through this wrapper instead.
 */
async function withMinerToolErrorHandling<T extends object>(
  run: () => Promise<MinerToolRun<T>> | MinerToolRun<T>,
  // #9525: the tool name, so this same wrapper doubles as the miner's dispatch-telemetry
  // chokepoint. REQUIRED -- every registration passes it, and leaving it optional would have made
  // "instrumented" a property of each call site rather than of the wrapper.
  toolName: string,
): Promise<{ content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown>; isError?: true }> {
  const startedAt = Date.now();
  try {
    const result = await run();
    const payload = isTextOverride(result) ? minerToolResult(result.structured, result.text) : minerToolResult(result);
    recordMinerDispatchTelemetry({ tool: toolName, ok: true, durationMs: Date.now() - startedAt, result: payload.structuredContent });
    return payload;
  } catch (error) {
    const data = { error: { code: toolErrorCode(error), message: error instanceof Error ? error.message : String(error) } };
    // #9659: the ENVELOPE, not the raw error. Passing the raw one made telemetry re-derive a code from
    // the message regexes, so a store that would not open told the caller `store_unavailable` while the
    // event recorded `not_found` -- two classifications of one failure, from adjacent lines.
    recordMinerDispatchTelemetry({ tool: toolName, ok: false, durationMs: Date.now() - startedAt, error, errorEnvelope: data.error });
    return { ...minerToolResult(data), isError: true };
  }
}

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
   * The mutating ops this server exposes (#9523). Defaults to the real on-disk stores; injected only by
   * tests. The MCP layer never touches a store directly -- every mutation is DISPATCHED by action name
   * through the governor-gated chat-action chokepoint, and these are what that chokepoint's handlers
   * ultimately call.
   */
  opsActions?: MinerOpsActions;
  /** Override the chat-action dispatcher; injection seam for tests. Defaults to the real dispatchChatAction. */
  dispatchAction?: typeof dispatchChatAction;
  /** Override the governor pause/resume clients the chat actions are wired to; injection seam for tests. */
  governorClients?: { pauseGovernor: (reason?: string) => Promise<unknown>; resumeGovernor: () => Promise<unknown> };
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

  // #9658: through the wrapper, like the other twenty. Ping is the health check an operator's monitoring
  // hits on a loop -- the cheapest signal that this server is alive and being used -- and it was the one
  // registration that never reached the dispatch-telemetry chokepoint, so a `usage_event` breakdown by
  // tool reported zero pings forever.
  registerMinerTool(server, minerPingTool, () => withMinerToolErrorHandling(() => MINER_PING_STATUS, minerPingTool.name),
  );

  registerMinerTool(server, minerPortfolioDashboardTool, () =>
      withMinerToolErrorHandling(() => {
        const ownsQueue = options.initPortfolioQueue === undefined;
        const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
        try {
          return collectPortfolioDashboard({ portfolioQueue }, { nowMs: options.nowMs ?? Date.now() });
        } finally {
          if (ownsQueue) portfolioQueue.close();
        }
      }, minerPortfolioDashboardTool.name),
  );

  registerMinerTool(server, minerManageStatusTool, () =>
      withMinerToolErrorHandling(() => {
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
          const rows = collectManageStatus({ portfolioQueue: portfolioQueue as PortfolioQueueStore, eventLedger });
          const runPortfolio = collectRunPortfolio({
            portfolioQueue: portfolioQueue as PortfolioQueueStore,
            eventLedger,
            runStateStore: runStateStore as RunStateStore,
          });
          return { rows, runPortfolio };
        } finally {
          if (ownsPortfolioQueue) portfolioQueue.close();
          if (ownsEventLedger) eventLedger.close();
          if (ownsRunStateStore) runStateStore.close();
        }
      }, minerManageStatusTool.name),
  );

  registerMinerTool(server, minerListClaimsTool, ({ repoFullName, status }: z.infer<typeof MinerListClaimsInput>) =>
      withMinerToolErrorHandling(() => {
        const ownsLedger = options.openClaimLedger === undefined;
        const ledger = (options.openClaimLedger ?? openClaimLedger)();
        try {
          const filter: { repoFullName?: string; status?: string } = {};
          if (repoFullName !== undefined) filter.repoFullName = repoFullName;
          if (status !== undefined) filter.status = status;
          const claims = ledger.listClaims(filter);
          // The text block stays the bare array every current consumer already parses;
          // structuredContent gets the object wrapper the MCP spec (and the output schema) requires.
          return { structured: { claims }, text: claims };
        } finally {
          if (ownsLedger) ledger.close();
        }
      }, minerListClaimsTool.name),
  );

  registerMinerTool(server, minerAuditFeedTool, (input: z.infer<typeof MinerAuditFeedInput>) =>
      withMinerToolErrorHandling(() => {
        const ownsLedger = options.initEventLedger === undefined;
        const eventLedger = (options.initEventLedger ?? initEventLedger)();
        try {
          // zod's `.optional()` widens each field to `string | undefined`, whereas normalizeAuditFeedMcpFilter's
          // input type spells the same absent-field slot as `string | null`; the normalizer treats missing and
          // null identically, so narrowing the parsed input to that shape is exact, not a behavior change.
          const filter = normalizeAuditFeedMcpFilter((input ?? {}) as AuditFeedMcpFilterInput);
          // collectEventLedgerAuditFeed already returns { repoFullName?, events } -- return it directly
          // rather than re-wrapping it in another `events` key.
          return collectEventLedgerAuditFeed(eventLedger, filter);
        } finally {
          if (ownsLedger) eventLedger.close();
        }
      }, minerAuditFeedTool.name),
  );

  registerMinerTool(server, minerGetRunStateTool, ({ repoFullName }: z.infer<typeof MinerGetRunStateInput>) =>
      withMinerToolErrorHandling(() => {
        const ownsStore = options.initRunStateStore === undefined;
        const store = (options.initRunStateStore ?? initRunStateStore)();
        try {
          return repoFullName === undefined ? { states: store.listRunStates() } : { repoFullName, state: store.getRunState(repoFullName) };
        } finally {
          if (ownsStore) store.close();
        }
      }, minerGetRunStateTool.name),
  );

  registerMinerTool(server, minerListPlansTool, ({ status }: z.infer<typeof MinerListPlansInput>) =>
      withMinerToolErrorHandling(() => {
        const ownsStore = options.openPlanStore === undefined;
        const store = (options.openPlanStore ?? openPlanStore)();
        try {
          const filter: { status?: string } = {};
          if (status !== undefined) filter.status = status;
          const plans = store.listPlans(filter);
          return { structured: { plans }, text: plans };
        } finally {
          if (ownsStore) store.close();
        }
      }, minerListPlansTool.name),
  );

  registerMinerTool(server, minerGetPlanTool, ({ planId }: z.infer<typeof MinerGetPlanInput>) =>
      withMinerToolErrorHandling(() => {
        const ownsStore = options.openPlanStore === undefined;
        const store = (options.openPlanStore ?? openPlanStore)();
        try {
          const plan = store.loadPlan(planId);
          return plan === null ? { planId, found: false } : { found: true, plan };
        } finally {
          if (ownsStore) store.close();
        }
      }, minerGetPlanTool.name),
  );

  registerMinerTool(server, minerGovernorDecisionsTool, ({ repoFullName }: z.infer<typeof MinerGovernorDecisionsInput>) =>
      withMinerToolErrorHandling(() => {
        const ownsLedger = options.initGovernorLedger === undefined;
        const ledger = (options.initGovernorLedger ?? initGovernorLedger)();
        try {
          const filter: { repoFullName?: string } = {};
          if (repoFullName !== undefined) filter.repoFullName = repoFullName;
          const decisions = ledger.readGovernorDecisions(filter);
          return { structured: { decisions }, text: decisions };
        } finally {
          if (ownsLedger) ledger.close();
        }
      }, minerGovernorDecisionsTool.name),
  );

  registerMinerTool(server, minerStatusTool, () =>
      withMinerToolErrorHandling(() => ({
        status: (options.collectStatus ?? collectStatus)(),
        doctor: (options.runDoctorChecks ?? runDoctorChecks)(),
      }), minerStatusTool.name),
  );

  // ── #9523 mutations, every one dispatched through the governor gate ────
  //
  // Registered ONLY when opsActions is supplied: a deployment that has not wired the store operations
  // advertises nothing it cannot serve. The MCP layer never calls a store -- it dispatches an action NAME
  // through dispatchChatAction, which runs the registry's governor-gated handler. That is why an MCP caller
  // can never reach a write path the dashboard could not: both go through the same chokepoint.
  {
    // Registered UNCONDITIONALLY, against the real stores unless a test injects otherwise: a tool the
    // registry declares but the server does not serve is a promised capability with nothing behind it, which
    // is exactly what validate:mcp refuses.
    registerMinerOpsChatActions(options.opsActions ?? createMinerOpsActions());
    if (options.governorClients) registerGovernorChatActions(options.governorClients);
    const dispatch = options.dispatchAction ?? dispatchChatAction;

    /** Shape a dispatch result into the tools' shared output: blocked/declined/ok, never a thrown gate. */
    const dispatchResult = async (action: string, params: Record<string, unknown>) => {
      const result = await dispatch({ action, params });
      if (result.ok) return { ok: true, action, result: (result as { result?: unknown }).result };
      // A refusal is an ANSWER, not a transport failure: the caller needs to know the governor said no and
      // why, which a thrown error would flatten into a generic tool error.
      return {
        ok: false,
        action,
        blocked: true,
        reason: result.status,
        // #9659: the shared envelope, so one `error` field means one thing everywhere. `blocked` and
        // `reason` still carry the refusal's own vocabulary; what used to be a bare string detail is now
        // the envelope's `message`, under a code drawn from the same closed set telemetry records.
        error: { code: DISPATCH_REFUSAL_CODES[result.status] ?? "unknown_error", message: typeof result.error === "string" ? result.error : result.status },
      };
    };

    registerMinerTool(server, minerGovernorPauseTool, (input) => withMinerToolErrorHandling(() => dispatchResult(GOVERNOR_PAUSE_CHAT_ACTION, input.reason ? { reason: input.reason } : {}), minerGovernorPauseTool.name),
    );

    registerMinerTool(server, minerGovernorResumeTool, () => withMinerToolErrorHandling(() => dispatchResult(GOVERNOR_RESUME_CHAT_ACTION, {}), minerGovernorResumeTool.name),
    );

    registerMinerTool(server, minerQueueReleaseTool, (input) => withMinerToolErrorHandling(() => dispatchResult(MINER_QUEUE_RELEASE_ACTION, { ...input }), minerQueueReleaseTool.name),
    );

    registerMinerTool(server, minerQueueRequeueTool, (input) => withMinerToolErrorHandling(() => dispatchResult(MINER_QUEUE_REQUEUE_ACTION, { ...input }), minerQueueRequeueTool.name),
    );

    registerMinerTool(server, minerClaimReleaseTool, (input) => withMinerToolErrorHandling(() => dispatchResult(MINER_CLAIM_RELEASE_ACTION, { ...input }), minerClaimReleaseTool.name),
    );

    registerMinerTool(server, minerDenyHooksDecideTool, (input) => withMinerToolErrorHandling(() => dispatchResult(MINER_DENY_HOOKS_DECIDE_ACTION, { ...input }), minerDenyHooksDecideTool.name),
    );

    registerMinerTool(server, minerRunMigrationsTool, () => withMinerToolErrorHandling(() => dispatchResult(MINER_RUN_MIGRATIONS_ACTION, {}), minerRunMigrationsTool.name),
    );

    registerMinerTool(server, minerPurgeRepoTool, (input) =>
        withMinerToolErrorHandling(async () => {
          const result = await dispatchResult(MINER_PURGE_REPO_ACTION, { repoFullName: input.repoFullName });
          return { ...result, repoFullName: input.repoFullName };
        }, minerPurgeRepoTool.name),
    );
  }

  // ── #9523 reads ────────────────────────────────────────────────────────
  registerMinerTool(server, minerDoctorTool, () =>
      withMinerToolErrorHandling(() => {
        // status.js reports each check as {name, ok, detail}. The contract carries pass/warn/fail because the
        // catalog wants doctor to GROW checks (#9523) and a boolean cannot express "degraded but working";
        // every check maps to pass/fail today, and `warn` is reserved for the first check that needs it.
        const checks = ((options.runDoctorChecks ?? runDoctorChecks)() as { name: string; ok: boolean; detail: string }[]).map((check) => ({
          name: check.name,
          status: check.ok ? ("pass" as const) : ("fail" as const),
          detail: check.detail,
        }));
        return { ok: checks.every((check) => check.status !== "fail"), checks };
      }, minerDoctorTool.name),
  );

  registerMinerTool(server, minerMetricsSnapshotTool, () =>
      withMinerToolErrorHandling(() => {
        const ownsPredictionLedger = options.initPredictionLedger === undefined;
        const ownsEventLedger = options.initEventLedger === undefined;
        let predictionLedger;
        let eventLedger;
        try {
          predictionLedger = (options.initPredictionLedger ?? initPredictionLedger)();
          eventLedger = (options.initEventLedger ?? initEventLedger)();
          const outcomes = toOutcomeRecords(eventLedger.readEvents() as never);
          // The SAME aggregation the Prometheus scrape renders (#9523) -- a second summing pass here would be
          // a second definition of what each counter means, free to drift from the text exposition.
          const families = collectMinerPredictionMetrics(collectPredictionMetricRows(predictionLedger as never, outcomes));
          return { generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(), families };
        } finally {
          if (ownsPredictionLedger) predictionLedger?.close();
          if (ownsEventLedger) eventLedger?.close();
        }
      }, minerMetricsSnapshotTool.name),
  );

  registerMinerTool(server, minerCalibrationReportTool, () =>
      withMinerToolErrorHandling(() => {
        const ownsPredictionLedger = options.initPredictionLedger === undefined;
        const ownsEventLedger = options.initEventLedger === undefined;
        let predictionLedger;
        let eventLedger;
        try {
          predictionLedger = (options.initPredictionLedger ?? initPredictionLedger)();
          eventLedger = (options.initEventLedger ?? initEventLedger)();
          return buildCalibrationReport(toPredictionRecords(predictionLedger.readPredictions()), toOutcomeRecords(eventLedger.readEvents()));
        } finally {
          if (ownsPredictionLedger) predictionLedger?.close();
          if (ownsEventLedger) eventLedger?.close();
        }
      }, minerCalibrationReportTool.name),
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
  await Promise.all([initMinerSentry(process.env), initMinerPostHog(process.env)]);
  installCliSignalHandlers({
    captureError: (error, context) =>
      Promise.all([captureMinerErrorAndFlush(error, context), captureMinerPostHogErrorAndFlush(error, context)]).then(() => undefined),
  });

  createMinerMcpServer()
    .connect(new StdioServerTransport())
    .catch(async (error) => {
      console.error(error);
      // Awaited so the captured event has a chance to actually reach each configured sink before exit() tears
      // the process down -- a bare synchronous capture only queues it (#6011 follow-up, extended to PostHog
      // per #8292's parallel-run posture).
      await Promise.all([
        captureMinerErrorAndFlush(error, { kind: "mcp_startup_connect_failed" }),
        captureMinerPostHogErrorAndFlush(error, { kind: "mcp_startup_connect_failed" }),
      ]);
      process.exit(1);
    });
}
/* v8 ignore stop */
