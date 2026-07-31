export type DuplicateWinnerMode = "inherit" | "off" | "enabled";

/** Truthy convention matches the rest of this codebase's `LOOPOVER_*` flags (`/^(1|true|yes|on)$/i`,
 *  trimmed + case-insensitive, e.g. `selfTuneFlagOn`/`isReputationEnabled`) -- so `1`, `on`, `TRUE`, and a
 *  `.env` value carrying trailing whitespace all read as truthy, not silently as OFF. Unlike
 *  `isSkipAutomationBotPullRequestsEnabledGlobally` (default ON, inverted truthy match), this flag is opt-in
 *  and default OFF: sparing a duplicate cluster's earliest claimant is a real behavior change to the close
 *  disposition, not a low-risk waste-elimination default. */
export function isDuplicateWinnerEnabledGlobally(env: { LOOPOVER_DUPLICATE_WINNER?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_DUPLICATE_WINNER ?? "").trim());
}

/** Per-repo override resolved against the global default. Mirrors `resolveSkipAutomationBotPullRequests`'s
 *  inherit/off/enabled shape (settings/automation-bot-skip.ts) -- symmetric: "off" and "enabled" both fully
 *  override the global default in either direction, so a repo opting IN is never blocked by a globally-off
 *  default, and a repo opting OUT keeps the legacy "every sibling closes" behavior even when the fleet default
 *  is on. */
export function resolveDuplicateWinnerEnabled(globalDefault: boolean, mode: DuplicateWinnerMode | null | undefined): boolean {
  if (mode === "off") return false;
  if (mode === "enabled") return true;
  return globalDefault;
}
