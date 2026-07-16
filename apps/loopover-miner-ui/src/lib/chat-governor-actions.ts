// Miner-ui wire for governor pause/resume chat actions (#6521).
//
// Binds the shared registry registrations (packages/loopover-miner/lib/chat-governor-actions.js) to the
// existing `pauseGovernor` / `resumeGovernor` clients — the same functions the Ledgers buttons call.
// Also owns the pending-aware dispatch helper and result unwrap used by the chat surface.

import {
  CHAT_ACTION_DISPATCH_ENABLE_VALUE,
  CHAT_ACTION_DISPATCH_FLAG,
  dispatchChatAction,
  type ChatActionDispatchResult,
} from "../../../../packages/loopover-miner/lib/chat-action-dispatch.js";
import { type ChatActionRegistry } from "../../../../packages/loopover-miner/lib/chat-action-registry.js";
import {
  GOVERNOR_PAUSE_CHAT_ACTION,
  GOVERNOR_RESUME_CHAT_ACTION,
  registerGovernorChatActions as registerGovernorChatActionsCore,
} from "../../../../packages/loopover-miner/lib/chat-governor-actions.js";
import { pauseGovernor, resumeGovernor, type GovernorPauseStateResult } from "./governor";

export {
  GOVERNOR_PAUSE_CHAT_ACTION,
  GOVERNOR_RESUME_CHAT_ACTION,
  isGovernorPauseChatParams,
  isGovernorResumeChatParams,
} from "../../../../packages/loopover-miner/lib/chat-governor-actions.js";

export type GovernorChatActionName = typeof GOVERNOR_PAUSE_CHAT_ACTION | typeof GOVERNOR_RESUME_CHAT_ACTION;

export type RegisterGovernorChatActionsOptions = {
  registry?: ChatActionRegistry;
  pauseGovernorFn?: typeof pauseGovernor;
  resumeGovernorFn?: typeof resumeGovernor;
  evaluateGate?: () => { decision: { stage: string } };
};

/** Idempotently register both actions, defaulting to the real `./governor` clients. */
export function registerGovernorChatActions(options: RegisterGovernorChatActionsOptions = {}): void {
  registerGovernorChatActionsCore({
    pauseGovernor: options.pauseGovernorFn ?? pauseGovernor,
    resumeGovernor: options.resumeGovernorFn ?? resumeGovernor,
    registry: options.registry,
    evaluateGate: options.evaluateGate,
  });
}

export type RunGovernorChatActionOptions = {
  env?: Record<string, string | undefined>;
  registry?: ChatActionRegistry;
  /** Flipped true for the duration of the dispatch (mirrors LedgersPage `actionPending`). */
  onPending?: (pending: boolean) => void;
};

/**
 * Dispatch a governor chat action through the shared flag-gated entry point. Always goes through
 * `dispatchChatAction` — never calls the registered handler directly.
 */
export async function runGovernorChatAction(
  request: { action: GovernorChatActionName; params?: unknown },
  options: RunGovernorChatActionOptions = {},
): Promise<ChatActionDispatchResult> {
  options.onPending?.(true);
  try {
    return await dispatchChatAction(request, { env: options.env, registry: options.registry });
  } finally {
    options.onPending?.(false);
  }
}

/** Env map that enables chat-action dispatch (the only truthy value the shared flag accepts). */
export function enabledChatActionsEnv(): Record<string, string> {
  return { [CHAT_ACTION_DISPATCH_FLAG]: CHAT_ACTION_DISPATCH_ENABLE_VALUE };
}

/**
 * Unwrap a successful dispatch envelope to the inner `GovernorPauseStateResult` the handler returned.
 * Returns null when dispatch did not execute (disabled / unknown / invalid / gated).
 */
export function unwrapGovernorPauseChatResult(
  dispatchResult: ChatActionDispatchResult,
): GovernorPauseStateResult | null {
  if (dispatchResult.status !== "dispatched") return null;
  const gated = dispatchResult.result as { status?: string; result?: GovernorPauseStateResult } | undefined;
  if (gated?.status !== "executed") return null;
  const inner = gated.result;
  if (inner == null || typeof inner !== "object" || !("ok" in inner)) return null;
  return inner;
}

export { CHAT_ACTION_DISPATCH_FLAG, CHAT_ACTION_DISPATCH_ENABLE_VALUE };
