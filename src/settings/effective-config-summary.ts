import type { AgentActionMode } from "./agent-execution";
import { AGENT_ACTION_CLASSES, resolveAutonomy } from "./autonomy";
import { summarizeCommandAuthorizationPolicy } from "./command-authorization";
import type { RepositorySettings } from "../types";

/**
 * PURE, public-safe summary of a repo's EFFECTIVE review config (#2168) — the yml>DB>defaults result a maintainer
 * would otherwise only see in the dashboard, surfaced on demand via `@gittensory configuration`. Renders ONLY
 * non-sensitive operational config: the agent execution mode, per-action-class autonomy, the slop-gate threshold,
 * the blacklist label, and the command-authorization overview (reusing {@link summarizeCommandAuthorizationPolicy}).
 *
 * Deliberately omits every secret / wallet / hotkey / coldkey / raw-trust-score / reward field (house rule) — none
 * of the rendered fields derives from a private score, so the output is safe to post publicly. The handler still
 * wraps it in `sanitizePublicComment` + `gittensoryFooter` as a second belt. `executionMode` is passed in resolved
 * (the caller applies the global kill-switch via {@link resolveAgentActionMode}) so this stays pure. */
export function summarizeEffectiveConfig(settings: RepositorySettings, executionMode: AgentActionMode): string {
  const autonomyLines = AGENT_ACTION_CLASSES.map(
    (actionClass) => `  - \`${actionClass}\`: ${resolveAutonomy(settings.autonomy, actionClass)}`,
  );
  // The command-authorization policy always normalizes to a populated default + per-command overrides (the
  // maintainer-only command defaults), so both lists are non-empty — no empty-case branch needed.
  const authorization = summarizeCommandAuthorizationPolicy(settings.commandAuthorization);
  const overrideLines = authorization.commandOverrides.map(
    (override) => `  - \`${override.command}\`: ${override.allowedRoles.join(", ")}`,
  );
  const slopGate = typeof settings.slopGateMinScore === "number" ? String(settings.slopGateMinScore) : "not set";
  // Config-as-code allows an explicit `null` to DISABLE the label; an absent value falls back to the "slop" default.
  const blacklistLabel = settings.blacklistLabel === null ? "(disabled)" : (settings.blacklistLabel ?? "slop");
  return [
    "**Effective review configuration**",
    "",
    `- Agent execution mode: **${executionMode}**`,
    "- Autonomy by action class:",
    ...autonomyLines,
    `- Slop-gate minimum score: ${slopGate}`,
    `- Blacklist label: \`${blacklistLabel}\``,
    "- Command authorization:",
    `  - default roles: ${authorization.defaultAllowed.join(", ")}`,
    "  - overrides:",
    ...overrideLines,
  ].join("\n");
}
