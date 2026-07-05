import type { AgentActionClass, AutoMaintainPolicy, AutoMergeMethod, AutonomyPolicy } from "../types";
import { AI_JUDGMENT_BLOCKER_CODES, type GateCheckConclusion } from "../rules/advisory";
import { DEFAULT_AUTO_MAINTAIN_POLICY, autonomyRequiresApproval, isActingAutonomyLevel, resolveAutonomy } from "./autonomy";
import { changedPathsHittingGuardrail, isGuardrailHit } from "../signals/change-guardrail";
import { AGENT_LABEL_PENDING_CLOSURE } from "../review/linked-issue-hard-rules";
import { sanitizePublicComment } from "../github/commands";

// High-slop threshold default when a repo hasn't set slopGateMinScore (mirrors the gate's `high` band).
const DEFAULT_SLOP_GATE_MIN_SCORE = 60;

// The maintainer auto-maintain decision layer (#778): given the gate verdict + the PR's current state + the
// repo's autonomy config, decide which GitHub state actions to take. PURE and deterministic — the executor
// owns the gate stack (mode / permission / auth) and the actual GitHub mutation. Conservative by design:
// every action is independently gated by its own autonomy class, and the irreversible ones (merge / close)
// demand strong positive signals.


// The bucket labels the layer applies to reflect the gate verdict. These are generic fallbacks only; self-host
// operators can rename or disable them via config-as-code so engine behavior never depends on project-specific
// `gittensory:*` labels.
export const AGENT_LABEL_READY = "ready-to-merge";
export const AGENT_LABEL_CHANGES = "changes-requested";
// Default label applied to a blacklisted contributor's PR (#1425). NOT hardcoded into the action — it is
// configurable per-repo via `.gittensory.yml` (`settings.blacklistLabel`); the planner uses the resolved label
// and falls back to this default, so the disposition works regardless of the label a repo sets.
export const DEFAULT_BLACKLIST_LABEL = "slop";
// Default label applied to a PR/issue closed for exceeding the per-contributor open-item cap (#2270). Same
// configurable-with-fallback shape as DEFAULT_BLACKLIST_LABEL — a repo can override it via
// `.gittensory.yml` (`settings.contributorCapLabel`); this is only the fallback when unset.
export const DEFAULT_CONTRIBUTOR_CAP_LABEL = "over-contributor-limit";
// Default label applied to a PR closed for review-nag cooldown (#2463). NOT hardcoded into the action — it is
// configurable per-repo via `.gittensory.yml` (`settings.reviewNagLabel`); the planner uses the resolved label
// and falls back to this default, mirroring DEFAULT_BLACKLIST_LABEL's shape.
export const DEFAULT_REVIEW_NAG_LABEL = "review-nag-cooldown";
// Default label applied to a PR re-closed for review-evasion (#review-evasion-protection): a contributor
// closing/converting-to-draft their own PR while an active review pass is running. NOT hardcoded -- a repo
// can override it via `.gittensory.yml` (`settings.reviewEvasionLabel`); this is only the fallback when unset.
// Applied by the direct webhook-driven enforcement handlers in queue/processors.ts, which bypass the planner
// (mirroring the existing draft-dodge/reopen-reclose guards' shape), so it is not consumed by
// planAgentMaintenanceActions -- it lives alongside its siblings here purely for discoverability.
export const DEFAULT_REVIEW_EVASION_LABEL = "review-evasion";
// Keep the review-nag lookback operationally bounded so repo-controlled config cannot overflow Date arithmetic.
export const MAX_REVIEW_NAG_COOLDOWN_DAYS = 365;
// Default label for a PR that PASSES the gate but is intentionally held for manual review. This is only the
// fallback; self-host operators can set `settings.manualReviewLabel` (or null to disable the label) while the
// guardrail hold itself remains enforced by `settings.hardGuardrailGlobs`.
export const AGENT_LABEL_NEEDS_REVIEW = "manual-review";
// A PR that touches migrations/** and would otherwise auto-merge, but a LIVE recheck against the current tip
// of the base branch found a migration-number collision with a sibling PR merged since this PR's CI last ran
// (#2550). Distinct from AGENT_LABEL_NEEDS_REVIEW so an operator can filter/alert on this specific, proven-
// recurring failure mode separately from an ordinary guardrail hold.
export const AGENT_LABEL_MIGRATION_COLLISION = "migration-collision";

// Maintainer-managed automation accounts whose PRs are never auto-closed. A recurring accumulator (e.g.
// github-actions[bot] opening automation/readme-refresh) or a dependency PR must not be killed by a duplicate
// or slop heuristic — the maintainer owns its lifecycle. (reviewbot wrongly auto-closed such an accumulator,
// awesome-claude #4192.) Still eligible for auto-merge when clean + passing.
const PROTECTED_AUTOCLOSE_AUTHORS = new Set(["github-actions[bot]", "dependabot[bot]", "renovate[bot]"]);
export function isProtectedAutomationAuthor(login: string | null | undefined): boolean {
  return login != null && PROTECTED_AUTOCLOSE_AUTHORS.has(login.toLowerCase());
}

export type PlannedAgentAction = {
  actionClass: AgentActionClass;
  // #label-scoping: the autonomy class that actually AUTHORIZED this action, when it differs from `actionClass`
  // (a `label` action can be authorized by `close` — an anti-abuse enforcement label inseparable from its
  // close — or by `review_state_label` — the planner's own disposition-communication labels — rather than the
  // generic `label` class). The executor's durable-pending-approval re-check MUST resolve autonomy via this
  // field (falling back to `actionClass` when absent) so a later re-check re-verifies the SAME class the
  // planner actually used, not a stale/unrelated `label` dial. Absent for every non-`label` action class, where
  // `actionClass` already IS the governing autonomy class.
  autonomyClass?: AgentActionClass;
  // auto_with_approval → the action is staged for a human approval (the #779 queue) instead of executing now.
  requiresApproval: boolean;
  reason: string;
  // Action-specific payload (only the field for this actionClass is set):
  label?: string;
  // For a `label` action: whether to ADD (default) or REMOVE the label. The flag-then-close double-check adds
  // the pending-closure label on Pass 1 and removes it when the violation resolves; all other label actions add.
  labelOp?: "add" | "remove";
  // For a `label` action: an OPTIONAL issue comment posted alongside the label mutation (the flag-then-close
  // warning on Pass 1, or the "resolved" note on flag-clear). Kept on the `label` action so the flag uses the
  // already-held Issues-API `label` autonomy class (no new action class / no write-permission gate).
  comment?: string;
  reviewBody?: string;
  mergeMethod?: AutoMergeMethod;
  closeComment?: string;
  // For a `close` action: the individual reasons that justified closure. `reason` stays as the flat,
  // human-readable summary for legacy callers/public notification text; this structured list is persisted into
  // audit metadata so a close caused by multiple independent signals remains historically reconstructable.
  closeReasons?: string[];
  // For a `close` action: WHICH kind of close this is, so the close-precision circuit-breaker can scope itself.
  // "linked-issue-hard-rule" = the DETERMINISTIC flag-then-close state machine (zero hallucination risk — and on
  // the verify path it posts a comment PROMISING closure); "heuristic" = a verdict-driven close (gate-verdict /
  // duplicate / slop / CI). The breaker downgrades ONLY "heuristic" closes; the deterministic close is EXEMPT
  // (silently holding a close whose comment already promised closure would be incoherent). Absent on non-close
  // actions; treated as a heuristic close only when explicitly tagged "heuristic".
  // ALSO set on a `label` action that is inseparable metadata on a close of this SAME kind in the same planned
  // batch (blacklist/contributor_cap/review_nag) — the executor correlates the two by this value so the label
  // is only actually applied when its paired close didn't get denied/error (#label-close-split-brain: `label`
  // mutates via the Issues API and is exempt from the PR-write-permission gate `close` must pass, so without
  // this correlation a transient write-permission denial could leave a PR mislabeled "closed for X" while it
  // is, in fact, still open).
  closeKind?: "linked-issue-hard-rule" | "blacklist" | "contributor_cap" | "review_nag" | "heuristic";
  // For a CI-driven heuristic close, the CI state that must still hold at actuation time. Other heuristic
  // closes (gate verdict, duplicate/slop, conflict) do not depend on red CI and must not be blocked by green CI.
  // ALWAYS set for a heuristic close (never omitted) -- see the field's doc comment on AgentPendingActionParams
  // in types.ts for why the tri-state (rather than an optional "failed") matters (#2478).
  closeRequiresCiState?: "failed" | "not_required";
  // True when a base conflict was part of this close's justification -- see the doc comment on
  // AgentPendingActionParams in types.ts for why the approval queue's accept-time recheck is scoped to this
  // specific case rather than every non-CI heuristic close. ALWAYS set for a heuristic close (never omitted).
  closeRequiresMergeableState?: boolean;
  // For a "heuristic" close: true when the close is backed by CONCRETE, non-judgment evidence — a committed
  // secret, a failing/red CI run, a base conflict, a deterministic linked-issue-overlap duplicate, or a
  // rule-based lane/manifest/pre-merge rejection — rather than any AI/model-derived verdict or a fuzzy score.
  // The close-precision circuit-breaker (downgradeCloseToHold) EXEMPTS a concrete-evidence close: it only
  // exists to catch the class of error where a heuristic call turned out to be wrong, and a committed secret
  // or a red CI run is not a plausible false positive. An AI verdict — even a dual-model CONSENSUS — is
  // deliberately NOT concrete: two models agreeing is still a judgment call, not deterministic evidence, and a
  // systematically wrong AI-driven close is exactly the failure mode this breaker exists to catch (gate review
  // finding, round 2 — an AI-only blocker must not bypass its own precision safety net). Absent/false ⇒ the
  // close stays subject to the breaker like any other heuristic close (the conservative default).
  closeConcreteEvidence?: boolean;
  expectedHeadSha?: string;
  // For an `approve` action: retract the bot's own prior approval instead of posting a new one — a later commit
  // no longer qualifies for approval, but the PR isn't merging or closing this pass, so the stale APPROVE
  // (which still counts toward a "require approving reviews" branch-protection rule) must not be left in place.
  // (#2254)
  dismissStaleApproval?: boolean;
  // For an `assign` action (#3182): the login to set as the PR's GitHub assignee -- the PR's own opening
  // contributor. GitHub silently drops an assignee lacking push/triage access rather than erroring, so the
  // executor falls back to a per-login label when the real assignment doesn't stick.
  assignee?: string;
};

// Gate-blocker codes backed by CONCRETE, non-judgment evidence: a committed secret, a deterministic
// linked-issue-overlap duplicate, or a rule-based content/surface-lane or manifest/pre-merge rejection — every
// entry here is produced by an exact match / regex / deterministic rule, never by a model's output. NO AI- or
// model-derived code belongs in this set, no matter how the verdict was reached (including a dual-model
// CONSENSUS): the close-precision breaker exists specifically to catch a systematically-wrong AI/heuristic
// judgment, and an AI-only blocker that could bypass its own precision safety net would defeat the point (gate
// review finding, round 2 — `ai_consensus_defect` was wrongly included here and has been removed; both
// `ai_consensus_defect` and `ai_review_split` stay fully subject to the breaker, defended below by explicitly
// excluding advisory.ts's own AI_JUDGMENT_BLOCKER_CODES so this can't silently regress). Kept here (not in
// rules/advisory.ts) because "which findings are trustworthy enough to survive the breaker" is a
// disposition-planning concern, not a gate-evaluation one — the set of finding codes is itself generic
// self-host engine vocabulary (src/rules/advisory.ts), not specific to any one repository. Every entry is a
// plain string literal, deliberately NOT imported from its producer's own exported constant (even where one
// exists, e.g. advisory.ts's DUPLICATE_ONLY_BLOCKER_CODES / pre-merge-checks.ts's PRE_MERGE_CHECK_BLOCKING_CODE):
// this module sits inside a real module-load cycle
// (scoring/model.ts -> db/repositories.ts -> agent-actions.ts -> advisory.ts -> scoring/preview.ts ->
// scoring/model.ts), and spreading/reading another module's export INTO A TOP-LEVEL ARRAY LITERAL evaluates it
// eagerly at module-load time, before that module has necessarily finished initializing on this cycle's first
// pass -- confirmed by a real "X is not iterable" failure when that was tried. A plain literal has no such
// hazard. A source-text parity test in the test file below guards all nine against producer-side drift instead.
const CONCRETE_EVIDENCE_BLOCKER_CODES = new Set<string>([
  "secret_leak",
  "duplicate_pr_risk",
  "surface_lane_reject",
  "manifest_missing_tests",
  "manifest_linked_issue_required",
  "pre_merge_check_required",
  "lockfile_tamper_risk",
  "missing_linked_issue",
  "self_authored_linked_issue",
]);

/** True when a would-CLOSE is justified by at least one piece of concrete, non-judgment evidence: red CI, a
 *  base conflict, a deterministic duplicate-PR link, or a gate-blocker code in {@link CONCRETE_EVIDENCE_BLOCKER_CODES}.
 *  Mixed blockers (one concrete + one ambiguous) still count as concrete — the concrete signal alone already
 *  justifies the close regardless of what else is present. Defensively excludes advisory.ts's own
 *  {@link AI_JUDGMENT_BLOCKER_CODES} even though none should ever land in CONCRETE_EVIDENCE_BLOCKER_CODES — a
 *  belt-and-suspenders guard against exactly the regression a gate review already caught once (`ai_consensus_defect`
 *  wrongly classified as concrete). */
function hasConcreteCloseEvidence(input: AgentActionPlanInput, ciFailed: boolean, isConflict: boolean): boolean {
  if (ciFailed || isConflict) return true;
  if ((input.pr.linkedDuplicateCount ?? 0) > 0) return true;
  return (input.gateBlockerCodes ?? []).some((code) => CONCRETE_EVIDENCE_BLOCKER_CODES.has(code) && !AI_JUDGMENT_BLOCKER_CODES.has(code));
}

export type AgentActionPlanInput = {
  conclusion: GateCheckConclusion;
  blockerTitles: string[];
  // The gate's blocking finding CODES (parallel to blockerTitles). Retained for compatibility/telemetry; blocker
  // findings remain blocking and are not refuted by green CI in the disposition planner.
  gateBlockerCodes?: string[] | undefined;
  // Historical compatibility flag for the removed green-CI AI refutation path. Ignored by the planner; a configured
  // blocker remains a blocker regardless of this value.
  aiCiRefutationEnabled?: boolean | undefined;
  autonomy: AutonomyPolicy | null | undefined;
  // Optional so the trigger can pass raw repo settings; both fall back to conservative defaults here.
  autoMaintain?: AutoMaintainPolicy | undefined;
  slopGateMinScore?: number | null | undefined;
  // Convergence safety (hard-guardrail port, #4196 incident class): the PR's changed paths + the repo's
  // hard-guardrail globs. Any changed path matching a guardrail glob forces MANUAL review only for otherwise
  // review-good PRs; blockers, red CI, and base conflicts still close for close-eligible contributors.
  changedPaths: string[];
  hardGuardrailGlobs: string[];
  // Configured manual-review hold label. Undefined uses the default "manual-review"; null disables only the
  // label, not the guardrail hold. Separate from review_state_label so operators can avoid ready/changes labels.
  manualReviewLabel?: string | null | undefined;
  // Optional disposition label overrides. Undefined uses generic defaults; null disables that specific label.
  readyToMergeLabel?: string | null | undefined;
  changesRequestedLabel?: string | null | undefined;
  migrationCollisionLabel?: string | null | undefined;
  pendingClosureLabel?: string | null | undefined;
  // True when the PR author is the repo owner (e.g. JSONbored). Standing rule: owner PRs are NEVER
  // auto-closed. They may still auto-merge when clean + passing.
  authorIsOwner: boolean;
  // True when the PR author is a fleet-operator login (env ADMIN_GITHUB_LOGINS) that is NOT the literal repo
  // owner (#2133). This is the same trusted-operator identity already honored by the reopen-reclose path's
  // hasMaintainerPermission — folded in here so it isn't a second, drifting definition of "maintainer". Treated
  // identically to authorIsOwner throughout this planner (never auto-closed by default; auto-close only when
  // closeOwnerAuthors is on).
  authorIsAdmin: boolean;
  // True when the PR author is a maintainer-managed automation account (e.g. github-actions[bot] opening an
  // accumulator like automation/readme-refresh, or dependabot/renovate). These are NEVER auto-closed — a noise
  // heuristic (duplicate/slop) must not kill a recurring maintainer-managed PR. They may still auto-merge.
  authorIsAutomationBot: boolean;
  // Per-repo toggle (#configurable-owner-close): when TRUE, the repo OWNER's own PRs (and admin-authored PRs,
  // #2133) are eligible for auto-close like a contributor's (still gated by the `close` autonomy class +
  // adverse-signal conditions). Default/undefined ⇒ owner/admin PRs are exempt (merge or manual-hold only).
  // Automation-bot PRs stay exempt regardless.
  closeOwnerAuthors?: boolean | undefined;
  // Live CI aggregate over ALL of the PR's checks — required OR not, including non-required ones like
  // codecov/patch and every commit-status (reviewbot parity). "passed" = every check completed and none
  // failed; "failed" = at least one check failed; "pending" = at least one check still running; "unverified"
  // = no checks reported (or CI can't be verified, e.g. a fork PR whose workflows await approval). The
  // disposition layer NEVER approves/merges unless "passed", CLOSES a non-owner PR on "failed" (citing the
  // failing checks) / HOLDS the owner's, and DEFERS every action while "pending" (settle-before-decide — the
  // check-completion webhook re-runs this planner once CI settles).
  ciState: "passed" | "failed" | "pending" | "unverified";
  // True when any visible CI check/status is still queued or in progress, even when branch protection lets
  // ciState stay "passed" because the pending context is non-required. The planner must still settle first.
  ciHasPending?: boolean | undefined;
  // The names of the failing checks, surfaced in the close/request-changes reason so the contributor knows
  // WHY (e.g. "codecov/patch"). Empty unless ciState === "failed".
  failingCheckNames?: string[] | undefined;
  // Historical compatibility field. Red CI now closes close-eligible contributors regardless of branch-protection
  // membership because any visible completed red check/status is adverse.
  ciRequiredContextsVerified?: boolean | undefined;
  // Linked-issue HARD-RULE result (#linked-issue-hard-rules). A DETERMINISTIC verdict about the issue(s) this PR
  // links (owner-assigned / missing point-label / maintainer-only), pre-computed by the trigger. When
  // `violated`, a CONTRIBUTOR PR is one-shot CLOSED citing `reason` — and because it is deterministic (no
  // hallucination risk), that close fires REGARDLESS of a hard-guardrail path hit (the guard exists only for
  // AI verdicts). It still NEVER fires for the owner or automation bots (the `isContributor` guard). Absent /
  // not-violated ⇒ no effect.
  linkedIssueHardRule?: { violated: boolean; reason: string | null } | undefined;
  // Contributor blacklist (#1425, anti-abuse): when the PR author is on the resolved blacklist (per-repo ∪
  // global), the disposition SHORT-CIRCUITS to a deterministic close ahead of ALL merit/CI/AI analysis — the
  // banned account never gets merit-reviewed or auto-merged. Zero-hallucination (not an AI judgment), so its
  // close is tagged separately (closeKind "blacklist"). Fires for a CONTRIBUTOR only
  // (owner/automation bots are never auto-closed). `reason` is private maintainer metadata used only for matching
  // context; the public close comment intentionally uses static copy. Absent / not-matched ⇒ no effect.
  blacklistMatch?: { matched: boolean; reason: string | null | undefined } | undefined;
  // The repo-configured label applied to a blacklisted author's PR (#1425), resolved from `.gittensory.yml`.
  // Absent ⇒ the default (`DEFAULT_BLACKLIST_LABEL` = "slop"); explicit `null` ⇒ close WITHOUT any label
  // (#label-scoping). Gated on `close` autonomy, NOT `label` (see the `blacklistMatch` block below) — the
  // label is inseparable metadata on the close, never applied independently.
  blacklistLabel?: string | null | undefined;
  // Per-contributor open-PR/open-issue cap (#2270, anti-abuse): when the incoming PR pushes its author over the
  // repo's configured `contributorOpenPrCap`, the disposition SHORT-CIRCUITS to a deterministic label + close
  // ahead of ALL merit/CI/AI analysis — same zero-hallucination shape as blacklistMatch, so its close is tagged
  // `closeKind: "contributor_cap"` (immune to the close-precision breaker like blacklist/linked-issue-hard-rule).
  // Fires for a CONTRIBUTOR only (owner/admin/automation bots are NEVER auto-closed by this). `openCount` and
  // `cap` are PUBLIC (the author's own open-item count on a public repo, and the repo's own configured limit),
  // so — unlike the blacklist's private-reason close — they ARE interpolated into the public close comment.
  // `itemKind` selects the close-comment noun ("pull requests" for the PR-path caller, "issues" for the
  // issue-path caller, #2270) — REQUIRED (not defaulted) so a caller can't silently mislabel the other kind.
  // "pull requests and issues" (#2562) is for the install-wide globalContributorOpenItemCap, whose count sums
  // BOTH kinds across the install — a single-kind label there would misstate a mixed-kind contributor's count.
  // `scope` (#2562) selects the close-comment's cap description: "repository" (default when absent, back-compat
  // for every existing per-repo caller) says "this repository's configured limit"; "install" says "across every
  // repository this install gates, combined" for the install-wide globalContributorOpenItemCap. Same closeKind
  // ("contributor_cap") and label either way — this is a description-only distinction, not a new disposition.
  contributorCapMatch?: { matched: boolean; authorLogin: string; openCount: number; cap: number; itemKind: "pull requests" | "issues" | "pull requests and issues"; scope?: "repository" | "install" | undefined } | undefined;
  // The repo-configured label applied to an over-cap author's PR/issue (#2270), resolved from `.gittensory.yml`.
  // Absent ⇒ the default (`DEFAULT_CONTRIBUTOR_CAP_LABEL` = "over-contributor-limit"); explicit `null` ⇒ close
  // WITHOUT any label (#label-scoping). Gated on `close` autonomy, NOT `label` — same shape as {@link blacklistLabel}.
  contributorCapLabel?: string | null | undefined;
  // Review-nag cooldown (#2463, anti-abuse): when the PR author has pinged `@gittensory` past the repo's
  // configured threshold within the cooldown window AND the repo's `reviewNagPolicy` is `"close"`, the
  // disposition SHORT-CIRCUITS to a deterministic label + close ahead of ALL merit/CI/AI analysis — same
  // zero-hallucination shape as blacklistMatch, so its close is tagged `closeKind: "review_nag"`. Fires for a
  // CONTRIBUTOR only (owner/admin/automation bots are never auto-closed). The comment-throttle decision itself
  // (counting pings, choosing hold vs. close) happens at the webhook trigger, not here — this input is already
  // the resolved "yes, close this PR" verdict. Absent / not-matched ⇒ no effect.
  reviewNagMatch?: { matched: boolean; authorLogin: string; pingCount: number; maxPings: number } | undefined;
  // The repo-configured label applied to a review-nag-closed PR (#2463), resolved from `.gittensory.yml`.
  // Absent ⇒ the default (`DEFAULT_REVIEW_NAG_LABEL` = "review-nag-cooldown"); explicit `null` ⇒ close WITHOUT
  // any label (#label-scoping). Gated on `close` autonomy, NOT `label` — same shape as {@link blacklistLabel}.
  reviewNagLabel?: string | null | undefined;
  // Flag-then-close double-check for the linked-issue hard rule (#linked-issue-verify-before-close). When
  // `verifyBeforeClose` is true (the default), a violation FLAGS the PR (pending-closure label + warning comment)
  // on first detection and only CLOSES on a LATER evaluation when the violation STILL holds AND the PR already
  // carries the pending-closure label (a label-based two-pass state machine). When false, the close fires
  // immediately (the original GAP-5 behavior). Absent ⇒ immediate close (back-compat for callers that don't
  // pass it). `closeDelaySeconds` is surfaced in the flag comment so the contributor knows the verification
  // window. The presence of the label is read from `input.pr.labels`.
  linkedIssueVerify?: { verifyBeforeClose: boolean; closeDelaySeconds: number } | undefined;
  // Live premerge migrations/** collision recheck (#2550). The trigger (runAgentMaintenancePlanAndExecute) has
  // already fetched the base branch's LIVE migration filenames, unioned them with this PR's own new migration
  // additions, and run collision detection — this input is already the resolved "yes, hold this merge"
  // verdict (or absent, meaning no live collision was found). When present, this SUPPRESSES the merge exactly
  // like a hard-guardrail hold (folded into `heldForManualReview`), and its `comment` is attached to the
  // emitted migration-collision label so the contributor knows why. Never causes a CLOSE — only
  // ever downgrades a would-merge into a held-for-review state, same risk profile as the guardrail hold.
  migrationCollisionHold?: { reason: string; comment: string } | undefined;
  // Unlinked-issue guardrail (#unlinked-issue-guardrail, credibility-gate-farming defense). The trigger
  // (runAgentMaintenancePlanAndExecute) has already run the deterministic pre-filter + AI verification for a
  // PR that links NO issue -- this input is already the resolved "yes, hold this merge" verdict (or absent,
  // meaning no confirmed direct match was found). Same risk profile as migrationCollisionHold: SUPPRESSES
  // the merge (folded into `heldForManualReview`), never causes a CLOSE, and is the rare exception to "a
  // missing linked issue is never a close reason" -- it only ever downgrades a would-merge into a held-for-
  // review state so a human can confirm the match before it's credited.
  unlinkedIssueMatchHold?: { reason: string; comment: string } | undefined;
  pr: {
    mergeableState?: string | null | undefined;
    reviewDecision?: string | null | undefined;
    slopRisk?: number | null | undefined;
    labels: string[];
    linkedDuplicateCount?: number | undefined;
    // RC3 terminal-fail merges: the live head SHA + the SHA at which a prior merge was terminally blocked
    // (perms/required-check/conflict). When they match, the merge can't complete for this commit → suppress it.
    headSha?: string | null | undefined;
    mergeBlockedSha?: string | null | undefined;
    // Re-approval idempotency: the head SHA the bot last auto-approved. When it equals the live headSha this
    // exact commit is already bot-approved → suppress the `approve` disposition (a GitHub App's own approval
    // does NOT reliably flip reviewDecision to APPROVED, so without this the bot re-approves every sweep). A new
    // commit makes the live head differ → the bot may approve the new code (correct).
    approvedHeadSha?: string | null | undefined;
    // The PR's opening contributor (#3182), threaded through ONLY for the `assign` disposition below. Absent
    // (undefined) on the several other, narrower callers of this planner (issue-cap/review-nag short-circuits)
    // is harmless -- those all set `conclusion: "skipped"` or hit an earlier short-circuit `return`, so the
    // `assign` block below is unreachable from them regardless.
    authorLogin?: string | null | undefined;
  };
};

function hasLabel(labels: string[], name: string): boolean {
  return labels.some((label) => label.toLowerCase() === name.toLowerCase());
}

function hasLabelOrPlanned(labels: string[], actions: PlannedAgentAction[], name: string): boolean {
  return hasLabel(labels, name) || actions.some((action) => action.actionClass === "label" && action.labelOp !== "remove" && action.label?.toLowerCase() === name.toLowerCase());
}

export type AgentDispositionLabelSettings = {
  manualReviewLabel?: string | null | undefined;
  readyToMergeLabel?: string | null | undefined;
  changesRequestedLabel?: string | null | undefined;
  migrationCollisionLabel?: string | null | undefined;
  pendingClosureLabel?: string | null | undefined;
};

type ResolvedAgentDispositionLabels = {
  manualReview: string | null;
  readyToMerge: string | null;
  changesRequested: string | null;
  migrationCollision: string | null;
  pendingClosure: string | null;
};

function resolveAgentDispositionLabels(settings: AgentDispositionLabelSettings): ResolvedAgentDispositionLabels {
  return {
    manualReview: settings.manualReviewLabel === null ? null : (settings.manualReviewLabel ?? AGENT_LABEL_NEEDS_REVIEW),
    readyToMerge: settings.readyToMergeLabel === null ? null : (settings.readyToMergeLabel ?? AGENT_LABEL_READY),
    changesRequested: settings.changesRequestedLabel === null ? null : (settings.changesRequestedLabel ?? AGENT_LABEL_CHANGES),
    migrationCollision: settings.migrationCollisionLabel === null ? null : (settings.migrationCollisionLabel ?? AGENT_LABEL_MIGRATION_COLLISION),
    pendingClosure: settings.pendingClosureLabel === null ? null : (settings.pendingClosureLabel ?? AGENT_LABEL_PENDING_CLOSURE),
  };
}

function guardrailHoldReason(changedPaths: string[], hardGuardrailGlobs: string[]): string {
  const matches = changedPathsHittingGuardrail(changedPaths, hardGuardrailGlobs);
  if (matches.length === 0) return "guarded path -> manual review (changed-file list unavailable)";
  const visible = matches.slice(0, 3).map((path) => `\`${path}\``).join(", ");
  return `guarded path -> manual review (${visible}${matches.length > 3 ? `, and ${matches.length - 3} more` : ""})`;
}

/**
 * Accuracy circuit-breaker (#self-improve / GAP-4): when auto-merge is DISABLED for a repo (the auto-tuner
 * engaged the holdonly flag after merge precision dropped, or a human set it), DOWNGRADE a would-MERGE into a
 * human HOLD — drop the `merge` action and surface the configured manual-review label so the PR is held for a person
 * instead of auto-merged. Mirrors reviewbot non-content-gate.ts (~212: a would-merge becomes a hold under the
 * breaker; close/label/approve are untouched).
 *
 * PURE + idempotent: with `holdOnly` false this returns the plan UNCHANGED (byte-identical, the common path);
 * with it true and no merge planned it is also a no-op. Only ever makes the system MORE cautious.
 */
export function downgradeMergeToHold(planned: PlannedAgentAction[], holdOnly: boolean, labelSettings: AgentDispositionLabelSettings = {}): PlannedAgentAction[] {
  if (!holdOnly || !planned.some((action) => action.actionClass === "merge")) return planned;
  const labels = resolveAgentDispositionLabels(labelSettings);
  const next = planned.filter((action) => action.actionClass !== "merge");
  // The dropped merge implies the PR is review-good — re-label it for manual review (replacing a stale
  // ready-to-merge promise) so the held PR is clearly flagged for a person. Idempotent: only add when absent.
  const alreadyNeedsReview = labels.manualReview !== null && next.some((action) => action.actionClass === "label" && action.label === labels.manualReview && action.labelOp !== "remove");
  const stagedMerge = planned.find((action) => action.actionClass === "merge");
  if (labels.manualReview !== null && !alreadyNeedsReview) {
    next.push({
      actionClass: "label",
      // Authorized by `merge` (the class actually being downgraded here), NOT `review_state_label` — mirrors
      // the guardrail-hold label above (#label-scoping) so this hold label posts whenever merge autonomy is
      // acting, independent of whether the repo has separately opted into the advisory review_state_label class.
      autonomyClass: "merge",
      requiresApproval: stagedMerge?.requiresApproval ?? false,
      reason: "accuracy circuit-breaker engaged (merge precision dropped) — would-merge held for human review",
      label: labels.manualReview,
      labelOp: "add",
    });
  }
  // Drop any ready-to-merge label add (the auto-merge it promised is now suppressed).
  return next.filter((action) => !(labels.readyToMerge !== null && action.actionClass === "label" && action.label === labels.readyToMerge && action.labelOp !== "remove"));
}

/**
 * CLOSE-precision circuit-breaker (the symmetric mirror of {@link downgradeMergeToHold}): when auto-CLOSE is
 * DISABLED for a repo (the auto-tuner engaged the `closehold` flag after CLOSE precision dropped, or a human set
 * it), DOWNGRADE a would-CLOSE into a human HOLD — drop the `close` action(s) and surface the configured manual-review
 * label so the PR is held for a person instead of auto-closed.
 *
 * TIGHTENING-ONLY in the close direction: it can ONLY remove a `close` action + ADD a label. It NEVER adds or
 * enables a close, merge, or approve, and it never touches an existing merge/approve action.
 *
 * OWNER-REQUIRED SCOPING: it downgrades ONLY HEURISTIC (verdict-driven) closes — those tagged
 * `closeKind: "heuristic"` (gate-verdict / duplicate / slop / CI). It EXEMPTS the DETERMINISTIC linked-issue
 * hard-rule close (`closeKind: "linked-issue-hard-rule"`): that close is zero-hallucination, and on the verify
 * path it posts a comment PROMISING closure — silently downgrading it to a hold while a comment promises closure
 * would be incoherent. So a plan whose only close is the deterministic one is returned UNCHANGED. A plan with a
 * heuristic close gets it dropped; a deterministic close present alongside is KEPT.
 *
 * It ALSO exempts a heuristic close carrying `closeConcreteEvidence: true` (red CI, a base conflict, a
 * committed secret, a deterministic duplicate, or another code in {@link CONCRETE_EVIDENCE_BLOCKER_CODES}):
 * the breaker exists to catch a heuristic call that turned out to be WRONG, and concrete evidence is not the
 * class of error it is watching for. A heuristic close with no concrete evidence (an unconfirmed AI verdict,
 * a bare gate-verdict=failure, or a slop-score threshold) stays fully subject to the breaker.
 *
 * The existing changes-requested label is KEPT (it correctly says the PR is not mergeable). PURE + idempotent:
 * with `closeHoldOnly` false this returns the plan UNCHANGED (the common path); with no downgradable close
 * planned it is also a no-op. Only ever makes the system MORE cautious.
 */
export function downgradeCloseToHold(planned: PlannedAgentAction[], closeHoldOnly: boolean, labelSettings: AgentDispositionLabelSettings = {}): PlannedAgentAction[] {
  const isHeuristicClose = (action: PlannedAgentAction): boolean => action.actionClass === "close" && action.closeKind === "heuristic" && action.closeConcreteEvidence !== true;
  if (!closeHoldOnly || !planned.some(isHeuristicClose)) return planned;
  const labels = resolveAgentDispositionLabels(labelSettings);
  // Drop ONLY the heuristic close(s); a deterministic linked-issue-hard-rule close (if any) is left intact.
  const next = planned.filter((action) => !isHeuristicClose(action));
  // The dropped close means the PR is held for a person — surface the manual-review label. Idempotent: only add when
  // absent (e.g. a guarded-but-passing plan may already carry it). NEVER adds a merge/approve.
  const alreadyNeedsReview = labels.manualReview !== null && next.some((action) => action.actionClass === "label" && action.label === labels.manualReview && action.labelOp !== "remove");
  const droppedClose = planned.find(isHeuristicClose);
  if (labels.manualReview !== null && !alreadyNeedsReview) {
    next.push({
      actionClass: "label",
      // Authorized by `close` (the class actually being downgraded here), NOT `review_state_label` — same
      // reasoning as downgradeMergeToHold's own manual-review label above (#label-scoping).
      autonomyClass: "close",
      requiresApproval: droppedClose?.requiresApproval ?? false,
      reason: "close-precision circuit-breaker engaged — would-close held for human review",
      label: labels.manualReview,
      labelOp: "add",
    });
  }
  // KEEP the changes-requested label (it correctly states the PR is not mergeable) and every other action.
  return next;
}

function closeMessage(reasons: string[]): string {
  return `Gittensory is closing this pull request on the maintainer's behalf (${reasons.join("; ")}). This is an automated maintenance action — to pursue this change, please open a new pull request with the issues resolved. Closed PRs may be analyzed later to improve review accuracy, but they are not automatically reopened or re-reviewed.`;
}

// The close comment for a blacklisted author (#1425). Do not interpolate maintainer-supplied blacklist metadata:
// reasons/evidence may come from private configuration, and this string is posted to the public PR thread.
function blacklistCloseMessage(): string {
  return "Gittensory is closing this pull request on the maintainer's behalf. This account is blocked from contributing to this repository, so the change was not reviewed on its merits. This is an automated maintenance action.";
}

// The close comment for exceeding the per-contributor open-item cap (#2270). Unlike blacklistCloseMessage, this
// DOES interpolate authorLogin/openCount/cap — none of that is private (the author's own login and their own
// open-item count on a public repo are already public/derivable from GitHub itself), and stating the exact
// numbers is the point: a deterministic, contributor-visible cap, not a silent quality-based hold. `scope`
// (#2562) picks the cap description: "repository" (default, back-compat for every existing per-repo caller) vs.
// "install" for the install-wide globalContributorOpenItemCap — same message shape, closeKind, and label either
// way, just an accurate noun phrase for where the count was aggregated.
function contributorCapCloseMessage(authorLogin: string, openCount: number, cap: number, itemNoun: "pull requests" | "issues" | "pull requests and issues", scope?: "repository" | "install" | undefined): string {
  const scopeDescription = scope === "install" ? "this install's configured limit (across every repository it gates, combined)" : "this repository's configured limit";
  return `Gittensory closed this because @${authorLogin} has ${openCount} open ${itemNoun}, above ${scopeDescription} of ${cap}. Close or merge an existing one to open a new one. This is an automated maintenance action.`;
}

// The close comment for review-nag cooldown (#2463). DOES interpolate authorLogin/pingCount/maxPings — none of
// that is private (the author's own login and their own public @gittensory ping count are already public/
// derivable from the PR thread itself), mirroring the contributor-cap close message's same reasoning.
function reviewNagCloseMessage(authorLogin: string, pingCount: number, maxPings: number): string {
  return `Gittensory closed this because @${authorLogin} pinged @gittensory ${pingCount} times, above this repository's configured limit of ${maxPings}. Please wait for the cooldown window to pass before requesting review again. This is an automated maintenance action.`;
}

/**
 * Plan best-effort assignment of the PR's opening contributor (#3182), independent of merge/close/CI outcome.
 * MUST run before the CI-pending settle-before-decide return below (#assign-before-ci-pending) — a PR that has
 * already been reviewed/evaluated (conclusion isn't "skipped") should get an assignee for triage even while an
 * unrelated check is still pending; assign has no bearing on mergeability so it never needs CI to settle first.
 * Gated purely on its own `assign` autonomy class, same as every other independent action here.
 */
function maybePlanAssign(actions: PlannedAgentAction[], input: AgentActionPlanInput): void {
  const level = resolveAutonomy(input.autonomy, "assign");
  if (!isActingAutonomyLevel(level) || !input.pr.authorLogin) return;
  actions.push({
    actionClass: "assign",
    requiresApproval: autonomyRequiresApproval(level),
    reason: "auto-assign PR opener",
    assignee: input.pr.authorLogin,
  });
}

/**
 * Plan the maintainer auto-maintain actions for one PR. Returns a COHERENT set (never both approve and
 * request-changes; never both merge and close), each entry already filtered to an acting autonomy class.
 * Ordered least → most irreversible: label, then the review, then the disposition.
 */
export function planAgentMaintenanceActions(input: AgentActionPlanInput): PlannedAgentAction[] {
  const actions: PlannedAgentAction[] = [];
  const autoMaintain = input.autoMaintain ?? DEFAULT_AUTO_MAINTAIN_POLICY;
  const slopGateMinScore = input.slopGateMinScore ?? DEFAULT_SLOP_GATE_MIN_SCORE;
  // Branch-protection-aware: required approvals are satisfied when the repo asks for none, or GitHub already
  // resolved the PR's reviews to APPROVED.
  const failingCheckNames = input.failingCheckNames ?? [];
  const approvalsSatisfied = autoMaintain.requireApprovals === 0 || input.pr.reviewDecision === "APPROVED";
  const level = (actionClass: AgentActionClass) => resolveAutonomy(input.autonomy, actionClass);
  const acting = (actionClass: AgentActionClass) => isActingAutonomyLevel(level(actionClass));
  const approval = (actionClass: AgentActionClass) => autonomyRequiresApproval(level(actionClass));

  // Contributor blacklist (#1425): a banned author's PR is a DETERMINISTIC short-circuit — it SHORT-CIRCUITS to a
  // label + close AHEAD of all merit/CI/gate/AI analysis (this returns before any of it), so a blocked account is
  // never merit-reviewed or auto-merged. Fires for a CONTRIBUTOR only (owner/admin/automation bots are NEVER
  // auto-closed, the standing rule — #2133 folds the fleet-operator admin allowlist into the same exemption).
  // Zero-hallucination, so its close is `closeKind: "blacklist"`, separate from heuristic
  // closes. The `acting`/`approval` gates here + the executor's pause/dry-run/
  // kill-switch gate make it dry-run-able and approval-gated exactly like every other action. The close comment is
  // static by construction so private maintainer metadata from the blacklist entry cannot leak.
  const blacklistContributor = !input.authorIsOwner && !input.authorIsAdmin && !input.authorIsAutomationBot;
  if (input.blacklistMatch?.matched === true && blacklistContributor) {
    // #label-scoping: this label is inseparable metadata on the close below, so it rides on `close` autonomy,
    // NOT the generic `label` class — a repo can enable close without also opting into the broad label dial.
    // Explicit `null` (vs. absent/undefined) means "close without any label."
    const label = input.blacklistLabel === null ? null : (input.blacklistLabel ?? DEFAULT_BLACKLIST_LABEL);
    // Close is pushed BEFORE its coupled label (#label-close-split-brain) so the executor's outcome-correlation
    // guard always has the close's outcome already recorded by the time it evaluates the label.
    if (acting("close")) {
      actions.push({
        actionClass: "close",
        requiresApproval: approval("close"),
        reason: "blacklisted contributor",
        closeReasons: ["blacklisted contributor"],
        closeComment: sanitizePublicComment(blacklistCloseMessage()),
        closeKind: "blacklist",
        // Pin like merge/approve (#2452): for an auto_with_approval stage this travels into the pending row so
        // the accept-time supersede check (agent-approval-queue.ts) can detect a force-push after staging, and
        // decidePendingAgentAction separately re-resolves live blacklist membership for this closeKind.
        ...(input.pr.headSha ? { expectedHeadSha: input.pr.headSha } : {}),
      });
    }
    if (acting("close") && label !== null) actions.push({ actionClass: "label", autonomyClass: "close", closeKind: "blacklist", requiresApproval: approval("close"), reason: "blacklisted contributor", label, labelOp: "add" });
    return actions;
  }

  // Per-contributor open-item cap (#2270): same zero-hallucination short-circuit shape as the blacklist above —
  // fires ahead of ALL merit/CI/AI analysis, for a CONTRIBUTOR only. Re-checks the owner/admin/bot exemption
  // independently of the caller (defense-in-depth, matching the blacklist block's own redundant check above).
  const capContributor = !input.authorIsOwner && !input.authorIsAdmin && !input.authorIsAutomationBot;
  if (input.contributorCapMatch?.matched === true && capContributor) {
    const { authorLogin, openCount, cap, itemKind, scope } = input.contributorCapMatch;
    // #label-scoping: same close-autonomy-gated, null-clearable shape as the blacklist label above.
    const label = input.contributorCapLabel === null ? null : (input.contributorCapLabel ?? DEFAULT_CONTRIBUTOR_CAP_LABEL);
    // Close is pushed BEFORE its coupled label (#label-close-split-brain) — see the closeKind doc comment above.
    if (acting("close")) {
      actions.push({
        actionClass: "close",
        requiresApproval: approval("close"),
        reason: "over the per-contributor open-item cap",
        closeReasons: ["over the per-contributor open-item cap"],
        closeComment: sanitizePublicComment(contributorCapCloseMessage(authorLogin, openCount, cap, itemKind, scope)),
        closeKind: "contributor_cap",
      });
    }
    if (acting("close") && label !== null) actions.push({ actionClass: "label", autonomyClass: "close", closeKind: "contributor_cap", requiresApproval: approval("close"), reason: "over the per-contributor open-item cap", label, labelOp: "add" });
    return actions;
  }

  // Review-nag cooldown (#2463): same zero-hallucination short-circuit shape as the blacklist above — fires
  // ahead of ALL merit/CI/AI analysis, for a CONTRIBUTOR only. The webhook trigger has already decided "this
  // ping crosses the threshold AND the repo's policy is close" before ever setting this input; the planner's
  // only job is to build the deterministic label+close plan under the repo's normal autonomy/dry-run/kill-switch
  // gates, exactly like every other action.
  const reviewNagContributor = !input.authorIsOwner && !input.authorIsAdmin && !input.authorIsAutomationBot;
  if (input.reviewNagMatch?.matched === true && reviewNagContributor) {
    const { authorLogin, pingCount, maxPings } = input.reviewNagMatch;
    // #label-scoping: same close-autonomy-gated, null-clearable shape as the blacklist label above.
    const label = input.reviewNagLabel === null ? null : (input.reviewNagLabel ?? DEFAULT_REVIEW_NAG_LABEL);
    // Close is pushed BEFORE its coupled label (#label-close-split-brain) — see the closeKind doc comment above.
    if (acting("close")) {
      actions.push({
        actionClass: "close",
        requiresApproval: approval("close"),
        reason: "review-nag cooldown",
        closeReasons: ["review-nag cooldown"],
        closeComment: sanitizePublicComment(reviewNagCloseMessage(authorLogin, pingCount, maxPings)),
        closeKind: "review_nag",
        ...(input.pr.headSha ? { expectedHeadSha: input.pr.headSha } : {}),
      });
    }
    if (acting("close") && label !== null) actions.push({ actionClass: "label", autonomyClass: "close", closeKind: "review_nag", requiresApproval: approval("close"), reason: "review-nag cooldown", label, labelOp: "add" });
    return actions;
  }

  // Only a SKIPPED gate (genuinely not evaluated) drives no action. A NEUTRAL gate (first-time-contributor
  // grace, or eval-not-ready while state is still syncing) is gate-NON-BLOCKING: it flows to the disposition so
  // the PR is merged (clean+green) or HELD with a label — never left silently undecided. (#harm-stop neutral-silent-stuck)
  if (input.conclusion === "skipped") return actions;

  // #assign-before-ci-pending: plan the (best-effort, CI-independent) assignee BEFORE the pending-CI
  // settle-before-decide return just below — a reviewed/evaluated PR must not sit unassigned while an unrelated
  // check is still pending. Every deterministic no-review short-circuit above (blacklist/cap/review-nag) already
  // returned before reaching this line, so none of them are affected.
  maybePlanAssign(actions, input);

  // CI state over ALL of the PR's checks (required OR not — codecov/patch included) — reviewbot's ci_red
  // parity. A red CI is NEVER approved/merged and is itself a close-worthy signal (non-owner). While CI is
  // still running, never approve or merge, but do not let unrelated pending checks mask terminal close reasons
  // that are already known now (a base conflict, a blocking gate verdict, or CI that has already gone red even
  // if some other, unrelated check is still pending).
  const ciPassed = input.ciState === "passed";
  const ciFailed = input.ciState === "failed";
  const ciPending = input.ciState === "pending" || input.ciHasPending === true;

  // The gate verdict is authoritative. Green CI is still required for merge/approve, but it does not rewrite an AI
  // or review-thread blocker into success once the gate has classified it as blocking.
  const conclusion: GateCheckConclusion = input.conclusion;
  const isConflict = input.pr.mergeableState === "dirty"; // conflicts with base — can't merge as-is
  const isContributor = !input.authorIsOwner && !input.authorIsAdmin && !input.authorIsAutomationBot;
  // The owner-close exemption is PER-REPO CONFIGURABLE (#configurable-owner-close): by default the repo owner's
  // own PRs are exempt from auto-close (closeOwnerAuthors !== true ⇒ merge or manual-hold only), but a maintainer
  // can opt in to closing them like a contributor's. #2133 folds the fleet-operator admin allowlist into the same
  // trusted-identity exemption (a login honored as a maintainer everywhere else in the codebase must not be
  // treated as an ordinary contributor here). Automation bots stay exempt regardless (a noise heuristic must not
  // kill a recurring maintainer-managed accumulator).
  const closeEligible = isContributor || ((input.authorIsOwner || input.authorIsAdmin) && input.closeOwnerAuthors === true);
  // A terminal reason is one that CANNOT be un-decided by an unrelated check eventually settling: a confirmed
  // gate failure, a base conflict, or CI already red (red is red regardless of what else is still pending —
  // see #ci-fail-closes-guarded below, which closes on `ciFailed` once fully settled; this bypass just lets
  // that same verdict fire immediately instead of waiting on unrelated pending checks to catch up).
  const pendingCiMayStillCloseForTerminalReason = closeEligible && acting("close") && (conclusion === "failure" || isConflict || ciFailed);
  // Settle-before-decide: pending CI suppresses success-path work, but not terminal close work. Otherwise a PR
  // with a known base conflict, a blocking gate verdict, or already-red CI can sit open forever behind an
  // unrelated stuck check.
  if (ciPending && !pendingCiMayStillCloseForTerminalReason) return actions;

  // Only SUCCESS earns the review-good auto-merge. A NEUTRAL gate flows (no longer silently returns []) but is
  // NOT auto-merged — it falls through to a HELD + labeled state for review. (Auto-merging a neutral / grace
  // PR is a separate trust/policy decision, deliberately NOT bundled into the harm-stop.) (#harm-stop)
  const gatePassing = conclusion === "success";
  // A changed path matching a hard guardrail forces manual review only when the PR is otherwise review-good
  // (suppresses auto-MERGE / auto-approve). It must never downgrade blockers/conflicts/red CI to manual review.
  // Fail SAFE on UNKNOWN paths (#1062): when guardrails are configured but the changed-file set is empty (cache
  // not yet / no longer populated), we cannot prove the PR doesn't touch a guarded path, so treat it as a hit —
  // never auto-merge, auto-approve, or auto-close a PR whose diff we don't know. Repos with no guardrails
  // configured stay permissive.
  const guardrailHit = isGuardrailHit(input.changedPaths, input.hardGuardrailGlobs);
  // Every read site below is itself gated on guardrailHit being true, so this default is never actually
  // read -- it exists only so guardrailReason stays a plain string instead of forcing a `?? fallback` at
  // every call site (each of which would be an untestable, permanently-unreachable branch).
  const guardrailReason = guardrailHit ? guardrailHoldReason(input.changedPaths, input.hardGuardrailGlobs) : "guarded path -> manual review";
  // Manual review is the RARE exception (the operator's minimize-manual goal): the ONLY things that hold a PR
  // for a human instead of merge/close are an auto-merge-ready PR that touches a hard-guardrail path, or a
  // live migration-number collision detected against the CURRENT tip of the base branch (#2550 — a sibling PR
  // merged a same-numbered migration file since this PR's CI last ran). (An owner PR that is not review-good
  // is held separately, via the owner close-exemption below — never auto-closed.) Submission volume is NOT a
  // hold reason: a high-volume author's clean PR still merges and their bad PR still closes — the quality
  // gate, not a submission count, is the defense (anti-farming-by-manual-hold removed).
  const heldForManualReview = guardrailHit || input.migrationCollisionHold !== undefined || input.unlinkedIssueMatchHold !== undefined;
  const labels = resolveAgentDispositionLabels(input);
  // Canonical (reviewbot non-content-gate) policy, tuned to the operator's minimize-manual goal: merge-or-close
  // with high accuracy; manual review is the RARE exception. A PR is "review-good" when the gate passes AND CI is
  // green — that's the only thing that earns an auto-merge or an approve. Everything else, for a CONTRIBUTOR, is a
  // one-shot CLOSE (taopedia model: resolve + open a fresh PR). The guardrail is handled SEPARATELY: it converts
  // would-approve/would-merge dispositions into a manual hold.
  const ciUnverified = input.ciState === "unverified";
  const reviewGood = gatePassing && ciPassed;
  const mergeableClean = input.pr.mergeableState === "clean";
  // RC3: a prior merge attempt failed terminally for THIS exact head SHA (403/405/409/conflict) → never re-plan
  // the merge; it can't complete for this commit. A new commit makes the live head differ from mergeBlockedSha.
  const mergeTerminallyBlocked = input.pr.mergeBlockedSha != null && input.pr.headSha != null && input.pr.mergeBlockedSha === input.pr.headSha;
  // Re-approval idempotency: this exact commit is already bot-approved when the stored approved-head SHA equals
  // the live head SHA → never re-post an approval for it (a GitHub App's own approval does not reliably flip
  // reviewDecision to APPROVED, so reviewDecision alone can't dedup). A new commit makes the heads differ →
  // approve may fire again. Absent approved-head SHA (never approved by the bot) ⇒ not idempotent-skipped.
  const alreadyApprovedThisHead = input.pr.approvedHeadSha != null && input.pr.headSha != null && input.pr.approvedHeadSha === input.pr.headSha;
  const canMerge = reviewGood && !heldForManualReview && acting("merge") && mergeableClean && approvalsSatisfied && !mergeTerminallyBlocked;
  // CLOSE a contributor PR ONLY on a REAL adverse signal — a confirmed gate FAILURE, red CI, or a base
  // CONFLICT. NEVER close merely because CI is UNVERIFIED (a fork whose Actions await approval, or unreadable
  // checks) or otherwise not-yet-mergeable — those are HELD for review, not killed (#harm-stop fork-false-close).
  // Owner/automation PRs are never closed unless owner-close is explicitly enabled. Guardrails do not soften
  // blockers/conflicts/red CI; they hold only otherwise-ready PRs for manual review.
  // (Rebase-if-behind already ran above, so a red CI here is on the latest base — not a stale-base artifact.) (#ci-fail-closes-guarded)
  const willClose = closeEligible && acting("close") && (ciFailed || conclusion === "failure" || isConflict);
  // Linked-issue HARD-RULE close (#linked-issue-hard-rules). A DETERMINISTIC verdict about the LINKED ISSUE
  // (owner-assigned / missing point-label / maintainer-only) — NOT an AI verdict, so there is no hallucination
  // to guard against: this close fires REGARDLESS of `guardrailHit`. It still only ever closes a CONTRIBUTOR
  // PR (the `isContributor` guard owns the owner/automation exemption) and respects the `close` autonomy class.
  // It takes PRECEDENCE over merge/approve below: a PR linking an ineligible issue must never auto-merge.
  const linkedIssueHardRule = input.linkedIssueHardRule;
  // Base condition: a CONTRIBUTOR PR links an issue tripping a deterministic hard rule AND the `close` autonomy
  // class is acting. (The owner/automation exemption lives in `isContributor`.)
  const linkedIssueViolated = linkedIssueHardRule?.violated === true && closeEligible && acting("close");
  // Flag-then-close double-check (#linked-issue-verify-before-close). Default behavior when the caller doesn't
  // pass the config is IMMEDIATE close (back-compat). When verifyBeforeClose is on, the close is a TWO-PASS
  // label-state machine: Pass 1 flags (adds the pending-closure label + a warning comment) and Pass 2 — the next
  // evaluation, with the violation still present AND the label already on the PR — closes.
  const verifyBeforeClose = input.linkedIssueVerify?.verifyBeforeClose === true;
  const closeDelaySeconds = input.linkedIssueVerify?.closeDelaySeconds ?? 0;
  const pendingClosureLabelPresent = labels.pendingClosure !== null && hasLabel(input.pr.labels, labels.pendingClosure);
  // Pass 1 is only safe when the pending-closure state can be written immediately. If labels are disabled or
  // approval-gated, holding would fail open because Pass 2 is keyed on a label that cannot appear yet; fall back
  // to the original immediate close in that case. #label-scoping: this label lives in the review_state_label
  // family (see below), so its readiness check must use the SAME class the actual push is gated on.
  const canApplyPendingClosureFlagNow = labels.pendingClosure !== null && acting("review_state_label") && !approval("review_state_label");
  // Pass 1 — violation present, verify-mode on, label NOT yet on the PR, and the state label can be applied now
  // → FLAG (label + comment), do NOT close.
  const flagForLinkedIssue = linkedIssueViolated && verifyBeforeClose && !pendingClosureLabelPresent && canApplyPendingClosureFlagNow;
  // Close NOW when: verify-mode OFF (immediate, original GAP-5), OR Pass 2 (violation persists AND the
  // pending-closure label is already present from a prior pass), OR verification cannot safely persist its flag.
  const willCloseForLinkedIssue = linkedIssueViolated && (!verifyBeforeClose || pendingClosureLabelPresent || !canApplyPendingClosureFlagNow);
  // The violation has CLEARED (no longer violated) but the PR still carries a pending-closure flag from a prior
  // pass → remove the stale flag (never close). Independent of `isContributor`/`close` autonomy: clearing a stale
  // label is always safe and must happen even if the rule/author no longer qualifies for a close.
  const clearLinkedIssueFlag = linkedIssueHardRule?.violated !== true && pendingClosureLabelPresent;
  // True whenever a pending linked-issue close is in flight (flag OR close) — drives the changes-requested label
  // and suppresses approve/merge below (a PR about to be closed for an ineligible issue must never auto-merge).
  const linkedIssueCloseInFlight = flagForLinkedIssue || willCloseForLinkedIssue;
  const ciReason = ciFailed
    ? `CI is failing${failingCheckNames.length ? ` (${failingCheckNames.join(", ")})` : ""}`
    : ciUnverified
      ? "CI could not be verified"
      : "";

  // 1) manual-review label — a configurable, single-purpose label for guardrail holds. This is intentionally
  // separate from review_state_label so a one-shot repo can opt into `manual-review` without also enabling the
  // older ready/changes disposition labels. It is authorized by merge autonomy because it only fires when a
  // would-merge PR is held for a human by a guardrail.
  if (reviewGood && guardrailHit && labels.manualReview !== null && acting("merge") && !hasLabelOrPlanned(input.pr.labels, actions, labels.manualReview)) {
    actions.push({
      actionClass: "label",
      autonomyClass: "merge",
      requiresApproval: false,
      reason: `verdict=${conclusion}; ${guardrailReason}`,
      label: labels.manualReview,
      labelOp: "add",
    });
  }

  // 1c) migration-collision manual-review fallback (#manual-review-coverage) — the migration-collision LABEL
  // itself stays gated on review_state_label below (section 2, unchanged) so an operator's dedicated filter on
  // that specific label is undisturbed. But when review_state_label is OFF (a one-shot repo that only configures
  // manualReviewLabel), a live migration-collision hold previously suppressed the merge with NO visible label and
  // NO comment at all — a would-merge PR silently stuck forever, with no signal that a human needs to look or why.
  // Authorized by `merge` (the class actually suppressing the merge here), mirroring the guardrail-hold label
  // immediately above. Fires ONLY as a fallback (review_state_label not acting), so it can never duplicate
  // section 2's own migration-collision label + rebase comment.
  if (reviewGood && input.migrationCollisionHold !== undefined && !acting("review_state_label") && labels.manualReview !== null && acting("merge") && !hasLabelOrPlanned(input.pr.labels, actions, labels.manualReview)) {
    actions.push({
      actionClass: "label",
      autonomyClass: "merge",
      requiresApproval: false,
      reason: `verdict=${conclusion}; ${input.migrationCollisionHold.reason}`,
      label: labels.manualReview,
      labelOp: "add",
      comment: sanitizePublicComment(input.migrationCollisionHold.comment),
    });
  }

  // 1d) unlinked-issue-match manual-review fallback (#unlinked-issue-guardrail) — mirrors 1c exactly, for the
  // credibility-gate-farming guardrail: when review_state_label is OFF, surface the hold + evidence via the
  // generic manualReviewLabel fallback so a confirmed match isn't silently invisible. Never duplicates 1's or
  // 1c's label (hasLabelOrPlanned guard) if either already added it first.
  if (reviewGood && input.unlinkedIssueMatchHold !== undefined && !acting("review_state_label") && labels.manualReview !== null && acting("merge") && !hasLabelOrPlanned(input.pr.labels, actions, labels.manualReview)) {
    actions.push({
      actionClass: "label",
      autonomyClass: "merge",
      requiresApproval: false,
      reason: `verdict=${conclusion}; ${input.unlinkedIssueMatchHold.reason}`,
      label: labels.manualReview,
      labelOp: "add",
      comment: sanitizePublicComment(input.unlinkedIssueMatchHold.comment),
    });
  }

  // 2) review_state_label (#label-scoping) — ready-to-merge (review-good, unguarded) / manual-review
  // (review-good but guarded) / changes-requested (not review-good → will be closed for a contributor, held for
  // the owner). A pending linked-issue hard-rule close (flag OR close pass) forces the changes-requested label
  // regardless of the gate verdict (the PR is about to be closed for an ineligible linked issue). Idempotent.
  // Gated on the DEDICATED `review_state_label` class, not the generic `label` — these are the bot's own
  // disposition-communication labels (advisory, not enforcement), default OFF like every autonomy class so a
  // one-shot-mode repo never sees disposition labels without an explicit opt-in.
  if (acting("review_state_label")) {
    // A live migration-collision hold takes priority over a plain guardrail hold when both are true — it is
    // the more specific, actionable signal (tells the contributor exactly what to do: rebase), and gets its
    // own distinct label (#2550) so an operator can filter/alert on it separately from an ordinary guardrail.
    const label = linkedIssueCloseInFlight || !reviewGood ? labels.changesRequested : input.migrationCollisionHold !== undefined ? labels.migrationCollision : heldForManualReview ? labels.manualReview : labels.readyToMerge;
    const reason = linkedIssueCloseInFlight
      ? `linked-issue hard rule: ${linkedIssueHardRule?.reason ?? "ineligible linked issue"}`
      : !reviewGood
        ? `verdict=${conclusion}${ciReason ? `; ${ciReason}` : ""}`
        : input.migrationCollisionHold !== undefined
          ? `verdict=${conclusion}; ${input.migrationCollisionHold.reason}`
          : input.unlinkedIssueMatchHold !== undefined
            ? `verdict=${conclusion}; ${input.unlinkedIssueMatchHold.reason}`
            : heldForManualReview
              ? `verdict=${conclusion}; ${guardrailReason}`
              : `verdict=${conclusion}; CI green`;
    if (label !== null && !hasLabelOrPlanned(input.pr.labels, actions, label)) {
      actions.push({
        actionClass: "label",
        autonomyClass: "review_state_label",
        requiresApproval: approval("review_state_label"),
        reason,
        label,
        // Only the migration-collision hold and the unlinked-issue-match hold carry a comment here — the
        // guardrail/ready/changes labels never did and still don't (comment stays undefined, matching the
        // pre-#2550 shape exactly). Migration-collision takes priority when both are somehow true (matches
        // the label-priority choice above).
        ...(!linkedIssueCloseInFlight && reviewGood && input.migrationCollisionHold !== undefined
          ? { comment: sanitizePublicComment(input.migrationCollisionHold.comment) }
          : !linkedIssueCloseInFlight && reviewGood && input.unlinkedIssueMatchHold !== undefined
            ? { comment: sanitizePublicComment(input.unlinkedIssueMatchHold.comment) }
            : {}),
      });
    }
    // Flag-then-close double-check, Pass 1: add the pending-closure label + a warning comment citing the specific
    // rule and the verification window. The label's presence is the state that, persisting to the next pass with
    // the violation still present, triggers the close. Idempotent (the flag only fires when the label is absent).
    if (flagForLinkedIssue && labels.pendingClosure !== null) {
      const ruleReason = linkedIssueHardRule?.reason ?? "the linked issue is not eligible for a community PR";
      const window = closeDelaySeconds > 0 ? `~${closeDelaySeconds}s` : "the next verification";
      actions.push({
        actionClass: "label",
        autonomyClass: "review_state_label",
        closeKind: "linked-issue-hard-rule",
        requiresApproval: approval("review_state_label"),
        reason: `linked-issue hard rule (flagged for verification): ${ruleReason}`,
        label: labels.pendingClosure,
        labelOp: "add",
        comment: `⚠️ This PR links an ineligible issue (${ruleReason}) and will be closed on re-verification in ${window} unless the linked issue changes.`,
      });
    }
    // Violation CLEARED but a stale pending-closure flag remains → remove it (+ a resolved note). Never closes.
    if (clearLinkedIssueFlag && labels.pendingClosure !== null) {
      actions.push({
        actionClass: "label",
        autonomyClass: "review_state_label",
        closeKind: "linked-issue-hard-rule",
        requiresApproval: approval("review_state_label"),
        reason: "linked-issue hard rule resolved — clearing the pending-closure flag",
        label: labels.pendingClosure,
        labelOp: "remove",
        comment: "✓ The linked-issue hard-rule violation is resolved — this PR is no longer pending closure.",
      });
    }
  }

  // 3) review — APPROVE a review-good PR only when it is NOT on a guarded path; a guarded PR falls through to the
  // owner's manual safety review (never auto-approved). The bot NEVER posts a formal CHANGES_REQUESTED review: a
  // blocking review counts against required approvals and STRANDS a PR when it later goes green (a stale
  // request-changes keeps it un-mergeable forever). A not-good CONTRIBUTOR PR is CLOSED below; a not-good
  // OWNER/automation PR is HELD via the needs-human label + the (non-blocking) unified review comment — never a
  // formal request-changes. (#no-request-changes) Either merge/approve, or close, with the rare manual hold left
  // open + commented, never blocked.
  // Never APPROVE a base-conflicting PR: it is closed below (willClose on isConflict), so a "Gittensory approves —
  // safe to merge" review on a PR we're about to close is incoherent (and a stale approval strands the PR if it
  // later goes green). A `behind`/`blocked` PR is fine to approve (it is rebased pre-review or the approval clears
  // the block); only a hard `dirty` conflict is excluded here. (#ready-needs-mergeable, the #4220 report) */
  if (reviewGood && !heldForManualReview && !linkedIssueCloseInFlight && !isConflict && acting("approve") && input.pr.reviewDecision !== "APPROVED" && !alreadyApprovedThisHead) {
    actions.push({
      actionClass: "approve",
      requiresApproval: approval("approve"),
      reason: "gate passed, CI green",
      reviewBody: "Gittensory approves — the gate is satisfied and CI is green.",
      // Pin the approve to the EXACT reviewed head (#2262), matching the merge action's existing pin. For an
      // auto_with_approval stage this travels into the pending row (actionParams persists expectedHeadSha), so
      // the accept-time supersede check — which only fires when expectedHeadSha is truthy — actually engages: a
      // force-push after staging is detected and denied instead of the accept silently approving the NEW,
      // unreviewed commit. The executor also pins createPullRequestReview's commit_id to this SHA.
      ...(input.pr.headSha ? { expectedHeadSha: input.pr.headSha } : {}),
    });
  } else if (
    // A prior bot approval is now STALE: a later commit landed (approvedHeadSha !== the current head) and this
    // pass isn't posting a fresh approve (the branch above didn't fire). GitHub's reviewDecision is derived from
    // the LATEST review per reviewer, so leaving the old APPROVE in place can still satisfy a "require approving
    // reviews" rule and let a human merge the new, un-reviewed commit directly on GitHub. Only matters when the
    // PR stays open under review this pass — canMerge/willClose/willCloseForLinkedIssue each make it moot (a
    // merge doesn't care about the stale review, and a close removes the PR from mergeable consideration
    // entirely). (#2254)
    input.pr.approvedHeadSha != null &&
    input.pr.headSha != null &&
    input.pr.approvedHeadSha !== input.pr.headSha &&
    acting("approve") &&
    !canMerge &&
    !willClose &&
    !willCloseForLinkedIssue
  ) {
    actions.push({
      actionClass: "approve",
      requiresApproval: approval("approve"),
      reason: "stale approval retracted — a newer commit no longer qualifies for approval",
      dismissStaleApproval: true,
      // Pin to the head that was actually evaluated as stale (mirrors the merge action's head pinning above) so
      // a queued (auto_with_approval) dismissal replayed later can't retract a DIFFERENT, newer bot approval if
      // the head moved again while this row waited for a maintainer (#2361). input.pr.headSha is already
      // narrowed non-null by the `else if` condition above (line ~454), so no fallback branch is needed here.
      expectedHeadSha: input.pr.headSha,
    });
  }

  // 4) disposition — FLAG-HOLD (linked-issue Pass 1: flagged this pass, verification pending → NO disposition) /
  // LINKED-ISSUE HARD-RULE CLOSE (deterministic, fires even on a guarded path; precedes merge) / MERGE
  // (review-good, unguarded, mergeable, approvals) / CLOSE (not-good OR conflicting CONTRIBUTOR PR, one-shot) /
  // MANUAL (guarded, or any not-good OWNER/automation PR — held, never closed). Mutually exclusive.
  if (flagForLinkedIssue) {
    // Pass 1 of the flag-then-close double-check: the PR was flagged in the label section above and is HELD this
    // pass — no merge, no close. The NEXT evaluation (violation still present + the label now on the PR) closes.
    // Falling through here also suppresses the general `willClose` path so a flagged red-CI PR isn't closed until
    // the verification pass confirms the linked-issue violation.
  } else if (willCloseForLinkedIssue) {
    // A contributor linked an issue that violates a deterministic hard rule (owner-assigned / missing
    // point-label / maintainer-only). Close one-shot, citing the SPECIFIC rule + issue so the contributor knows
    // exactly why. This is the FIRST disposition branch: it wins over an otherwise-mergeable verdict (a PR for
    // an ineligible issue must never auto-merge) and fires REGARDLESS of `guardrailHit` (deterministic, not AI).
    const reason = linkedIssueHardRule?.reason ?? "the linked issue is not eligible for a community PR";
    // Tagged "linked-issue-hard-rule": the close-precision breaker EXEMPTS this deterministic close (it is not
    // verdict-driven, and the verify path may already have promised closure in a comment).
    actions.push({
      actionClass: "close",
      requiresApproval: approval("close"),
      reason,
      closeReasons: [reason],
      closeComment: closeMessage([reason]),
      closeKind: "linked-issue-hard-rule",
      // Pin like merge/approve (#2452): lets the accept-time supersede check detect a force-push after staging.
      ...(input.pr.headSha ? { expectedHeadSha: input.pr.headSha } : {}),
    });
  } else if (canMerge) {
    actions.push({
      actionClass: "merge",
      requiresApproval: approval("merge"),
      reason: `gate passed, CI green, mergeable, ${autoMaintain.requireApprovals} approval(s) satisfied`,
      mergeMethod: autoMaintain.mergeMethod,
      // Pin the merge to the EXACT reviewed head. For an `auto_with_approval` stage this travels into the pending
      // row (actionParams persists expectedHeadSha), so a force-push after staging can never be merged: the
      // executor pins GitHub's merge `sha` to this commit → a moved head yields a 409 (terminal hold) instead of
      // merging un-reviewed code. A live sweep sets this == ctx.headSha, so its behavior is unchanged.
      ...(input.pr.headSha ? { expectedHeadSha: input.pr.headSha } : {}),
    });
  } else if (willClose) {
    // Contributor PR that is NOT review-good (gate blockers / red CI) OR conflicts with base → CLOSE one-shot.
    // Guardrails hold otherwise-ready changes only; they do not downgrade blockers into manual review.
    const closeReasons: string[] = [];
    if (ciFailed) closeReasons.push(ciReason);
    if (isConflict) closeReasons.push("conflicts with the base branch — resolve and open a fresh PR");
    for (const blockerTitle of input.blockerTitles) closeReasons.push(blockerTitle);
    if (input.pr.slopRisk != null && input.pr.slopRisk >= slopGateMinScore) closeReasons.push(`slop score ${input.pr.slopRisk} ≥ ${slopGateMinScore}`);
    if ((input.pr.linkedDuplicateCount ?? 0) > 0) closeReasons.push("duplicate of another open PR");
    if (closeReasons.length === 0) closeReasons.push("the review gate is not satisfied");
    // Tagged "heuristic": a verdict-driven close (gate-verdict / duplicate / slop / CI). The close-precision
    // breaker downgrades this to a hold when close precision has dropped — UNLESS it is also backed by concrete,
    // non-judgment evidence (see closeConcreteEvidence's doc comment), in which case the breaker leaves it alone.
    actions.push({
      actionClass: "close",
      requiresApproval: approval("close"),
      reason: closeReasons.join("; "),
      closeReasons,
      closeComment: closeMessage(closeReasons),
      closeKind: "heuristic",
      closeConcreteEvidence: hasConcreteCloseEvidence(input, ciFailed, isConflict),
      // Pin like merge/approve (#2452): lets the accept-time supersede check detect a force-push after staging;
      // the executor's own step-6 live-CI re-check (#2128) separately covers the CI-driven reason above.
      ...(input.pr.headSha ? { expectedHeadSha: input.pr.headSha } : {}),
      // Always explicit (never omitted) -- see the field's doc comment (#2478): an omitted value on a REPLAYED
      // staged action must unambiguously mean "legacy row, predates this field", not "not CI-driven".
      closeRequiresCiState: ciFailed ? "failed" : "not_required",
      // Always explicit (never omitted), mirroring closeRequiresCiState's own discipline above.
      closeRequiresMergeableState: isConflict,
    });
  }
  // else: guarded → manual; not-good OWNER/automation → manual; action-required/unverified → manual;
  // not-good CONTRIBUTOR whose verdict isn't adverse enough to close (e.g. a NEUTRAL gate with green CI and no
  // conflict) → manual; review-good-but-not-yet-mergeable → held briefly (rebase/approve resolves it next pass).
  // The CONTRIBUTOR branch (`!willClose`) closes a real reliability gap: previously this checked `!closeEligible`
  // alone, so a not-review-good CONTRIBUTOR whose conclusion wasn't adverse enough to trip `willClose` (chiefly
  // `neutral`) fell through with NO action and NO label at all whenever review_state_label was off — silently
  // contradicting the neutral-verdict "never left silently undecided" invariant above (#harm-stop
  // neutral-silent-stuck) for exactly the one-shot repos that configure manualReviewLabel without also enabling
  // review_state_label. Requires `close` actually ACTING (mirroring the label's own `autonomyClass: "close"`
  // below) so a repo with every relevant class off stays fully quiescent — see "plans nothing when every class is
  // at a non-acting level". For the owner/admin/automation-bot branch (`!closeEligible`) this is unchanged: those
  // authors are never close-eligible regardless of the `close` autonomy dial, so the hold must still surface.
  const manualHoldReason =
    guardrailHit
      ? `verdict=${conclusion}; ${guardrailReason}`
      : ciUnverified
        ? "CI could not be verified"
        : conclusion === "action_required"
          ? "review requires maintainer action"
          : !reviewGood && !willClose && (!closeEligible || acting("close"))
            ? `verdict=${conclusion}${ciReason ? `; ${ciReason}` : ""}`
            : null;
  if (
    manualHoldReason !== null &&
    labels.manualReview !== null &&
    !actions.some((action) => action.actionClass === "merge" || action.actionClass === "close") &&
    !hasLabelOrPlanned(input.pr.labels, actions, labels.manualReview)
  ) {
    actions.push({
      actionClass: "label",
      autonomyClass: reviewGood ? "merge" : "close",
      requiresApproval: false,
      reason: manualHoldReason,
      label: labels.manualReview,
      labelOp: "add",
    });
  }

  return actions;
}
