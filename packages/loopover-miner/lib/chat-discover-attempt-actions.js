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
export const DISCOVER_CHAT_ACTION = "discover";
export const ATTEMPT_CHAT_ACTION = "attempt";
/** The endpoint owns the gate (see the header note); satisfy the registry brand only. */
const allowEndpointGatedAction = () => ({ decision: { stage: "allow" } });
const DISCOVER_KEYS = new Set(["targets", "search", "dryRun", "json", "apiBaseUrl", "tokenEnv"]);
const ATTEMPT_KEYS = new Set(["repoFullName", "issueNumber", "minerLogin", "base", "live", "dryRun", "json"]);
function asParamsRecord(params) {
    if (params == null || typeof params !== "object" || Array.isArray(params))
        return null;
    return params;
}
/** A non-empty string — the shape every required text field here needs. */
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
}
/**
 * `DiscoverActionInput` — every field optional (the CLI defaults them all), so an empty object is a valid
 * "discover with defaults". Unknown keys are rejected rather than ignored: these params can be model-authored,
 * and a typo'd flag must fail loudly instead of silently running a different discovery than intended.
 */
export function isDiscoverChatParams(params) {
    if (params == null)
        return true;
    const record = asParamsRecord(params);
    if (record === null)
        return false;
    for (const key of Object.keys(record)) {
        if (!DISCOVER_KEYS.has(key))
            return false;
    }
    if (record.targets !== undefined) {
        if (!Array.isArray(record.targets) || !record.targets.every(isNonEmptyString))
            return false;
    }
    for (const key of ["search", "apiBaseUrl", "tokenEnv"]) {
        if (record[key] !== undefined && typeof record[key] !== "string")
            return false;
    }
    for (const key of ["dryRun", "json"]) {
        if (record[key] !== undefined && typeof record[key] !== "boolean")
            return false;
    }
    return true;
}
/**
 * `AttemptActionInput` — `repoFullName` / `issueNumber` / `minerLogin` are REQUIRED (the CLI has no default
 * for which issue to attempt), so unlike discover there is no valid empty form. `issueNumber` must be a
 * positive integer: a float or 0 would reach the CLI as a nonsense issue reference.
 */
export function isAttemptChatParams(params) {
    const record = asParamsRecord(params);
    if (record === null)
        return false;
    for (const key of Object.keys(record)) {
        if (!ATTEMPT_KEYS.has(key))
            return false;
    }
    if (!isNonEmptyString(record.repoFullName))
        return false;
    if (!isNonEmptyString(record.minerLogin))
        return false;
    if (!Number.isInteger(record.issueNumber) || record.issueNumber <= 0)
        return false;
    if (record.base !== undefined && typeof record.base !== "string")
        return false;
    for (const key of ["live", "dryRun", "json"]) {
        if (record[key] !== undefined && typeof record[key] !== "boolean")
            return false;
    }
    return true;
}
/**
 * Idempotently register `discover` / `attempt`.
 */
export function registerDiscoverAttemptChatActions(options) {
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
            handler: governorGatedHandler(async (request) => requestDiscover((asParamsRecord(request?.params) ?? {})), { evaluateGate }),
        });
    }
    if (!registry.has(ATTEMPT_CHAT_ACTION)) {
        registry.register(ATTEMPT_CHAT_ACTION, {
            paramsValidator: isAttemptChatParams,
            handler: governorGatedHandler(async (request) => requestAttempt(asParamsRecord(request?.params)), { evaluateGate }),
        });
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hhdC1kaXNjb3Zlci1hdHRlbXB0LWFjdGlvbnMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJjaGF0LWRpc2NvdmVyLWF0dGVtcHQtYWN0aW9ucy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxzREFBc0Q7QUFDdEQsRUFBRTtBQUNGLHlHQUF5RztBQUN6RywyR0FBMkc7QUFDM0csNEdBQTRHO0FBQzVHLHVHQUF1RztBQUN2Ryw0R0FBNEc7QUFDNUcsbUdBQW1HO0FBQ25HLDhHQUE4RztBQUM5RyxnQ0FBZ0M7QUFDaEMsRUFBRTtBQUNGLDZFQUE2RTtBQUM3RSxxR0FBcUc7QUFDckcscUVBQXFFO0FBQ3JFLCtGQUErRjtBQUMvRiw2R0FBNkc7QUFDN0csaUZBQWlGO0FBQ2pGLDJHQUEyRztBQUMzRyw4R0FBOEc7QUFDOUcsNkdBQTZHO0FBQzdHLDZHQUE2RztBQUM3Ryw2R0FBNkc7QUFFN0csT0FBTyxFQUFFLG9CQUFvQixFQUFFLGtCQUFrQixFQUFFLE1BQU0sMkJBQTJCLENBQUM7QUFHckYsTUFBTSxDQUFDLE1BQU0sb0JBQW9CLEdBQUcsVUFBbUIsQ0FBQztBQUN4RCxNQUFNLENBQUMsTUFBTSxtQkFBbUIsR0FBRyxTQUFrQixDQUFDO0FBcUJ0RCx5RkFBeUY7QUFDekYsTUFBTSx3QkFBd0IsR0FBRyxHQUFHLEVBQUUsQ0FBQyxDQUFDLEVBQUUsUUFBUSxFQUFFLEVBQUUsS0FBSyxFQUFFLE9BQU8sRUFBRSxFQUFFLENBQUMsQ0FBQztBQUUxRSxNQUFNLGFBQWEsR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLFNBQVMsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxZQUFZLEVBQUUsVUFBVSxDQUFDLENBQUMsQ0FBQztBQUNqRyxNQUFNLFlBQVksR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLGNBQWMsRUFBRSxhQUFhLEVBQUUsWUFBWSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLE1BQU0sQ0FBQyxD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