// Review-memory activation wiring (#2179, config slice of #1964). Default OFF: the operator flag
// GITTENSORY_REVIEW_MEMORY is a master kill-switch, and the per-repo `.gittensory.yml` review.memory toggle
// (#4101, same shape as inlineComments/fixHandoff, #4099) fully controls activation by itself when explicitly
// set — there has never been a GITTENSORY_REVIEW_REPOS cutover allowlist for this feature (an unset manifest
// toggle preserves the ORIGINAL always-off default; it was never sufficient to be allowlisted alone, and in
// fact no allowlist fallback ever existed for review memory in the first place). With the env flag unset, the
// suppression store is never read from the review path at all (the caller guards on this flag before doing any
// D1 read or matching), so the review stays byte-identical to today.

import { matchSuppressions, type ReviewMemoryFindingInput } from "./review-memory-match";
import type { AdvisoryFinding, ReviewSuppressionRecord } from "../types";

/** True when repeat-false-positive suppression is enabled at the operator level. Flag-OFF (default) → the
 *  caller takes no new branch, so no suppression-store read and no matcher call ever happens. Truthy follows
 *  the codebase convention (`/^(1|true|yes|on)$/i`, same as isImpactMapEnabled / isRagEnabled /
 *  isSafetyEnabled). */
export function isReviewMemoryEnabled(env: { GITTENSORY_REVIEW_MEMORY?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_MEMORY ?? "");
}

/** PURE (#4101): should review-memory suppression apply for THIS repo/PR? (1) The operator's
 *  GITTENSORY_REVIEW_MEMORY flag is an absolute MASTER KILL-SWITCH — off ⇒ always false, regardless of the
 *  manifest, and no per-repo config can bypass it (consistent with every other converged feature — see
 *  `resolveConvergedFeature` in `feature-activation.ts`). (2) An explicit per-repo `.gittensory.yml`
 *  `review.memory` override (`true`/`false`) now FULLY controls the feature by itself — a repo can turn this on
 *  without needing any allowlist at all. (3) `manifestToggle` unset (`undefined`) preserves this feature's
 *  ORIGINAL design exactly: review memory has never had a GITTENSORY_REVIEW_REPOS cutover allowlist to fall
 *  back to (unlike rag/reputation/safety/unifiedComment/grounding), so this stays `false` regardless, byte-
 *  identical to every repo's behavior before this change. Exactly mirrors `shouldEmitFixHandoff`'s shape and
 *  precedence. */
export function shouldApplyReviewMemory(
  env: { GITTENSORY_REVIEW_MEMORY?: string | undefined },
  manifestToggle: boolean | undefined,
): boolean {
  if (!isReviewMemoryEnabled(env)) return false;
  return manifestToggle === true;
}
const RESOLVE_FINDING_CODE = /^[a-z][a-z0-9_]{0,199}$/;
export function normalizeResolveFindingRef(raw: string | null | undefined): { ok: true; scope: "whole_pr" } | { ok: true; scope: "single"; findingCode: string } | { ok: false; reason: "malformed_finding_id" } { const trimmed = (raw ?? "").trim(); if (trimmed.length === 0) return { ok: true, scope: "whole_pr" }; const normalized = trimmed.toLowerCase().replace(/^finding-/, ""); if (!RESOLVE_FINDING_CODE.test(normalized)) return { ok: false, reason: "malformed_finding_id" }; return { ok: true, scope: "single", findingCode: normalized }; }
export function selectWarningsForResolve(warnings: ReadonlyArray<AdvisoryFinding>, ref: { ok: true; scope: "whole_pr" } | { ok: true; scope: "single"; findingCode: string }): { findings: AdvisoryFinding[]; reason?: "finding_not_found" } { if (ref.scope === "whole_pr") return { findings: [...warnings] }; const matches = warnings.filter((finding) => finding.code === ref.findingCode); if (matches.length === 0) return { findings: [], reason: "finding_not_found" }; return { findings: matches }; }

/** Apply-to-findings wiring (#2181, apply slice of #1964). PURE — no DB I/O (the caller already resolved
 *  `signals` via listReviewSuppressions); the caller wraps the READ side in its own try/catch (fail-safe: a
 *  store-read error is caught by the caller and this function is never reached at all, so findings pass
 *  through untouched — see processors.ts). ADVISORY-ONLY BY CONSTRUCTION: the caller must only ever pass this
 *  the gate's non-blocking `warnings` — NEVER `blockers` — so a suppressed/demoted finding can never affect the
 *  merge/close disposition. `suppress`-matched findings are DROPPED; `demote`-matched findings are KEPT but
 *  moved to the END of the list, so an existing `review.max_findings` display cap (if configured) truncates a
 *  demoted (previously-seen-but-not-identical) finding before a fresh one. Order among non-demoted findings is
 *  otherwise preserved. */
export function applyReviewMemorySuppression(
  findings: ReadonlyArray<AdvisoryFinding>,
  signals: ReadonlyArray<ReviewSuppressionRecord>,
): { findings: AdvisoryFinding[]; suppressedCount: number; demotedCount: number } {
  if (findings.length === 0 || signals.length === 0) return { findings: [...findings], suppressedCount: 0, demotedCount: 0 };
  const kept: AdvisoryFinding[] = [];
  const demoted: AdvisoryFinding[] = [];
  let suppressedCount = 0;
  for (const finding of findings) {
    const result = matchSuppressions(toReviewMemoryFindingInput(finding), signals);
    if (result === "suppress") {
      suppressedCount += 1;
      continue;
    }
    if (result === "demote") {
      demoted.push(finding);
      continue;
    }
    kept.push(finding);
  }
  return { findings: [...kept, ...demoted], suppressedCount, demotedCount: demoted.length };
}

/** Adapt an `AdvisoryFinding` (the gate's own finding shape) to the decoupled `ReviewMemoryFindingInput` the
 *  matcher needs: `category` is the finding's own deterministic `code`; `AdvisoryFinding` carries no `path`
 *  today, so every finding fingerprints as repo-wide ("" path) — a future path-anchored finding type can pass
 *  its own path through once one exists, with zero change to the matcher itself. `message` combines `title` +
 *  `detail` so two findings with the same title but a different detail body still fingerprint differently. */
function toReviewMemoryFindingInput(finding: AdvisoryFinding): ReviewMemoryFindingInput {
  return { category: finding.code, message: `${finding.title} ${finding.detail}` };
}
