// Chat action-dispatch chokepoint (#6519).
//
// SINGLE ENTRY POINT, NEVER BYPASS: every action a miner-chat message issues MUST go through
// `dispatchChatAction` here -- never a parallel or direct call into a registered handler, an HTTP endpoint,
// or a local-write tool. This function is the one place the config flag is checked and the one place a
// registered handler is looked up and invoked. It adds NO second safety check of its own: the real
// fail-closed enforcement lives in packages/loopover-engine/src/governor/chokepoint.ts (the precedence
// ladder) reached through the packages/loopover-miner/lib/governor-chokepoint.js stateful wrapper, which the
// registry's `governorGatedHandler` contract forces every registered handler through. Dispatch only gates on
// the flag, rejects unknown actions, and runs the registered params-validator before invoking the handler.
//
// Disabled by default: the flag fails closed (off unless explicitly enabled), and the shared registry
// (chat-action-registry.js) ships empty, so no action can execute until a child issue registers a handler
// AND an operator flips the flag on.

import { chatActionRegistry } from "./chat-action-registry.js";

/** Env var an operator sets to turn the chat-action dispatch layer on. */
export const CHAT_ACTION_DISPATCH_FLAG = "LOOPOVER_MINER_CHAT_ACTIONS";
/** The one and only value that enables dispatch. Anything else (unset, empty, "true", "1", ...) stays off. */
export const CHAT_ACTION_DISPATCH_ENABLE_VALUE = "enabled";

/**
 * Fail-closed config-flag gate: enabled only when the flag is set to exactly the enable value (trimmed).
 * Unset, empty, or any other value -- including truthy-looking ones like "true"/"1" -- reads as disabled.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isChatActionDispatchEnabled(env = process.env) {
  const raw = env?.[CHAT_ACTION_DISPATCH_FLAG];
  return typeof raw === "string" && raw.trim() === CHAT_ACTION_DISPATCH_ENABLE_VALUE;
}

/**
 * The single entry point every chat-issued action goes through. In order:
 *   1. Check the config flag FIRST -- before touching the registry or validating params. When disabled,
 *      return a clearly-typed `"disabled"` result and look up nothing.
 *   2. Reject an unknown (unregistered) action.
 *   3. Run the action's own registered params-validator; reject on failure without coercing or dropping
 *      fields (the caller's `params` is passed through unchanged).
 *   4. Invoke the registered (governor-gated) handler and return its result.
 *
 * @param {{ action?: string, params?: unknown, governorInput?: unknown }} request
 * @param {{ env?: Record<string, string | undefined>, registry?: typeof chatActionRegistry }} [options]
 * @returns {Promise<{ ok: boolean, status: string, action: string | null, [k: string]: unknown }>}
 */
export async function dispatchChatAction(request, options = {}) {
  const env = options.env ?? process.env;

  // Flag first -- before touching the registry or validating params. Fail closed.
  if (!isChatActionDispatchEnabled(env)) {
    return { ok: false, status: "disabled", action: readAction(request) };
  }

  const registry = options.registry ?? chatActionRegistry;
  const action = readAction(request);
  if (action === null || !registry.has(action)) {
    return { ok: false, status: "unknown_action", action };
  }

  const registered = registry.get(action);
  let valid;
  try {
    valid = registered.paramsValidator(request?.params) === true;
  } catch (error) {
    // A validator that throws is treated as a rejection (fail closed), not as a dispatch error.
    return { ok: false, status: "invalid_params", action, error: error instanceof Error ? error.message : String(error) };
  }
  if (!valid) {
    return { ok: false, status: "invalid_params", action };
  }

  let result;
  try {
    result = await registered.handler(request);
  } catch (error) {
    // A handler that throws fails closed with the module's typed result shape (#6989), consistent with the
    // paramsValidator catch above -- a distinct "handler_error" status lets a caller tell an execution
    // failure apart from a params-validation failure.
    return { ok: false, status: "handler_error", action, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, status: "dispatched", action, result };
}

/** The requested action name, or null when the request omits a string action. */
function readAction(request) {
  return request && typeof request.action === "string" ? request.action : null;
}
