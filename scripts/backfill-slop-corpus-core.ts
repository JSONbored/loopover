// Pure core for the slop-corpus replay backfill (#8277) — phase 3 of the calibration backfill family.
// The slop scorer is deterministic and in-repo, so the #8224 report-only knob's evidence can be
// manufactured honestly: replay `buildSlopAssessment` over each archived PR diff (the #8130/#8170
// raw-context corpus) and synthesize provenance-tagged `slop_gate_score` fired/override pairs labeled by
// what humans actually did — the same counterfactual "mapping a" framing the phase-1 close-confidence
// backfill documented. This core is transform-only (no IO), mirroring backfill-calibration-corpus-core.ts;
// the CLI wrapper owns the manifest read and the wrangler/pg writes.
//
// SIGNAL-SUBSET HONESTY: only the diff-derivable signals can replay (trivialWhitespaceChurn,
// missingTestEvidence, nonSubstantivePadding — changedFiles parse out of the archived unified diff). The
// unarchived inputs (description, commit messages, duplicate-cluster membership, linked-issue state) are
// passed UNDEFINED so their signals SKIP rather than fire spuriously — a replayed score is therefore a
// LOWER BOUND on what live scoring would have produced. Every synthesized row records the computed signal
// codes plus the provenance tag so the eventual flip-to-live decision can weigh exactly that.

import { buildSlopAssessment, SLOP_WEIGHTS, slopBandFor, type SlopChangedFile } from "../packages/loopover-engine/src/signals/slop";
import type { SynthesizedAuditRow } from "./backfill-calibration-corpus-core.js";

export const SLOP_BACKFILL_RULE_ID = "slop_gate_score";
export const SLOP_BACKFILL_PROVENANCE = "slop_replay_backfill_v1";
const FIRED_EVENT_TYPE = `signal.rule_fired:${SLOP_BACKFILL_RULE_ID}`;
const OVERRIDE_EVENT_TYPE = `signal.human_override:${SLOP_BACKFILL_RULE_ID}`;

/** One replayable source case, projected from a backtest-corpus manifest (backtest-corpus-export.ts):
 *  the archived bounded diff plus the human label the original rule's history already established. */
/** The diff-derivable signal codes the replay may score, mapped to the scorer's own weights. Everything
 *  else needs unarchived inputs and is EXCLUDED even if the scorer fires it on an undefined field. */
const REPLAYABLE_SIGNAL_WEIGHTS: Record<string, number | undefined> = {
  trivial_whitespace_churn: SLOP_WEIGHTS.trivialWhitespaceChurn,
  missing_test_evidence: SLOP_WEIGHTS.missingTestEvidence,
  non_substantive_padding: SLOP_WEIGHTS.nonSubstantivePadding,
};

export type SlopReplaySourceCase = {
  targetKey: string;
  label: "confirmed" | "reversed";
  firedAt: string;
  decidedAt: string;
  diff: string;
};

/**
 * Parse a unified diff into the scorer's {@link SlopChangedFile} shape: one entry per `diff --git` block
 * (b-side path — the post-change name), with per-file added/deleted line counts (`+`/`-` bodies only,
 * never the `+++`/`---` headers). Tolerant of the 45KB truncation marker the phase-2 apply path appends:
 * a truncated tail simply yields fewer counted lines — the parse never throws on any string input.
 */
export function parseDiffChangedFiles(diff: string): SlopChangedFile[] {
  const files: SlopChangedFile[] = [];
  let current: { path: string; additions: number; deletions: number } | null = null;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header) {
      if (current) files.push(current);
      current = { path: header[1]!, additions: 0, deletions: 0 };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) current.additions += 1;
    else if (line.startsWith("-")) current.deletions += 1;
  }
  if (current) files.push(current);
  return files;
}

export type SlopReplayReport = {
  replayed: number;
  skippedEmptyDiff: number;
  skippedNoFiles: number;
  skippedDuplicateTarget: number;
  /** Histogram of replayed risks by band edge — the evidence summary the issue asks for. */
  riskCounts: { zero: number; low: number; elevated: number; high: number };
  reversed: number;
  confirmed: number;
  rows: SynthesizedAuditRow[];
};

/**
 * Replay the deterministic slop scorer over each source case and synthesize the provenance-tagged
 * fired/override pair (ids derive from the targetKey alone, so re-runs upsert idempotently — the phase-1
 * insert builder's ON CONFLICT discipline applies unchanged). The fired event's `occurredAt` reuses the
 * source case's own firedAt and the override sits at its decidedAt (floored to 1s after the firing when
 * the archive's timestamps collide), so buildBacktestCorpus's strictly-after pairing always matches.
 * Deterministic output for deterministic input.
 */
export function replaySlopCorpus(cases: readonly SlopReplaySourceCase[]): SlopReplayReport {
  const report: SlopReplayReport = {
    replayed: 0,
    skippedEmptyDiff: 0,
    skippedNoFiles: 0,
    skippedDuplicateTarget: 0,
    riskCounts: { zero: 0, low: 0, elevated: 0, high: 0 },
    reversed: 0,
    confirmed: 0,
    rows: [],
  };
  const seen = new Set<string>();
  for (const sourceCase of cases) {
    if (!sourceCase.diff || !sourceCase.diff.trim()) {
      report.skippedEmptyDiff += 1;
      continue;
    }
    if (seen.has(sourceCase.targetKey)) {
      report.skippedDuplicateTarget += 1;
      continue;
    }
    const changedFiles = parseDiffChangedFiles(sourceCase.diff);
    if (changedFiles.length === 0) {
      report.skippedNoFiles += 1;
      continue;
    }
    seen.add(sourceCase.targetKey);
    // Signal-subset honesty, enforced by ALLOWLIST rather than trusting undefined-skipping: the scorer
    // treats a missing description as an empty one (buildEmptyDescriptionFinding fires on undefined —
    // correct live, where absence IS emptiness, but inflating here, where the field simply wasn't
    // archived). Only the three diff-derivable signals may contribute; risk and band recompute from
    // exactly their weights via the scorer's own exported constants.
    const assessment = buildSlopAssessment({ changedFiles });
    const replayableFindings = assessment.findings.filter((finding) => REPLAYABLE_SIGNAL_WEIGHTS[finding.code] !== undefined);
    const slopRisk = Math.min(
      100,
      replayableFindings.reduce((sum, finding) => sum + REPLAYABLE_SIGNAL_WEIGHTS[finding.code]!, 0),
    );
    const band = slopBandFor(slopRisk);
    const computedSignals = replayableFindings.map((finding) => finding.code).sort();

    report.replayed += 1;
    if (slopRisk >= 60) report.riskCounts.high += 1;
    else if (slopRisk >= 30) report.riskCounts.elevated += 1;
    else if (slopRisk > 0) report.riskCounts.low += 1;
    else report.riskCounts.zero += 1;
    if (sourceCase.label === "reversed") report.reversed += 1;
    else report.confirmed += 1;

    const firedMs = Date.parse(sourceCase.firedAt);
    const decidedMs = Date.parse(sourceCase.decidedAt);
    const overrideIso = new Date(
      Number.isFinite(decidedMs) && Number.isFinite(firedMs) && decidedMs > firedMs ? decidedMs : (Number.isFinite(firedMs) ? firedMs : 0) + 1000,
    ).toISOString();
    report.rows.push(
      {
        id: `backfill:${SLOP_BACKFILL_RULE_ID}:${sourceCase.targetKey}:fired`,
        eventType: FIRED_EVENT_TYPE,
        actor: "loopover",
        targetKey: sourceCase.targetKey,
        outcome: slopRisk >= 60 ? "above_threshold" : "below_threshold",
        detail: `rule ${SLOP_BACKFILL_RULE_ID} replayed against ${sourceCase.targetKey} [backfilled]`,
        metadataJson: JSON.stringify({
          confidence: slopRisk / 100,
          band,
          computedSignals,
          backfilled: true,
          provenance: SLOP_BACKFILL_PROVENANCE,
        }),
        createdAt: sourceCase.firedAt,
      },
      {
        id: `backfill:${SLOP_BACKFILL_RULE_ID}:${sourceCase.targetKey}:override`,
        eventType: OVERRIDE_EVENT_TYPE,
        actor: "human",
        targetKey: sourceCase.targetKey,
        outcome: "completed",
        detail: `human ${sourceCase.label} rule ${SLOP_BACKFILL_RULE_ID} against ${sourceCase.targetKey} [backfilled]`,
        metadataJson: JSON.stringify({ verdict: sourceCase.label, backfilled: true, provenance: SLOP_BACKFILL_PROVENANCE }),
        createdAt: overrideIso,
      },
    );
  }
  return report;
}

/** Render the dry-run/apply summary — the shape the #8277 evidence comment quotes. */
export function renderSlopReplayReport(report: SlopReplayReport, mode: "dry-run" | "apply"): string {
  return [
    `Slop corpus replay backfill (${mode}) — provenance ${SLOP_BACKFILL_PROVENANCE}`,
    `  replayed: ${report.replayed} (confirmed ${report.confirmed}, reversed ${report.reversed})`,
    `  risk bands: zero ${report.riskCounts.zero} | low ${report.riskCounts.low} | elevated ${report.riskCounts.elevated} | high ${report.riskCounts.high}`,
    `  skipped: empty-diff ${report.skippedEmptyDiff}, no-files ${report.skippedNoFiles}, duplicate-target ${report.skippedDuplicateTarget}`,
    mode === "dry-run" ? "dry-run only — re-run with --apply to write. Rows upsert idempotently by id." : `  rows written: ${report.rows.length}`,
  ].join("\n");
}
