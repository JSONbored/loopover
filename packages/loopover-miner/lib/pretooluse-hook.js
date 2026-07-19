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
    }
    catch {
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
 */
export function buildHouseRulesPreToolUseHook(config = {}, options = {}) {
    const rules = config.rules ?? DEFAULT_DENY_RULES;
    const repoFullName = config.repoFullName;
    const append = options.append ?? appendGovernorEvent;
    return async function houseRulesPreToolUseHook(input) {
        try {
            const toolName = input && typeof input === "object" ? input.tool_name : undefined;
            const toolInput = input && typeof input === "object" ? input.tool_input : undefined;
            const verdict = evaluateDenyHooks({ name: toolName, input: toolInput }, [...rules]);
            if (verdict.allowed)
                return {};
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
        }
        catch (error) {
            const reason = `pretooluse_hook_internal_error: ${error instanceof Error ? error.message : String(error)}`;
            recordDenial(append, repoFullName, reason, {});
            return denyOutput(reason);
        }
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHJldG9vbHVzZS1ob29rLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicHJldG9vbHVzZS1ob29rLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFHQUFxRztBQUNyRyxrR0FBa0c7QUFDbEcscUdBQXFHO0FBQ3JHLG9HQUFvRztBQUNwRyxFQUFFO0FBQ0Ysd0dBQXdHO0FBQ3hHLHVHQUF1RztBQUN2RyxrR0FBa0c7QUFDbEcsNEZBQTRGO0FBQzVGLHNHQUFzRztBQUN0RyxxR0FBcUc7QUFDckcsc0dBQXNHO0FBQ3RHLHlCQUF5QjtBQUN6QixFQUFFO0FBQ0YseUdBQXlHO0FBQ3pHLGlDQUFpQztBQUVqQyxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsaUJBQWlCLEVBQWlCLE1BQU0saUJBQWlCLENBQUM7QUFDdkYsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUEyQjNELFNBQVMsWUFBWSxDQUNuQixNQUFnRSxFQUNoRSxZQUFnQyxFQUNoQyxNQUFjLEVBQ2QsT0FBZ0M7SUFFaEMsSUFBSSxDQUFDO1FBQ0gsTUFBTSxDQUFDO1lBQ0wsU0FBUyxFQUFFLFFBQVE7WUFDbkIsWUFBWSxFQUFFLFlBQVksSUFBSSxJQUFJO1lBQ2xDLFdBQVcsRUFBRSxpQkFBaUI7WUFDOUIsUUFBUSxFQUFFLE1BQU07WUFDaEIsTUFBTTtZQUNOLE9BQU87U0FDUixDQUFDLENBQUM7SUFDTCxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ1Asb0dBQW9HO1FBQ3BHLHFHQUFxRztRQUNyRyx3RkFBd0Y7SUFDMUYsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLFVBQVUsQ0FBQyxNQUFjO0lBQ2hDLE9BQU87UUFDTCxrQkFBa0IsRUFBRTtZQUNsQixhQUFhLEVBQUUsWUFBWTtZQUMzQixrQkFBa0IsRUFBRSxNQUFNO1lBQzFCLHdCQUF3QixFQUFFLE1BQU07U0FDakM7S0FDRixDQUFDO0FBQ0osQ0FBQztBQUVEOzs7Ozs7Ozs7R0FTRztBQUNILE1BQU0sVUFBVSw2QkFBNkIsQ0FDM0MsU0FBOEMsRUFBRSxFQUNoRCxVQUFnRCxFQUFFO0lBTWxELE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxLQUFLLElBQUksa0JBQWtCLENBQUM7SUFDakQsTUFBTSxZQUFZLEdBQUcsTUFBTSxDQUFDLFlBQVksQ0FBQztJQUN6QyxNQUFNLE1BQU0sR0FBRyxPQUFPLENBQUMsTUFBTSxJQUFJLG1CQUFtQixDQUFDO0lBRXJELE9BQU8sS0FBSyxVQUFVLHdCQUF3QixDQUFDLEtBQUs7UUFDbEQsSUFBSSxDQUFDO1lBQ0gsTUFBTSxRQUFRLEdBQUcsS0FBSyxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO1lBQ2xGLE1BQU0sU0FBUyxHQUFHLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztZQUNwRixNQUFNLE9BQU8sR0FBRyxpQkFBaUIsQ0FDL0IsRUFBRSxJQUFJLEVBQUUsUUFBa0IsRUFBRSxLQUFLLEVBQUUsU0FBb0MsRUFBRSxFQUN6RSxDQUFDLEdBQUcsS0FBSyxDQUFDLENBQ1gsQ0FBQztZQUVGLElBQUksT0FBTyxDQUFDLE9BQU87Z0JBQUUsT0FBTyxFQUFFLENBQUM7WUFFL0IsMEdBQTBHO1lBQzFHLDZGQUE2RjtZQUM3Rix5R0FBeUc7WUFDekcsMkZBQTJGO1lBQzNGLE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxTQUFVLENBQUMsTUFBTSxJQUFJLDRCQUE0QixDQUFDO1lBQ3pFLFlBQVksQ0FBQyxNQUFNLEVBQUUsWUFBWSxFQUFFLE1BQU0sRUFBRTtnQkFDekMsUUFBUSxFQUFFLE9BQU8sUUFBUSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxJQUFJO2dCQUN4RCxPQUFPLEVBQUUsT0FBTyxDQUFDLFNBQVUsQ0FBQyxPQUFPO2FBQ3BDLENBQUMsQ0FBQztZQUNILE9BQU8sVUFBVSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQzVCLENBQUM7UUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1lBQ2YsTUFBTSxNQUFNLEdBQUcsbUNBQW1DLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQzNHLFlBQVksQ0FBQyxNQUFNLEVBQUUsWUFBWSxFQUFFLE1BQU0sRUFBRSxFQUFFLENBQUMsQ0FBQztZQUMvQyxPQUFPLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUM1QixDQUFDO0lBQ0gsQ0FBQyxDQUFDO0FBQ0osQ0FBQyJ9