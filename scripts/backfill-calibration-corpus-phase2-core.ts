// Pure core for the phase-2 calibration backfill (#8170, epic #8082): the two GitHub-truth passes phase 1
// (#8157, backfill-calibration-corpus-core.ts) deliberately deferred. The thin IO wrapper
// (backfill-calibration-corpus-phase2.ts) does every DB/GitHub read and write; everything here is pure.
//
//   • Pass A — retro successor scan: run #8166's `evaluateSuccessorMatch` (imported, never re-implemented)
//     over historical bot-close decisions vs the merged PRs that followed them. A confirmed match flips the
//     phase-1 override row's verdict to `reversed` — the ledger's first organic-shaped negative labels.
//   • Pass B — raw-context re-fetch: patch the phase-1 fired rows with the PR diff the live capture (#8130)
//     would have recorded (`metadata.diff`, bounded to RAW_CONTEXT_MAX_DIFF_CHARS), public repos only.
//   • Conservative + idempotent: borderline successor matches record NOTHING; both patchers return null on
//     an already-patched row, so re-runs are no-ops; every patched row carries a distinct provenance tag.
import { evaluateSuccessorMatch, SUPERSEDED_LOOKBACK_MS, type SupersededHeuristics } from "../src/review/reversal-superseded.js";
import { RAW_CONTEXT_MAX_DIFF_CHARS } from "../src/rules/advisory.js";
import { BACKFILL_RULE_ID } from "./backfill-calibration-corpus-core.js";

/** Distinct provenance for pass A's retro labels — never confusable with phase 1's decision-level rows. */
export const RETRO_SUCCESSOR_PROVENANCE = "github_successor_scan";
/** Distinct provenance for pass B's re-fetched raw context. */
export const RAW_CONTEXT_REFETCH_PROVENANCE = "github_raw_context_refetch";

/** A phase-1 backfilled close decision, hydrated with the GitHub truth the wrapper fetched. */
export type HistoricalCloseSide = {
  targetKey: string;
  repo: string;
  number: number;
  /** ISO close time (phase 1's terminal_at) — successors must merge within the #8166 lookback AFTER it. */
  closedAt: string;
  authorLogin: string | null;
  linkedIssues: readonly number[];
  files: readonly string[];
};

/** A candidate successor: a PR in the same repo that actually merged. */
export type SuccessorSide = {
  number: number;
  mergedAt: string;
  authorLogin: string | null;
  linkedIssues: readonly number[];
  files: readonly string[];
};

export type RetroSuccessorMatch = {
  targetKey: string;
  supersededBy: number;
  heuristics: SupersededHeuristics;
};

/**
 * Decide which historical closes were superseded by a later merge. Pure: both sides arrive pre-fetched.
 * The window is directional — a successor must merge AFTER the close and within {@link SUPERSEDED_LOOKBACK_MS}
 * (#8166's own bound) — and the EARLIEST qualifying merge wins so re-runs with more candidates stay stable.
 */
export function matchRetroSuccessors(close: HistoricalCloseSide, successors: readonly SuccessorSide[]): RetroSuccessorMatch | null {
  const closedAtMs = Date.parse(close.closedAt);
  if (!Number.isFinite(closedAtMs)) return null;
  const eligible = successors
    .filter((successor) => {
      if (successor.number === close.number) return false;
      const mergedAtMs = Date.parse(successor.mergedAt);
      return Number.isFinite(mergedAtMs) && mergedAtMs > closedAtMs && mergedAtMs - closedAtMs <= SUPERSEDED_LOOKBACK_MS;
    })
    .sort((a, b) => (a.mergedAt < b.mergedAt ? -1 : a.mergedAt > b.mergedAt ? 1 : a.number - b.number));
  for (const successor of eligible) {
    const heuristics = evaluateSuccessorMatch(
      { authorLogin: successor.authorLogin, linkedIssues: successor.linkedIssues, files: successor.files },
      { authorLogin: close.authorLogin, linkedIssues: close.linkedIssues, files: close.files },
    );
    if (heuristics) return { targetKey: close.targetKey, supersededBy: successor.number, heuristics };
  }
  return null;
}

/** The deterministic phase-1 row ids this pass is allowed to touch — live capture rows are never patched. */
export function backfillOverrideId(targetKey: string): string {
  return `backfill:${BACKFILL_RULE_ID}:${targetKey}:override`;
}
export function backfillFiredId(targetKey: string): string {
  return `backfill:${BACKFILL_RULE_ID}:${targetKey}:fired`;
}

/**
 * Patch a phase-1 override row's metadata to the retro `reversed` verdict. Returns the new JSON, or null
 * when the row is already reversed (idempotent re-run) or does not parse as an object (never guess).
 */
export function patchOverrideMetadataToReversed(metadataJson: string, match: RetroSuccessorMatch): string | null {
  const metadata = parseObject(metadataJson);
  if (!metadata) return null;
  if (metadata.verdict === "reversed") return null;
  return JSON.stringify({
    ...metadata,
    verdict: "reversed",
    retroLabel: {
      provenance: RETRO_SUCCESSOR_PROVENANCE,
      supersededBy: match.supersededBy,
      heuristics: match.heuristics,
    },
  });
}

/**
 * Patch a phase-1 fired row's metadata with the re-fetched PR diff — the field the live #8130 capture
 * records for this rule (`metadata.diff`, same bound). Returns null when raw context is already present
 * (either captured live or patched by an earlier run), when the diff is empty, or on unparseable metadata.
 */
export function patchFiredMetadataWithDiff(metadataJson: string, diff: string): string | null {
  const metadata = parseObject(metadataJson);
  if (!metadata) return null;
  if (typeof metadata.diff === "string") return null;
  const bounded = diff.slice(0, RAW_CONTEXT_MAX_DIFF_CHARS);
  if (bounded === "") return null;
  return JSON.stringify({ ...metadata, diff: bounded, rawContextProvenance: RAW_CONTEXT_REFETCH_PROVENANCE });
}

export type Phase2Report = {
  pass: "successors" | "raw-context";
  scanned: number;
  patched: number;
  alreadyPatched: number;
  noMatch: number;
  /** Pass-A heuristic breakdown (#8170's apply decision hinges on it): a SAME-AUTHOR rework merging is
   *  strong bot-was-wrong evidence; a shared-issue match by a DIFFERENT author is routine duplicate
   *  competition in this culture — the winner merging does not make closing the loser wrong. */
  matchedSameAuthor: number;
  matchedSharedIssueOnly: number;
  requestsUsed: number;
  exhaustedBudget: boolean;
  resumeFrom: string | null;
};

/** Render the dry-run/apply report #8170 requires before any apply. */
export function renderPhase2Report(report: Phase2Report, mode: "dry-run" | "apply"): string {
  const lines = [
    `Calibration corpus backfill phase 2 (${mode}) — pass ${report.pass}, provenance ${
      report.pass === "successors" ? RETRO_SUCCESSOR_PROVENANCE : RAW_CONTEXT_REFETCH_PROVENANCE
    }`,
    `  scanned: ${report.scanned}  patched: ${report.patched}  already-patched: ${report.alreadyPatched}  no-match/skipped: ${report.noMatch}`,
    ...(report.pass === "successors"
      ? [`  match heuristics: same-author rework ${report.matchedSameAuthor}, shared-issue-only (different author) ${report.matchedSharedIssueOnly}`]
      : []),
    `  GitHub requests used: ${report.requestsUsed}${report.exhaustedBudget ? " (budget exhausted — resumable)" : ""}`,
  ];
  if (report.resumeFrom) lines.push(`  resume from: ${report.resumeFrom} (state file updated)`);
  return lines.join("\n");
}

function parseObject(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* corrupt row -- treat as unpatchable, mirroring phase 1's fail-open metadata parse */
  }
  return null;
}
