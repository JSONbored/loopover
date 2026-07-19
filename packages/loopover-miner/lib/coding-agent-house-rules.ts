// House-rules-enforced coding-agent construction (#2343 follow-up). buildHouseRulesPreToolUseHook
// (pretooluse-hook.js) is the LIVE PreToolUse interception point, but the engine package's
// createCodingAgentDriver / runCodingAgentAttempt (driver-factory.ts) cannot import it directly -- the
// dependency only ever flows loopover-miner -> @loopover/engine, never the reverse (the engine
// package is portable and cannot depend on the miner CLI package). This module is the missing miner-side
// glue: it wraps runCodingAgentAttempt so the `agent-sdk` provider gets house-rule enforcement by DEFAULT --
// a future real call site does not need to remember to attach it itself, closing the exact gap
// buildHouseRulesPreToolUseHook's own doc comment already anticipated ("the live interception wiring itself").
//
// This does not build a CLI entrypoint. UPDATE (#5135/#5396): a real production call site now exists --
// packages/loopover-miner/lib/coding-agent-construction.js's `constructProductionCodingAgentDriver` calls
// `createCodingAgentDriver` directly -- but it does NOT go through `runCodingAgentAttempt` or this module's
// own `runHouseRulesEnforcedCodingAgentAttempt` wrapper below; the real invocation path is
// `constructProductionCodingAgentDriver` -> the resulting driver becomes `IterateLoopDeps.driver` -> consumed
// by `runIterateLoop` (packages/loopover-engine/src/miner/iterate-loop.ts). House-rule enforcement for the
// live `agent-sdk` provider is instead attached directly there, via this module's own
// `buildHouseRulesAgentSdkHooks` export (called from `constructProductionCodingAgentDriver` -- so the
// DEFAULT-attachment guarantee below still holds, just through a different real call site than originally
// anticipated). `runHouseRulesEnforcedCodingAgentAttempt` itself remains real, tested, and callable, but has
// no production caller today -- it's a lower-level composable for a hypothetical caller that wants the
// non-iterate-loop path, not something this package currently needs.

import {
  runCodingAgentAttempt,
  type AgentSdkHooks,
  type CodingAgentDriverResult,
  type CodingAgentExecutionMode,
  type LintGuardResult,
  type RunCodingAgentAttemptOptions,
} from "@loopover/engine";
import { buildHouseRulesPreToolUseHook } from "./pretooluse-hook.js";
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
export function buildHouseRulesAgentSdkHooks(
  config: HouseRulesConfig = {},
  options: HouseRulesOptions = {},
): HouseRulesAgentSdkHooks {
  return {
    PreToolUse: [
      {
        hooks: [
          buildHouseRulesPreToolUseHook(config, options) as (
            input: unknown,
            toolUseId?: string,
            context?: unknown,
          ) => Promise<Record<string, unknown>>,
        ],
      },
    ],
  };
}

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
export function runHouseRulesEnforcedCodingAgentAttempt(
  options: RunCodingAgentAttemptOptions & {
    houseRulesConfig?: HouseRulesConfig;
    houseRulesOptions?: HouseRulesOptions;
  },
): Promise<{ mode: CodingAgentExecutionMode; result: CodingAgentDriverResult & { lintGuard?: LintGuardResult } }> {
  const { houseRulesConfig, houseRulesOptions, ...attemptOptions } = options;
  const hooks =
    attemptOptions.hooks ??
    (attemptOptions.providerName.trim().toLowerCase() === "agent-sdk"
      ? buildHouseRulesAgentSdkHooks(houseRulesConfig, houseRulesOptions)
      : undefined);
  return runCodingAgentAttempt({ ...attemptOptions, ...(hooks !== undefined ? { hooks } : {}) });
}
