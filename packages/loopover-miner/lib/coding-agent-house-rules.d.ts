import { type AgentSdkHooks, type CodingAgentDriverResult, type CodingAgentExecutionMode, type LintGuardResult, type RunCodingAgentAttemptOptions } from "@loopover/engine";
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
    PreToolUse: Array<{
        hooks: Array<(input: unknown, toolUseId?: string, context?: unknown) => Promise<Record<string, unknown>>>;
    }>;
};
/**
 * Wrap {@link buildHouseRulesPreToolUseHook}'s callback into the Claude Agent SDK's own `hooks.PreToolUse`
 * registration shape (an array of matcher groups, each holding an array of hook callbacks) -- the exact
 * contract `agent-sdk-driver.ts`'s own doc comment names as "#2343's stated attachment point", and the shape
 * `packages/loopover-engine/test/agent-sdk-driver.test.ts` asserts is forwarded to the SDK verbatim.
 */
export declare function buildHouseRulesAgentSdkHooks(config?: HouseRulesConfig, options?: HouseRulesOptions): HouseRulesAgentSdkHooks;
/**
 * Drop-in replacement for the engine's `runCodingAgentAttempt` that defaults `hooks` to
 * {@link buildHouseRulesAgentSdkHooks} for the `agent-sdk` provider, so house-rule enforcement (#2343) is ON
 * by default rather than opt-in. An explicitly-supplied `hooks` option always wins (e.g. a test injecting its
 * own hook double, or a caller composing additional hooks of its own) -- this only fills the gap when the
 * caller omitted it entirely. CLI providers (`claude-cli`, `codex-cli`) have no hook-registration surface, and
 * the engine fails closed if `hooks` is supplied to them at all -- so the default is scoped to `agent-sdk`
 * only; a CLI attempt with no explicit `hooks` gets none (today's inert no-op), while one that explicitly
 * supplies `hooks` still gets the engine's real fail-closed rejection instead of a silently unenforced run.
 */
export declare function runHouseRulesEnforcedCodingAgentAttempt(options: RunCodingAgentAttemptOptions & {
    houseRulesConfig?: HouseRulesConfig;
    houseRulesOptions?: HouseRulesOptions;
}): Promise<{
    mode: CodingAgentExecutionMode;
    result: CodingAgentDriverResult & {
        lintGuard?: LintGuardResult;
    };
}>;
