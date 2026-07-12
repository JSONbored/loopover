// House-rules-enforced coding-agent construction (#2343 follow-up). buildHouseRulesPreToolUseHook
// (pretooluse-hook.js) is the LIVE PreToolUse interception point, but the engine package's
// createCodingAgentDriver / runCodingAgentAttempt (driver-factory.ts) cannot import it directly -- the
// dependency only ever flows gittensory-miner -> @jsonbored/gittensory-engine, never the reverse (the engine
// package is portable and cannot depend on the miner CLI package). This module is the missing miner-side
// glue: it wraps runCodingAgentAttempt so the `agent-sdk` provider gets house-rule enforcement by DEFAULT --
// a future real call site does not need to remember to attach it itself, closing the exact gap
// buildHouseRulesPreToolUseHook's own doc comment already anticipated ("the live interception wiring itself").
//
// This does not build a CLI entrypoint -- nothing in this package constructs a coding-agent driver in
// production yet (verified: no caller of createCodingAgentDriver/runCodingAgentAttempt exists anywhere in
// packages/gittensory-miner today). That is separate, larger follow-up work. What this DOES guarantee: once
// such a call site exists, it only has to call `runHouseRulesEnforcedCodingAgentAttempt` (a drop-in
// replacement for the engine's own `runCodingAgentAttempt`) to get real, unbypassable house-rule enforcement
// automatically, rather than depending on that future author to remember to wire hooks by hand.

import { runCodingAgentAttempt } from "@jsonbored/gittensory-engine";
import { buildHouseRulesPreToolUseHook } from "./pretooluse-hook.js";

/**
 * Wrap {@link buildHouseRulesPreToolUseHook}'s callback into the Claude Agent SDK's own `hooks.PreToolUse`
 * registration shape (an array of matcher groups, each holding an array of hook callbacks) -- the exact
 * contract `agent-sdk-driver.ts`'s own doc comment names as "#2343's stated attachment point", and the shape
 * `packages/gittensory-engine/test/agent-sdk-driver.test.ts` asserts is forwarded to the SDK verbatim.
 *
 * @param {Parameters<typeof buildHouseRulesPreToolUseHook>[0]} [config]
 * @param {Parameters<typeof buildHouseRulesPreToolUseHook>[1]} [options]
 * @returns {{ PreToolUse: Array<{ hooks: Array<ReturnType<typeof buildHouseRulesPreToolUseHook>> }> }}
 */
export function buildHouseRulesAgentSdkHooks(config = {}, options = {}) {
  return { PreToolUse: [{ hooks: [buildHouseRulesPreToolUseHook(config, options)] }] };
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
 *
 * @param {Parameters<typeof runCodingAgentAttempt>[0] & {
 *   houseRulesConfig?: Parameters<typeof buildHouseRulesPreToolUseHook>[0],
 *   houseRulesOptions?: Parameters<typeof buildHouseRulesPreToolUseHook>[1],
 * }} options
 * @returns {ReturnType<typeof runCodingAgentAttempt>}
 */
export function runHouseRulesEnforcedCodingAgentAttempt(options) {
  const { houseRulesConfig, houseRulesOptions, ...attemptOptions } = options;
  const hooks =
    attemptOptions.hooks ??
    (attemptOptions.providerName.trim().toLowerCase() === "agent-sdk"
      ? buildHouseRulesAgentSdkHooks(houseRulesConfig, houseRulesOptions)
      : undefined);
  return runCodingAgentAttempt({ ...attemptOptions, ...(hooks !== undefined ? { hooks } : {}) });
}
