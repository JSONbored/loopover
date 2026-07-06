// Unified PR review comment renderer (convergence — see docs/GITTENSORY_REVIEW_UNIFIED_COMMENT.md).
//
// Produces ONE in-place comment in the gittensory SHAPE (colored alert sidebar + readiness
// signal table + collapsibles + re-run + earning footer) with reviewbot's deep review folded
// in (the verdict, the synthesized summary, a "Code review" signal row, nits/blockers), deduped.
//
// ADDITIVE + DORMANT: the live Worker keeps composeUnifiedReview() (advisory-render.ts). This
// renderer is exposed via engine.ts for the host (the gittensory app) to call at cutover — it is
// a PURE function (no I/O, no redaction). The host applies its public-safe redaction AFTER, the
// same way the runtime does today (makePublicRedactor / redactOutsideCodeFences).
//
// The host provides gittensory's readiness signals + footer + collapsibles in UnifiedCommentContext;
// reviewbot's review data comes in UnifiedReviewInput. The whole comment recolors by one unified
// status so there is a single authoritative verdict, never two.
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence): every type + helper this module
// needs is defined HERE. No imports from reviewbot. The logic is byte-faithful to the reviewbot
// source (src/core/unified-comment-render.ts + src/core/advisory-render.ts); the only deltas are
// mechanical guards for gittensory's stricter tsconfig (noUncheckedIndexedAccess +
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
  ciState: "passed" | "failed" | "unverified";
  failingChecks?: string[];
  failingDetails?: CheckFailureDetail[];
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

/** Case-insensitive de-dup of concern lines (two reviewers often raise the same point). Preserves first wording. */
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
  return out.slice(0, 20);
}

export function extractReviewSummary(reviews: DualReviewNote[]): ExtractedReviewSummary {
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
}

/** One row of the readiness signal table (gittensory side, host-provided; the engine adds Code review). */
export interface UnifiedSignalRow {
  label: string;
  state: "ok" | "warn" | "fail";
  /** Short result text, e.g. "Linked", "25/25". */
  result?: string;
  /** Evidence cell, e.g. "#1372". */
  evidence?: string;
}

/** A collapsed section (gittensory side: signal definitions, contributor next steps, …). */
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
  /** The Gittensory gate is passing (no hard blocker). */
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

/** The host (gittensory) side: brand, readiness score, signals, sections, re-run, footer. */
export interface UnifiedCommentContext {
  /** Headline brand, default "Gittensory review". */
  brand?: string;
  /** gittensory readiness score 0–100 (omitted = no chip). */
  readinessScore?: number;
  /** gittensory readiness signal rows (rendered after the Code review row). */
  signals?: UnifiedSignalRow[];
  /** Extra collapsed sections (rendered after Nits). */
  extraCollapsibles?: UnifiedCollapsible[];
  /** Re-run checkbox label, e.g. "Re-run Gittensory review" (omitted = no checkbox). */
  reRunLabel?: string;
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

const SIGNAL_ICON: Record<UnifiedSignalRow["state"], string> = { ok: "✅", warn: "⚠️", fail: "❌" };

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
  // Readiness is otherwise advisory for the Gittensory verdict. A PR is not "safe to merge" until CI is green,
  // but pending/unverified CI should hold rather than create a red/blocked Gittensory decision by itself.
  if (status === "ready" && input.readiness && input.readiness.ciState !== "passed") {
    return "held";
  }
  // Merge-state readiness follows the same rule: do not claim "safe to merge" while GitHub says the branch is
  // dirty/behind, but keep the comment in a held/advisory tone instead of turning readiness into a blocker.
  // Other states — clean, a not-yet-computed `unknown`, or a `blocked` that the bot's own pending approval will clear — do not downgrade.
  // (#ready-needs-mergeable)
  if (status === "ready" && input.readiness?.mergeStateLabel) {
    const mergeState = input.readiness.mergeStateLabel.toLowerCase();
    if (mergeState === "dirty" || mergeState === "behind") return "held";
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
  if (status === "ready" && ctx.preflightHeld) return "held";
  // Held-vs-closed disposition parity (#8/#9): owner/automation-bot authors may be exempt from auto-close, so a
  // close verdict on those authors is rendered as held. Guardrail holds are handled above only for otherwise-ready
  // PRs; they must not downgrade a blocker/close verdict to manual review.
  if (input.decision === "close") {
    if (ctx.neverClosed) return "held";
  }
  return status;
}

function headlineLabel(status: UnifiedCommentStatus, input: UnifiedReviewInput, ctx: UnifiedCommentContext): string {
  switch (status) {
    case "ready":
      return "approve/merge recommended";
    case "advisory":
      return "advisory review";
    case "held":
      return "manual review recommended";
    case "blocked":
      return input.decision === "close" && !ctx.neverClosed ? "reject/close recommended" : "fixes required";
  }
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

function statusChips(input: UnifiedReviewInput, ctx: UnifiedCommentContext): string {
  const chips: string[] = [`\`${plural(input.changedFiles, "file")}\``];
  if (input.reviewerCount > 0) chips.push(`\`${plural(input.reviewerCount, "AI reviewer")}\``);
  const blockerCount = (input.blockers ?? []).length;
  chips.push(blockerCount ? `\`${plural(blockerCount, "blocker")}\`` : "`no blockers`");
  if (typeof ctx.readinessScore === "number") chips.push(`\`readiness ${Math.round(ctx.readinessScore)}/100\``);
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

function verdictLine(status: UnifiedCommentStatus, input: UnifiedReviewInput, ctx: UnifiedCommentContext): string {
  const icon = STATUS_META[status].icon;
  const reasons = (defaultReason?: string) => {
    const raw = input.verdictReason?.trim() || defaultReason?.trim() || "";
    return raw ? `\n${actionReasonBullets(raw)}` : "";
  };
  switch (status) {
    case "ready":
      return input.merged
        ? `**${icon} Suggested Action - Approve/Merge**${reasons("auto-merged")}`
        : `**${icon} Suggested Action - Approve/Merge**${reasons("safe to merge")}`;
    case "advisory":
      return `**${icon} Suggested Action - Advisory Only**${reasons("no action taken")}`;
    case "held":
      return `**${icon} Suggested Action - Manual Review**${reasons()}`;
    case "blocked":
      if (ctx.neverClosed) {
        return `**${icon} Suggested Action - Manual Review**${reasons()}`;
      }
      if (input.decision === "close" && !ctx.neverClosed) {
        return `**${icon} Suggested Action - Reject/Close**${reasons()}`;
      }
      return `**${icon} Suggested Action - Fix Blockers**${reasons()}`;
  }
}

/** Dedupe + cap a list of lines (case-insensitive), so blockers/nits never balloon the comment. */
function dedupeLines(items: string[], cap = 12): string[] {
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

function signalTable(input: UnifiedReviewInput, ctx: UnifiedCommentContext): string {
  const blockerCount = (input.blockers ?? []).length;
  const reviewerEvidence =
    input.reviewerCount > 1
      ? `${input.reviewerCount} reviewers, synthesized`
      : input.reviewerCount === 1
        ? "1 reviewer"
        : "No AI review summary";
  const codeRow: UnifiedSignalRow = {
    label: "Code review",
    state: blockerCount ? "fail" : "ok",
    result: blockerCount ? plural(blockerCount, "blocker") : "No blockers",
    evidence: reviewerEvidence,
  };
  const rows = [codeRow, ...(ctx.signals ?? [])];
  const lines = rows.map((r, i) => {
    const labelText = escapePublicHtmlAngles(r.label);
    const label = i === 0 ? `**${labelText}**` : labelText;
    const resultText = r.result ? ` ${escapePublicHtmlAngles(r.result)}` : "";
    const result = `${SIGNAL_ICON[r.state]}${resultText}`;
    return `| ${label} | ${result} | ${escapePublicHtmlAngles(r.evidence ?? "")} |`;
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
export function renderUnifiedReviewComment(input: UnifiedReviewInput, ctx: UnifiedCommentContext = {}): string {
  const status = deriveUnifiedStatus(input, ctx);
  const meta = STATUS_META[status];
  const brand = escapePublicHtmlAngles(ctx.brand ?? "Gittensory review");
  const reviewTimestamp = formatReviewTimestamp(ctx.reviewedAt);
  // review.comment_verbosity (#2047): quiet drops every collapsible (Nits + extraCollapsibles) — blockers,
  // the gate result, and the signal table are never gated by verbosity, only decorative detail is. detailed
  // renders every collapsible pre-expanded. normal/unset ⇒ byte-identical to today.
  const verbosity = ctx.commentVerbosity ?? "normal";
  const collapsiblesOpen = verbosity === "detailed";

  const blocks: string[] = [
    meta.square.repeat(12),
    `### ${meta.icon} ${brand} result - ${headlineLabel(status, input, ctx)}${status === "ready" && input.merged ? " · auto-merged" : ""}`,
    ...(reviewTimestamp ? [`<sub>Review updated: ${reviewTimestamp}</sub>`] : []),
    statusChips(input, ctx),
    verdictLine(status, input, ctx),
  ];

  if (input.summary.trim()) blocks.push(`**Review summary**\n${escapePublicHtmlAngles(input.summary.trim())}`);

  const nitsAll = dedupeLines(input.nits ?? []);
  const nitsTrunc = truncateFindingsForDisplay(nitsAll, input.maxFindingsCaps?.nits);
  if (nitsAll.length && verbosity !== "quiet") {
    const nitsBody = nitsTrunc.shown.length
      ? appendMoreFooter(taskList(nitsTrunc.shown), nitsTrunc.hiddenCount)
      : `_+${nitsTrunc.hiddenCount} more_`;
    blocks.push(details("Nits", nitsBody, `${nitsAll.length} non-blocking`, collapsiblesOpen));
  }

  const blockersAll = dedupeLines(input.blockers ?? []);
  const blockersTrunc = truncateFindingsForDisplay(blockersAll, input.maxFindingsCaps?.blockers);
  if (blockersAll.length) {
    const heading = status === "blocked" ? "Why this is blocked" : "Concerns raised — review before merging";
    const blockersBody = blockersTrunc.shown.length
      ? appendMoreFooter(bullets(blockersTrunc.shown), blockersTrunc.hiddenCount)
      : `_+${blockersTrunc.hiddenCount} more_`;
    blocks.push(`**${heading}**\n${blockersBody}`);
  }

  // Failing CI checks — list WHICH checks failed and WHY (codecov %/test/lint reason) under the "CI failing"
  // chip, instead of leaving the chip as the only signal. Only when CI actually failed (failingChecksBlock
  // guards on ciState === "failed"); public-safe (names + short reasons only).
  const failingChecks = failingChecksBlock(input.readiness);
  if (failingChecks) blocks.push(`**CI checks failing**\n${failingChecks}`);

  blocks.push(signalTable(input, ctx));

  // Linked-issue satisfaction advisory (#2174): additive, collapsed section — omitted entirely when the host
  // never resolved a result (default) or `review.comment_verbosity: quiet` trims decorative detail, exactly
  // like Nits/extraCollapsibles above. Never affects `status`/the gate verdict.
  const satisfactionBody = linkedIssueSatisfactionBlock(input.linkedIssueSatisfaction);
  if (satisfactionBody && verbosity !== "quiet") {
    blocks.push(details("Linked issue satisfaction", satisfactionBody, undefined, collapsiblesOpen));
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

  // The re-run checkbox MUST render at top level, OUTSIDE the alert blockquote. GitHub disables interactive
  // task-list checkboxes inside a blockquote (every line `> `-prefixed by asAlert), so a checkbox emitted via
  // asAlert can never be ticked — no issue_comment.edited fires and maybeProcessPrPanelRetrigger never runs.
  // Appending it after the alert keeps the box clickable AND keeps the checked-marker regex matching a non-
  // quoted `- [x] <marker> …` line. The PR_PANEL_COMMENT_MARKER prepended by the bridge still leads the body.
  const alerted = asAlert(meta.alert, blocks.join("\n\n"));
  return ctx.reRunLabel ? `${alerted}\n\n- [ ] ${ctx.reRunLabel}` : alerted;
}

/**
 * Build the renderer's input from reviewbot's actual review output, reusing the shared extraction
 * (extractReviewSummary) so the converged comment surfaces exactly the blockers / nits / summary / consensus
 * reviewbot itself decided on — never a divergent second synthesis. The host then supplies its gittensory
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
  const brand = escapePublicHtmlAngles(ctx.brand ?? "Gittensory");
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
