// Review-memory activation wiring (#2179, config slice of #1964). Mirrors impact-map-wire.ts's
// isImpactMapEnabled: a single GLOBAL env kill-switch the self-host operator controls, ANDed with the per-repo
// `.gittensory.yml review.memory` manifest toggle (resolved via `resolveReviewMemoryManifestToggle`,
// src/signals/focus-manifest.ts) — so a repo can only ever NARROW what the operator has already turned on,
// never widen it. Both OFF by default: with the env flag unset, the suppression store is never read from the
// review path at all (the caller guards on this flag before doing any D1 read or matching), so the review
// stays byte-identical to today.

import { matchSuppressions, type ReviewMemoryFindingInput } from "./review-memory-match";
import type { AdvisoryFinding, ReviewSuppressionRecord } from "../types";

/** True when repeat-false-positive suppression is enabled at the operator level. Flag-OFF (default) → the
 *  caller takes no new branch, so no suppression-store read and no matcher call ever happens. Truthy follows
 *  the codebase convention (`/^(1|true|yes|on)$/i`, same as isImpactMapEnabled / isRagEnabled /
 *  isSafetyEnabled). */
export function isReviewMemoryEnabled(env: { GITTENSORY_REVIEW_MEMORY?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_MEMORY ?? "");
}

/** Resolve whether review-memory suppression should apply for THIS repo/PR: the operator's global env
 *  kill-switch AND the per-repo manifest opt-in. Neither alone is sufficient — mirrors every other
 *  converged-feature gate in this codebase (env kill-switch first, then the manifest narrows it further). */
export function shouldApplyReviewMemory(
  env: { GITTENSORY_REVIEW_MEMORY?: string | undefined },
  manifestReviewMemoryEnabled: boolean,
): boolean {
  return isReviewMemoryEnabled(env) && manifestReviewMemoryEnabled;
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
