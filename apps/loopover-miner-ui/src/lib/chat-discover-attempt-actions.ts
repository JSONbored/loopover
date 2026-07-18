// Miner-ui wire for discover/attempt chat actions (#6837 — completing the miner-ui half that #7076 found
// missing).
//
// Binds the shared registry registrations (packages/loopover-miner/lib/chat-discover-attempt-actions.js) to the
// existing `requestDiscover` / `requestAttempt` HTTP clients — the same functions that POST `/api/discover` and
// `/api/attempt`. Like chat-governor-actions.ts, this module only supplies those clients in; it adds no new
// route and no hand-rolled fetch. UI text-to-action resolution for discover/attempt is intentionally left to a
// follow-up, so there is no runner/unwrap surface here yet — registering the handlers is the whole scope.

import { type ChatActionRegistry } from "../../../../packages/loopover-miner/lib/chat-action-registry.js";
import {
  ATTEMPT_CHAT_ACTION,
  DISCOVER_CHAT_ACTION,
  registerDiscoverAttemptChatActions as registerDiscoverAttemptChatActionsCore,
} from "../../../../packages/loopover-miner/lib/chat-discover-attempt-actions.js";
import { requestAttempt, type AttemptActionInput } from "./attempt";
import { requestDiscover, type DiscoverActionInput } from "./discover";

export {
  ATTEMPT_CHAT_ACTION,
  DISCOVER_CHAT_ACTION,
  isAttemptChatParams,
  isDiscoverChatParams,
} from "../../../../packages/loopover-miner/lib/chat-discover-attempt-actions.js";

export type DiscoverAttemptChatActionName = typeof DISCOVER_CHAT_ACTION | typeof ATTEMPT_CHAT_ACTION;

export type RegisterDiscoverAttemptChatActionsOptions = {
  registry?: ChatActionRegistry;
  requestDiscoverFn?: typeof requestDiscover;
  requestAttemptFn?: typeof requestAttempt;
  evaluateGate?: () => { decision: { stage: string } };
};

/** Idempotently register both actions, defaulting to the real `./discover` / `./attempt` clients. */
export function registerDiscoverAttemptChatActions(options: RegisterDiscoverAttemptChatActionsOptions = {}): void {
  const discover = options.requestDiscoverFn ?? requestDiscover;
  const attempt = options.requestAttemptFn ?? requestAttempt;
  registerDiscoverAttemptChatActionsCore({
    // The registry passes an already-validated params record (isDiscoverChatParams / isAttemptChatParams ran
    // in dispatch first), so narrowing to each client's input type here is safe.
    requestDiscover: (input) => discover(input as DiscoverActionInput),
    requestAttempt: (input) => attempt(input as AttemptActionInput),
    registry: options.registry,
    evaluateGate: options.evaluateGate,
  });
}
