// Unified-comment bridge (reviewbot→gittensory convergence, Stage D).
//
// A PURE, testable mapping from gittensory's live PR-review data (the gate `GateCheckEvaluation`, the AI
// `advisoryNotes` + consensus defect, the readiness signal rows + total, the footer) onto the ported
// unified renderer (`renderUnifiedReviewComment`). Flag-gated and default-OFF in the processor; flag-OFF
// keeps the legacy `buildPublicPrIntelligenceComment` path byte-identical.
//
// gittensory's GATE stays authoritative: we pass the gate-derived `decision` into `buildUnifiedReviewInput`
// so `deriveUnifiedStatus` lets it override the reviewer recommendations (the renderer already enforces
// this). The output PREPENDS the exact panel marker the legacy body carries, so the existing in-place
// upsert (`createOrUpdatePrIntelligenceComment`) updates the same comment instead of posting a duplicate.
//
// Public-safe: most inputs are already safe by construction — the AI notes via
// `composeAdvisoryNotes`→`toPublicSafe`; the consensus-defect blocker via `toPublicSafe` (in
// `consensusDefectOf`); the signal rows via the panel helpers' `sanitizePanelText`. The ONE input not
// covered by an existing filter is the gate's `warnings` (rendered as Nits) — those carry an
// AdvisoryFinding's raw title/action, which the check-run path sanitizes (`sanitizeForCheckRun`) but this
// comment path historically did not. This module therefore scrubs Nits itself (see `publicSafeNit` /
// `PRIVATE_FORBIDDEN_TERMS`) as defense-in-depth before they reach a public comment.

import type { AdvisoryFinding } from "../types";
import type { GateCheckConclusion, GateCheckEvaluation } from "../rules/advisory";
import type { PublicPrPanelSignalRow } from "../signals/engine";
import type { CaptureRoute } from "./visual/capture";
// Single-source the panel marker from its canonical home (the upsert reads it there); re-export so existing
// importers of `PR_PANEL_COMMENT_MARKER` from this module keep working. The unified body MUST prepend this
// verbatim or `createOrUpdatePrIntelligenceComment` posts a DUPLICATE instead of updating in place.
import { PR_PANEL_COMMENT_MARKER } from "../github/comments";
import { GITTENSORY_GATE_CHECK_NAME } from "./check-names";
import { classifyChangedFile, type ReviewFileClass } from "./changed-files-classify";
import { classifyFindingCategory, FINDING_CATEGORIES, type FindingCategory } from "./finding-category-classify";
import {
  buildUnifiedReviewInput,
  renderUnifiedReviewComment,
  type DualReviewNote,
  type MergeReadiness,
  type ReviewNotes,
  type ReviewRecommendation,
  type UnifiedCollapsible,
  type UnifiedSignalRow,
  type Verdict,
} from "./unified-comment";
import { splitAiReviewNits } from "./ai-notes";

export { PR_PANEL_COMMENT_MARKER };
export { splitAiReviewNits } from "./ai-notes";

// ── Public-safe defense-in-depth (privacy-critical) ──────────────────────────────────────────────
//
// Every field this bridge feeds into the renderer is ALREADY public-safe by construction on the live
// gittensory inputs (verified at convergence issue #1):
//   • panel rows (result/evidence) — built by buildPublicPrPanelSignalRows' panel helpers (public-safe);
//   • aiReview.notes — composed via composeAdvisoryNotes → toPublicSafe (drops anything unsafe);
//   • the consensus-defect title/detail — produced via toPublicSafe in consensusDefectOf.
// The ONE field whose inputs are NOT routed through an existing public-safe filter is the gate's
// `warnings` (turned into Nits): they carry an AdvisoryFinding's raw title/action. The gate/check-run
// path sanitizes those strings (sanitizeForCheckRun) before they reach GitHub, but this comment path
// did not. Rather than trust that every present and FUTURE warning finding is benign, scrub Nits with a
// boundary mirroring the check-run sanitizer + the legacy panel's private-term guard, and DROP a Nit
// that still trips the guard. This never alters flag-OFF (the legacy panel keeps its own filtering).
//
// Mirrors src/rules/advisory.ts CHECK_RUN_FORBIDDEN_TERMS (scrubbed → "[context]") and
// src/signals/engine.ts containsPrivatePublicTerm (drop if still present). Kept inline so this module
// stays a pure, dependency-light renderer-mapping seam.
const PRIVATE_FORBIDDEN_TERMS =
  /\b(?:rewards?|payouts?|farming|estimated\s+scores?|raw\s+trust\s+scores?|trust\s+scores?|score\s+estimates?|reward\s+estimates?|wallets?|hotkeys?|coldkeys?|reviewability|scoreability|private\s+signals?|likely_duplicate|reviewability\s*\d)\b/gi;
const PRIVATE_DROP_TERMS = /\b(?:reward|payout|farming|wallet|hotkey|trust score|raw trust|estimated score|scoreability|likely_duplicate|reviewability\s*\d)\b/i;

/** Scrub forbidden terms from a contributor-facing Nit; return null to DROP it if it still leaks after
 *  scrubbing (fail-safe: never publish a line that names private rubric/scoring/reward internals). */
function publicSafeNit(line: string): string | null {
  const scrubbed = line.replace(PRIVATE_FORBIDDEN_TERMS, "[context]").replace(/\s+/g, " ").trim();
  if (!scrubbed) return null;
  return PRIVATE_DROP_TERMS.test(scrubbed) ? null : scrubbed;
}

/** Map gittensory's gate conclusion to the renderer's authoritative `Verdict`.
 *  success → merge · failure → close · action_required/neutral → manual · skipped → comment. */
export function gateConclusionToVerdict(conclusion: GateCheckConclusion): Verdict {
  switch (conclusion) {
    case "success":
      return "merge";
    case "failure":
      return "close";
    case "action_required":
    case "neutral":
      return "manual";
    case "skipped":
      return "comment";
  }
}

/** A reviewer recommendation aligned with the gate verdict (advisory; the gate `decision` overrides it).
 *  Exported so the bridge unit tests can pin the gate-verdict → reviewer-recommendation mapping directly. */
export function verdictToRecommendation(verdict: Verdict): ReviewRecommendation {
  switch (verdict) {
    case "merge":
      return "merge";
    case "close":
      return "close";
    case "manual":
      return "manual_review";
    case "comment":
    case "ignore":
      return "manual_review";
  }
}

/** Derive an ok/warn/fail state from a legacy panel result cell's leading status icon (✅/⚠️/❌). */
function rowState(resultCell: string): UnifiedSignalRow["state"] {
  if (resultCell.startsWith("✅")) return "ok";
  if (resultCell.startsWith("❌")) return "fail";
  return "warn";
}

/** Strip the leading status icon from a result cell so it is not duplicated next to the unified icon. */
function rowResultText(resultCell: string): string {
  return resultCell.replace(/^[✅⚠️❌]+\s*/u, "").trim();
}

/** Map the legacy panel signal rows → the unified table's rows (label/state/result/evidence). The
 *  unified renderer adds its own "Code review" row first; these follow it (gittensory's gate row included). */
export function panelRowsToSignalRows(rows: PublicPrPanelSignalRow[]): UnifiedSignalRow[] {
  return rows.map((row) => {
    const [label, result, evidence] = row.cells;
    return { label, state: rowState(result), result: rowResultText(result), evidence };
  });
}

/** Self-host environmental + process findings that are already represented in the signal table and are NOT code
 *  observations — keep them OUT of the Nits list so the nit count reflects real code review, not boilerplate that
 *  padded nearly every review (#review-accuracy). */
const BOILERPLATE_NIT_CODES = new Set([
  "repo_not_registered",
  "repo_not_seen",
  "pr_not_cached",
  "pre_merge_check_unresolved",
  "missing_linked_issue",
  "no_linked_issue_without_rationale",
]);
const BOILERPLATE_NIT_TITLE =
  /local gittensory cache|registration is not available|config was not parsed|not registered/i;
const MANUAL_HOLD_WARNING_CODES = new Set([
  "guardrail_hold",
  "oversized_pr",
  "ai_review_inconclusive",
]);

function holdWarningVerdictReason(finding: AdvisoryFinding): string {
  const title = finding.title.trim();
  const detail = finding.detail.trim();
  return detail.length > 0 ? `${title}: ${detail}` : title;
}

function gateVerdictReason(gate: GateCheckEvaluation): string | undefined {
  const holdReasons = gate.warnings
    .filter((finding) => MANUAL_HOLD_WARNING_CODES.has(finding.code))
    .map(holdWarningVerdictReason)
    .filter(Boolean);
  if (holdReasons.length > 0) return holdReasons.join("; ");
  return gate.summary?.trim() || gate.title?.trim() || undefined;
}

export function isBoilerplateNit(finding: AdvisoryFinding): boolean {
  return (
    BOILERPLATE_NIT_CODES.has(finding.code) ||
    BOILERPLATE_NIT_TITLE.test(finding.title)
  );
}

/** Build the single AI reviewer note from gittensory's AI output: the composed advisory write-up (minus its nits)
 *  becomes the assessment; a consensus defect (recovered from the advisory findings) becomes a blocker; the AI's own
 *  nits AND the gate's non-blocking warnings become the collapsible nits. Deterministic warnings alone must NOT
 *  manufacture a reviewer note: a final public comment may only claim an AI review when there is a real AI
 *  assessment/defect. Returns `[]` when there is nothing reviewer-side to surface (no AI notes, no consensus defect,
 *  no non-AI gate blocker) so the renderer hides the reviewer chip. The gate `decision` (passed separately) stays
 *  authoritative over `recommendation` — this is advisory framing only. */
export function buildDualReviewNotes(args: {
  aiReview?: { notes: string } | undefined;
  consensusDefect?: { title: string; detail: string } | undefined;
  warnings?: AdvisoryFinding[] | undefined;
  /** The gate's hard blockers (GateCheckEvaluation.blockers). Folded into the reviewer blockers so a NON-AI
   *  gate failure (missing linked issue, slop, manifest, secret leak, …) renders a populated "Why this is
   *  blocked" list — not just an empty one driven by the AI consensus defect (FIX D1). The `ai_consensus_defect`
   *  is EXCLUDED here because it is already surfaced via `consensusDefect` (so it appears exactly once). Each is
   *  scrubbed through the same public-safe boundary as Nits (defense-in-depth) before reaching the comment. */
  gateBlockers?: AdvisoryFinding[] | undefined;
  recommendation: ReviewRecommendation;
  verdict: Verdict;
  reviewerModel?: string;
}): DualReviewNote[] {
  const { main: assessment, nits: aiNitLines } = splitAiReviewNits(
    args.aiReview?.notes?.trim() ?? "",
  );
  // The consensus defect is a REAL blocker only when the gate itself promoted it (aiReviewGateMode: "block" —
  // see src/rules/advisory.ts). When aiReviewGateMode is off/advisory (the default), `ai_consensus_defect` is
  // still unconditionally added to advisory.findings (so it's always recoverable here), but the gate
  // conclusion stays "success" and the PR still merges — labeling it a "Blocker" then is actively misleading
  // (a green, auto-merging check-run next to a "1 blocker" chip). Fold it into the non-blocking Nits instead,
  // clearly framed as advisory-only, so the comment never claims a merge is blocked when it will not be.
  // (#2592 — the gate's own block/advisory decision is unchanged; this only fixes how the comment labels it.)
  const consensusIsGateBlocking = (args.gateBlockers ?? []).some(
    (finding) => finding.code === "ai_consensus_defect",
  );
  const consensusBlocker = args.consensusDefect && consensusIsGateBlocking
    ? [formatConsensusDefectBlocker(args.consensusDefect)]
    : [];
  const consensusAdvisoryNits = args.consensusDefect && !consensusIsGateBlocking
    ? [publicSafeNit(`${formatConsensusDefectBlocker(args.consensusDefect)} (advisory only — not configured to block merge)`)].filter(
        (line): line is string => line !== null,
      )
    : [];
  // FIX D1: fold the gate's own hard blockers into the reviewer blockers (so a non-AI gate failure populates
  // "Why this is blocked"). Exclude `ai_consensus_defect` (already surfaced via consensusDefect → appears once)
  // and scrub each through the same public-safe boundary as Nits, DROPPING any that still leaks a private term.
  const gateBlockerLines = (args.gateBlockers ?? [])
    .filter((finding) => finding.code !== "ai_consensus_defect")
    .map((finding) => `${finding.title}${finding.action ? ` — ${finding.action}` : ""}`.trim())
    .filter(Boolean)
    .map((line) => publicSafeNit(line))
    .filter((line): line is string => line !== null);
  const blockers = [...consensusBlocker, ...gateBlockerLines];
  // Nits are the only renderer input not already routed through an existing public-safe filter (the gate's
  // raw warning findings). Scrub each with the private-term boundary and DROP any that still leaks. See
  // PRIVATE_FORBIDDEN_TERMS above. (The consensus-defect blocker is already public-safe via toPublicSafe; the
  // gate blockers above go through the SAME scrub as Nits.)
  const gateNits = (args.warnings ?? [])
    .filter((warning) => !isBoilerplateNit(warning))
    .map((warning) => `${warning.title}${warning.action ? ` — ${warning.action}` : ""}`.trim())
    .filter(Boolean)
    .map((line) => publicSafeNit(line))
    .filter((line): line is string => line !== null);
  // The AI review's own nits (#focused-reviews) are non-blocking — fold them into the SAME collapsible Nits section as
  // the gate warnings, ahead of them, rather than leaving them in the prominent assessment blob. Already public-safe
  // via composeAdvisoryNotes → toPublicSafe; re-scrubbed here for defense-in-depth, consistent with the gate nits.
  const aiNits = aiNitLines
    .map((line) => publicSafeNit(line))
    .filter((line): line is string => line !== null);
  // The advisory-only consensus defect leads the list (it's the most severe item even though non-blocking).
  const nits = [...consensusAdvisoryNits, ...aiNits, ...gateNits];
  if (!assessment && blockers.length === 0 && nits.length === 0) return [];
  const notes: ReviewNotes = {
    assessment,
    suggestions: [],
    risks: [],
    verdict: args.verdict,
    recommendation: args.recommendation,
    confidence: 0.9,
    blockers,
    nits,
  };
  return [{ model: args.reviewerModel ?? "Gittensory AI review", notes }];
}

/** Recover a consensus defect (the dual-model agreement the gate already folded into its findings) from
 *  the advisory findings so the bridge can surface it as a structured blocker. */
export function consensusDefectFromFindings(findings: AdvisoryFinding[] | undefined): { title: string; detail: string } | undefined {
  const found = (findings ?? []).find((finding) => finding.code === "ai_consensus_defect");
  if (!found) return undefined;
  return { title: found.title, detail: found.detail };
}

function formatConsensusDefectBlocker(defect: { title: string; detail: string }): string {
  const title = defect.title.trim();
  const detail = defect.detail.trim();
  if (!detail) return title;
  const normalizedTitle = normalizeConcernLine(title);
  const normalizedDetail = normalizeConcernLine(detail);
  if (normalizedTitle.includes(normalizedDetail)) return detail;
  return `${title}: ${detail}`.trim();
}

function normalizeConcernLine(value: string): string {
  return value.toLowerCase().replace(/[\s.,;:!?`]+/g, " ").trim();
}

export type UnifiedCommentBridgeArgs = {
  /** gittensory's authoritative gate verdict (drives the unified status + the Gate row). */
  gate: GateCheckEvaluation;
  /** The AI maintainer-review advisory notes (already public-safe), if any. */
  aiReview?: { notes: string } | undefined;
  /** The advisory findings — the bridge recovers the `ai_consensus_defect` consensus blocker from here. */
  advisoryFindings?: AdvisoryFinding[] | undefined;
  /** The legacy panel readiness signal rows (from `buildPublicPrPanelSignalRows`). */
  panelRows: PublicPrPanelSignalRow[];
  /** Which rows the maintainer kept visible (`.gittensory.yml review.fields`); a key set to `false` is hidden. */
  reviewFields?: Partial<Record<PublicPrPanelSignalRow["key"], boolean>> | undefined;
  /** The gittensory readiness total (0–100) → the readiness chip. */
  readinessTotal: number;
  /** Number of changed files reviewed. */
  changedFiles: number;
  /** Number of independent AI reviewers synthesized (0 hides the reviewer chip/row evidence count). */
  reviewerCount?: number | undefined;
  /** CI + merge-state readiness, when the caller resolved it (gittensory's panel omits it today). */
  mergeReadiness?: MergeReadiness | undefined;
  /** Whether the PR was auto-merged (only changes the ready-state verdict wording). */
  merged?: boolean | undefined;
  /** The footer markdown (earn CTA + attribution) — rendered under a divider. */
  footerMarkdown: string;
  /** The re-run checkbox label. */
  reRunLabel?: string | undefined;
  /** Extra collapsed sections (e.g. signal definitions / contributor next steps). */
  extraCollapsibles?: UnifiedCollapsible[] | undefined;
  /** Headline brand (default "Gittensory review"). */
  brand?: string | undefined;
  /** Visual before/after capture routes (visual-capture port). When present + non-empty, a "Visual preview"
   *  collapsible (a markdown table of <img> tags pointing at the public /gittensory/shot URLs) is appended.
   *  Public-safe: only URLs + route paths — no private terms. Default OFF (the processor passes this only
   *  when screenshotsAllowed + the PR touches web-visible files). */
  beforeAfter?: CaptureRoute[] | undefined;
  /** Changed-file path + additions/deletions, one entry per file (review.changed_files_summary port). When
   *  present + non-empty, a "Changed files" collapsible (one row per source/test/docs/config/generated
   *  category, with file counts and +/- totals) is appended. Deterministic, no AI. Default OFF (the processor
   *  passes this only when the manifest opts in — see `resolveReviewPromptOverrides`'s `changedFilesSummary`).
   *  (#1957) */
  changedFilesSummary?: ChangedFileSummaryInput[] | undefined;
  /** Deterministic per-PR review-effort estimate (review.effort_score port, `src/review/review-effort.ts`). When
   *  present, a compact `review effort: N/5 (~M min)` chip is appended to the status-chip row (passed straight
   *  through to `buildUnifiedReviewInput`'s `reviewEffort`). No AI. Default OFF (the processor passes this only
   *  when the manifest opts in — see `resolveReviewPromptOverrides`'s `effortScore`). (#1955) */
  reviewEffort?: { band: 1 | 2 | 3 | 4 | 5; minutes: number } | undefined;
  /** Line-anchored AI findings, one entry per inline finding (review.finding_categories port). When present +
   *  non-empty, a "Finding categories" collapsible (a count per security/correctness/performance/maintainability/
   *  tests/style category) is appended. A finding missing its own `category` falls back to
   *  `classifyFindingCategory` — never omitted from the count. Default OFF (the processor passes this only when
   *  the manifest opts in — see `resolveReviewPromptOverrides`'s `findingCategories`). (#1958) */
  findingCategories?: FindingCategoryInput[] | undefined;
  /** The disposition holds this PR for owner review because its diff touches a hard-guardrail path — so an
   *  otherwise-ready comment renders "held for review" instead of "safe to merge". (#guarded-hold-comment) */
  heldForReview?: boolean | undefined;
  /** The author is the repo owner or a protected automation bot — never auto-closed, so a gate "close" verdict
   *  renders as "held" rather than "Closed" (#8/#9). */
  neverClosed?: boolean | undefined;
  /** Preflight is holding this PR (e.g. the review lane is unavailable) — an otherwise-ready comment then renders
   *  "held", never "safe to merge". (#2002) */
  preflightHeld?: boolean | undefined;
  /** Public freshness marker for the posted/updated review comment. Defaults to the current publish time. */
  reviewedAt?: string | number | Date | undefined;
};

/**
 * Build the "Visual preview" collapsible from the before/after capture routes — a clean table whose cells are
 * CLICKABLE THUMBNAILS: a small `<img>` (GitHub caps it to the column width) wrapped in an `<a href>` to the
 * SAME full-resolution shot, so a click opens the screenshot full-size. One row per route per viewport
 * (desktop / mobile), with the route path as the caption and a before (production) vs after (this PR's preview)
 * column. Emitted as TRUSTED raw HTML (`rawHtml: true`) so the `<a>/<img>` survive — public-safe by
 * construction: every value is a first-party minted /gittensory/shot URL or a route path (no private rubric /
 * scoring terms), and a stray `"` in a URL is neutralized so it can't break out of the attribute. Returns null
 * when nothing is renderable (no route has any shot URL), so the section is omitted rather than shown empty.
 */
export function buildBeforeAfterCollapsible(routes: CaptureRoute[]): UnifiedCollapsible | null {
  const attr = (value: string): string =>
    value.replace(/[&"<>]/g, (char) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[char] as string);
  const markdownCode = (value: string): string =>
    `\`${value
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\|/g, "\\|")
      .replace(/[<>]/g, (char) => (char === "<" ? "&lt;" : "&gt;"))}\``;
  const cell = (url: string | undefined, label: string): string =>
    url ? `<a href="${attr(url)}" target="_blank" rel="noopener"><img width="360" alt="${attr(label)}" src="${attr(url)}"></a>` : "—";
  const rows: string[] = [];
  for (const route of routes) {
    const path = markdownCode(route.path);
    if (route.beforeUrl || route.afterUrl) {
      rows.push(`| ${path} | desktop | ${cell(route.beforeUrl, `before ${route.path}`)} | ${cell(route.afterUrl, `after ${route.path}`)} |`);
    }
    if (route.beforeUrlMobile || route.afterUrlMobile) {
      rows.push(`| ${path} | mobile | ${cell(route.beforeUrlMobile, `before ${route.path} (mobile)`)} | ${cell(route.afterUrlMobile, `after ${route.path} (mobile)`)} |`);
    }
  }
  if (rows.length === 0) return null;
  const body = [
    "| Route | Viewport | Before (production) | After (this PR's preview) |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "_Click any thumbnail to open the full-size screenshot. Before = production · After = this PR's preview deploy._",
  ].join("\n");
  return { title: "Visual preview", body, rawHtml: true };
}

/** A changed file's path + line deltas — everything `buildChangedFilesSummaryCollapsible` needs to group and
 *  total. Deliberately narrower than `PullRequestFileRecord` (path/additions/deletions only) so the bridge
 *  doesn't drag GitHub's full file-record shape into its pure-rendering surface. */
export type ChangedFileSummaryInput = { path: string; additions: number; deletions: number };

/** Display order for the "Changed files" table — SOURCE FIRST, mirroring the same source-first priority this
 *  codebase already applies to the AI reviewer's own diff ordering (`diffFilePriority`,
 *  `src/review/review-diff.ts`): the code a maintainer most needs to read leads, generated/mechanical output
 *  trails. A category absent from the PR's changed files is simply omitted (no zero rows). */
const CHANGED_FILE_CATEGORY_ORDER: ReviewFileClass[] = ["source", "test", "docs", "config", "generated"];

const CHANGED_FILE_CATEGORY_LABEL: Record<ReviewFileClass, string> = {
  source: "Source",
  test: "Test",
  docs: "Docs",
  config: "Config",
  generated: "Generated",
};

/**
 * Build the "Changed files" collapsible: one row per file category (source/test/docs/config/generated, via
 * the deterministic `classifyChangedFile`), with a file count and +/- totals — collapsing an arbitrarily large
 * same-category group into a single row so a big PR doesn't turn into a wall of per-file lines. No AI, no
 * network — pure grouping over data the caller already has. Returns null when there are no files (nothing to
 * summarize), so the caller can unconditionally chain this alongside the other optional collapsibles.
 */
export function buildChangedFilesSummaryCollapsible(files: ChangedFileSummaryInput[]): UnifiedCollapsible | null {
  if (files.length === 0) return null;
  const totals = new Map<ReviewFileClass, { count: number; additions: number; deletions: number }>();
  for (const file of files) {
    const category = classifyChangedFile(file.path);
    const entry = totals.get(category);
    if (entry) {
      entry.count += 1;
      entry.additions += file.additions;
      entry.deletions += file.deletions;
    } else {
      totals.set(category, { count: 1, additions: file.additions, deletions: file.deletions });
    }
  }
  const rows = CHANGED_FILE_CATEGORY_ORDER.flatMap((category) => {
    const entry = totals.get(category);
    if (!entry) return [];
    return [`| ${CHANGED_FILE_CATEGORY_LABEL[category]} | ${entry.count} | +${entry.additions} | -${entry.deletions} |`];
  });
  const body = ["| Category | Files | Added | Removed |", "| --- | --- | --- | --- |", ...rows].join("\n");
  return { title: "Changed files", body };
}

/** A finding's path + body — everything `buildFindingCategoryCollapsible` needs to use the finding's own
 *  `category` when present, or fall back to `classifyFindingCategory` when it isn't. Deliberately narrower than
 *  `InlineFinding` (no line/severity/suggestion) so the bridge's pure-rendering surface stays minimal. */
export type FindingCategoryInput = { path: string; body: string; category?: FindingCategory | undefined };

const FINDING_CATEGORY_LABEL: Record<FindingCategory, string> = {
  security: "Security",
  correctness: "Correctness",
  performance: "Performance",
  maintainability: "Maintainability",
  tests: "Tests",
  style: "Style",
};

/**
 * Build the "Finding categories" collapsible: a count per category (security/correctness/performance/
 * maintainability/tests/style) across this review's line-anchored AI findings. A finding missing its own
 * `category` (the model omitted it) falls back to the deterministic `classifyFindingCategory` — every finding
 * is counted exactly once, never dropped. No AI, no network. Returns null when there are no findings, so the
 * caller can unconditionally chain this alongside the other optional collapsibles.
 */
export function buildFindingCategoryCollapsible(findings: FindingCategoryInput[]): UnifiedCollapsible | null {
  if (findings.length === 0) return null;
  const counts = new Map<FindingCategory, number>();
  for (const finding of findings) {
    const category = finding.category ?? classifyFindingCategory(finding);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const rows = FINDING_CATEGORIES.flatMap((category) => {
    const count = counts.get(category);
    if (!count) return [];
    return [`| ${FINDING_CATEGORY_LABEL[category]} | ${count} |`];
  });
  const body = ["| Category | Findings |", "| --- | --- |", ...rows].join("\n");
  return { title: "Finding categories", body };
}

/**
 * Build the unified PR-review comment body from gittensory's live data. Returns a string that STARTS with
 * the panel marker (so the existing upsert updates in place) followed by the rendered unified comment.
 * The gate verdict is authoritative: it is passed as `decision` so the renderer's `deriveUnifiedStatus`
 * lets it override the reviewer recommendation.
 */
export function buildUnifiedCommentBody(args: UnifiedCommentBridgeArgs): string {
  // #gate-dryrun: in dry-run mode the gate exposes the would-be conclusion (advisory promoted to block) as
  // `displayConclusion` so the rendered merge/close/manual verdict reflects what it WOULD do; the posted check
  // stays the real, non-enforcing `conclusion`. Outside dry-run, displayConclusion is absent ⇒ falls back.
  const verdict = gateConclusionToVerdict(args.gate.displayConclusion ?? args.gate.conclusion);
  const consensusDefect = consensusDefectFromFindings(args.advisoryFindings);
  const reviews = buildDualReviewNotes({
    aiReview: args.aiReview,
    consensusDefect,
    warnings: args.gate.warnings,
    // FIX D1: hand the gate's own hard blockers to the reviewer note so a non-AI gate failure populates the
    // "Why this is blocked" list (the consensus defect alone left it empty for those PRs).
    gateBlockers: args.gate.blockers,
    recommendation: verdictToRecommendation(verdict),
    verdict,
  });
  // FIX D2: carry the gate's authoritative reason onto the held/blocked/closed verdict headline. The gate
  // summary is the human-readable "why" (e.g. "A hard blocker was found."); fall back to the title. Public-safe
  // by construction (gate summary/title are author-facing) and angle-escaped by the renderer's verdictLine.
  // Only attached for a NON-merge verdict: a passing (merge → ready) PR keeps its positive "safe to merge" /
  // "all checks passed" wording rather than being overwritten by the gate's "no blocker found" summary.
  const gateReason = gateVerdictReason(args.gate);
  const verdictReason = verdict !== "merge" ? gateReason : undefined;
  const input = buildUnifiedReviewInput({
    changedFiles: args.changedFiles,
    reviews,
    decision: verdict,
    ...(verdictReason !== undefined ? { verdictReason } : {}),
    ...(args.mergeReadiness !== undefined ? { readiness: args.mergeReadiness } : {}),
    ...(args.merged !== undefined ? { merged: args.merged } : {}),
    ...(args.reviewEffort !== undefined ? { reviewEffort: args.reviewEffort } : {}),
  });
  // The gate already produced 0/1 reviewer notes from a synthesis of the model pair; reflect the caller's
  // actual reviewer count (for the chip + the "N reviewers, synthesized" evidence) without re-deriving it.
  // A non-AI gate blocker can still be folded into the blocker list above, but it must not make the comment claim
  // an AI reviewer ran. Without this guard, deterministic nits/warnings rendered as `1 AI reviewer` with no
  // review summary.
  input.reviewerCount =
    args.aiReview !== undefined
      ? typeof args.reviewerCount === "number"
        ? args.reviewerCount
        : input.reviewerCount
      : 0;

  // Honor `.gittensory.yml review.fields` row visibility, exactly as the legacy panel does.
  const visibleRows = args.panelRows.filter((row) => args.reviewFields?.[row.key] !== false);
  const signals = panelRowsToSignalRows(visibleRows);

  // review.changed_files_summary port: when the manifest opts in, the processor hands us every changed file's
  // path + deltas here; append the grouped "Changed files" collapsible ahead of the visual preview (structure
  // before pixels). Flag-OFF (the processor passes undefined) ⇒ extraCollapsibles is unchanged. (#1957)
  const changedFilesCollapsible =
    args.changedFilesSummary && args.changedFilesSummary.length > 0
      ? buildChangedFilesSummaryCollapsible(args.changedFilesSummary)
      : null;
  const withChangedFiles =
    changedFilesCollapsible !== null ? [...(args.extraCollapsibles ?? []), changedFilesCollapsible] : args.extraCollapsibles;
  // review.finding_categories port: when the manifest opts in, the processor hands us this review's line-anchored
  // AI findings here; append the "Finding categories" collapsible right after Changed files (both are structural
  // review-shape summaries, ahead of the visual preview). Flag-OFF (the processor passes undefined) ⇒
  // extraCollapsibles is unchanged. (#1958)
  const findingCategoryCollapsible =
    args.findingCategories && args.findingCategories.length > 0
      ? buildFindingCategoryCollapsible(args.findingCategories)
      : null;
  const withFindingCategories =
    findingCategoryCollapsible !== null ? [...(withChangedFiles ?? []), findingCategoryCollapsible] : withChangedFiles;
  // Visual-capture port: when before/after routes are present, append a "Visual preview" collapsible to the
  // extra sections. Flag-OFF (the processor passes no beforeAfter) ⇒ extraCollapsibles is unchanged.
  const visualCollapsible = args.beforeAfter && args.beforeAfter.length > 0 ? buildBeforeAfterCollapsible(args.beforeAfter) : null;
  const extraCollapsibles =
    visualCollapsible !== null ? [...(withFindingCategories ?? []), visualCollapsible] : withFindingCategories;

  const body = renderUnifiedReviewComment(input, {
    brand: args.brand ?? "Gittensory review",
    readinessScore: args.readinessTotal,
    signals,
    footerMarkdown: args.footerMarkdown,
    reviewedAt: args.reviewedAt ?? new Date(),
    ...(args.reRunLabel !== undefined ? { reRunLabel: args.reRunLabel } : {}),
    ...(extraCollapsibles !== undefined ? { extraCollapsibles } : {}),
    ...(args.heldForReview ? { heldForReview: true } : {}),
    ...(args.neverClosed ? { neverClosed: true } : {}),
    ...(args.preflightHeld ? { preflightHeld: true } : {}),
  });

  // Prepend the marker verbatim (matching the legacy body, which leads with the marker then a blank line)
  // so `createOrUpdatePrIntelligenceComment` finds and updates the SAME comment in place.
  return `${PR_PANEL_COMMENT_MARKER}\n\n${body}`;
}

/**
 * Build the unified body for the CLOSED/SKIPPED case (the PR closed before full evaluation). This is the
 * unified-renderer analogue of the legacy `buildClosedPrPanelUpdate` skipped review-agent panel,
 * routed through `buildUnifiedCommentBody` so a comment that started life as a unified OPEN-PR comment keeps
 * its unified shape (and the SAME marker) when the PR closes, instead of being overwritten by the legacy
 * panel under the shared marker. A synthetic `skipped` gate maps (via `gateConclusionToVerdict`) to the
 * `comment` verdict → `advisory` status, matching the legacy panel's non-blocking NOTE tone. No AI review,
 * no findings, and a single synthetic "Gate result — Skipped" signal row (the only signal we can assert for
 * a PR we never finished evaluating). Public-safe by construction: every string here is a static literal.
 */
export function buildClosedUnifiedCommentBody(args: { repoFullName: string; pullNumber: number; footerMarkdown: string }): string {
  const skippedGate: GateCheckEvaluation = {
    enabled: true,
    conclusion: "skipped",
    title: `${GITTENSORY_GATE_CHECK_NAME} skipped`,
    summary: "PR closed before full evaluation. No late first comment was created.",
    blockers: [],
    warnings: [],
  };
  const gateRow: PublicPrPanelSignalRow = {
    key: "gateResult",
    cells: ["Gate result", "⚠️ Skipped", `${args.repoFullName}#${args.pullNumber} is no longer open.`, "No action."],
  };
  return buildUnifiedCommentBody({
    gate: skippedGate,
    panelRows: [gateRow],
    readinessTotal: 0,
    changedFiles: 0,
    reviewerCount: 0,
    footerMarkdown: args.footerMarkdown,
  });
}

/** Truthy-env flag check, matching the codebase convention (e.g. SCORING_TIME_DECAY_ENABLED). */
export function isUnifiedReviewCommentEnabled(env: { GITTENSORY_REVIEW_UNIFIED_COMMENT?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_UNIFIED_COMMENT ?? "");
}
