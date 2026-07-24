// Unified-comment bridge (reviewbot→loopover convergence, Stage D).
//
// A PURE, testable mapping from loopover's live PR-review data (the gate `GateCheckEvaluation`, the AI
// `advisoryNotes` + consensus defect, the readiness signal rows + total, the footer) onto the ported
// unified renderer (`renderUnifiedReviewComment`). #6103: this is now the ONLY PR-comment renderer --
// the legacy `buildPublicPrIntelligenceComment` path this used to sit alongside was deleted once it had
// no remaining production caller.
//
// loopover's GATE stays authoritative: we pass the gate-derived `decision` into `buildUnifiedReviewInput`
// so `deriveUnifiedStatus` lets it override the reviewer recommendations (the renderer already enforces
// this). The output PREPENDS the panel marker, so the existing in-place upsert
// (`createOrUpdatePrIntelligenceComment`) updates the same comment instead of posting a duplicate.
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
import { formatManifestValidationNotice } from "../signals/focus-manifest";
import type { CaptureInteractionRoute, CaptureRoute } from "./visual/capture";
import { VISUAL_REGRESSION_FINDING_CODE, VISUAL_UNRELATED_ISSUE_FINDING_CODE } from "./visual/visual-findings";
// Single-source the panel marker from its canonical home (the upsert reads it there); re-export so existing
// importers of `PR_PANEL_COMMENT_MARKER` from this module keep working. The unified body MUST prepend this
// verbatim or `createOrUpdatePrIntelligenceComment` posts a DUPLICATE instead of updating in place.
import { PR_PANEL_COMMENT_MARKER } from "../github/comments";
import { LOOPOVER_GATE_CHECK_NAME } from "./check-names";
import { classifyChangedFile, type ReviewFileClass } from "./changed-files-classify";
import { githubPrFileDiffUrl } from "./changed-files-diff-link";
import { classifyFindingCategory, FINDING_CATEGORIES, type FindingCategory } from "./finding-category-classify";
import type { FixHandoffBlock } from "./fix-handoff-render";
import {
  buildAutoMergeSummaryCollapsible,
  buildUnifiedReviewInput,
  renderUnifiedReviewComment,
  type AutoMergeSummarySignals,
  type DualReviewNote,
  type MergeReadiness,
  type ReviewNotes,
  type ReviewRecommendation,
  type UnifiedCollapsible,
  type UnifiedCommentContext,
  type UnifiedReviewInput,
  type UnifiedSignalRow,
  type Verdict,
} from "./unified-comment";
import { splitAiReviewNits } from "./ai-notes";

export { PR_PANEL_COMMENT_MARKER };
export { splitAiReviewNits } from "./ai-notes";

// ── Public-safe defense-in-depth (privacy-critical) ──────────────────────────────────────────────
//
// Every field this bridge feeds into the renderer is ALREADY public-safe by construction on the live
// loopover inputs (verified at convergence issue #1):
//   • panel rows (result/evidence) — built by buildPublicPrPanelSignalRows' panel helpers (public-safe);
//   • aiReview.notes — composed via composeAdvisoryNotes → toPublicSafe (drops anything unsafe);
//   • the consensus-defect title/detail — produced via toPublicSafe in consensusDefectOf.
// The ONE field whose inputs are NOT routed through an existing public-safe filter is the gate's
// `warnings` (turned into Nits): they carry an AdvisoryFinding's raw title/action. The gate/check-run
// path sanitizes those strings (sanitizeForCheckRun) before they reach GitHub, but this comment path
// did not. Rather than trust that every present and FUTURE warning finding is benign, scrub Nits with a
// boundary mirroring the check-run sanitizer's own private-term guard, and DROP a Nit that still trips it.
//
// Mirrors src/rules/advisory.ts CHECK_RUN_FORBIDDEN_TERMS (scrubbed → "[context]") and
// src/signals/engine.ts containsPrivatePublicTerm (drop if still present). Kept inline so this module
// stays a pure, dependency-light renderer-mapping seam.
const PRIVATE_FORBIDDEN_TERMS =
  /\b(?:rewards?|payouts?|farming|estimated\s+scores?|raw\s+trust\s+scores?|raw\s+trust|trust\s+scores?|score\s+estimates?|reward\s+estimates?|wallets?|hotkeys?|coldkeys?|mnemonics?|seed\s?phrases?|cohorts?|miner[-_\s]?originated|human[-_\s]?originated|rankings?|reviewability|scoreability|private\s+signals?|likely_duplicate|reviewability\s*\d)\b/gi;
const PRIVATE_DROP_TERMS = /\b(?:reward|payout|farming|wallet|hotkey|trust score|raw trust|estimated score|scoreability|cohort|mnemonic|likely_duplicate|reviewability\s*\d)\b/i;

/** Scrub forbidden terms from a contributor-facing Nit; return null to DROP it if it still leaks after
 *  scrubbing (fail-safe: never publish a line that names private rubric/scoring/reward internals). */
function publicSafeNit(line: string): string | null {
  const scrubbed = line.replace(PRIVATE_FORBIDDEN_TERMS, "[context]").replace(/\s+/g, " ").trim();
  if (!scrubbed) return null;
  return PRIVATE_DROP_TERMS.test(scrubbed) ? null : scrubbed;
}

/** Map loopover's gate conclusion to the renderer's authoritative `Verdict`.
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

/** Derive an ok/warn/fail state from a panel result cell's leading status icon (✅/⚠️/❌). */
function rowState(resultCell: string): UnifiedSignalRow["state"] {
  if (resultCell.startsWith("✅")) return "ok";
  if (resultCell.startsWith("❌")) return "fail";
  // A leading ℹ️ is an explicit neutral/informational marker (e.g. "no public Gittensor match", "none detected") —
  // it must map to the `info` state, not fall through to `warn`, so a non-blocking row never renders as ⚠️.
  if (resultCell.startsWith("ℹ️")) return "info";
  return "warn";
}

/** Strip the leading status icon from a result cell so it is not duplicated next to the unified icon. */
function rowResultText(resultCell: string): string {
  return resultCell.replace(/^[✅⚠️❌ℹ️]+\s*/u, "").trim();
}

/** Map the panel signal rows (buildPublicPrPanelSignalRows) → the unified table's rows
 *  (label/state/result/evidence). The unified renderer adds its own "Code review" row first; these follow
 *  it (loopover's gate row included). `gates: true` only for the "Gate result" row (#6067) -- the ONLY row
 *  among these that can actually move the verdict; every other row's own Evidence/Action text already says
 *  it's advisory-only. Drives the split between the renderer's always-visible "Decision drivers" list and
 *  its collapsed advisory-signals fold. */
export function panelRowsToSignalRows(rows: PublicPrPanelSignalRow[]): UnifiedSignalRow[] {
  return rows.map((row) => {
    const [label, result, evidence] = row.cells;
    return { label, state: rowState(result), result: rowResultText(result), evidence, gates: row.key === "gateResult" };
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
  /local loopover cache|registration is not available|config was not parsed|not registered/i;
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

/** Human-facing text for a gate HARD blocker finding: `title` alone when there's nothing more specific to add,
 *  or `title: detail` when detail says something the title doesn't already (mirrors holdWarningVerdictReason's
 *  shape immediately above, now applied to blockers too). Prefers `publicText` over `detail` when a producer set
 *  both (the same preference every other public-facing reader of AdvisoryFinding uses, e.g. local-branch.ts /
 *  github/commands.ts) — `publicSafeNit` below still scrubs the result either way as defense-in-depth.
 *
 *  FIX D-detail: before this, gateBlockerLines rendered ONLY `finding.title`, dropping `detail`/`publicText`
 *  entirely for every hard-blocker close. Several finding producers deliberately give EVERY verdict from a given
 *  check the SAME constant title (e.g. the content lane's surface findings are all titled "Registry surface
 *  review" regardless of whether the actual reason is a duplicate resubmission, an unsafe URL, or a secret) so
 *  the check-run itself stays identifiable — the verdict-specific explanation lives entirely in detail/publicText.
 *  Title-only rendering made "Why this is blocked" read identically generic across every distinct close reason,
 *  hiding the one thing a contributor (or a maintainer auditing a close) actually needs to see.
 *  `.action`, when present, is still appended as its own suffix — a distinct call-to-action some finding
 *  producers set independently of detail/publicText. */
function gateBlockerLine(finding: AdvisoryFinding): string {
  const title = finding.title.trim();
  const reason = (finding.publicText ?? finding.detail).trim();
  const base = reason.length > 0 && reason !== title ? `${title}: ${reason}` : title;
  return `${base}${finding.action ? ` — ${finding.action}` : ""}`.trim();
}

function gateVerdictReason(gate: GateCheckEvaluation): string | undefined {
  const holdReasons = gate.warnings
    .filter((finding) => MANUAL_HOLD_WARNING_CODES.has(finding.code))
    .map(holdWarningVerdictReason)
    .filter(Boolean);
  if (holdReasons.length > 0) return holdReasons.join("; ");
  // evaluateGateCheckCore's `summary` for a "failure" conclusion is LITERALLY `gate.blockers` restated as one
  // joined string (title + action per finding) -- and buildDualReviewNotes folds those SAME `gate.blockers`
  // into the reviewer notes that render as the "Why this is blocked" section a few lines below. Falling back
  // to `gate.summary`/`gate.title` here would print the identical blocker text TWICE in one comment (the
  // real-world bug behind loopover PR #5347's screenshot). Only reachable when gate.blockers is non-empty,
  // since evaluateGateCheckCore only sets `blockers: []` on a neutral/success conclusion -- so this never
  // affects the held/neutral case above, which has no "Why this is blocked" section to duplicate against.
  if (gate.blockers.length > 0) return undefined;
  return gate.summary?.trim() || gate.title?.trim() || undefined;
}

export function isBoilerplateNit(finding: AdvisoryFinding): boolean {
  return (
    BOILERPLATE_NIT_CODES.has(finding.code) ||
    BOILERPLATE_NIT_TITLE.test(finding.title)
  );
}

/** Build the single AI reviewer note from loopover's AI output: the composed advisory write-up (minus its nits)
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
  // and scrub each through the same public-safe boundary as Nits, DROPPING any that still leaks a private term
  // -- UNLESS the finding declares itself `alreadyPublicSafe` (a fixed, engineer-authored message with no
  // interpolated contributor/AI content, e.g. the content lane's deterministic surface-review findings): the
  // scrub exists to catch a private rubric term LEAKING into dynamically assembled text, not to mangle a static
  // string an engineer already reviewed into the uninformative "[context]" placeholder (#7981).
  const gateBlockerLines = (args.gateBlockers ?? [])
    .filter((finding) => finding.code !== "ai_consensus_defect")
    .map((finding) => {
      const line = gateBlockerLine(finding);
      return line && finding.alreadyPublicSafe ? line : publicSafeNit(line);
    })
    .filter((line): line is string => line !== null);
  const blockers = [...consensusBlocker, ...gateBlockerLines];
  // Nits are the only renderer input not already routed through an existing public-safe filter (the gate's
  // raw warning findings). Scrub each with the private-term boundary and DROP any that still leaks. See
  // PRIVATE_FORBIDDEN_TERMS above. (The consensus-defect blocker is already public-safe via toPublicSafe; the
  // gate blockers above go through the SAME scrub as Nits.)
  // `visual_regression_finding`/`visual_unrelated_issue_finding` are excluded here the same way
  // `ai_consensus_defect` is excluded from gateBlockerLines above — they render in their OWN "Visual
  // findings" collapsible (see `visualFindingsFromFindings`/`buildVisualFindingsCollapsible`), so folding
  // them into generic Nits too would render them twice.
  const gateNits = (args.warnings ?? [])
    .filter((warning) => !isBoilerplateNit(warning) && warning.code !== VISUAL_REGRESSION_FINDING_CODE && warning.code !== VISUAL_UNRELATED_ISSUE_FINDING_CODE)
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
  return [{ model: args.reviewerModel ?? "LoopOver AI review", notes }];
}

/** Recover a consensus defect (the dual-model agreement the gate already folded into its findings) from
 *  the advisory findings so the bridge can surface it as a structured blocker. */
export function consensusDefectFromFindings(findings: AdvisoryFinding[] | undefined): { title: string; detail: string } | undefined {
  const found = (findings ?? []).find((finding) => finding.code === "ai_consensus_defect");
  if (!found) return undefined;
  return { title: found.title, detail: found.detail };
}

/** Recover the advisory-only visual-regression AND visual-unrelated-issue findings (#4111 / `review.visual.
 *  bugAnalysis` — AI-vision analysis of before/after visual captures) from the SAME advisory findings array
 *  `consensusDefectFromFindings` reads above — feeding the identical pipeline every other AI-judgment finding
 *  rides, so a visual finding is suppressible by review.memory, audited the same way, and — critically — can
 *  NEVER become a gate blocker: neither `visual_regression_finding` nor `visual_unrelated_issue_finding` is
 *  one of the codes `isConfiguredGateBlocker` (src/rules/advisory.ts) recognizes, so both always stay a
 *  warning. Both codes share the SAME collapsible/rendering path — each finding's own title/action text
 *  (see `buildVisualRegressionFindings`) already makes the distinction ("possible regression" vs "possible
 *  unrelated issue — consider opening a new issue") without needing a separate section here. Formatted
 *  `title: detail`, scrubbed through the same `publicSafeNit` defense-in-depth boundary as every other
 *  bridge-recovered string. */
export function visualFindingsFromFindings(findings: AdvisoryFinding[] | undefined): string[] {
  return (findings ?? [])
    .filter((finding) => finding.code === VISUAL_REGRESSION_FINDING_CODE || finding.code === VISUAL_UNRELATED_ISSUE_FINDING_CODE)
    .map((finding) => `${finding.title}: ${finding.detail}`.trim())
    .map((line) => publicSafeNit(line))
    .filter((line): line is string => line !== null);
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
  /** loopover's authoritative gate verdict (drives the unified status + the Gate row). */
  gate: GateCheckEvaluation;
  /** The AI maintainer-review advisory notes (already public-safe), if any. */
  aiReview?: { notes: string } | undefined;
  /** The advisory findings — the bridge recovers the `ai_consensus_defect` consensus blocker from here. */
  advisoryFindings?: AdvisoryFinding[] | undefined;
  /** The readiness signal rows (from `buildPublicPrPanelSignalRows`). */
  panelRows: PublicPrPanelSignalRow[];
  /** Which rows the maintainer kept visible (`.loopover.yml review.fields`); a key set to `false` is hidden. */
  reviewFields?: Partial<Record<PublicPrPanelSignalRow["key"], boolean>> | undefined;
  /** The loopover readiness total (0–100) → the readiness chip. */
  readinessTotal: number;
  /** Number of changed files reviewed. */
  changedFiles: number;
  /** Number of independent AI reviewers synthesized (0 hides the reviewer chip/row evidence count). */
  reviewerCount?: number | undefined;
  /** CI + merge-state readiness, when the caller resolved it (loopover's panel omits it today). */
  mergeReadiness?: MergeReadiness | undefined;
  /** Whether the PR was auto-merged (only changes the ready-state verdict wording). */
  merged?: boolean | undefined;
  /** The footer markdown (earn CTA + attribution) — rendered under a divider. */
  footerMarkdown: string;
  /** The re-run checkbox label. */
  reRunLabel?: string | undefined;
  /** #4589: the generate-tests checkbox label. */
  generateTestsLabel?: string | undefined;
  /** Extra collapsed sections (e.g. signal definitions / contributor next steps). */
  extraCollapsibles?: UnifiedCollapsible[] | undefined;
  /** Headline brand (default "LoopOver review"). */
  brand?: string | undefined;
  /** Visual before/after capture routes (visual-capture port). When present + non-empty, a "Visual preview"
   *  collapsible (a markdown table of <img> tags pointing at the public /loopover/shot URLs) is appended.
   *  Public-safe: only URLs + route paths — no private terms. Default OFF (the processor passes this only
   *  when screenshotsAllowed + the PR touches web-visible files). */
  beforeAfter?: CaptureRoute[] | undefined;
  interactions?: CaptureInteractionRoute[] | undefined;
  /** Changed-file path + additions/deletions, one entry per file (review.changed_files_summary port). When
   *  present + non-empty, a "Changed files" collapsible (one row per source/test/docs/config/generated
   *  category, with file counts and +/- totals) is appended. Deterministic, no AI. Default OFF (the processor
   *  passes this only when the manifest opts in — see `resolveReviewPromptOverrides`'s `changedFilesSummary`).
   *  (#1957) */
  changedFilesSummary?: ChangedFileSummaryInput[] | undefined;
  /** Repo + PR number for per-file "View diff" links in the changed-files table (#2157). */
  changedFilesSummaryContext?: ChangedFilesSummaryContext | undefined;
  /** Deterministic per-PR review-effort estimate (review.effort_score port, `src/review/review-effort.ts`). When
   *  present, a compact `review effort: N/5 (~M min)` chip is appended to the status-chip row (passed straight
   *  through to `buildUnifiedReviewInput`'s `reviewEffort`). No AI. Default OFF (the processor passes this only
   *  when the manifest opts in — see `resolveReviewPromptOverrides`'s `effortScore`). (#1955) */
  reviewEffort?: { band: 1 | 2 | 3 | 4 | 5; minutes: number } | undefined;
  /** Read-only "auto-merge readiness" conditions table (review.auto_merge_summary port, #2051/#4147). When
   *  present, an "Auto-merge readiness" collapsible listing which auto-merge conditions currently pass/fail
   *  is appended — informational only, never a decision or a promise to merge (the gate/status chip above it
   *  remains the actual verdict). No AI, no network. Default OFF (the processor passes this only when the
   *  manifest opts in — see `resolveReviewPromptOverrides`'s `autoMergeSummary`). */
  autoMergeSummary?: AutoMergeSummarySignals | undefined;
  /** Display-only caps from `review.max_findings` (#2049). */
  maxFindingsCaps?: { blockers: number | null; nits: number | null } | undefined;
  /** `review.comment_verbosity` port (#2047): how much collapsible detail renders — `quiet` drops the Nits
   *  and every extra collapsible section (blockers/gate result/signals are unaffected); `detailed` renders
   *  every collapsible pre-expanded. Passed straight through to `renderUnifiedReviewComment`'s ctx. Default
   *  OFF (the processor passes this only when the manifest opts in — see `resolveReviewPromptOverrides`'s
   *  `commentVerbosity`). */
  commentVerbosity?: "quiet" | "normal" | "detailed" | null | undefined;
  /** The manifest's parse `warnings[]` (#2056) — when non-empty, a "Manifest validation" collapsible listing
   *  each grouped, deduped warning is appended, so an invalid/malformed `.loopover.yml` value fails clearly
   *  instead of silently falling back to a default. No AI, no network. Absent/empty ⇒ no section
   *  (byte-identical) — always safe to pass the manifest's raw warnings unconditionally. */
  manifestWarnings?: string[] | undefined;
  /** Line-anchored AI findings, one entry per inline finding (review.finding_categories port). When present +
   *  non-empty, a "Finding categories" collapsible (a count per security/correctness/performance/maintainability/
   *  tests/style category) is appended. A finding missing its own `category` falls back to
   *  `classifyFindingCategory` — never omitted from the count. Default OFF (the processor passes this only when
   *  the manifest opts in — see `resolveReviewPromptOverrides`'s `findingCategories`). (#1958) */
  findingCategories?: FindingCategoryInput[] | undefined;
  /** Deterministic impact-map entries (review.impact_map port, `src/review/impact-map.ts`, #2184/#2185). When
   *  present + non-empty, an "Impact map" collapsible (changed module → changed symbols → plausibly affected
   *  modules, bounded with a "+N more" overflow line) is appended. No AI. Default OFF (the processor passes
   *  this only when BOTH the operator's LOOPOVER_REVIEW_IMPACT_MAP flag and the per-repo manifest opt-in
   *  are on — see `shouldComputeImpactMap`, `src/review/impact-map-wire.ts`). */
  impactMap?: ImpactMapSummaryInput[] | undefined;
  /** review.fixHandoff emission (#1962): pre-rendered fix-handoff blocks (one per inline finding — a
   *  contributor's own local agent can consume them; content-only, no server-side write). When present and
   *  non-empty a "Fix handoff" collapsible is appended. Default OFF — the processor passes this only when the
   *  operator's LOOPOVER_REVIEW_FIX_HANDOFF flag AND the per-repo `review.fixHandoff` manifest opt-in are on
   *  (see `shouldEmitFixHandoff`, `src/review/fix-handoff.ts`), so the rendered comment is byte-identical when off. */
  fixHandoffBlocks?: FixHandoffBlock[] | undefined;
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
  /** Linked-issue satisfaction advisory (#1961/#3906): the resolved {status, rationale} the processor computed
   *  via runLinkedIssueSatisfactionForAdvisory, passed straight through to buildUnifiedReviewInput's field of
   *  the same name. Presentation only — never changes `decision`/the gate verdict, which the `block`-mode
   *  blocker (linked_issue_scope_mismatch, src/rules/advisory.ts) already folded into `gate` above when it
   *  applies. Absent (default; the processor only resolves this when linkedIssueSatisfactionGateMode !=
   *  "off") ⇒ no section is rendered, byte-identical to today. */
  linkedIssueSatisfaction?: { status: "addressed" | "partial" | "unaddressed"; rationale: string } | undefined;
  /** Threshold-only backtest advisory (#8138), already rendered to Markdown by the processor
   *  (thresholdBacktestBlock, src/services/threshold-backtest.ts) — passed straight through to
   *  buildUnifiedReviewInput's field of the same name. Presentation only. Absent/empty (default; the
   *  processor only resolves this when a PR's diff changes a known confidence threshold constant) ⇒ no
   *  section is rendered, byte-identical to today. */
  thresholdBacktest?: string | undefined;
};

/**
 * Build the "Visual findings" collapsible (#4111) from the advisory-only visual-regression observations
 * `visualFindingsFromFindings` recovered — one bullet per finding. Rendered ahead of "Visual preview" so the
 * AI's read of the screenshots leads the raw before/after table a maintainer would otherwise have to eyeball
 * themselves. Returns null when there are none, so the caller can unconditionally chain this alongside the
 * other optional collapsibles (byte-identical for every review where no vision call ran).
 */
export function buildVisualFindingsCollapsible(findings: string[]): UnifiedCollapsible | null {
  if (findings.length === 0) return null;
  const body = findings.map((finding) => `- ${finding}`).join("\n");
  return { title: "Visual findings", body };
}

/**
 * Build the "Visual preview" collapsible from the before/after capture routes — a clean table whose cells are
 * CLICKABLE THUMBNAILS: a small `<img>` (GitHub caps it to the column width) wrapped in an `<a href>` to the
 * SAME full-resolution shot, so a click opens the screenshot full-size. One row per route per viewport
 * (desktop / mobile) per captured theme (#3678, e.g. "desktop (dark)" — unlabeled when a route has no theme,
 * exactly like today), with the route path as the caption and a before (production) vs after (this PR's
 * preview) column, plus a Diff column (#3674, self-host only) highlighting exactly what changed when a
 * pixel-diff provider is available and finds a real visual difference — absent on hosted builds and any
 * unchanged/no-diff cell, which render as a dash like every other missing shot. Emitted as TRUSTED raw HTML
 * (`rawHtml: true`) so the `<a>/<img>` survive — public-safe by construction: every value is a first-party
 * minted /loopover/shot URL or a route path (no private rubric / scoring terms), and a stray `"` in a URL
 * is neutralized so it can't break out of the attribute. Returns null when nothing is renderable (no route
 * has any shot URL), so the section is omitted rather than shown empty.
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
  // #6324: the same one-line caption UNDER the thumbnail that the screenshot-table contract itself requires
  // of contributors (see e.g. .claude/skills/metagraphed/SKILL.md's Phase B2 in JSONbored/metagraphed) --
  // previously only present as the invisible `alt` attribute, never rendered as visible text. <br> (not a
  // literal newline, which would break the GFM table row) keeps the caption inside the same cell; <sub> is
  // the same de-emphasized styling this table already uses for its own footer legend line below.
  // `imgUrl` (defaults to `url`) is what the <img src> loads; `url` is ALWAYS what the <a href> points at, so
  // "click to open full-size" keeps resolving to the true original even when a smaller downscaled copy
  // (route.before/afterThumbUrl[Mobile], self-host only) is embedded inline instead -- both viewports pass
  // their own thumb field below, not just desktop.
  const cell = (url: string | undefined, label: string, imgUrl: string = url ?? ""): string =>
    url ? `<a href="${attr(url)}" target="_blank" rel="noopener"><img width="360" alt="${attr(label)}" src="${attr(imgUrl)}"></a><br><sub>${attr(label)}</sub>` : "—";
  const rows: string[] = [];
  let hasAnyDiff = false;
  for (const route of routes) {
    const path = markdownCode(route.path);
    const themeSuffix = route.theme ? ` (${route.theme})` : "";
    if (route.beforeUrl || route.afterUrl) {
      if (route.diffUrl) hasAnyDiff = true;
      rows.push(`| ${path} | desktop${themeSuffix} | ${cell(route.beforeUrl, `before ${route.path}${themeSuffix}`, route.beforeThumbUrl)} | ${cell(route.afterUrl, `after ${route.path}${themeSuffix}`, route.afterThumbUrl)} | ${cell(route.diffUrl, `diff ${route.path}${themeSuffix}`)} |`);
    }
    if (route.beforeUrlMobile || route.afterUrlMobile) {
      if (route.diffUrlMobile) hasAnyDiff = true;
      rows.push(`| ${path} | mobile${themeSuffix} | ${cell(route.beforeUrlMobile, `before ${route.path} (mobile)${themeSuffix}`, route.beforeThumbUrlMobile)} | ${cell(route.afterUrlMobile, `after ${route.path} (mobile)${themeSuffix}`, route.afterThumbUrlMobile)} | ${cell(route.diffUrlMobile, `diff ${route.path} (mobile)${themeSuffix}`)} |`);
    }
  }
  if (rows.length === 0) return null;
  const body = [
    "| Route | Viewport | Before (production) | After (this PR's preview) | Diff |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    hasAnyDiff
      ? "_Click any thumbnail to open the full-size screenshot. Before = production · After = this PR's preview deploy · Diff highlights exactly what changed._"
      : "_Click any thumbnail to open the full-size screenshot. Before = production · After = this PR's preview deploy._",
  ].join("\n");
  return { title: "Visual preview", body, rawHtml: true };
}

/**
 * Build the "Scroll preview" collapsible from the same before/after capture routes (#3612) — rendered
 * ALONGSIDE "Visual preview", never replacing it, since a scroll-through GIF is evidence for scroll-linked
 * behavior (parallax, reveal-on-scroll, a sticky header) that a single static screenshot can't show, not a
 * substitute for the static before/after comparison. Self-host only (`review.visual.gif`, off by default —
 * see capture.ts's `gifWanted`) and desktop-viewport only in this first cut, so there is no Viewport column
 * here (unlike "Visual preview"'s desktop/mobile rows). Same clickable-thumbnail markup and public-safety
 * argument as `buildBeforeAfterCollapsible`. Returns null when no route has a GIF, so the section is omitted
 * entirely for every repo that hasn't opted in — byte-identical to pre-#3612 for everyone else.
 */
export function buildScrollPreviewCollapsible(routes: CaptureRoute[]): UnifiedCollapsible | null {
  const attr = (value: string): string =>
    value.replace(/[&"<>]/g, (char) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[char] as string);
  const markdownCode = (value: string): string =>
    `\`${value
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\|/g, "\\|")
      .replace(/[<>]/g, (char) => (char === "<" ? "&lt;" : "&gt;"))}\``;
  // #6324: same visible one-line caption as buildBeforeAfterCollapsible's own cell() -- see its doc comment.
  const cell = (url: string | undefined, label: string): string =>
    url ? `<a href="${attr(url)}" target="_blank" rel="noopener"><img width="360" alt="${attr(label)}" src="${attr(url)}"></a><br><sub>${attr(label)}</sub>` : "—";
  const rows: string[] = [];
  for (const route of routes) {
    if (!route.beforeGifUrl && !route.afterGifUrl) continue;
    const path = markdownCode(route.path);
    const themeSuffix = route.theme ? ` (${route.theme})` : "";
    rows.push(`| ${path}${themeSuffix} | ${cell(route.beforeGifUrl, `before ${route.path}${themeSuffix} (scroll)`)} | ${cell(route.afterGifUrl, `after ${route.path}${themeSuffix} (scroll)`)} |`);
  }
  if (rows.length === 0) return null;
  const body = [
    "| Route | Before (production) | After (this PR's preview) |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "_A short scroll-through clip (desktop) — click either thumbnail to open the full animation. Evidence for scroll-linked behavior a single screenshot can't show._",
  ].join("\n");
  return { title: "Scroll preview", body, rawHtml: true };
}

/**
 * Build the "Interaction preview" collapsible from captured hover/click interaction GIFs
 * (`review.visual.interactions`) — rendered ALONGSIDE "Visual preview"/"Scroll preview", never replacing
 * them, since a hover-triggered popover or click-driven state change isn't visible in a static screenshot
 * OR a scroll-through clip. One row per configured interaction TARGET (not per viewport/theme — an
 * interaction is rarely breakpoint- or theme-dependent, mirroring the contributor-facing animated-evidence
 * contract's own "one row per interaction target" shape), captioned with the interaction's `label` when
 * configured, falling back to its raw CSS `selector` otherwise. Self-host only (see capture.ts's
 * `isScrollGifAvailable` gate) — off, byte-identical to today, for every repo that hasn't opted in. Same
 * clickable-thumbnail markup and public-safety argument as `buildScrollPreviewCollapsible`. Returns null
 * when no interaction produced a GIF, so the section is omitted entirely.
 */
export function buildInteractionPreviewCollapsible(interactions: CaptureInteractionRoute[]): UnifiedCollapsible | null {
  const attr = (value: string): string =>
    value.replace(/[&"<>]/g, (char) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[char] as string);
  // #6324: same visible one-line caption convention as buildBeforeAfterCollapsible/buildScrollPreviewCollapsible.
  const cell = (url: string | undefined, label: string): string =>
    url ? `<a href="${attr(url)}" target="_blank" rel="noopener"><img width="380" alt="${attr(label)}" src="${attr(url)}"></a><br><sub>${attr(label)}</sub>` : "—";
  const rows: string[] = [];
  for (const interaction of interactions) {
    if (!interaction.beforeGifUrl && !interaction.afterGifUrl) continue;
    const target = interaction.label && interaction.label.trim() ? interaction.label.trim() : interaction.selector;
    rows.push(`| ${attr(target)} | ${cell(interaction.beforeGifUrl, `before ${target}`)} | ${cell(interaction.afterGifUrl, `after ${target}`)} |`);
  }
  if (rows.length === 0) return null;
  const body = [
    "| Target | Before | After |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "_Static screenshots can't show pointer-driven behavior — click either thumbnail to open the full interaction clip._",
  ].join("\n");
  return { title: "Interaction preview", body, rawHtml: true };
}

/** A changed file's path + line deltas — everything `buildChangedFilesSummaryCollapsible` needs to group and
 *  total. Deliberately narrower than `PullRequestFileRecord` (path/additions/deletions only) so the bridge
 *  doesn't drag GitHub's full file-record shape into its pure-rendering surface. */
export type ChangedFileSummaryInput = { path: string; additions: number; deletions: number };

/** Repo + PR coordinates for per-file "View diff" links on the changed-files table (#2157). */
export type ChangedFilesSummaryContext = { repoFullName: string; pullNumber: number };

const MAX_CHANGED_FILE_DIFF_ROWS = 200;
const MAX_CHANGED_FILES_DIFF_BODY_LENGTH = 30_000;

function markdownChangedFilePath(value: string): string {
  const safeValue = value
    .replace(/[\u0000-\u001f\u007f]/g, "�")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[<>]/g, (char) => (char === "<" ? "&lt;" : "&gt;"));
  const longestBacktickRun = safeValue.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
  const fence = "`".repeat(longestBacktickRun + 1);
  return `${fence}${safeValue}${fence}`;
}

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
 * Build the "Changed files" collapsible. Without `context`, groups by category (source/test/docs/config/generated)
 * with file counts and +/- totals — byte-identical to #2145. With `context`, renders one row per file (sorted
 * source-first) and a public-safe GitHub Files-tab "View diff" link per row (#2157).
 */
export function buildChangedFilesSummaryCollapsible(
  files: ChangedFileSummaryInput[],
  context?: ChangedFilesSummaryContext | undefined,
): UnifiedCollapsible | null {
  if (files.length === 0) return null;
  if (context && files.length <= MAX_CHANGED_FILE_DIFF_ROWS) {
    const sorted = [...files].sort((left, right) => {
      const leftCategory = CHANGED_FILE_CATEGORY_ORDER.indexOf(classifyChangedFile(left.path));
      const rightCategory = CHANGED_FILE_CATEGORY_ORDER.indexOf(classifyChangedFile(right.path));
      if (leftCategory !== rightCategory) return leftCategory - rightCategory;
      return left.path.localeCompare(right.path);
    });
    const rows = sorted.map((file) => {
      const diffUrl = githubPrFileDiffUrl(context.repoFullName, context.pullNumber, file.path);
      const diffCell = diffUrl ? `[View diff](${diffUrl})` : "—";
      return `| ${markdownChangedFilePath(file.path)} | +${file.additions} | -${file.deletions} | ${diffCell} |`;
    });
    const body = ["| File | Added | Removed | |", "| --- | --- | --- | --- |", ...rows].join("\n");
    if (body.length <= MAX_CHANGED_FILES_DIFF_BODY_LENGTH) return { title: "Changed files", body };
  }
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

/**
 * Build the "Manifest validation" collapsible from a manifest's parse `warnings[]` (#2056) — grouped,
 * deduped, so an invalid/malformed `.loopover.yml` value fails clearly instead of silently falling back
 * to a default. Returns null when there are no warnings, so the caller can unconditionally chain this
 * alongside the other optional collapsibles (byte-identical when the manifest is fully valid).
 */
export function buildManifestValidationCollapsible(warnings: string[]): UnifiedCollapsible | null {
  const notice = formatManifestValidationNotice(warnings);
  if (notice === null) return null;
  return { title: "Manifest validation", body: notice };
}

/** One impact-map entry — everything `buildImpactMapCollapsible` needs to render a row. Deliberately narrower
 *  than `ImpactMapEntry` (`src/review/impact-map.ts`) shape-wise (it IS that shape) so this bridge's import
 *  surface stays limited to what rendering actually reads. */
export type ImpactMapSummaryInput = { changedModule: string; affectedModules: string[]; callers: string[] };

/** Hard cap on affected-module cells actually PRINTED per row — independent of (and typically smaller than)
 *  the upstream `MAX_AFFECTED_MODULES_PER_ENTRY` compute-time cap, so a maintainer-facing table stays compact
 *  even when the computation itself kept a slightly larger set for AI-grounding use (#2186). Overflow renders
 *  as a trailing "+N more" instead of silently truncating with no indication more exist. */
const MAX_RENDERED_AFFECTED_MODULES = 5;

/** Public-safe inline-code rendering for a file path table cell. Impact-map paths can include
 *  contributor-controlled filenames, so choose a code-span delimiter longer than any run inside the
 *  value instead of trying to backslash-escape backticks (Markdown does not honor that inside code spans).
 *  Normalize row-breaking controls and entity-escape table/HTML metacharacters before wrapping. */
function markdownPathCode(value: string): string {
  const safeValue = value
    .replace(/[\r\n]+/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\|/g, "&#124;")
    .replace(/[<>]/g, (char) => (char === "<" ? "&lt;" : "&gt;"));
  const longestBacktickRun = Math.max(0, ...Array.from(safeValue.matchAll(/`+/g), (match) => match[0].length));
  const delimiter = "`".repeat(longestBacktickRun + 1);
  return `${delimiter} ${safeValue} ${delimiter}`;
}

/**
 * Build the "Impact map" collapsible (#2185): one row per changed module that has at least one deterministic
 * RAG-derived affected module, listing the changed symbols that drove the query and the (bounded, "+N more"
 * on overflow) affected modules a maintainer should also glance at. No AI, no network — pure rendering over
 * data the caller's (already flag-gated, #2184) impact-map computation produced. Returns null when there are
 * no entries (an empty/absent impact map — RAG unavailable, cold index, or the feature off), so the caller
 * can unconditionally chain this alongside the other optional collapsibles exactly like changedFilesSummary.
 */
export function buildImpactMapCollapsible(entries: ImpactMapSummaryInput[]): UnifiedCollapsible | null {
  if (entries.length === 0) return null;
  const rows = entries.map((entry) => {
    const shown = entry.affectedModules.slice(0, MAX_RENDERED_AFFECTED_MODULES);
    const overflow = entry.affectedModules.length - shown.length;
    const affectedCell = `${shown.map(markdownPathCode).join(", ")}${overflow > 0 ? ` (+${overflow} more)` : ""}`;
    const callersCell = entry.callers.length > 0 ? entry.callers.join(", ") : "—";
    return `| ${markdownPathCode(entry.changedModule)} | ${callersCell} | ${affectedCell} |`;
  });
  const body = [
    "| Changed module | Symbols | Plausibly affected |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "_Deterministic — from the codebase index, not an AI guess. Files worth a second look, not a guaranteed-complete call graph._",
  ].join("\n");
  return { title: "Impact map", body };
}

/**
 * Build the "Fix handoff" collapsible (#1962): the pre-rendered fix-handoff blocks for this review's inline
 * findings, one per finding, so a contributor's OWN local coding agent can consume them. Pure rendering — each
 * block's `.body` was already produced (and made public-safe) by `buildFixHandoffBlock`
 * (src/review/fix-handoff-render.ts); this only stitches them under one collapsible. Returns null when there are
 * no blocks (emission off, or no inline findings), so the caller chains it unconditionally exactly like the
 * impact-map / finding-category collapsibles above.
 */
export function buildFixHandoffCollapsible(blocks: FixHandoffBlock[]): UnifiedCollapsible | null {
  if (blocks.length === 0) return null;
  return { title: "Fix handoff", body: blocks.map((block) => block.body).join("\n\n") };
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

// #6069: a safe upper bound for the RENDERED comment body (before the marker prefix in buildUnifiedCommentBody
// below), comfortably under GitHub's real ~65536-character issue/PR comment cap (see MAX_STORED_BODY_CHARS,
// src/db/repositories.ts, for the same real limit applied to INCOMING bodies) -- leaves headroom for that
// marker plus a margin against undercounting. A maximally-featured PR (every optional collapsible active,
// plus e.g. a large changed-files table) had no aggregate size guard before this -- each section only ever
// capped ITSELF, so a comment could silently exceed GitHub's limit and fail to post at all.
const COMMENT_BODY_BUDGET_CHARS = 60_000;

/**
 * Render the comment, dropping the LOWEST-priority optional collapsibles -- from the end of
 * `extraCollapsibles` -- one at a time until the body fits COMMENT_BODY_BUDGET_CHARS or none are left to
 * drop. The construction order in `buildUnifiedCommentBody` already puts the heaviest/most decorative
 * sections last (Visual preview / Scroll preview's embedded image tables, Changed files' up-to-200-row
 * table), ahead of nothing but each other, so trimming from the end removes bulk before reference material.
 * Disposition-relevant content -- headline, chips, verdict, blockers, per-blocker AI fix context, decision
 * drivers -- is rendered directly by `renderUnifiedReviewComment` and is never part of `extraCollapsibles`,
 * so this loop can never drop it. When trimming happens, a final note is appended so the omission is visible
 * IN the comment (a maintainer reading it sees why detail is missing), not just an ops log they'd never see.
 */
function renderWithinBudget(
  input: UnifiedReviewInput,
  ctxBase: Omit<UnifiedCommentContext, "extraCollapsibles">,
  extraCollapsibles: UnifiedCollapsible[] | undefined,
): string {
  const all = extraCollapsibles ?? [];
  let kept = all;
  for (;;) {
    const body = renderUnifiedReviewComment(input, { ...ctxBase, ...(kept.length > 0 ? { extraCollapsibles: kept } : {}) });
    if (body.length <= COMMENT_BODY_BUDGET_CHARS || kept.length === 0) {
      if (kept.length === all.length) return body;
      const omittedCount = all.length - kept.length;
      const note: UnifiedCollapsible = {
        title: "Some detail omitted",
        body: `${omittedCount} additional section${omittedCount === 1 ? "" : "s"} were left out of this comment to stay within GitHub's comment size limit.`,
      };
      return renderUnifiedReviewComment(input, { ...ctxBase, extraCollapsibles: [...kept, note] });
    }
    kept = kept.slice(0, -1);
  }
}

/**
 * Build the unified PR-review comment body from loopover's live data. Returns a string that STARTS with
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
  // #6068: split the fix-handoff blocks by severity -- blocker-severity ones render per-blocker (right after
  // each blocker, via blockerFixContext below); nit-severity ones stay in the combined "Fix handoff"
  // collapsible (buildFixHandoffCollapsible, further down) exactly as before. Same source data
  // (buildFixHandoffBlocks(aiReview.inlineFindings), src/queue/processors.ts), just routed by severity.
  const blockerFixHandoffBlocks = args.fixHandoffBlocks?.filter((block) => block.severity === "blocker") ?? [];
  const input = buildUnifiedReviewInput({
    changedFiles: args.changedFiles,
    reviews,
    decision: verdict,
    ...(verdictReason !== undefined ? { verdictReason } : {}),
    ...(args.mergeReadiness !== undefined ? { readiness: args.mergeReadiness } : {}),
    ...(args.merged !== undefined ? { merged: args.merged } : {}),
    ...(args.reviewEffort !== undefined ? { reviewEffort: args.reviewEffort } : {}),
    ...(args.maxFindingsCaps !== undefined ? { maxFindingsCaps: args.maxFindingsCaps } : {}),
    ...(args.findingCategories !== undefined ? { inlineFindings: args.findingCategories } : {}),
    ...(args.linkedIssueSatisfaction !== undefined ? { linkedIssueSatisfaction: args.linkedIssueSatisfaction } : {}),
    ...(args.thresholdBacktest !== undefined ? { thresholdBacktest: args.thresholdBacktest } : {}),
    ...(blockerFixHandoffBlocks.length > 0 ? { blockerFixContext: blockerFixHandoffBlocks } : {}),
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

  // Honor `.loopover.yml review.fields` row visibility.
  const visibleRows = args.panelRows.filter((row) => args.reviewFields?.[row.key] !== false);
  const signals = panelRowsToSignalRows(visibleRows);

  // review-manifest validation (#2056): a broken/malformed .loopover.yml value should fail clearly, so this
  // is unconditional (no manifest opt-in) — prepended ahead of every content-shape summary since a config
  // problem is more foundational than what changed. No warnings ⇒ extraCollapsibles is unchanged.
  const manifestValidationCollapsible =
    args.manifestWarnings && args.manifestWarnings.length > 0 ? buildManifestValidationCollapsible(args.manifestWarnings) : null;
  const withManifestValidation =
    manifestValidationCollapsible !== null ? [manifestValidationCollapsible, ...(args.extraCollapsibles ?? [])] : args.extraCollapsibles;
  // review.auto_merge_summary port (#2051/#4147): when the manifest opts in, the processor hands us the
  // already-computed auto-merge condition signals here; append the read-only "Auto-merge readiness"
  // collapsible right after manifest validation (decision-relevant, so ahead of the structural/visual
  // summaries below). Flag-OFF (the processor passes undefined) ⇒ extraCollapsibles is unchanged.
  const autoMergeSummaryCollapsible = args.autoMergeSummary !== undefined ? buildAutoMergeSummaryCollapsible(args.autoMergeSummary) : null;
  const withAutoMergeSummary =
    autoMergeSummaryCollapsible !== null ? [...(withManifestValidation ?? []), autoMergeSummaryCollapsible] : withManifestValidation;
  // review.changed_files_summary port: when the manifest opts in, the processor hands us every changed file's
  // path + deltas here; append the grouped "Changed files" collapsible ahead of the visual preview (structure
  // before pixels). Flag-OFF (the processor passes undefined) ⇒ extraCollapsibles is unchanged. (#1957)
  const changedFilesCollapsible =
    args.changedFilesSummary && args.changedFilesSummary.length > 0
      ? buildChangedFilesSummaryCollapsible(args.changedFilesSummary, args.changedFilesSummaryContext)
      : null;
  const withChangedFiles =
    changedFilesCollapsible !== null ? [...(withAutoMergeSummary ?? []), changedFilesCollapsible] : withAutoMergeSummary;
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
  // review.impact_map port (#2184/#2185): when BOTH the operator flag and the manifest opt in, the processor
  // hands us the deterministic impact-map entries here; append the "Impact map" collapsible right after
  // Finding categories (another structural, no-AI summary) and ahead of the visual preview. Flag-OFF (the
  // processor passes undefined) ⇒ extraCollapsibles is unchanged.
  const impactMapCollapsible = args.impactMap && args.impactMap.length > 0 ? buildImpactMapCollapsible(args.impactMap) : null;
  const withImpactMap =
    impactMapCollapsible !== null ? [...(withFindingCategories ?? []), impactMapCollapsible] : withFindingCategories;
  // review.fixHandoff emission (#1962): when the operator flag AND the manifest opt in, the processor hands us
  // the pre-rendered fix-handoff blocks here. #6068: blocker-severity blocks now render per-blocker instead
  // (blockerFixHandoffBlocks above, threaded into `input.blockerFixContext`) -- this collapsible carries only
  // the nit-severity remainder, after Impact map (another structural, no-AI section) and ahead of the visual
  // preview. Flag-OFF, or every block was blocker-severity, (the processor passes undefined / an empty
  // remainder) ⇒ extraCollapsibles is unchanged.
  const nitFixHandoffBlocks = args.fixHandoffBlocks?.filter((block) => block.severity === "nit") ?? [];
  const fixHandoffCollapsible = nitFixHandoffBlocks.length > 0 ? buildFixHandoffCollapsible(nitFixHandoffBlocks) : null;
  const withFixHandoff =
    fixHandoffCollapsible !== null ? [...(withImpactMap ?? []), fixHandoffCollapsible] : withImpactMap;
  // Advisory-only AI-vision analysis of visual captures (#4111): recovered from the SAME advisory findings
  // array the consensus defect is recovered from, so an untouched (no vision call ran) review is unaffected —
  // `visualFindingsFromFindings` returns `[]` unless a caller actually appended a `visual_regression_finding`.
  const visualFindings = visualFindingsFromFindings(args.advisoryFindings);
  const visualFindingsCollapsible = visualFindings.length > 0 ? buildVisualFindingsCollapsible(visualFindings) : null;
  const withVisualFindings =
    visualFindingsCollapsible !== null ? [...(withFixHandoff ?? []), visualFindingsCollapsible] : withFixHandoff;
  // Visual-capture port: when before/after routes are present, append a "Visual preview" collapsible to the
  // extra sections. Flag-OFF (the processor passes no beforeAfter) ⇒ extraCollapsibles is unchanged.
  const visualCollapsible = args.beforeAfter && args.beforeAfter.length > 0 ? buildBeforeAfterCollapsible(args.beforeAfter) : null;
  const withVisual = visualCollapsible !== null ? [...(withVisualFindings ?? []), visualCollapsible] : withVisualFindings;
  // #3612: "Scroll preview" renders ALONGSIDE "Visual preview" (never replacing it) — self-host + gif:true
  // only, so this is null (no section, no behavior change) for every repo that hasn't opted in.
  const scrollCollapsible = args.beforeAfter && args.beforeAfter.length > 0 ? buildScrollPreviewCollapsible(args.beforeAfter) : null;
  const withScroll = scrollCollapsible !== null ? [...(withVisual ?? []), scrollCollapsible] : withVisual;
  // #interaction-gif-capture: "Interaction preview" renders ALONGSIDE "Visual preview"/"Scroll preview"
  // (never replacing them) — self-host + review.visual.interactions only, so this is null (no section, no
  // behavior change) for every repo that hasn't opted in.
  const interactionCollapsible = args.interactions && args.interactions.length > 0 ? buildInteractionPreviewCollapsible(args.interactions) : null;
  const extraCollapsibles = interactionCollapsible !== null ? [...(withScroll ?? []), interactionCollapsible] : withScroll;

  const body = renderWithinBudget(
    input,
    {
      brand: args.brand ?? "LoopOver review",
      readinessScore: args.readinessTotal,
      signals,
      footerMarkdown: args.footerMarkdown,
      reviewedAt: args.reviewedAt ?? new Date(),
      ...(args.reRunLabel !== undefined ? { reRunLabel: args.reRunLabel } : {}),
      ...(args.generateTestsLabel !== undefined ? { generateTestsLabel: args.generateTestsLabel } : {}),
      ...(args.heldForReview ? { heldForReview: true } : {}),
      ...(args.neverClosed ? { neverClosed: true } : {}),
      ...(args.preflightHeld ? { preflightHeld: true } : {}),
      commentVerbosity: args.commentVerbosity,
    },
    extraCollapsibles,
  );

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
 * `comment` verdict → `advisory` status (a non-blocking NOTE tone). No AI review,
 * no findings, and a single synthetic "Gate result — Skipped" signal row (the only signal we can assert for
 * a PR we never finished evaluating). Public-safe by construction: every string here is a static literal.
 */
export function buildClosedUnifiedCommentBody(args: { repoFullName: string; pullNumber: number; footerMarkdown: string }): string {
  const skippedGate: GateCheckEvaluation = {
    enabled: true,
    conclusion: "skipped",
    title: `${LOOPOVER_GATE_CHECK_NAME} skipped`,
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
