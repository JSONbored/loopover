// AMS miner tool contracts (#9536).
//
// Every tool here is `locality: "miner"`: it reads the miner box's own local SQLite stores (plan,
// event ledger, governor ledger, run state, portfolio queue, claim ledger, prediction ledger).
// That is not a deployment preference -- no hosted Worker can reach those files, which is exactly
// why LoopOver runs a separate MCP server for AMS rather than collapsing to one process.
//
// Before this migration not one of these tools declared an output schema or returned
// structuredContent; every handler stringified JSON into a text block. The schemas below are
// modelled from the aggregators the handlers actually call, so the structured payload each tool
// gains is a description of what it already returns, not a new shape.
import { z } from "zod";
import { defineTool } from "../tool-definition.js";

/** Statuses a portfolio-queue entry can hold. */
export const QUEUE_STATUSES = ["queued", "in_progress", "done"] as const;

/** Statuses a local claim-ledger row can hold. */
export const CLAIM_STATUSES = ["active", "released", "expired"] as const;

/** Per-status counts, repeated at both the global and per-repo level of the dashboard. */
const queueStatusCounts = z.looseObject({
  queued: z.number(),
  in_progress: z.number(),
  done: z.number(),
});

// ── ping ────────────────────────────────────────────────────────────────────────────────────────

export const MinerPingInput = z.object({});

/** Static, and deliberately so: this tool exists to prove the server is reachable without touching
 *  any store, so its output is a fixed literal rather than anything derived. */
export const MinerPingOutput = z.looseObject({
  status: z.literal("ok"),
  tool: z.literal("loopover_miner_ping"),
});

export const minerPingTool = defineTool({
  name: "loopover_miner_ping",
  title: "Miner health check",
  description:
    "Health check for the loopover-miner MCP server. Returns a static status object confirming the server is reachable. Reads no AMS state and takes no arguments.",
  category: "utility",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerPingInput,
  output: MinerPingOutput,
});

// ── portfolio dashboard ─────────────────────────────────────────────────────────────────────────

export const MinerPortfolioDashboardInput = z.object({});

/** `PortfolioDashboardSummary` (packages/loopover-miner/lib/portfolio-dashboard.ts).
 *  `oldestQueuedAgeMs` is null when no clock was supplied or nothing is queued -- a real absence,
 *  not a zero. */
export const MinerPortfolioDashboardOutput = z.looseObject({
  total: z.number(),
  byStatus: queueStatusCounts,
  repos: z.array(
    z.looseObject({
      apiBaseUrl: z.string(),
      repoFullName: z.string(),
      byStatus: queueStatusCounts,
      total: z.number(),
    }),
  ),
  oldestQueuedAgeMs: z.number().nullable(),
});

export const minerPortfolioDashboardTool = defineTool({
  name: "loopover_miner_get_portfolio_dashboard",
  title: "Miner portfolio dashboard",
  description:
    "Read-only per-repo portfolio-queue backlog dashboard: status counts (queued/in_progress/done), totals, and the oldest-queued age in ms. Wraps the existing collectPortfolioDashboard aggregator (no new logic) -- the same data `loopover-miner queue dashboard --json` prints locally. Takes no arguments; mutates nothing.",
  category: "agent",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerPortfolioDashboardInput,
  output: MinerPortfolioDashboardOutput,
});

// ── manage status ───────────────────────────────────────────────────────────────────────────────

/** `ManageStatusRow`. Every field but the identifiers is nullable: a PR can be tracked before CI
 *  has reported, before the gate has run, and before it has an outcome. */
export const manageStatusRowSchema = z.looseObject({
  repoFullName: z.string(),
  prNumber: z.number(),
  branch: z.string().nullable(),
  ciState: z.string().nullable(),
  gateVerdict: z.string().nullable(),
  outcome: z.string().nullable(),
  lastPolledAt: z.string().nullable(),
  queueStatus: z.enum(QUEUE_STATUSES).nullable(),
  priority: z.number().nullable(),
});

export const MinerManageStatusInput = z.object({});

/** `{ rows, runPortfolio }` -- the same pair `manage status --json` prints. */
export const MinerManageStatusOutput = z.looseObject({
  rows: z.array(manageStatusRowSchema),
  runPortfolio: z.array(
    z.looseObject({
      repoFullName: z.string(),
      runState: z.string().nullable(),
      runStateUpdatedAt: z.string().nullable(),
      prCount: z.number(),
      prs: z.array(manageStatusRowSchema),
    }),
  ),
});

export const minerManageStatusTool = defineTool({
  name: "loopover_miner_get_manage_status",
  title: "Miner manage-phase status",
  description:
    "Read-only manage-phase status: the per-managed-PR rows `loopover-miner manage status` reports (branch, CI state, gate verdict, outcome, last-polled-at, queue status/priority) plus the run-level portfolio view (one row per tracked repo: run state, updated-at, PR count). Joins the portfolio queue, the append-only event ledger, and run-state by reusing the existing collectManageStatus/collectRunPortfolio aggregators -- no new join logic. Read-only: never calls GitHub, never mutates local stores. Takes no arguments.",
  category: "agent",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerManageStatusInput,
  output: MinerManageStatusOutput,
});

// ── claims ──────────────────────────────────────────────────────────────────────────────────────

export const MinerListClaimsInput = z.object({
  repoFullName: z.string().optional(),
  status: z.enum(CLAIM_STATUSES).optional(),
});

/** The ledger's own row shape. Left open below the named fields because `listClaims` returns rows
 *  straight from SQLite, and the store has added columns over time without the MCP surface
 *  changing -- pinning it closed would make the next column a breaking change. */
export const MinerListClaimsOutput = z.looseObject({
  claims: z.array(
    z.looseObject({
      repoFullName: z.string(),
      issueNumber: z.number(),
      status: z.string(),
      claimedAt: z.string().nullish(),
      note: z.string().nullish(),
    }),
  ),
});

export const minerListClaimsTool = defineTool({
  name: "loopover_miner_list_claims",
  title: "List miner claims",
  description:
    "Read-only listing of the local claim ledger: which issues this miner has claimed (repo, issue number, status, claimed-at, note). Optional repoFullName/status filters pass through to the existing listClaims query. Exposes no claim/release mutation and no conflict-resolution logic.",
  category: "agent",
  auth: "public",
  locality: "miner",
  availability: "selfhost",
  input: MinerListClaimsInput,
  output: MinerListClaimsOutput,
});
