import type { AgentSdkHooks, CodingAgentDriverResult, CodingAgentExecutionMode, LintGuardResult, RunCodingAgentAttemptOptions } from "@jsonbored/gittensory-engine";
import type { DenyRule } from "./deny-hooks.js";
import type { appendGovernorEvent } from "./governor-ledger.js";

export type HouseRulesConfig = {
  rules?: readonly DenyRule[];
  repoFullName?: string;
};

export type HouseRulesOptions = {
  append?: typeof appendGovernorEvent;
};

/** The concrete shape {@link buildHouseRulesAgentSdkHooks} returns -- a single PreToolUse matcher group
 *  holding the one house-rules callback. Structurally assignable to the engine's opaque `AgentSdkHooks`. */
export type HouseRulesAgentSdkHooks = AgentSdkHooks & {
  PreToolUse: Array<{ hooks: Array<(input: unknown, toolUseId?: string, context?: unknown) => Promise<Record<string, unknown>>> }>;
};

export function buildHouseRulesAgentSdkHooks(config?: HouseRulesConfig, options?: HouseRulesOptions): HouseRulesAgentSdkHooks;

export function runHouseRulesEnforcedCodingAgentAttempt(
  options: RunCodingAgentAttemptOptions & { houseRulesConfig?: HouseRulesConfig; houseRulesOptions?: HouseRulesOptions },
): Promise<{ mode: CodingAgentExecutionMode; result: CodingAgentDriverResult & { lintGuard?: LintGuardResult } }>;
