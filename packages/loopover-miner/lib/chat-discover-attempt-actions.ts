// Discover/attempt chat-action registrations (#6837).
//
// The third and last child of the chat action-dispatch scaffolding (#6519) — chat-action-registry.js:4-5
// names all three families (portfolio release/requeue, governor pause/resume, discover/attempt); the other
// two already ship. Registers `discover` / `attempt` into a chat-action registry. Handlers MUST be wired to
// the miner-ui clients `requestDiscover` / `requestAttempt` (apps/loopover-miner-ui/src/lib/{discover,
// attempt}.ts), so chat POSTs the SAME `/api/discover` and `/api/attempt` routes that already exist (#6522,
// registered at vite.config.ts:36-37) — never discover-cli.js/attempt-cli.js directly, and never a
// hand-rolled fetch. The miner-ui wire module passes those clients in; this module only owns the registration
// contract + params validators.
//
// GATING — the gate lives at the endpoint, not here, and that is deliberate:
//   * `attempt` INHERITS the real Governor chokepoint for free: the route calls the real, unmodified
//     `runAttempt`, and attempt-runner.js routes every write through
//     `evaluateGovernorChokepointGatePersisted` before executing it (vite-attempt-api.ts:7-9).
//   * `discover` has no chokepoint because it performs no gated write — it only fans out, ranks and enqueues
//     (vite-discover-api.ts:13-14), so the CLI has none and the route adds none.
// Re-evaluating the chokepoint here would therefore be a SECOND, competing gate on a path that already has
// one (or needs none) — exactly what those route comments rule out, and it would gate chat more strictly than
// the equivalent CLI invocation. So, like chat-governor-actions.js and chat-portfolio-actions.js, we satisfy
// the registry's `governorGatedHandler` brand with an allow-stage evaluateGate. Execution still stays behind
// the shared LOOPOVER_MINER_CHAT_ACTIONS flag via `dispatchChatAction`, and `evaluateGate` stays injectable.

import { governorGatedHandler, chatActionRegistry } from "./chat-action-registry.js";
import type { ChatActionRegistry } from "./chat-action-registry.js";

export const DISCOVER_CHAT_ACTION = "discover" as const;
export const ATTEMPT_CHAT_ACTION = "attempt" as const;

export type DiscoverChatActionInput = {
  targets?: string[];
  search?: string;
  dryRun?: boolean;
  json?: boolean;
  apiBaseUrl?: string;
  tokenEnv?: string;
};

export type AttemptChatActionInput = {
  repoFullName: string;
  issueNumber: number;
  minerLogin: string;
  base?: string;
  live?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

/** The endpoint owns the gate (see the header note); satisfy the registry brand only. */
const allowEndpointGatedAction = () => ({ decision: { stage: "allow" } });

const DISCOVER_KEYS = new Set(["targets", "search", "dryRun", "json", "apiBaseUrl", "tokenEnv"]);
const ATTEMPT_KEYS = new Set(["repoFullName", "issueNumber", "minerLogin", "base", "live", "dryRun", "json"]);

function asParamsRecord(params: unknown): Record<string, unknown> | null {
  if (params == null || typeof params !== "object" || Array.isArray(params)) return null;
  return params as Record<string, unknown>;
}

/** A non-empty string — the shape every required text field here needs. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * `DiscoverActionInput` — every field optional (the CLI defaults them all), so an empty object is a valid
 * "discover with defaults". Unknown keys are rejected rather than ignored: these params can be model-authored,
 * and a typo'd flag must fail loudly instead of silently running a different discovery than intended.
 */
export function isDiscoverChatParams(params: unknown): boolean {
  if (params == null) return true;
  const record = asParamsRecord(params);
  if (record === null) return false;
  for (const key of Object.keys(record)) {
    if (!DISCOVER_KEYS.has(key)) return false;
  }
  if (record.targets !== undefined) {
    if (!Array.isArray(record.targets) || !record.targets.every(isNonEmptyString)) return false;
  }
  for (const key of ["search", "apiBaseUrl", "tokenEnv"]) {
    if (record[key] !== undefined && typeof record[key] !== "string") return false;
  }
  for (const key of ["dryRun", "json"]) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") return false;
  }
  return true;
}

/**
 * `AttemptActionInput` — `repoFullName` / `issueNumber` / `minerLogin` are REQUIRED (the CLI has no default
 * for which issue to attempt), so unlike discover there is no valid empty form. `issueNumber` must be a
 * positive integer: a float or 0 would reach the CLI as a nonsense issue reference.
 */
export function isAttemptChatParams(params: unknown): boolean {
  const record = asParamsRecord(params);
  if (record === null) return false;
  for (const key of Object.keys(record)) {
    if (!ATTEMPT_KEYS.has(key)) return false;
  }
  if (!isNonEmptyString(record.repoFullName)) return false;
  if (!isNonEmptyString(record.minerLogin)) return false;
  if (!Number.isInteger(record.issueNumber) || (record.issueNumber as number) <= 0) return false;
  if (record.base !== undefined && typeof record.base !== "string") return false;
  for (const key of ["live", "dryRun", "json"]) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") return false;
  }
  return true;
}

/**
 * Idempotently register `discover` / `attempt`.
 */
export function registerDiscoverAttemptChatActions(options: {
  requestDiscover: (input: DiscoverChatActionInput) => Promise<unknown>;
  requestAttempt: (input: AttemptChatActionInput) => Promise<unknown>;
  registry?: ChatActionRegistry;
  evaluateGate?: () => { decision: { stage: string } };
}): void {
  const requestDiscover = options?.requestDiscover;
  const requestAttempt = options?.requestAttempt;
  if (typeof requestDiscover !== "function") {
    throw new TypeError("registerDiscoverAttemptChatActions: requestDiscover must be a function");
  }
  if (typeof requestAttempt !== "function") {
    throw new TypeError("registerDiscoverAttemptChatActions: requestAttempt must be a function");
  }

  const registry = options.registry ?? chatActionRegistry;
  const evaluateGate = options.evaluateGate ?? allowEndpointGatedAction;

  if (!registry.has(DISCOVER_CHAT_ACTION)) {
    registry.register(DISCOVER_CHAT_ACTION, {
      paramsValidator: isDiscoverChatParams,
      // Nullish params mean "discover with defaults" -- forwarded as {} so the client always POSTs an object.
      handler: governorGatedHandler(async (request) => requestDiscover((asParamsRecord(request?.params) ?? {}) as DiscoverChatActionInput), {
        evaluateGate,
      }),
    });
  }

  if (!registry.has(ATTEMPT_CHAT_ACTION)) {
    registry.register(ATTEMPT_CHAT_ACTION, {
      paramsValidator: isAttemptChatParams,
      handler: governorGatedHandler(async (request) => requestAttempt(asParamsRecord(request?.params) as AttemptChatActionInput), {
        evaluateGate,
      }),
    });
  }
}
