import type { DenyRule } from "./deny-hooks.js";
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

export function buildHouseRulesPreToolUseHook(
  config?: BuildHouseRulesPreToolUseHookConfig,
  options?: BuildHouseRulesPreToolUseHookOptions,
): (input: PreToolUseHookLikeInput, toolUseId?: string, context?: unknown) => Promise<PreToolUseHookJSONOutput | Record<string, never>>;
