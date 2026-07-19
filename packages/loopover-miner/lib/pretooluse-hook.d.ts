import { type DenyRule } from "./deny-hooks.js";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";
export type BuildHouseRulesPreToolUseHookConfig = {
    rules?: readonly DenyRule[];
    repoFullName?: string;
};
export type BuildHouseRulesPreToolUseHookOptions = {
    append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry;
};
/** Minimal shape this module reads from the real Agent SDK `PreToolUseHookInput`. */
export type PreToolUseHookLikeInput = {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    hook_event_name?: string;
};
export type PreToolUseHookJSONOutput = {
    hookSpecificOutput?: {
        hookEventName: "PreToolUse";
        permissionDecision: "deny";
        permissionDecisionReason: string;
    };
};
/**
 * Build a Claude Agent SDK `PreToolUse` hook callback enforcing the house-rule denylist. Register the
 * returned function under `options.hooks.PreToolUse` (e.g. `{ hooks: [PreToolUse: [{ hooks: [built] }]] }`
 * on the object passed to `createAgentSdkCodingAgentDriver({ hooks })`).
 *
 * House rules are sourced from a single, auditable list: {@link DEFAULT_DENY_RULES} by default, or an
 * effective rule set built by the caller (e.g. `resolveEffectiveDenyRules` from deny-hook-synthesis.js,
 * merging in maintainer-approved synthesized rules) — this module composes whatever rule set it is given,
 * it does not own deriving one.
 */
export declare function buildHouseRulesPreToolUseHook(config?: BuildHouseRulesPreToolUseHookConfig, options?: BuildHouseRulesPreToolUseHookOptions): (input: PreToolUseHookLikeInput, toolUseId?: string, context?: unknown) => Promise<PreToolUseHookJSONOutput | Record<string, never>>;
