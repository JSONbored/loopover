export type OpenPrFileCollisionMode = "inherit" | "off" | "enabled";

/** Truthy convention matches the rest of this codebase's `LOOPOVER_*` flags (`/^(1|true|yes|on)$/i`, trimmed
 *  + case-insensitive, e.g. `selfTuneFlagOn`/`isReputationEnabled`) -- so `1`, `on`, `TRUE`, and a `.env`
 *  value carrying trailing whitespace all read as truthy, not silently as OFF. Opt-in and default OFF: the
 *  enrichment call this gates costs an extra GitHub API round-trip per open PR
 *  (enrichOpenPullRequestsWithChangedFiles), so an operator should deliberately turn it on rather than pay
 *  that cost by default. */
export function isOpenPrFileCollisionEnabledGlobally(env: { LOOPOVER_OPEN_PR_FILE_COLLISION?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_OPEN_PR_FILE_COLLISION ?? "").trim());
}

/** Per-repo override resolved against the global default. Mirrors `resolveDuplicateWinnerEnabled`'s
 *  inherit/off/enabled shape (settings/duplicate-winner-mode.ts) -- symmetric: "off" and "enabled" both fully
 *  override the global default in either direction, so a repo that wants the extra file-collision annotation
 *  cost isn't blocked by a globally-off default, and a repo that wants to opt OUT of the extra API calls can
 *  do so even when the fleet default is on. */
export function resolveOpenPrFileCollisionEnabled(globalDefault: boolean, mode: OpenPrFileCollisionMode | null | undefined): boolean {
  if (mode === "off") return false;
  if (mode === "enabled") return true;
  return globalDefault;
}
