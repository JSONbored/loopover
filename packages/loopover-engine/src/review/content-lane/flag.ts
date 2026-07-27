// Content-lane feature flag (convergence — reviewbot→loopover content-review port).
//
// loopover's native code-gate reviews CODE repos. The content lane reviews CONTENT repos — a
// curated list (awesome-claude) and a registry (metagraphed) — a different domain with its own
// deterministic primitives (duplicate detection, source-evidence reachability, security scanning,
// scope classification, and metagraphed's netuid grounding). The lane is ported as native,
// self-contained loopover modules under this directory.
//
// FLAG-GATED + DEFAULT-OFF: the lane only runs when LOOPOVER_REVIEW_CONTENT_LANE is truthy in the Env.
// Flag-off, the host never reaches these modules, so the live behavior is byte-identical. At
// cutover the host flips the flag and routes awesome-claude + metagraphed PRs through the lane.

/** Env subset the content lane reads. The full Env adds it via env.d.ts; this keeps the lane
 *  testable without the whole binding (pass a plain object). */
export interface ContentLaneEnv {
  /** When truthy ("1"/"true"/"on"/"yes"), the content lane is enabled. Default OFF. */
  LOOPOVER_REVIEW_CONTENT_LANE?: string;
  /** When truthy, a surface entry that passes STATIC validation is ADDITIONALLY verified against live content
   *  (#8908 evidence grounding, #8909 functional-surface probing) before it can merge. Default OFF. */
  LOOPOVER_REVIEW_SURFACE_VERIFICATION?: string;
}

/** Is the content lane enabled? Default OFF — only a recognized truthy flag turns it on. */
export function isContentLaneEnabled(env: ContentLaneEnv | undefined | null): boolean {
  if (!env) return false;
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_REVIEW_CONTENT_LANE ?? "").trim());
}

/**
 * Is LIVE surface-entry verification enabled (#8908, #8909)? Default OFF, and deliberately its OWN flag rather
 * than riding on LOOPOVER_REVIEW_CONTENT_LANE: it is the first thing in this lane that makes OUTBOUND requests
 * to submitter-controlled URLs, and it can HOLD or CLOSE submissions that merge today. Both properties need to
 * be rollable back on their own without taking the whole (already-cutover) content lane down with them.
 *
 * The caller ANDs this with the lane's existing activation, so verification runs only where a RegistryLaneSpec
 * already resolved — i.e. it inherits the per-repo scoping for free and needs no config-surface of its own.
 */
export function isSurfaceVerificationEnabled(env: ContentLaneEnv | undefined | null): boolean {
  if (!env) return false;
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_REVIEW_SURFACE_VERIFICATION ?? "").trim());
}
