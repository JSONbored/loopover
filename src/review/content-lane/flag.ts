// Content-lane feature flag (convergence — reviewbot→gittensory content-review port).
//
// gittensory's native code-gate reviews CODE repos. The content lane reviews CONTENT repos — a
// curated list (awesome-claude) and a registry (metagraphed) — a different domain with its own
// deterministic primitives (duplicate detection, source-evidence reachability, security scanning,
// scope classification, and metagraphed's netuid grounding). The lane is ported as native,
// self-contained gittensory modules under this directory.
//
// FLAG-GATED + DEFAULT-OFF: the lane only runs when GITTENSORY_REVIEW_CONTENT_LANE is truthy in the Env.
// Flag-off, the host never reaches these modules, so the live behavior is byte-identical. At
// cutover the host flips the flag and routes awesome-claude + metagraphed PRs through the lane.

import { dualPrefixEnvFlag } from "../../utils/env";

/** Env subset the content lane reads. The full Env adds it via env.d.ts; this keeps the lane
 *  testable without the whole binding (pass a plain object). */
export interface ContentLaneEnv {
  /** When truthy ("1"/"true"/"on"/"yes"), the content lane is enabled. Default OFF.
   *  #4774 dual-read: LOOPOVER_REVIEW_CONTENT_LANE below wins over this legacy name when both are set. */
  GITTENSORY_REVIEW_CONTENT_LANE?: string;
  /** #4774: LOOPOVER_ companion for GITTENSORY_REVIEW_CONTENT_LANE above — wins when both are set. */
  LOOPOVER_REVIEW_CONTENT_LANE?: string;
}

/** Is the content lane enabled? Default OFF — only a recognized truthy flag turns it on. */
export function isContentLaneEnabled(env: ContentLaneEnv | undefined | null): boolean {
  if (!env) return false;
  return dualPrefixEnvFlag(env as unknown as Record<string, string | undefined>, "REVIEW_CONTENT_LANE");
}
