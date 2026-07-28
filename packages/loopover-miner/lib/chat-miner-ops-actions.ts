// Chat-action registrations for the miner's MCP-reachable mutating ops (#9523).
//
// This is the whole safety story for those tools. Every mutation the miner MCP exposes registers HERE, into
// the same `chat-action-registry` the dashboard's own actions use, and therefore through
// `governorGatedHandler()` -- which the registry structurally requires, since a raw function can never
// satisfy its private brand. The MCP layer never calls a store directly; it dispatches an action name. So an
// MCP caller cannot reach a write path the dashboard could not, and that is enforced by the registry's
// contract rather than by review discipline.
//
// Registration is idempotent (see `registerMinerOpsChatActions`), because both the MCP server and any future
// chat surface may initialize in the same process.
import { governorGatedHandler, chatActionRegistry } from "./chat-action-registry.js";
import type { ChatActionRegistry, ChatActionRequest } from "./chat-action-registry.js";

export const MINER_QUEUE_RELEASE_ACTION = "miner_queue_release";
export const MINER_QUEUE_REQUEUE_ACTION = "miner_queue_requeue";
export const MINER_CLAIM_RELEASE_ACTION = "miner_claim_release";
export const MINER_DENY_HOOKS_DECIDE_ACTION = "miner_deny_hooks_decide";
export const MINER_RUN_MIGRATIONS_ACTION = "miner_run_migrations";
export const MINER_PURGE_REPO_ACTION = "miner_purge_repo";

/**
 * Store-level operations, injected rather than imported so the registration module stays free of the stores
 * themselves -- the same seam `createMinerMcpServer` already uses for its readers, and what lets the
 * structural test register against fakes without touching disk.
 */
export type MinerOpsActions = {
  releaseQueueItem(input: { repoFullName: string; issueNumber: number }): Promise<unknown> | unknown;
  requeueQueueItem(input: { repoFullName: string; issueNumber: number }): Promise<unknown> | unknown;
  releaseClaim(input: { repoFullName: string; issueNumber: number }): Promise<unknown> | unknown;
  decideDenyHook(input: { repoFullName: string; hookId: string; decision: "approve" | "reject" }): Promise<unknown> | unknown;
  runMigrations(): Promise<unknown> | unknown;
  purgeRepo(input: { repoFullName: string }): Promise<unknown> | unknown;
};

function isQueueTargetParams(params: unknown): boolean {
  if (params == null || typeof params !== "object" || Array.isArray(params)) return false;
  const { repoFullName, issueNumber } = params as { repoFullName?: unknown; issueNumber?: unknown };
  return typeof repoFullName === "string" && repoFullName.includes("/") && Number.isInteger(issueNumber) && (issueNumber as number) > 0;
}

function isDenyHookDecisionParams(params: unknown): boolean {
  if (params == null || typeof params !== "object" || Array.isArray(params)) return false;
  const { repoFullName, hookId, decision } = params as { repoFullName?: unknown; hookId?: unknown; decision?: unknown };
  return (
    typeof repoFullName === "string" &&
    repoFullName.includes("/") &&
    typeof hookId === "string" &&
    hookId.length > 0 &&
    (decision === "approve" || decision === "reject")
  );
}

/** Migrations take no arguments -- only nullish or an empty object is valid. */
function isMigrationsParams(params: unknown): boolean {
  if (params == null) return true;
  if (typeof params !== "object" || Array.isArray(params)) return false;
  return Object.keys(params as object).length === 0;
}

function isPurgeParams(params: unknown): boolean {
  if (params == null || typeof params !== "object" || Array.isArray(params)) return false;
  const { repoFullName } = params as { repoFullName?: unknown };
  return typeof repoFullName === "string" && repoFullName.includes("/");
}

/**
 * No nullish fallback: every action that calls this has a params validator requiring an OBJECT, and
 * dispatchChatAction runs that validator before the handler. A `?? {}` here would be unreachable defensive
 * code -- `miner_run_migrations`, the one action that accepts absent params, takes none and never calls this.
 */
function paramsOf<T>(request: ChatActionRequest): T {
  return request.params as T;
}

/**
 * Idempotently register the miner's mutating ops actions.
 *
 * Unlike governor pause/resume -- administrative control, which supplies an allow-stage gate -- these are
 * content writes against the miner's own stores, so they take the registry's DEFAULT evaluator: the real
 * `evaluateGovernorChokepointGate`, and through it the fail-closed precedence ladder in
 * @loopover/engine's governor chokepoint.
 */
export function registerMinerOpsChatActions(
  actions: MinerOpsActions,
  registry: ChatActionRegistry = chatActionRegistry,
  /**
   * Override the chokepoint evaluator. Mirrors the dashboard's own
   * `registerPortfolioQueueChatActions({ evaluateGate })` seam: production always uses the DEFAULT (the real
   * `evaluateGovernorChokepointGate`), and only a test supplies one, so the gate cannot be weakened by
   * configuration.
   */
  options: { evaluateGate?: (input: unknown, gateOptions?: unknown) => unknown } = {},
): void {
  const gateOpts = options.evaluateGate ? { evaluateGate: options.evaluateGate } : undefined;
  const definitions: [string, (params: unknown) => boolean, (request: ChatActionRequest) => Promise<Record<string, unknown>>][] = [
    [
      MINER_QUEUE_RELEASE_ACTION,
      isQueueTargetParams,
      async (request) => ({ result: await actions.releaseQueueItem(paramsOf(request)) }),
    ],
    [
      MINER_QUEUE_REQUEUE_ACTION,
      isQueueTargetParams,
      async (request) => ({ result: await actions.requeueQueueItem(paramsOf(request)) }),
    ],
    [MINER_CLAIM_RELEASE_ACTION, isQueueTargetParams, async (request) => ({ result: await actions.releaseClaim(paramsOf(request)) })],
    [
      MINER_DENY_HOOKS_DECIDE_ACTION,
      isDenyHookDecisionParams,
      async (request) => ({ result: await actions.decideDenyHook(paramsOf(request)) }),
    ],
    [
      MINER_RUN_MIGRATIONS_ACTION,
      isMigrationsParams,
      async () => ({ result: await actions.runMigrations() }),
    ],
    [MINER_PURGE_REPO_ACTION, isPurgeParams, async (request) => ({ result: await actions.purgeRepo(paramsOf(request)) })],
  ];

  for (const [name, paramsValidator, run] of definitions) {
    if (registry.has(name)) continue;
    registry.register(name, { paramsValidator, handler: governorGatedHandler(run, gateOpts) });
  }
}

/** Every action name this module owns -- the structural test asserts each is governor-gated. */
export const MINER_OPS_CHAT_ACTIONS = [
  MINER_QUEUE_RELEASE_ACTION,
  MINER_QUEUE_REQUEUE_ACTION,
  MINER_CLAIM_RELEASE_ACTION,
  MINER_DENY_HOOKS_DECIDE_ACTION,
  MINER_RUN_MIGRATIONS_ACTION,
  MINER_PURGE_REPO_ACTION,
] as const;
