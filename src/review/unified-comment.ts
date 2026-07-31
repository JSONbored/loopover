// Unified PR review comment renderer (convergence). The sole comment-rendering path since #6103 — no
// operator flag selects it anymore.
//
// Produces ONE in-place comment in the loopover SHAPE (colored alert sidebar + readiness
// signal table + collapsibles + re-run + earning footer) with reviewbot's deep review folded
// in (the verdict, the synthesized summary, a "Code review" signal row, nits/blockers), deduped.
//
// ADDITIVE + DORMANT: the live Worker keeps composeUnifiedReview() (advisory-render.ts). This
// renderer is exposed via engine.ts for the host (the loopover app) to call at cutover — it is
// a PURE function (no I/O, no redaction). The host applies its public-safe redaction AFTER, the
// same way the runtime does today (makePublicRedactor / redactOutsideCodeFences).
//
// The host provides loopover's readiness signals + footer + collapsibles in UnifiedCommentContext;
// reviewbot's review data comes in UnifiedReviewInput. The whole comment recolors by one unified
// status so there is a single authoritative verdict, never two.
//
// SELF-CONTAINED NATIVE PORT (reviewbot→loopover convergence): every type + helper this module
// needs is defined HERE. No imports from reviewbot. The logic is byte-faithful to the reviewbot
// source (src/core/unified-comment-render.ts + src/core/advisory-render.ts); the only deltas are
// mechanical guards for loopover's stricter tsconfig (noUncheckedIndexedAccess +
// exactOptionalPropertyTypes), which do not change behavior.

// ── Inlined minimal types (ported from reviewbot src/core/{ai-review,types,checks-gate}.ts) ─────

/** A reviewer's decision (a recommendation, not an enforced action). Always one of four — no neutral "comment". */
export type ReviewRecommendation = "merge" | "request_changes" | "close" | "manual_review";

/** The gate's final verdict (reviewbot src/core/types.ts). */
export type Verdict = "merge" | "close" | "manual" | "comment" | "ignore";

/** A maintainer-style review: assessment + actionable notes (not a pass/fail gate).
 *  Inlined from reviewbot's ReviewNotes — only the fields this renderer's extraction reads
 *  are load-bearing, but the full shape is preserved for a faithful port. */
export interface ReviewNotes {
  assessment: string;
  suggestions: string[];
  risks: string[];
  verdict: Verdict | "manual";
  /** This reviewer's recommended outcome for the human merger. */
  recommendation: ReviewRecommendation;
  confidence: number;
  /** Tier-1 (prSummary): a brief file-by-file walkthrough of the change. */
  walkthrough?: string;
  /** Change MAGNITUDE for the non-content auto-merge gate (#non-content-gate): a `fundamental` change —
   *  or one that `touchesImportantLogic` (backend/frontend logic, CI, a feature/contract) — is HELD for a
   *  human even when correct; a `trivial`/`moderate` fix may auto-merge. Optional: only gated lanes ask. */
  changeClass?: "trivial" | "moderate" | "fundamental";
  touchesImportantLogic?: boolean;
  /** Unified review (CodeRabbit-style Changes table): a per-file one-line summary of what changed. */
  changes?: Array<{ file: string; summary: string }>;
  /** Tier-1 (inlineComments): line-level findings. `line` is the NEW-file line; `suggestion` (when
   *  suggestedEdits is on) is replacement code rendered as a committable ```suggestion block.
   *  `severity` tiers the finding (critical=bug/security/breakage, major=should fix before merge,
   *  minor=small improvement, nitpick=trivial/style); `title` is a short headline. */
  findings?: Array<{
    file: string;
    line: number;
    comment: string;
    suggestion?: string;
    severity?: "critical" | "major" | "minor" | "nitpick";
    title?: string;
  }>;
  /** Unified-review comment (#unified-comment): the reviewer's concerns split by severity — `blockers` are
   *  concrete must-fix defects (a blocker present ⇒ don't auto-merge); `nits` are non-blocking suggestions. */
  blockers?: string[];
  nits?: string[];
}

/** One model's advisory review (or null when that model was unavailable/unparseable). */
export interface DualReviewNote {
  model: string;
  notes: ReviewNotes | null;
}

/** A failing check with the WHY, not just the name — so a review can factor the specific failure in (e.g.
 *  codecov's "60% of diff hit (target 97%)") instead of a bare "codecov/patch failed". `summary` comes from
 *  a check-run's output.title/summary or a commit-status's description; `detailsUrl` links the logs/report. */
export interface CheckFailureDetail {
  name: string;
  summary?: string;
  detailsUrl?: string;
}

// ── Ported merge-readiness + review-summary extraction (reviewbot src/core/advisory-render.ts) ──

/** Merge-readiness facts the caller resolves from GitHub BEFORE the advisory runs: is the PR actually
 *  mergeable, and is every CI check green? The reviewers judge the DIFF; this judges whether the PR can land
 *  at all — so a clean diff verdict never becomes a formal APPROVE on a conflicting / red-CI PR (#3906/#3908).
 *  Canonical home (#288): was duplicated identically in the awesome-claude + metagraphed agents. */
export interface MergeReadiness {
  mergeStateLabel?: string;
  /** #8759: the SHARED interpretation of mergeStateLabel, resolved by the bridge via
   *  pr-disposition.ts's isCommentMergeStateHeld so this self-contained file never re-derives meaning
   *  from the raw string. When present it is authoritative; absent (older callers) the legacy raw-string
   *  check below applies, byte-identical to the pre-#8759 behavior. */
  mergeStateHeld?: boolean;
  ciState: "passed" | "failed" | "unverified";
  failingChecks?: string[];
  failingDetails?: CheckFailureDetail[];
  /** Checks that reported red (e.g. a third-party app's `action_required` conclusion) but are NOT a
   *  branch-protection required context -- so they never flip `ciState`/block merge on their own, but must
   *  still be VISIBLE rather than silently dropped (#4414-class regression: a non-required advisory check must
   *  neither auto-close the PR nor vanish without a trace). Rendered as its own non-blocking collapsible,
   *  independent of `ciState`. */
  nonRequiredFailingDetails?: CheckFailureDetail[];
}

/** The structured synthesis of the reviewers' notes that drives BOTH the legacy unified comment
 *  (composeUnifiedReview) and the converged renderer's input (buildUnifiedReviewInput) — so the two never
 *  diverge on which blockers/nits/summary are surfaced or what counts as a consensus blocker. (#unified-comment) */
export interface ExtractedReviewSummary {
  recommendations: ReviewRecommendation[];
  failedCount: number;
  blockers: string[];
  nits: string[];
  summary: string;
  consensusBlocker: boolean;
}

/** Case-insensitive de-dup of concern lines (two reviewers often raise the same point). Preserves first wording.
 *  Uncapped, mirroring dedupeLines (#10010): callers pass the FULL deduped set to truncateFindingsForDisplay,
 *  which is the disclosed-truncation stage -- capping here instead silently dropped items 21+ from the
 *  AI-context block and understated the "+N more" footer. */
function dedupeConcerns(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase().replace(/[\s.,;:!?]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function extractReviewSummary(reviews: DualReviewNote[]): ExtractedReviewSummary {
  const valid = reviews.filter((r) => r.notes);
  const failedCount = reviews.length - valid.length;
  const recommendations = valid.map((r) => (r.notes as ReviewNotes).recommendation);
  const blockers = dedupeConcerns(valid.flatMap((r) => (r.notes as ReviewNotes).blockers ?? []));
  // Nits = the reviewers' explicit nits + their free-form suggestions (both non-blocking).
  const nits = dedupeConcerns(valid.flatMap((r) => [...((r.notes as ReviewNotes).nits ?? []), ...(r.notes as ReviewNotes).suggestions]));
  // A CONSENSUS blocker = ≥2 reviewers flagged one (or the sole reviewer did). A lone blocker in a dual review is a
  // split (held), not a hard block — matches the gate's severity discipline.
  const reviewersWithBlockers = valid.filter((r) => ((r.notes as ReviewNotes).blockers ?? []).length > 0).length;
  const consensusBlocker = reviewersWithBlockers >= 2 || (valid.length === 1 && reviewersWithBlockers === 1);
  const summary = valid.map((r) => (r.notes as ReviewNotes).assessment).find((a) => a?.trim())?.trim() ?? "";
  return { recommendations, failedCount, blockers, nits, summary, consensusBlocker };
}

// ── Unified renderer (reviewbot src/core/unified-comment-render.ts) ──────────────────────────────

/** The four visual states the comment recolors between (bar + GitHub alert sidebar together). */
export type UnifiedCommentStatus = "ready" | "advisory" | "held" | "blocked";

/** reviewbot's review side of the comment (mapped by the host/runtime from the gate decision + notes). */
export interface UnifiedReviewInput {
  /** Number of changed files reviewed. */
  changedFiles: number;
  /** Independent AI reviewers synthesized (e.g. 2). 0 hides the chip. */
  reviewerCount: number;
  /** Per-reviewer recommendations (drives the derived status when no explicit decision). */
  recommendations: ReviewRecommendation[];
  /** The synthesized, already-public-safe summary prose. */
  summary: string;
  /** Consensus blocking issues (shown expanded when present). */
  blockers?: string[];
  /** Structured, per-finding fix context for blocker-severity inline findings (#6068) — one entry per finding
   *  with a commentable location, each already rendered (by `buildFixHandoffBlock`,
   *  src/review/fix-handoff-render.ts) into a copy-paste-ready markdown block (location + instruction +
   *  suggested diff). Rendered as its own "Copy AI fix context" collapsible right after each blocker,
   *  mirroring CodeRabbit's per-finding "Prompt for AI Agents" pattern — the whole-PR "Copy for AI agents"
   *  block above stays as the aggregate option. Structural shape (just `.body`) so the host can pass
   *  `FixHandoffBlock[]` without this renderer importing that type — stays self-contained. NOT correlated
   *  with the `blockers` strings above (they come from separate sources — gate hard-blockers, review-thread
   *  findings, and this AI-findings source do not share one array) — rendered as its own supplementary group
   *  after the blockers list, not matched 1:1 to a specific bullet. Absent/empty (default; the host only
   *  passes these when `review.fixHandoff` is on AND a fresh review produced blocker-severity inline
   *  findings) ⇒ no section, byte-identical. `path`/`line` are only used to label each collapsible so
   *  multiple entries stay distinguishable while collapsed. */
  blockerFixContext?: ReadonlyArray<{ path: string; line?: number; body: string }>;
  /** Non-blocking suggestions (collapsed). */
  nits?: string[];
  /** CI + merge-state readiness. */
  readiness?: MergeReadiness;
  /** The gate's final verdict, if already decided. */
  decision?: Verdict;
  /** Whether the PR was auto-merged (only changes the ready-state verdict wording). */
  merged?: boolean;
  /** Optional short reason appended to the verdict line. */
  verdictReason?: string;
  /** Whether blocker(s) are a consensus (≥2 reviewers / sole reviewer) — drives blocked vs held. */
  consensusBlocker?: boolean;
  /** Reviewers that produced no parseable verdict (a partial review → held, not ready). */
  failedCount?: number;
  /** Display-only caps from `review.max_findings` — truncate rendered blocker/nit lists with a "+N more" footer.
   *  Never affects gate logic. Absent/null sub-fields ⇒ byte-identical. (#2049) */
  maxFindingsCaps?: { blockers: number | null; nits: number | null };
  /** Deterministic per-PR review-effort estimate (`estimateReviewEffort`, `src/review/review-effort.ts`) — a
   *  1-5 complexity band + a minutes estimate from the changed files' added-line volume and file-type mix. No
   *  AI. Rendered as a compact `review effort: N/5 (~M min)` chip only when the host passes this (gated by
   *  `review.effort_score` — see `resolveReviewPromptOverrides`'s `effortScore`); omitted ⇒ no chip
   *  (byte-identical). (#1955) */
  reviewEffort?: { band: 1 | 2 | 3 | 4 | 5; minutes: number };
  /** Linked-issue satisfaction advisory (#2174, render slice of #1961): whether this PR's diff appears to
   *  satisfy the linked issue's own intent/acceptance criteria — `addressed` / `partial` / `unaddressed` plus a
   *  short rationale, already public-safe (see `src/services/linked-issue-satisfaction.ts`). PRESENTATION
   *  ONLY — rendered as an additive collapsible section; never changes `status`/the gate verdict. Absent
   *  (default; the host only resolves this when `review.linkedIssueSatisfaction` is on) ⇒ no section is
   *  rendered, byte-identical to today. */
  linkedIssueSatisfaction?: { status: "addressed" | "partial" | "unaddressed"; rationale: string };
  /** Threshold-only backtest advisory (#8138, epic #8082): already-rendered Markdown (via
   *  `thresholdBacktestBlock`/`renderBacktestComparison`, `src/services/threshold-backtest.ts` /
   *  `@loopover/engine`) reporting whether a PR's changed confidence threshold regresses precision/recall
   *  against real historical outcomes. A STRING, not structured data — this module is a self-contained port
   *  with no imports (see the file header), so rendering happens in the caller, not here. PRESENTATION
   *  ONLY — never changes `status`/the gate verdict. Absent/empty (default; only set when the host detected
   *  a changed known threshold constant) ⇒ no section is rendered, byte-identical to today. */
  thresholdBacktest?: string;
  /** The review's line-anchored inline findings (only their `category` is read), used ONLY to render a compact
   *  category-tally line (#2150). Structural shape so an `InlineFinding[]` is assignable without importing it —
   *  this renderer stays self-contained. Absent/empty (default; the host passes them only when it produced
   *  categorized inline findings) ⇒ no tally line, byte-identical. Presentation only — never affects the verdict. */
  inlineFindings?: ReadonlyArray<{ category?: UnifiedFindingCategory | undefined }>;
}

/** One row of the readiness signal table (loopover side, host-provided; the engine adds Code review). */
export interface UnifiedSignalRow {
  label: string;
  state: "ok" | "warn" | "fail" | "info";
  /** Short result text, e.g. "Linked", "25/25". */
  result?: string;
  /** Evidence cell, e.g. "#1372". */
  evidence?: string;
  /** True only for a row that can actually change the verdict (today: just "Gate result" — see
   *  panelRowsToSignalRows, which sets this from the row's own `key === "gateResult"`). Every other row is
   *  advisory context by construction (#6067) — its own Evidence/Action text already says so (e.g. "No
   *  action.", "Advisory only."). Drives the split between the always-visible "Decision drivers" list and
   *  the collapsed "Context & advisory signals" fold. Absent/false ⇒ advisory. */
  gates?: boolean;
}

/** A collapsed section (loopover side: signal definitions, contributor next steps, …). */
export interface UnifiedCollapsible {
  title: string;
  body: string;
  /** When true the body is TRUSTED raw HTML and is NOT angle-escaped — used only by the visual before/after
   *  table (a table of `<a href><img>` clickable thumbnails the bridge builds from first-party shot URLs). */
  rawHtml?: boolean;
}

/** Already-computed auto-merge readiness facts (#2051). The host resolves each from signals it ALREADY has — the
 *  merge-readiness probe, the gate verdict, the linked-issue check — and injects them here. This module only
 *  RENDERS them into a read-only table; it never re-derives a condition or calls any merge/close decision path. */
export interface AutoMergeSummarySignals {
  /** Every required CI check is green. */
  ciGreen: boolean;
  /** The LoopOver gate is passing (no hard blocker). */
  gatePassing: boolean;
  /** GitHub reports the branch mergeable / clean (no conflict, not behind). */
  mergeableClean: boolean;
  /** The PR references a valid, open linked issue. */
  linkedIssueValid: boolean;
}

/** Build the READ-ONLY "auto-merge readiness" collapsible (#2051) — a conditions table showing which auto-merge
 *  conditions currently pass/fail, rendered purely from the injected {@link AutoMergeSummarySignals}. Informational
 *  only: it states the current condition states, never a decision or a promise to merge. Pure — no IO, no decision
 *  path. The caller renders this ONLY when `review.auto_merge_summary` is on, so off ⇒ nothing added ⇒ byte-identical. */
export function buildAutoMergeSummaryCollapsible(signals: AutoMergeSummarySignals): UnifiedCollapsible {
  const mark = (ok: boolean): string => (ok ? "✅" : "❌");
  const rows: Array<[string, boolean]> = [
    ["CI checks green", signals.ciGreen],
    ["Gate passing", signals.gatePassing],
    ["Branch mergeable (clean)", signals.mergeableClean],
    ["Valid linked issue", signals.linkedIssueValid],
  ];
  const body = [
    "_Read-only snapshot of the current auto-merge conditions — informational; it does not decide or trigger a merge._",
    "",
    "| Condition | Status |",
    "| --- | --- |",
    ...rows.map(([label, ok]) => `| ${label} | ${mark(ok)} |`),
  ].join("\n");
  return { title: "Auto-merge readiness (read-only)", body };
}

/** The host (loopover) side: brand, readiness score, signals, sections, re-run, footer. */
export interface UnifiedCommentContext {
  /** Headline brand, default "LoopOver review". */
  brand?: string;
  /** loopover readiness score 0–100 (omitted = no chip). */
  readinessScore?: number;
  /** loopover readiness signal rows (rendered after the Code review row). */
  signals?: UnifiedSignalRow[];
  /** Extra collapsed sections (rendered after Nits). */
  extraCollapsibles?: UnifiedCollapsible[];
  /** Re-run checkbox label, e.g. "Re-run LoopOver review" (omitted = no checkbox). */
  reRunLabel?: string;
  /** #4589: generate-tests checkbox label, e.g. "Generate an AI Playwright test for this PR" (omitted = no
   *  checkbox). Same top-level-outside-the-blockquote placement as reRunLabel, for the same reason (see
   *  renderUnifiedReviewComment's own comment on why the re-run checkbox can't render inside the alert). */
  generateTestsLabel?: string;
  /** Footer markdown (earning + branding), rendered under a divider. */
  footerMarkdown?: string;
  /** Force the status (e.g. the host knows it auto-merged). */
  statusOverride?: UnifiedCommentStatus;
  /** The host's disposition holds this PR for owner review (its diff touches a hard-guardrail path), so an
   *  otherwise-ready status renders as "held for review" instead of "safe to merge". (#guarded-hold-comment) */
  heldForReview?: boolean;
  /** The PR's author is the repo owner or a protected automation bot — the disposition NEVER auto-closes them,
   *  so a gate "close" verdict renders as "held", not "Closed" (#8/#9). */
  neverClosed?: boolean;
  /** GitHub itself REFUSED the merge for this head, and the refusal is durable (#9862). Not a gate state and
   *  not visible in `mergeable_state` — a stacked PR is unmergeable via the REST API at all (403 "Merging
   *  stacked PRs via this API is not supported"), and a repo merge policy can refuse with a 405 — so the PR
   *  reads perfectly clean and green while the merge can never happen without a human. Rendering "safe to
   *  merge" there is the #4220 class in its purest form: the comment promises an action the bot has already
   *  been told it cannot take. The reason string is GitHub's own, surfaced verbatim so the maintainer knows
   *  what to do (merge in the web UI) instead of watching a green PR sit. */
  mergeBlockedReason?: string | undefined;
  /** Preflight is HOLDING this PR (e.g. the review lane is unavailable so the review is incomplete) — an
   *  otherwise-ready status must then render as "held" (manual review), never "safe to merge". (#2002) */
  preflightHeld?: boolean;
  /** Public freshness marker for the posted/updated review comment. Rendered as UTC when provided. */
  reviewedAt?: string | number | Date | undefined;
  /** `review.comment_verbosity`: how much of the comment's collapsible detail renders. `quiet` drops the
   *  Nits collapsible and every `extraCollapsibles` section entirely (blockers/gate result/signals always
   *  stay — this only trims decorative detail, never the merge/close-relevant signal); `detailed` renders
   *  every collapsible pre-expanded (`<details open>`) instead of collapsed. `normal`/undefined (default) ⇒
   *  byte-identical to today. (#2047) */
  commentVerbosity?: "quiet" | "normal" | "detailed" | null | undefined;
}

const STATUS_META: Record<UnifiedCommentStatus, { alert: string; square: string; icon: string }> = {
  ready: { alert: "TIP", square: "🟩", icon: "✅" },
  advisory: { alert: "NOTE", square: "🟦", icon: "💡" },
  held: { alert: "WARNING", square: "🟨", icon: "⏸️" },
  blocked: { alert: "CAUTION", square: "🟥", icon: "🛑" },
};

// `info` is a neutral/grey state — informational, NEVER implying a warning (⚠️) or failure (❌). It backs rows like a
// non-Gittensor contributor match or "no improvement detected" that are advisory context, not a reason to flag the PR.
const SIGNAL_ICON: Record<UnifiedSignalRow["state"], string> = { ok: "✅", warn: "⚠️", fail: "❌", info: "ℹ️" };

/** Derive the single unified status from reviewbot's decision/recs/CI + the host override. */
export function deriveUnifiedStatus(input: UnifiedReviewInput, ctx: UnifiedCommentContext = {}): UnifiedCommentStatus {
  if (ctx.statusOverride) return ctx.statusOverride;
  // An explicit gate verdict is authoritative — it already weighed the reviewers + guardrails.
  let status: UnifiedCommentStatus | undefined;
  switch (input.decision) {
    case "merge":
      status = "ready";
      break;
    case "close":
      status = "blocked";
      break;
    case "manual":
      status = "held";
      break;
    case "comment":
    case "ignore":
      status = "advisory";
      break;
  }
  // No explicit decision → mirror reviewbot's unifiedStatus over the reviewers: a consensus blocker / close →
  // blocked; a lone blocker, a split, or a partial (failed) review → held; an empty review → advisory; all-merge → ready.
  if (!status) {
    const recs = input.recommendations ?? [];
    const hasConsensusBlocker = input.consensusBlocker ?? (input.blockers ?? []).length > 0;
    if (recs.includes("close") || hasConsensusBlocker) status = "blocked";
    else if (recs.length === 0) status = "advisory";
    else if ((input.failedCount ?? 0) > 0 || recs.some((r) => r !== "merge")) status = "held";
    else status = "ready";
  }
  // CI failure is an objective failing review state even when the disposition cannot auto-close the PR
  // (for example, JSONbored/owner-authored PRs). The action wording below still respects `neverClosed`, so this
  // renders as a red fix-required/manual-follow-up state without suggesting an owner PR will be rejected/closed.
  if (input.readiness?.ciState === "failed") {
    return "blocked";
  }
  // Readiness is otherwise advisory for the LoopOver verdict. A PR is not "safe to merge" until CI is green,
  // but pending/unverified CI should hold rather than create a red/blocked LoopOver decision by itself.
  if (status === "ready" && input.readiness && input.readiness.ciState !== "passed") {
    return "held";
  }
  // Merge-state readiness follows the same rule: do not claim "safe to merge" while GitHub says the branch is
  // dirty/behind/unstable, but keep the comment in a held/advisory tone instead of turning readiness into a
  // blocker. `unstable` (#pr-5288-confusing-verdict) covers a non-required check reporting non-success (e.g. a
  // third-party App's own check) — exactly the state agentHoldAuditDetail (processors.ts) already treats as a
  // real merge-withhold reason (`mergeableState !== "clean"`), so without this the comment could say "safe to
  // merge" on the SAME PR the disposition planner is actively holding, which is the contradiction #5288 reported.
  // Other states — clean, a not-yet-computed `unknown`, or a `blocked` that the bot's own pending approval will
  // clear — do not downgrade. (#ready-needs-mergeable)
  if (status === "ready" && input.readiness?.mergeStateHeld !== undefined) {
    // #8759: the bridge resolved the shared interpretation (pr-disposition.ts) — authoritative when present.
    if (input.readiness.mergeStateHeld) return "held";
  } else if (status === "ready" && input.readiness?.mergeStateLabel) {
    const mergeState = input.readiness.mergeStateLabel.toLowerCase();
    if (mergeState === "dirty" || mergeState === "behind" || mergeState === "unstable") return "held";
  }
  // Guarded-hold gate — a clean + green PR whose diff touches a hard-guardrail path (CI config, the review
  // engine, visuals) is HELD for owner review by the disposition, never auto-merged. The comment must then say
  // "held for review", not "✅ safe to merge", so the signal matches the action (the same #4220 class: a green
  // PR that won't actually merge). Applied LAST so it only ever downgrades an otherwise-ready status — a real
  // CI / merge-state / gate block above still wins. (#guarded-hold-comment)
  if (status === "ready" && ctx.heldForReview) return "held";
  // A PREFLIGHT HOLD means the review is INCOMPLETE (e.g. the review lane is unavailable) — it otherwise only lands
  // in the advisory readiness score, so an otherwise-ready status would still read "safe to merge" on an
  // unfinished review. Downgrade it to a manual-review hold. Applied only to an otherwise-`ready` status, so it can
  // only ever DOWNGRADE, never approve. (#2002) — NOTE: a gate `merge` verdict WITH advisory blockers stays
  // authoritative-ready by design (the gate already weighed those); tightening THAT is the gate's confidence/bar.
  // A durable GitHub merge refusal (#9862): same downgrade-only discipline as the guardrail hold above. The
  // gate genuinely passed, so everything else about the review stands -- but the merge will not happen, and
  // the status must not claim otherwise.
  if (status === "ready" && ctx.mergeBlockedReason) return "held";
  if (status === "ready" && ctx.preflightHeld) return "held";
  // Held-vs-closed disposition parity (#8/#9): owner/automation-bot authors may be exempt from auto-close, so a
  // close verdict on those authors is rendered as held. Guardrail holds are handled above only for otherwise-ready
  // PRs; they must not downgrade a blocker/close verdict to manual review.
  if (input.decision === "close") {
    if (ctx.neverClosed) return "held";
  }
  return status;
}

/**
 * PURE. Is a `held` status merely WAITING, rather than asking a person to act? (#10117)
 *
 * `held` is reached from two genuinely different situations, and until now both rendered as "Manual Review":
 *
 *   WAITING   -- CI has not finished or gone green, or GitHub reports the branch dirty/behind/unstable. Since
 *                #10116 an unstable state deliberately summons nobody: it resolves itself on the next push,
 *                and the disposition applies no `manual-review` label. Telling the reader a human is
 *                recommended contradicts what the gate actually decided, and on an in-flight PR it is simply
 *                wrong -- the answer is "wait", not "escalate".
 *   ACTIONABLE -- a guardrail hold, a durable GitHub merge refusal (#9862), an incomplete review, or a close
 *                verdict on an author who is never auto-closed. Each of these DOES need a person, and each
 *                must keep saying so.
 *
 * Defined here, immediately beside the conditions in deriveUnifiedStatus that produce those two cases, and
 * consumed by BOTH wording sites -- the headline and the verdict box. Re-deriving "is this actionable?"
 * separately in each would be the same drift that let the comment and the disposition disagree in the first
 * place.
 *
 * Deliberately conservative: every actionable reason short-circuits it to false, so a state this does not
 * recognise keeps today's "Manual Review" wording. Being wrongly told to look is a smaller failure than being
 * wrongly told not to.
 */
function isWaitingRatherThanActionable(input: UnifiedReviewInput, ctx: UnifiedCommentContext): boolean {
  if (input.decision === "manual" || input.decision === "close") return false;
  if (ctx.heldForReview || ctx.mergeBlockedReason || ctx.preflightHeld || ctx.neverClosed) return false;
  // A partial/split/blocking review is a real finding set, not a wait.
  const recs = input.recommendations ?? [];
  if ((input.consensusBlocker ?? (input.blockers ?? []).length > 0) || (input.failedCount ?? 0) > 0) return false;
  if (recs.some((rec) => rec !== "merge")) return false;
  // An unsettled MERGE STATE, and only that.
  //
  // Deliberately NOT `ciState !== "passed"`. The vocabulary is passed|failed|unverified with no "pending"
  // member, and `failed` already returned "blocked" further up -- so the only value that could reach here via
  // CI is `unverified`, which is emphatically not a wait: agent-actions.ts lists it as a manualHoldReason
  // ("CI could not be verified") and the disposition genuinely holds the PR for a person. Softening that to
  // "no action needed yet" would tell a maintainer to stand down from a hold that is waiting on them. Caught
  // by tsc rejecting a "pending" literal that does not exist.
  //
  // A merge state GitHub has not settled is the real waiting case, and the one #10116 stopped escalating.
  return input.readiness?.mergeStateHeld === true;
}

function headlineLabel(status: UnifiedCommentStatus, input: UnifiedReviewInput, ctx: UnifiedCommentContext): string {
  switch (status) {
    case "ready":
      return "approve/merge recommended";
    case "advisory":
      return "advisory review";
    case "held":
      // #10117: only say a human is recommended when one actually is. See isWaitingRatherThanActionable.
      return isWaitingRatherThanActionable(input, ctx) ? "waiting on checks" : "manual review recommended";
    case "blocked":
      return input.decision === "close" && !ctx.neverClosed ? "reject/close recommended" : "fixes required";
  }
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

function statusChips(input: UnifiedReviewInput, ctx: UnifiedCommentContext, status: UnifiedCommentStatus): string {
  const chips: string[] = [`\`${plural(input.changedFiles, "file")}\``];
  if (input.reviewerCount > 0) chips.push(`\`${plural(input.reviewerCount, "AI reviewer")}\``);
  // Count the DEDUPED blockers -- the same set the "Why this is blocked" section renders from -- so the chip can
  // never claim a number the section does not account for (e.g. when input.blockers carries duplicates) (#9670).
  const blockerCount = dedupeLines(input.blockers ?? []).length;
  chips.push(blockerCount ? `\`${plural(blockerCount, "blocker")}\`` : "`no blockers`");
  // The readiness score is advisory-only and NEVER feeds the gate (see deriveUnifiedStatus's own comments) —
  // showing it next to a non-"ready" verdict reads as contradictory (e.g. "readiness 93/100" beside "fixes
  // required"). Only surface the number when the verdict itself agrees with a high score.
  if (status === "ready" && typeof ctx.readinessScore === "number") chips.push(`\`readiness ${Math.round(ctx.readinessScore)}/100\``);
  if (input.readiness) {
    const ci = input.readiness.ciState;
    chips.push(ci === "passed" ? "`CI green`" : ci === "failed" ? "`CI failing`" : "`CI pending`");
    if (input.readiness.mergeStateLabel) chips.push(`\`${escapePublicHtmlAngles(input.readiness.mergeStateLabel)}\``);
  }
  // review.effort_score (#1955): deterministic, no-AI — only rendered when the host resolved + passed it
  // (gated by the manifest toggle). Absent ⇒ no chip (byte-identical).
  if (input.reviewEffort) chips.push(`\`review effort: ${input.reviewEffort.band}/5 (~${input.reviewEffort.minutes} min)\``);
  return chips.join(" · ");
}

/** Nest a block one level deeper inside the outer alert blockquote (an extra `> ` per line). Gives the
 *  Suggested Action verdict — the single most load-bearing line in the comment — its own visually distinct
 *  bordered sub-block instead of a plain bold paragraph lost in the body flow. Pure markdown (a nested
 *  blockquote), no custom HTML/CSS — `asAlert` re-prefixes every line with its own `> ` afterward, so this
 *  produces ordinary two-deep blockquote nesting, which GitHub already renders with a second indent/border.
 *  Unlike `asAlert`, every caller-supplied line here is always non-empty (a bold verdict line, optionally
 *  followed by `- reason` bullets — never a blank separator), so no blank-line special case is needed. */
function nestedBox(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

function verdictLine(status: UnifiedCommentStatus, input: UnifiedReviewInput, ctx: UnifiedCommentContext): string {
  const icon = STATUS_META[status].icon;
  const reasons = (defaultReason?: string) => {
    const raw = input.verdictReason?.trim() || defaultReason?.trim() || "";
    return raw ? `\n${actionReasonBullets(raw)}` : "";
  };
  switch (status) {
    case "ready":
      return nestedBox(
        input.merged
          ? `**${icon} Suggested Action - Approve/Merge**${reasons("auto-merged")}`
          : `**${icon} Suggested Action - Approve/Merge**${reasons("safe to merge")}`,
      );
    case "advisory":
      return nestedBox(`**${icon} Suggested Action - Advisory Only**${reasons("no action taken")}`);
    case "held":
      // #9862: when GitHub itself refused the merge, say so IN the verdict box. It is the one hold a
      // maintainer must personally clear, and the previous behaviour ("Manual Review" with no reason, since
      // a merge block sets no verdictReason) is what made a stacked PR look like the bot silently gave up.
      // GitHub's own message is quoted verbatim -- it names the actual restriction and the remedy.
      if (ctx.mergeBlockedReason) {
        return nestedBox(
          `**${icon} Suggested Action - Manual Review**\n` +
            actionReasonBullets(`GitHub refused an automated merge for this commit: ${ctx.mergeBlockedReason}`) +
            `\n${actionReasonBullets("The review passed — merge this pull request yourself to complete it.")}`,
        );
      }
      // #10117: a hold that is only waiting on checks asks for patience, not a person. Since #10116 an
      // unstable merge state summons nobody and gets no manual-review label, so "Manual Review" here
      // contradicted the disposition on the same PR -- the #5288 contradiction in the other direction.
      if (isWaitingRatherThanActionable(input, ctx)) {
        return nestedBox(`**${icon} Suggested Action - Waiting on Checks**${reasons("no action needed yet")}`);
      }
      return nestedBox(`**${icon} Suggested Action - Manual Review**${reasons()}`);
    case "blocked":
      if (ctx.neverClosed) {
        return nestedBox(`**${icon} Suggested Action - Manual Review**${reasons()}`);
      }
      if (input.decision === "close" && !ctx.neverClosed) {
        return nestedBox(`**${icon} Suggested Action - Reject/Close**${reasons()}`);
      }
      return nestedBox(`**${icon} Suggested Action - Fix Blockers**${reasons()}`);
  }
}

/** Dedupe a list of lines (case-insensitive). `cap` defaults to unlimited (#9670): the blockers/nits callers
 *  pass the FULL deduped set to truncateFindingsForDisplay, which is the disclosed-truncation stage -- capping
 *  here instead silently dropped items 13+ from the AI-context block and hid the "+N more" footer. Callers that
 *  genuinely want a hard, undisclosed cap (e.g. buildAiContextBlock's reasons) still pass one explicitly. */
function dedupeLines(items: string[], cap = Number.POSITIVE_INFINITY): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const line = raw.trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= cap) break;
  }
  return out;
}

/** Truncate a findings list for display-only rendering. Null/undefined cap ⇒ unchanged. */
// The human-scannable display cap applied when a repo's maxFindingsCaps supplies nothing. Moved here from
// dedupeLines' old default so the cap is now disclosed truncation (with a "+N more" footer) rather than silent
// data loss upstream of the AI-context block and the more-footer (#9670).
const DEFAULT_FINDINGS_DISPLAY_CAP = 12;

export function truncateFindingsForDisplay(
  items: string[],
  cap: number | null | undefined,
): { shown: string[]; hiddenCount: number } {
  if (cap === null || cap === undefined) return { shown: items, hiddenCount: 0 };
  if (cap <= 0) return { shown: [], hiddenCount: items.length };
  if (items.length <= cap) return { shown: items, hiddenCount: 0 };
  return { shown: items.slice(0, cap), hiddenCount: items.length - cap };
}

function appendMoreFooter(lines: string, hiddenCount: number): string {
  return hiddenCount > 0 ? `${lines}\n- _+${hiddenCount} more_` : lines;
}

/** Escape angle brackets in caller-provided public text so raw HTML, HTML comments,
 *  or stray closing tags cannot change the GitHub comment structure. */
function escapePublicHtmlAngles(text: string): string {
  return text.replace(/[<>]/g, (char) => (char === "<" ? "&lt;" : "&gt;"));
}

function bullets(items: string[]): string {
  return dedupeLines(items)
    .map((i) => `- ${escapePublicHtmlAngles(i)}`)
    .join("\n");
}

function taskList(items: string[]): string {
  return dedupeLines(items)
    .map((i) => `- [ ] ${escapePublicHtmlAngles(i)}`)
    .join("\n");
}

/** A single copy-paste-ready plain-text prompt combining every blocker into one instruction an AI coding
 *  agent can act on directly — mirrors CodeRabbit's combined "Prompt for AI agents" feature (per their own
 *  docs: gathers every fix prompt from a review into ONE structured instruction instead of one per finding,
 *  specifically to cut the repeated copy-paste this produced before). A GitHub-rendered fenced code block
 *  gets its own copy icon for free — no custom JS needed, just plain text inside the fence. The sole caller
 *  only invokes this inside its own `blockersAll.length` guard, so an empty list never reaches here. */
function buildAiContextBlock(blockers: string[], open: boolean): string {
  const items = blockers.map((line, i) => `${i + 1}. ${line}`).join("\n\n");
  const body = "```\nFix the following blocker(s) from this PR review:\n\n" + items + "\n```";
  return details("📋 Copy for AI agents", body, "paste into your coding agent", open);
}

function actionReasonBullets(reason: string): string {
  const reasons = reason
    .split(/[;\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return dedupeLines(reasons, 8)
    .map((item) => `- ${escapePublicHtmlAngles(item)}`)
    .join("\n");
}

function formatReviewTimestamp(value: string | number | Date | undefined): string | null {
  if (value === undefined) return null;
  const time = value instanceof Date ? value : new Date(value);
  const ms = time.getTime();
  if (!Number.isFinite(ms)) return null;
  return time.toISOString().replace(/\.\d{3}Z$/, "Z").replace("T", " ").replace("Z", " UTC");
}

const LINKED_ISSUE_SATISFACTION_LABELS: Record<"addressed" | "partial" | "unaddressed", string> = {
  addressed: "Addressed",
  partial: "Partially addressed",
  unaddressed: "Not yet addressed",
};

/** Render the linked-issue satisfaction advisory (#2174) as a `status` heading + rationale body, or "" when
 *  absent — the caller only appends the section when this returns non-empty, so an unresolved advisory omits
 *  the section entirely (byte-identical to today). Angle-escaping happens once, in the shared `details()`
 *  wrapper the caller passes this body to (matching every other collapsible section's own convention). */
function linkedIssueSatisfactionBlock(result: UnifiedReviewInput["linkedIssueSatisfaction"]): string {
  if (!result?.rationale.trim()) return "";
  const label = LINKED_ISSUE_SATISFACTION_LABELS[result.status];
  return `**${label}**\n${result.rationale.trim()}`;
}

/** Render the failing CI checks as a bullet list of `name — reason` (reason only when the check carried one),
 *  preferring failingDetails (which pairs each name with its WHY: codecov %/test/lint reason) and falling back
 *  to the bare failingChecks names. Public-safe: only check names + their already-public short summary, both
 *  angle-escaped. "" when there is nothing to list, so the caller omits the section entirely. */
function failingChecksBlock(readiness: MergeReadiness | undefined): string {
  if (!readiness || readiness.ciState !== "failed") return "";
  const details = readiness.failingDetails ?? [];
  if (details.length > 0) {
    const lines = details
      .map((detail) => {
        const name = escapePublicHtmlAngles(detail.name.trim());
        if (!name) return "";
        const reason = detail.summary?.trim() ? ` — ${escapePublicHtmlAngles(detail.summary.trim())}` : "";
        return `- ${name}${reason}`;
      })
      .filter((line) => line.length > 0);
    if (lines.length) return lines.join("\n");
  }
  const names = (readiness.failingChecks ?? []).map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length === 0) return "";
  return [...new Set(names)].map((name) => `- ${escapePublicHtmlAngles(name)}`).join("\n");
}

/** Render non-required-but-red checks (#4414-class advisory holds) as a `name — reason` bullet list, same
 *  shape/public-safety rules as `failingChecksBlock`. Unlike that one, this is NOT gated on `ciState` -- these
 *  checks by definition never flip `ciState`, so the section must render purely off the data's own presence. */
function nonRequiredFailingChecksBlock(readiness: MergeReadiness | undefined): string {
  const details = readiness?.nonRequiredFailingDetails ?? [];
  const lines = details
    .map((detail) => {
      const name = escapePublicHtmlAngles(detail.name.trim());
      if (!name) return "";
      const reason = detail.summary?.trim() ? ` — ${escapePublicHtmlAngles(detail.summary.trim())}` : "";
      return `- ${name}${reason}`;
    })
    .filter((line) => line.length > 0);
  return lines.join("\n");
}

/** The synthetic "Code review" row -- its blocker count is NOT purely the AI reviewers' own findings:
 *  `buildDualReviewNotes` (FIX D1) folds the gate's own deterministic hard blockers in too, so a non-AI
 *  gate failure (a missing linked issue, a registry-deliverable check, a secret leak, ...) still populates
 *  a "Why this is blocked" list even when no AI reviewer ran at all. Never routed through `ctx.signals`, so
 *  this row always exists and is never subject to `review.fields` visibility (matches its pre-#6067
 *  behavior as the signal table's unconditional first row).
 *
 *  #7491-class fix: when `reviewerCount` is 0, ANY blocker present can only have come from that deterministic
 *  fold-in -- a fresh `ai_consensus_defect` (the other blocker source) requires an actual review pass to
 *  exist at all. The evidence text used to read "No AI review summary" regardless, which next to a nonzero
 *  blocker count ("1 blocker (No AI review summary)") looked self-contradictory: as if an AI pass ran,
 *  found something, but produced no write-up -- not "AI review never ran; a separate check is what's
 *  blocking this." */
function codeReviewRow(input: UnifiedReviewInput): UnifiedSignalRow {
  // Count the DEDUPED blockers so this row's evidence phrasing keys off the same population the blockers
  // section renders (a duplicate blocker must not tip reviewerEvidence into the "blocker is from ..." arm) (#9670).
  const blockerCount = dedupeLines(input.blockers ?? []).length;
  const reviewerEvidence =
    input.reviewerCount > 1
      ? `${input.reviewerCount} reviewers, synthesized`
      : input.reviewerCount === 1
        ? "1 reviewer"
        : blockerCount > 0
          ? "no AI review ran — blocker is from a non-AI gate check"
          : "No AI review summary";
  return {
    label: "Code review",
    state: blockerCount ? "fail" : "ok",
    result: blockerCount ? plural(blockerCount, "blocker") : "No blockers",
    evidence: reviewerEvidence,
  };
}

/** One "Decision drivers" bullet: `- {icon} {label} — {result} ({evidence})`. `evidence` is parenthesized
 *  only when present, matching how sparse the underlying data can legitimately be (e.g. an unconfigured gate). */
function signalRowLine(r: UnifiedSignalRow): string {
  const labelText = escapePublicHtmlAngles(r.label);
  const resultText = r.result ? escapePublicHtmlAngles(r.result) : "";
  const evidenceText = r.evidence ? ` (${escapePublicHtmlAngles(r.evidence)})` : "";
  return `- ${SIGNAL_ICON[r.state]} ${labelText} — ${resultText}${evidenceText}`;
}

/** The always-visible "Decision drivers" list (#6067): ONLY the rows that can actually move the verdict --
 *  the synthetic Code review row, plus any host-supplied row marked `gates: true` (today: just "Gate
 *  result", see `panelRowsToSignalRows`). Replaces the old signal table's synthetic-first-row special case
 *  with an explicit, always-non-empty list (Code review alone is a valid, common case -- e.g. no gate
 *  configured for the repo). A short bullet list, not a table: this is meant to be scanned in one glance,
 *  not cross-referenced like the advisory rows below. */
function decisionDriverBlock(input: UnifiedReviewInput, ctx: UnifiedCommentContext): string {
  const rows = [codeReviewRow(input), ...(ctx.signals ?? []).filter((r) => r.gates)];
  const lines = rows.map((r) => signalRowLine(r));
  return `**Decision drivers**\n${lines.join("\n")}`;
}

/** Every host-supplied row that is NOT `gates: true` -- advisory context that never moves the verdict (each
 *  row's own Evidence/Action text already says so, e.g. "No action.", "Advisory only."). Rendered as the
 *  same Signal/Result/Evidence table the pre-#6067 signal table used, just scoped to this subset and moved
 *  behind a fold (see the "Context & advisory signals" collapsible in renderUnifiedReviewComment) instead of
 *  always-visible -- most of what made the old always-rendered table feel noisy. "" when there is nothing
 *  advisory to show (e.g. the host passed no signals at all), so the caller can omit the section entirely. */
function advisorySignalsTable(ctx: UnifiedCommentContext): string {
  const rows = (ctx.signals ?? []).filter((r) => !r.gates);
  if (rows.length === 0) return "";
  const lines = rows.map((r) => {
    const resultText = r.result ? ` ${escapePublicHtmlAngles(r.result)}` : "";
    const result = `${SIGNAL_ICON[r.state]}${resultText}`;
    return `| ${escapePublicHtmlAngles(r.label)} | ${result} | ${escapePublicHtmlAngles(r.evidence ?? "")} |`;
  });
  return ["| Signal | Result | Evidence |", "|---|---|---|", ...lines].join("\n");
}

/** `open`: render pre-expanded (`<details open>`) — used by `review.comment_verbosity: detailed` (#2047).
 *  Default collapsed, matching today's byte-identical behavior. */
function details(title: string, body: string, sub?: string, open = false): string {
  const safeTitle = escapePublicHtmlAngles(title);
  const safeSub = sub ? ` — ${escapePublicHtmlAngles(sub)}` : "";
  return `<details${open ? " open" : ""}><summary><b>${safeTitle}</b>${safeSub}</summary>\n\n${escapePublicHtmlAngles(body)}\n</details>`;
}

/** Like details(), but the body is TRUSTED raw HTML and is NOT angle-escaped. Used only for the visual
 *  before/after table, whose body is built solely from first-party minted shot URLs + route paths (see
 *  buildBeforeAfterCollapsible). The title is still escaped. */
function detailsRaw(title: string, body: string, open = false): string {
  return `<details${open ? " open" : ""}><summary><b>${escapePublicHtmlAngles(title)}</b></summary>\n\n${body}\n</details>`;
}

/** Wrap the assembled body in a GitHub alert blockquote — this is the full-comment colored sidebar. */
function asAlert(alert: string, inner: string): string {
  const quoted = inner
    .split("\n")
    .map((l) => (l.length ? `> ${l}` : ">"))
    .join("\n");
  return `> [!${alert}]\n${quoted}`;
}

/**
 * Render the unified PR review comment as GitHub markdown. Pure + public-safe-by-construction
 * (it only emits the fields passed in; no guardrail paths / thresholds / rubric). The host applies
 * its redactor to the result before posting, exactly as the runtime does for the legacy comment.
 */
/** The finding-category names (#1958 / #2150) — mirrors the fixed enum in finding-category-classify.ts, inlined
 *  here to keep this renderer self-contained (no cross-module imports). */
export type UnifiedFindingCategory = "security" | "correctness" | "performance" | "maintainability" | "tests" | "style";

/** Tally CATEGORIZED inline findings by category (#2150). Uncategorized findings are ignored; ordered by count
 *  desc, then category name asc, so the rendered line is deterministic. Pure — no IO, no gate impact. */
export function tallyFindingCategories(
  findings: ReadonlyArray<{ category?: UnifiedFindingCategory | undefined }>,
): Array<{ category: UnifiedFindingCategory; count: number }> {
  const counts = new Map<UnifiedFindingCategory, number>();
  for (const finding of findings) {
    if (!finding.category) continue;
    counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

export function renderUnifiedReviewComment(input: UnifiedReviewInput, ctx: UnifiedCommentContext = {}): string {
  const status = deriveUnifiedStatus(input, ctx);
  const meta = STATUS_META[status];
  const brand = escapePublicHtmlAngles(ctx.brand ?? "LoopOver review");
  const reviewTimestamp = formatReviewTimestamp(ctx.reviewedAt);
  // review.comment_verbosity (#2047): quiet drops every collapsible (Nits + extraCollapsibles) — blockers,
  // the gate result, and the signal table are never gated by verbosity, only decorative detail is. detailed
  // renders every collapsible pre-expanded. normal/unset ⇒ byte-identical to today.
  const verbosity = ctx.commentVerbosity ?? "normal";
  const collapsiblesOpen = verbosity === "detailed";

  const blocks: string[] = [
    // No repeated-square banner row here (dropped, #6066) — the alert blockquote below already renders a
    // colored border + icon for the same status; a 12x-emoji row on top of that was pure decoration.
    `### ${meta.icon} ${brand} result - ${headlineLabel(status, input, ctx)}${status === "ready" && input.merged ? " · auto-merged" : ""}`,
    ...(reviewTimestamp ? [`<sub>Review updated: ${reviewTimestamp}</sub>`] : []),
    statusChips(input, ctx, status),
    verdictLine(status, input, ctx),
  ];

  if (input.summary.trim()) blocks.push(`**Review summary**\n${escapePublicHtmlAngles(input.summary.trim())}`);

  const nitsAll = dedupeLines(input.nits ?? []);
  const nitsTrunc = truncateFindingsForDisplay(nitsAll, input.maxFindingsCaps?.nits ?? DEFAULT_FINDINGS_DISPLAY_CAP);
  if (nitsAll.length && verbosity !== "quiet") {
    const nitsBody = nitsTrunc.shown.length
      ? appendMoreFooter(taskList(nitsTrunc.shown), nitsTrunc.hiddenCount)
      : `_+${nitsTrunc.hiddenCount} more_`;
    blocks.push(details("Nits", nitsBody, `${nitsAll.length} non-blocking`, collapsiblesOpen));
  }

  // dedupe uncapped so blockersAll is the FULL set: truncateFindingsForDisplay (the disclosed-truncation stage)
  // then sees a real hiddenCount, and buildAiContextBlock below gets every blocker as its comment promises. The
  // 12-item DISPLAY default is preserved here (not in dedupeLines) so an unset maxFindingsCaps still caps the
  // human list, now with a "+N more" footer rather than silent loss (#9670).
  const blockersAll = dedupeLines(input.blockers ?? []);
  const blockersTrunc = truncateFindingsForDisplay(blockersAll, input.maxFindingsCaps?.blockers ?? DEFAULT_FINDINGS_DISPLAY_CAP);
  if (blockersAll.length) {
    const heading = status === "blocked" ? "Why this is blocked" : "Concerns raised — review before merging";
    const blockersBody = blockersTrunc.shown.length
      ? appendMoreFooter(bullets(blockersTrunc.shown), blockersTrunc.hiddenCount)
      : `_+${blockersTrunc.hiddenCount} more_`;
    blocks.push(`**${heading}**\n${blockersBody}`);
    // The FULL (pre-display-truncation) blocker set, not blockersTrunc.shown -- an AI agent benefits from
    // every blocker, not just the human-scannable capped subset shown above. Never gated by verbosity: this
    // is an extension of the blockers themselves (never gated), not decorative detail like Nits.
    blocks.push(buildAiContextBlock(blockersAll, collapsiblesOpen));
  }

  // Per-finding "Copy AI fix context" (#6068): one collapsible per blocker-severity inline finding, each a
  // self-contained copy-paste-ready block (location + instruction + suggested diff) for a contributor's own
  // local coding agent -- the CodeRabbit-style per-finding companion to the whole-PR block above. Never
  // gated by verbosity, same rationale as the blockers section itself.
  for (const entry of input.blockerFixContext ?? []) {
    const location = entry.line && entry.line > 0 ? `${entry.path}:${entry.line}` : entry.path;
    blocks.push(details("🔧 Copy AI fix context", entry.body, location, collapsiblesOpen));
  }

  // Category breakdown (#2150): a compact, deterministic one-liner of the finding mix (e.g. "2 correctness ·
  // 1 security"). Omitted entirely when no finding carries a category (default) ⇒ byte-identical. Pure tally, no
  // AI, no gate impact.
  const categoryTally = tallyFindingCategories(input.inlineFindings ?? []);
  if (categoryTally.length) {
    blocks.push(`**Findings by category:** ${categoryTally.map(({ category, count }) => `${count} ${category}`).join(" · ")}`);
  }

  // Failing CI checks — list WHICH checks failed and WHY (codecov %/test/lint reason) under the "CI failing"
  // chip, instead of leaving the chip as the only signal. Only when CI actually failed (failingChecksBlock
  // guards on ciState === "failed"); public-safe (names + short reasons only).
  const failingChecks = failingChecksBlock(input.readiness);
  if (failingChecks) blocks.push(`**CI checks failing**\n${failingChecks}`);

  // Non-required-but-red checks (#4414-class advisory holds): visible but never blocking, so this renders
  // independent of ciState/status -- omitted entirely when nothing was flagged (default) ⇒ byte-identical.
  const nonRequiredFailingChecks = nonRequiredFailingChecksBlock(input.readiness);
  if (nonRequiredFailingChecks && verbosity !== "quiet") {
    blocks.push(details("Flagged checks (non-blocking)", nonRequiredFailingChecks, undefined, collapsiblesOpen));
  }

  // #6067: the old always-rendered 9-row table is split into an always-visible "Decision drivers" list
  // (only rows that can move the verdict) and a collapsed "Context & advisory signals" fold (everything
  // else). Like the table it replaces, NEITHER is gated by `review.comment_verbosity: quiet` -- these are
  // gate-relevant/context signals, not decorative detail (matches the file's existing verbosity contract:
  // only Nits + extraCollapsibles are ever dropped by `quiet`).
  blocks.push(decisionDriverBlock(input, ctx));
  const advisoryBody = advisorySignalsTable(ctx);
  if (advisoryBody) {
    blocks.push(details("Context & advisory signals", advisoryBody, "never blocks the verdict", collapsiblesOpen));
  }

  // Linked-issue satisfaction advisory (#2174): additive, collapsed section — omitted entirely when the host
  // never resolved a result (default) or `review.comment_verbosity: quiet` trims decorative detail, exactly
  // like Nits/extraCollapsibles above. Never affects `status`/the gate verdict.
  const satisfactionBody = linkedIssueSatisfactionBlock(input.linkedIssueSatisfaction);
  if (satisfactionBody && verbosity !== "quiet") {
    blocks.push(details("Linked issue satisfaction", satisfactionBody, undefined, collapsiblesOpen));
  }

  // Threshold-only backtest advisory (#8138): same additive, collapsed-by-default, never-verdict-affecting
  // shape as the linked-issue satisfaction section immediately above. Already-rendered Markdown -- see
  // UnifiedReviewInput.thresholdBacktest's own doc comment for why this module doesn't render it itself.
  const thresholdBacktestBody = input.thresholdBacktest?.trim() ?? "";
  if (thresholdBacktestBody && verbosity !== "quiet") {
    blocks.push(details("Threshold backtest", thresholdBacktestBody, "never blocks the verdict", collapsiblesOpen));
  }

  if (verbosity !== "quiet") {
    for (const c of ctx.extraCollapsibles ?? []) {
      if (c.body.trim()) {
        blocks.push(c.rawHtml ? detailsRaw(c.title, c.body.trim(), collapsiblesOpen) : details(c.title, c.body.trim(), undefined, collapsiblesOpen));
      }
    }
  }

  // Color-coded status legend (key) — a quiet footer mapping each headline color/icon to its meaning, so a
  // reader can tell at a glance what "this PR's status" means. Squares are the SAME ones used in the headline.
  blocks.push(
    `<sub>${STATUS_META.ready.square} Safe / merged · ${STATUS_META.advisory.square} Advisory · ${STATUS_META.held.square} Held for review · ${STATUS_META.blocked.square} Blocked / closed</sub>`,
  );
  if (ctx.footerMarkdown?.trim()) blocks.push(`---\n${ctx.footerMarkdown.trim()}`);

  // Every action checkbox MUST render at top level, OUTSIDE the alert blockquote. GitHub disables interactive
  // task-list checkboxes inside a blockquote (every line `> `-prefixed by asAlert), so a checkbox emitted via
  // asAlert can never be ticked — no issue_comment.edited fires and neither maybeProcessPrPanelRetrigger nor
  // maybeProcessPrPanelGenerateTests (#4589) ever runs. Appending them after the alert keeps each box clickable
  // AND keeps its checked-marker regex matching a non-quoted `- [x] <marker> …` line. The PR_PANEL_COMMENT_MARKER
  // prepended by the bridge still leads the body. Order is re-run first, generate-tests second (#4589) — stable
  // and matches the order the two features shipped in.
  const alerted = asAlert(meta.alert, blocks.join("\n\n"));
  const checkboxLines = [
    ctx.reRunLabel ? `- [ ] ${ctx.reRunLabel}` : null,
    ctx.generateTestsLabel ? `- [ ] ${ctx.generateTestsLabel}` : null,
  ].filter((line): line is string => line !== null);
  return checkboxLines.length > 0 ? `${alerted}\n\n${checkboxLines.join("\n")}` : alerted;
}

/**
 * Build the renderer's input from reviewbot's actual review output, reusing the shared extraction
 * (extractReviewSummary) so the converged comment surfaces exactly the blockers / nits / summary / consensus
 * reviewbot itself decided on — never a divergent second synthesis. The host then supplies its loopover
 * signals/footer in UnifiedCommentContext and calls renderUnifiedReviewComment.
 */
export function buildUnifiedReviewInput(opts: {
  changedFiles: string[] | number;
  reviews: DualReviewNote[];
  readiness?: MergeReadiness;
  decision?: Verdict;
  merged?: boolean;
  verdictReason?: string;
  reviewEffort?: { band: 1 | 2 | 3 | 4 | 5; minutes: number };
  maxFindingsCaps?: { blockers: number | null; nits: number | null };
  linkedIssueSatisfaction?: { status: "addressed" | "partial" | "unaddressed"; rationale: string };
  thresholdBacktest?: string;
  inlineFindings?: ReadonlyArray<{ category?: UnifiedFindingCategory | undefined }>;
  blockerFixContext?: ReadonlyArray<{ path: string; line?: number; body: string }>;
}): UnifiedReviewInput {
  const ex = extractReviewSummary(opts.reviews);
  const changedFiles = typeof opts.changedFiles === "number" ? opts.changedFiles : opts.changedFiles.length;
  return {
    changedFiles,
    reviewerCount: opts.reviews.filter((r) => r.notes).length,
    recommendations: ex.recommendations,
    summary: ex.summary,
    blockers: ex.blockers,
    nits: ex.nits,
    consensusBlocker: ex.consensusBlocker,
    failedCount: ex.failedCount,
    ...(opts.readiness !== undefined ? { readiness: opts.readiness } : {}),
    ...(opts.decision !== undefined ? { decision: opts.decision } : {}),
    ...(opts.merged !== undefined ? { merged: opts.merged } : {}),
    ...(opts.verdictReason !== undefined ? { verdictReason: opts.verdictReason } : {}),
    ...(opts.reviewEffort !== undefined ? { reviewEffort: opts.reviewEffort } : {}),
    ...(opts.maxFindingsCaps !== undefined ? { maxFindingsCaps: opts.maxFindingsCaps } : {}),
    ...(opts.linkedIssueSatisfaction !== undefined ? { linkedIssueSatisfaction: opts.linkedIssueSatisfaction } : {}),
    ...(opts.thresholdBacktest !== undefined ? { thresholdBacktest: opts.thresholdBacktest } : {}),
    ...(opts.inlineFindings !== undefined ? { inlineFindings: opts.inlineFindings } : {}),
    ...(opts.blockerFixContext !== undefined ? { blockerFixContext: opts.blockerFixContext } : {}),
  };
}

// ── Reviewing-in-progress placeholder ────────────────────────────────────────────────────────────
//
// Posted BEFORE the AI review runs so contributors see the bot is actively working rather than
// silent. Uses GitHub's IMPORTANT alert type (purple sidebar) — the one un-used final-state color.
// This is NOT a UnifiedCommentStatus: it is a transient pre-verdict placeholder, not a terminal
// review outcome. The createOrUpdatePrIntelligenceComment upsert replaces it in-place once the
// final verdict is ready. (#reviewing-placeholder)

const REVIEWING_SQUARE = "🟪";

/** Render the transient "🟪 reviewing…" placeholder body. Caller must prepend PR_PANEL_COMMENT_MARKER
 *  before posting so the upsert updates the existing bot comment instead of creating a duplicate.
 *  Pure and public-safe-by-construction (brand is angle-escaped; no raw caller text embedded). */
export function renderReviewingPlaceholder(ctx: { brand?: string } = {}): string {
  const brand = escapePublicHtmlAngles(ctx.brand ?? "LoopOver");
  const inner = [
    REVIEWING_SQUARE.repeat(12),
    `### 🔍 ${brand} is reviewing…`,
    "AI analysis is in progress. This comment will update when the review is complete.",
    `<sub>${STATUS_META.ready.square} Safe / merged · ${STATUS_META.advisory.square} Advisory · ${STATUS_META.held.square} Held for review · ${STATUS_META.blocked.square} Blocked / closed · ${REVIEWING_SQUARE} Reviewing</sub>`,
  ].join("\n\n");
  return asAlert("IMPORTANT", inner);
}

/** Returns true when the reviewing placeholder should be posted before the AI review runs.
 *  Pure helper so both branches are testable without async setup. */
export function shouldPostReviewingPlaceholder(args: { reviewWillRun: boolean; mode: string; willComment: boolean }): boolean {
  return args.reviewWillRun && args.mode === "live" && args.willComment;
}

// ── CI-wait placeholder ──────────────────────────────────────────────────────────────────────────
//
// #9042 — posted the FIRST time a PR defers waiting on CI, before readiness is even reached (i.e. before
// the reviewing-in-progress placeholder above ever gets a chance to run, since that one only fires once
// prReadyForReview has already returned true). Without this, a PR waiting on CI got NO surface at all --
// measured live: median 8.3min / p90 21.9min / max 50.9min with zero visible trace, which trained a
// maintainer to merge by hand rather than wait for a bot that looked like it was ignoring the PR (#8944:
// a maintainer merged during exactly this silent window, and CI then failed). Shares the SAME
// PR_PANEL_COMMENT_MARKER as the reviewing placeholder and the final verdict comment, so
// createOrUpdatePrIntelligenceComment's upsert-by-marker naturally REPLACES this placeholder the moment
// either of those posts -- "updated, not duplicated" falls out of the existing upsert primitive for free,
// the same way the reviewing placeholder above already relies on it.
const WAITING_SQUARE = "🟨";

/** Render the transient "waiting on CI" placeholder body. Caller must prepend PR_PANEL_COMMENT_MARKER
 *  before posting, exactly like {@link renderReviewingPlaceholder}. `reason` is a short, already-public-safe
 *  phrase (no raw external text) naming what ORB is waiting on -- e.g. "CI checks to finish" or "a required
 *  CI check that has not started yet". Pure. */
export function renderWaitingForCiPlaceholder(ctx: { reason: string; brand?: string }): string {
  const brand = escapePublicHtmlAngles(ctx.brand ?? "LoopOver");
  const reason = escapePublicHtmlAngles(ctx.reason);
  const inner = [
    WAITING_SQUARE.repeat(12),
    `### ⏳ ${brand} is waiting…`,
    `${brand} has seen this pull request and is waiting on ${reason} before reviewing it. This comment will update once the review runs.`,
    `<sub>${STATUS_META.ready.square} Safe / merged · ${STATUS_META.advisory.square} Advisory · ${STATUS_META.held.square} Held for review · ${STATUS_META.blocked.square} Blocked / closed · ${WAITING_SQUARE} Waiting</sub>`,
  ].join("\n\n");
  return asAlert("IMPORTANT", inner);
}
