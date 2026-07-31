/** Truthy convention matches the rest of this codebase's `LOOPOVER_*` flags (`/^(1|true|yes|on)$/i`, trimmed
 *  + case-insensitive, e.g. `isDuplicateWinnerEnabledGlobally`) -- so `1`, `on`, `TRUE`, and a `.env` value
 *  carrying trailing whitespace all read as truthy, not silently as OFF.
 *
 *  Opt-in and default OFF, for the same reason the duplicate-winner flag is (#10168): recognising a PR as
 *  superseded CLOSES it, which is a real, irreversible change to the close disposition rather than a
 *  low-risk default. Until a fleet operator sets this, the supersession finding is never produced and every
 *  affected PR keeps exactly the disposition it has today. */
export function isSupersededCloseEnabledGlobally(env: { LOOPOVER_SUPERSEDED_CLOSE?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_SUPERSEDED_CLOSE ?? "").trim());
}
