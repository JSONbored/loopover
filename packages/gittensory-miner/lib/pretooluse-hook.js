// PreToolUse-hook-enforced house rules (#2343). Wraps the pure `evaluateDenyHooks` decision function
// (deny-hooks.js, #2295) into a real Claude Agent SDK PreToolUse hook callback -- the actual live
// interception point a CodingAgentDriver session registers via `options.hooks.PreToolUse` (the exact
// seam `agent-sdk-driver.ts`'s `hooks` passthrough documents as "#2343's stated attachment point").
//
// WHY THIS HOLDS EVEN UNDER bypassPermissions: per the Agent SDK's own documented permission-evaluation
// order (https://code.claude.com/docs/en/agent-sdk/permissions), hooks run FIRST -- before deny rules,
// ask rules, the permission mode check, and allow rules -- and "Hooks still execute and can block
// operations if needed" even when `permissionMode: 'bypassPermissions'` is set: "Deny rules
// (disallowed_tools), explicit ask rules, and hooks are evaluated before the mode check and can still
// block a tool." This module does not implement that guarantee -- the SDK does. This module's job is
// only to return a correctly-shaped, fail-closed deny decision every time; the SDK is what makes that
// decision unbypassable.
//
// FAIL CLOSED: any internal error (a malformed tool-call shape, a governor-ledger append failure) denies
// rather than silently allowing.

import { DEFAULT_DENY_RULES, evaluateDenyHooks } from "./deny-hooks.js";
import { appendGovernorEvent } from "./governor-ledger.js";

function recordDenial(append, repoFullName, reason, payload) {
  try {
    append({
      eventType: "denied",
      repoFullName: repoFullName ?? null,
      actionClass: "pretooluse_hook",
      decision: "deny",
      reason,
      payload,
    });
  } catch {
    // A ledger append failure must never suppress or alter the deny decision itself -- the tool call is
    // still blocked even if the audit write fails. Silently allowing on a logging failure would be a far
    // worse outcome for a security boundary than an unrecorded (but still enforced) denial.
  }
}

function denyOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Build a Claude Agent SDK `PreToolUse` hook callback enforcing the house-rule denylist. Register the
 * returned function under `options.hooks.PreToolUse` (e.g. `{ hooks: [PreToolUse: [{ hooks: [built] }]] }`
 * on the object passed to `createAgentSdkCodingAgentDriver({ hooks })`).
 *
 * House rules are sourced from a single, auditable list: {@link DEFAULT_DENY_RULES} by default, or an
 * effective rule set built by the caller (e.g. `resolveEffectiveDenyRules` from deny-hook-synthesis.js,
 * merging in maintainer-approved synthesized rules) — this module composes whatever rule set it is given,
 * it does not own deriving one.
 *
 * @param {object} [config]
 * @param {ReadonlyArray<import("./deny-hooks.js").DenyRule>} [config.rules] defaults to DEFAULT_DENY_RULES
 * @param {string} [config.repoFullName] target repo, for governor-ledger scoping of recorded denials
 * @param {{ append?: typeof appendGovernorEvent }} [options]
 * @returns {(input: unknown, toolUseId?: string, context?: unknown) => Promise<Record<string, unknown>>}
 */
export function buildHouseRulesPreToolUseHook(config = {}, options = {}) {
  const rules = config.rules ?? DEFAULT_DENY_RULES;
  const repoFullName = config.repoFullName;
  const append = options.append ?? appendGovernorEvent;

  return async function houseRulesPreToolUseHook(input) {
    try {
      const toolName = input && typeof input === "object" ? input.tool_name : undefined;
      const toolInput = input && typeof input === "object" ? input.tool_input : undefined;
      const verdict = evaluateDenyHooks({ name: toolName, input: toolInput }, rules);

      if (verdict.allowed) return {};

      // `verdict.blockedBy` is always set together with `!verdict.allowed` (evaluateDenyHooks's only two return
      // shapes), and `.matcher` is always a defined string on it (ruleMatches gates every match on
      // `typeof rule.matcher === "string"` -- a rule can never become `blockedBy` otherwise). `.reason` has no
      // equivalent gate, so a caller-supplied custom rule omitting it is a real, reachable case.
      const reason = verdict.blockedBy.reason ?? "House rule denylist match.";
      recordDenial(append, repoFullName, reason, {
        toolName: typeof toolName === "string" ? toolName : null,
        matcher: verdict.blockedBy.matcher,
      });
      return denyOutput(reason);
    } catch (error) {
      const reason = `pretooluse_hook_internal_error: ${error instanceof Error ? error.message : String(error)}`;
      recordDenial(append, repoFullName, reason, {});
      return denyOutput(reason);
    }
  };
}
