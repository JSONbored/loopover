import type { AgentActionClass, AutoMaintainPolicy, AutoMergeMethod, AutonomyPolicy } from "../types";
import { AI_JUDGMENT_BLOCKER_CODES, type GateCheckConclusion } from "../rules/advisory";
import { DEFAULT_AUTO_MAINTAIN_POLICY, autonomyRequiresApproval, isActingAutonomyLevel, resolveAutonomy } from "./autonomy";
import { assessMergeableState, derivePrDisposition, type MergeHoldInput, type PrDispositionInput } from "./pr-disposition";
import { changedPathsHittingGuardrail, isGuardrailHit } from "../signals/change-guardrail";
import { AGENT_LABEL_PENDING_CLOSURE } from "../review/linked-issue-hard-rules";
import { REVIEW_THREAD_BLOCKER_CODE } from "../review/review-thread-findings";
import { sanitizePublicComment } from "../github/commands";
import { parseGitHubLoginList } from "../auth/security";

// High-slop threshold default when a repo hasn't set slopGateMinScore (mirrors the gate's `high` band).
const DEFAULT_SLOP_GATE_MIN_SCORE = 60;

// The maintainer auto-maintain decision layer (#778): given the gate verdict + the PR's current state + the
// repo's autonomy config, decide which GitHub state actions to take. PURE and deterministic — the executor
// owns the gate stack (mode / permission / auth) and the actual GitHub mutation. Conservative by design:
// every action is independently gated by its own autonomy class, and the irreversible ones (merge / close)
// demand strong positive signals.


// The bucket labels the layer applies to reflect the gate verdict. These are generic fallbacks only; self-host
// operators can rename or disable them via config-as-code so engine behavior never depends on project-specific
// `loopover:*` labels.
export const AGENT_LABEL_READY = "ready-to-merge";
export const AGENT_LABEL_CHANGES = "changes-requested";
// Default label applied to a blacklisted contributor's PR (#1425). NOT hardcoded into the action — it is
// configurable per-repo via `.loopover.yml` (`settings.blacklistLabel`); the planner uses the resolved label
// and falls back to this default, so the disposition works regardless of the label a repo sets.
export const DEFAULT_BLACKLIST_LABEL = "slop";
// Default label applied to a PR/issue closed for exceeding the per-contributor open-item cap (#2270). Same
// configurable-with-fallback shape as DEFAULT_BLACKLIST_LABEL — a repo can override it via
// `.loopover.yml` (`settings.contributorCapLabel`); this is only the fallback when unset.
export const DEFAULT_CONTRIBUTOR_CAP_LABEL = "over-contributor-limit";
// Default label applied to a PR closed for review-nag cooldown (#2463). NOT hardcoded into the action — it is
// configurable per-repo via `.loopover.yml` (`settings.reviewNagLabel`); the planner uses the resolved label
// and falls back to this default, mirroring DEFAULT_BLACKLIST_LABEL's shape.
export const DEFAULT_REVIEW_NAG_LABEL = "review-nag-cooldown";
// Default label applied by the copycat/plagiarism containment gate (#1969), both at its `label` tier (applied
// standalone, PR otherwise continues through the normal pipeline) and coupled to its `block` tier's close. Same
// configurable-with-fallback shape as DEFAULT_BLACKLIST_LABEL — a repo can override it via `.loopover.yml`
// (`settings.copycatLabel`); this is only the fallback when unset.
export const DEFAULT_COPYCAT_LABEL = "copycat";
// Default label applied to a PR re-closed for review-evasion (#review-evasion-protection): a contributor
// closing/converting-to-draft their own PR while an active review pass is running. NOT hardcoded -- a repo
// can override it via `.loopover.yml` (`settings.reviewEvasionLabel`); this is only the fallback when unset.
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

// #label-scoping (#4618): every per-repo configurable close/hold label shares this shape -- explicit `null`
// means "act without any label" (an operator opt-out), `undefined` (never configured) falls back to the
// operator-facing default below. Factored out of ~9 independently hand-copied ternaries of the exact same
// idiom across this file and queue/processors.ts. PURE.
export function resolveNullableLabel(configured: string | null | undefined, fallback: string): string | null {
  return configured === null ? null : (configured ?? fallback);
}

// Maintainer-managed automation accounts whose PRs are never auto-closed. A recurring accumulator (e.g.
// github-actions[bot] opening automation/readme-refresh) or a dependency PR must not be killed by a duplicate
// or slop heuristic — the maintainer owns its lifecycle. (reviewbot wrongly auto-closed such an accumulator,
// awesome-claude #4192.) Still eligible for auto-merge when clean + passing.
const PROTECTED_AUTOCLOSE_AUTHORS = new Set(["github-actions[bot]", "dependabot[bot]", "renovate[bot]"]);

// A self-hoster running a different automation stack (mergify[bot], snyk-bot, allcontributors[bot], ...) can
// extend the base allowlist with a whitespace- or comma-separated PROTECTED_AUTOCLOSE_AUTHORS_EXTRA env var
// instead of forking the code (#4615). Parsed through the shared parseGitHubLoginList so it splits on the same
// `/[\s,]+/` convention every other GitHub-login-list env var uses (ADMIN_GITHUB_LOGINS, ...), not a narrower
// comma-only split (#audit-3.13). Additive only -- an unset/blank value never shrinks the base set below.
function protectedAutocloseAuthors(env: Env | undefined): Set<string> {
  const extra = parseGitHubLoginList(env?.PROTECTED_AUTOCLOSE_AUTHORS_EXTRA);
  return extra.size > 0 ? new Set([...PROTECTED_AUTOCLOSE_AUTHORS, ...extra]) : PROTECTED_AUTOCLOSE_AUTHORS;
}

export function isProtectedAutomationAuthor(login: string | null | undefined, env?: Env): boolean {
  return login != null && protectedAutocloseAuthors(env).has(login.toLowerCase());
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
  closeKind?: "linked-issue-hard-rule" | "blacklist" | "contributor_cap" | "review_nag" | "screenshot_table" | "heuristic" | "copycat";
  // For a CI-driven heuristic close, the CI state that must still hold at actuation time. Other heuristic
  // closes (gate verdict, duplicate/slop, conflict) do not depend on red CI and must not be blocked by green CI.
  // ALWAYS set for a heuristic close (never omitted) -- see the field's doc comment on AgentPendingActionParams
  // in types.ts for why the tri-state (rather than an optional "failed") matters (#2478).
  closeRequiresCiState?: "failed" | "not_required";
  // True when a base conflict was part of this close's justification -- see the doc comment on
  // AgentPendingActionParams in types.ts for why the approval queue's accept-time recheck is scoped to this
  // specific case rather than every non-CI heuristic close. ALWAYS set for a heuristic close (never omitted).
  closeRequiresMergeableState?: boolean;
  // True when an unresolved GitHub review thread (REVIEW_THREAD_BLOCKER_CODE) was part of this close's
  // justification -- see the doc comment on AgentPendingActionParams in types.ts. Mirrors
  // closeRequiresMergeableState's own discipline: ALWAYS set for a heuristic close (never omitted).
  closeRequiresThreadResolved?: boolean;
  // True when a duplicate-PR justification (linkedDuplicateCount > 0) was part of this close's reasons --
  // mirrors closeRequiresMergeableState's discipline: ALWAYS set (never omitted) for a freshly planned
  // heuristic close, so `undefined` on a replayed row unambiguously means "legacy row, predates this field".
  // Unlike a conflict, this justification depends on a SIBLING PR's live state, not this PR's own -- the
  // recheck (agent-action-executor.ts / agent-approval-queue.ts) re-verifies duplicateWinnerPrNumber below,
  // when a specific one was named, rather than re-deriving the whole cluster (#dup-winner-staleness).
  closeRequiresDuplicateStillOpen?: boolean;
  // The specific sibling PR number this close named as the duplicate-cluster winner (dupWinnerLinkedDuplicateWinnerNumber),
  // persisted so the recheck above can re-verify THAT PR specifically instead of re-running the full election.
  // Absent when the election named no specific winner (LOOPOVER_DUPLICATE_WINNER off, or an ambiguous
  // election) even though closeRequiresDuplicateStillOpen is true -- the recheck has no cheap single-PR signal
  // in that case and is a no-op, matching the legacy (pre-dup-winner) behavior for that configuration.
  duplicateWinnerPrNumber?: number;
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
  // #7986: the specific gate-blocker code(s) (a subset of CONCRETE_EVIDENCE_BLOCKER_CODES) that justify
  // `closeConcreteEvidence: true` via the blocker-code path specifically -- empty/absent when the evidence is
  // CI-failure/base-conflict/duplicate-link based instead (those are not "rules" with a measurable per-code
  // track record the same way a blocker code is, so they are never subject to the per-rule downgrade
  // downgradeCloseToHold now also applies). Lets downgradeCloseToHold check a close's justification against a
  // live per-rule precision track record, instead of trusting blanket CONCRETE_EVIDENCE_BLOCKER_CODES
  // membership forever regardless of that specific code's own real-world accuracy.
  closeConcreteEvidenceCodes?: string[];
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
  // Legacy approval-queue rows may contain this field from the reverted linked-issue assignment fan-out. New
  // plans do not set it, actionParams does not persist it, and the executor ignores it because linked issue
  // assignment is an authorization signal granted by maintainers, not by PR-body closing references.
  assignLinkedIssues?: number[];
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
// hazard. A source-text parity test in the test file below guards all eleven against producer-side drift instead.
const CONCRETE_EVIDENCE_BLOCKER_CODES = new Set<string>([
  "secret_leak",
  "duplicate_pr_risk",
  "surface_lane_reject",
  "manifest_missing_tests",
  "manifest_linked_issue_required",
  "pre_merge_check_required",
  "lockfile_tamper_risk",
  "missing_linked_issue",
  // #10168: the superseded split-off of missing_linked_issue, and concrete on the same footing -- two
  // recorded timestamps and a merged sibling's own linked-issue set, no AI judgment anywhere in it.
  "linked_issue_superseded",
  "self_authored_linked_issue",
  // #content-lane-deliverable: a text/path match against the resolved RegistryLaneSpec, no AI judgment involved --
  // same deterministic footing as surface_lane_reject immediately above.
  "content_lane_deliverable_missing",
]);

/** The specific gate-blocker code(s) that justify concrete evidence via the {@link CONCRETE_EVIDENCE_BLOCKER_CODES}
 *  path specifically (#7986) — a subset of `input.gateBlockerCodes`, excluding advisory.ts's own
 *  {@link AI_JUDGMENT_BLOCKER_CODES} (belt-and-suspenders, same guard {@link hasConcreteCloseEvidence} always
 *  had). Empty when the close's ONLY concrete evidence is CI-failure/base-conflict/duplicate-link based
 *  (`hasConcreteCloseEvidence` returns true via one of those without ever reaching this) — those are not
 *  "rules" with a measurable per-code track record the same way a blocker code is, so `downgradeCloseToHold`'s
 *  per-rule check must never apply to them. */
function concreteCloseEvidenceCodes(input: AgentActionPlanInput): string[] {
  return (input.gateBlockerCodes ?? []).filter((code) => CONCRETE_EVIDENCE_BLOCKER_CODES.has(code) && !AI_JUDGMENT_BLOCKER_CODES.has(code));
}

/** True when a would-CLOSE is justified by at least one piece of concrete, non-judgment evidence: red CI, a
 *  base conflict, a deterministic duplicate-PR link, or a gate-blocker code in {@link CONCRETE_EVIDENCE_BLOCKER_CODES}
 *  (via {@link concreteCloseEvidenceCodes}). Mixed blockers (one concrete + one ambiguous) still count as
 *  concrete — the concrete signal alone already justifies the close regardless of what else is present. */
function hasConcreteCloseEvidence(input: AgentActionPlanInput, ciFailed: boolean, isConflict: boolean): boolean {
  if (ciFailed || isConflict) return true;
  // #9129: a duplicate-PR link is DELIBERATELY excluded from concrete evidence, unlike a base conflict (#3863) or
  // red CI. Those two are facts about THIS PR's own state, verifiable by loopover itself. A duplicate-issue-link
  // is a fact about a SIBLING PR's author-controlled body text -- any contributor can manufacture it for free by
  // citing the same issue number in a throwaway PR, with no code required, and thereby force ANY other PR
  // claiming that issue to look "duplicated" from the breaker's point of view. The previous justification here
  // reasoned only about the value going STALE between planning and actuation (closeRequiresDuplicateStillOpen's
  // live recheck already covers that); it never addressed an ADVERSARY choosing the value in the first place --
  // exactly the gap that let this become an offensive close primitive against a rival contributor. Excluding it
  // here lets downgradeCloseToHold's per-rule precision check apply to a duplicate-driven close like any other
  // heuristic judgment, instead of exempting it from the one safety net meant to catch a systematically wrong
  // call. (In practice evaluateGateCheckCore's own duplicate-only HOLD, #9129, already prevents this finding from
  // producing a close outright -- this exclusion is defense-in-depth for any other path that still reaches here.)
  return concreteCloseEvidenceCodes(input).length > 0;
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
  /** #9808 second half: the guardrail-escalation settings, threaded as discrete fields like every other
   *  settings-derived input here. `onCleanReview: "proceed"` + at least one knob set + reviewGood releases
   *  the guardrail hold; anything less keeps today's behavior exactly. */
  guardrailEscalationOnCleanReview?: "hold" | "proceed" | null | undefined;
  guardrailEscalationEffort?: string | null | undefined;
  guardrailEscalationSelfConsistencyRuns?: number | null | undefined;
  guardrailEscalationModel?: string | null | undefined;
  guardrailEscalationProvider?: string | null | undefined;
  // Configured manual-review hold label. Undefined uses the default "manual-review"; null disables only the
  // label, not the guardrail hold. Separate from review_state_label so operators can avoid ready/changes labels.
  manualReviewLabel?: string | null | undefined;
  /** #9939: the head SHA at which the PLANNER previously applied `manualReviewLabel`, or null/absent when the
   *  bot did not apply it. This is the provenance that makes the label liftable: the same label string is
   *  also how a maintainer freezes a PR by hand, so without it the planner cannot remove its own stale hold
   *  without risking silently undoing a human's. Absent ⇒ never auto-removed. */
  manualReviewLabelAppliedSha?: string | null | undefined;
  // Optional disposition label overrides. Undefined uses generic defaults; null disables that specific label.
  readyToMergeLabel?: string | null | undefined;
  changesRequestedLabel?: string | null | undefined;
  migrationCollisionLabel?: string | null | undefined;
  pendingClosureLabel?: string | null | undefined;
  // #9009 (narrow scope): true when a transient marker recorded that manual-review was held/applied because a
  // PRIOR pass lost the AI-review lock race (a genuinely transient infra artifact -- see
  // aiReviewLockContendedResult, ai-review-orchestration.ts), AND this pass's fresh gate evaluation no longer
  // shows that specific contention (the caller clears the marker the moment contention resolves, regardless of
  // whether this flag ends up removing the label -- see buildAgentMaintenancePlanInput's caller). Deliberately
  // the ONLY provenance-tracked auto-clear condition: every OTHER manual-review trigger (guardrail, migration
  // collision, breaker downgrades, unstable-mergeable, a human's own hold, ...) still requires a maintainer to
  // lift it, exactly as before -- see the stale-disposition-label-cleanup comment below for why a general
  // provenance-free auto-clear is unsafe. Absent/false ⇒ byte-identical to pre-#9009 behavior.
  manualReviewLockContentionResolved?: boolean | undefined;
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
  // The repo-configured label applied to a blacklisted author's PR (#1425), resolved from `.loopover.yml`.
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
  // The repo-configured label applied to an over-cap author's PR/issue (#2270), resolved from `.loopover.yml`.
  // Absent ⇒ the default (`DEFAULT_CONTRIBUTOR_CAP_LABEL` = "over-contributor-limit"); explicit `null` ⇒ close
  // WITHOUT any label (#label-scoping). Gated on `close` autonomy, NOT `label` — same shape as {@link blacklistLabel}.
  contributorCapLabel?: string | null | undefined;
  // Review-nag cooldown (#2463, anti-abuse): when the PR author has pinged `@loopover` past the repo's
  // configured threshold within the cooldown window AND the repo's `reviewNagPolicy` is `"close"`, the
  // disposition SHORT-CIRCUITS to a deterministic label + close ahead of ALL merit/CI/AI analysis — same
  // zero-hallucination shape as blacklistMatch, so its close is tagged `closeKind: "review_nag"`. Fires for a
  // CONTRIBUTOR only (owner/admin/automation bots are never auto-closed). The comment-throttle decision itself
  // (counting pings, choosing hold vs. close) happens at the webhook trigger, not here — this input is already
  // the resolved "yes, close this PR" verdict. Absent / not-matched ⇒ no effect.
  reviewNagMatch?: { matched: boolean; authorLogin: string; pingCount: number; maxPings: number } | undefined;
  // The repo-configured label applied to a review-nag-closed PR (#2463), resolved from `.loopover.yml`.
  // Absent ⇒ the default (`DEFAULT_REVIEW_NAG_LABEL` = "review-nag-cooldown"); explicit `null` ⇒ close WITHOUT
  // any label (#label-scoping). Gated on `close` autonomy, NOT `label` — same shape as {@link blacklistLabel}.
  reviewNagLabel?: string | null | undefined;
  // Copycat/plagiarism containment (#1969): the deterministic containment engine (src/queue/copycat-detection.ts)
  // has already scored this PR against its candidate prior-art set before this input was built — `matched: true`
  // means the best-scoring candidate cleared the configured threshold with an unambiguous (earlier-submission)
  // direction. Unlike blacklistMatch/contributorCapMatch/reviewNagMatch, this alone does NOT short-circuit —
  // whether it does depends on `copycatGateMode` (see the block below): `block` short-circuits exactly like
  // those three; `label` only adds a standalone label (maybePlanCopycatLabel) and lets the normal pipeline
  // continue; `warn`/`off` never reach here with matched:true at all (the caller only sets this when the
  // engine's own wouldAct, which already requires a non-off mode, was true). `matchedPullNumber` is a PR
  // number — already public on GitHub — so it, unlike blacklistMatch's private reason, is safe to interpolate
  // into the public close/label reason text.
  copycatMatch?: { matched: boolean; score: number; matchedPullNumber: number } | undefined;
  // `gate.copycat.mode` resolved for this repo (off/warn/label/block); selects which of the two copycat
  // behaviors above (if either) applies. Absent ⇒ "off" (no effect), matching every other gate mode's
  // absent-means-off convention.
  copycatGateMode?: "off" | "warn" | "label" | "block" | undefined;
  // The repo-configured label applied by the copycat gate (#1969), resolved from `.loopover.yml`. Absent ⇒ the
  // default (`DEFAULT_COPYCAT_LABEL` = "copycat"); explicit `null` ⇒ act WITHOUT any label (#label-scoping).
  // At `block` tier this rides `close` autonomy (inseparable metadata on the close, like blacklistLabel); at
  // `label` tier it rides its own `label` autonomy (see maybePlanCopycatLabel).
  copycatLabel?: string | null | undefined;
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
  // Advisory check-run hold (#4372). A maintainer-declared `gate.advisoryCheckRuns` entry resolved COMPLETED to a
  // non-passing conclusion. The check was excluded from CI pass/fail entirely (it never blocks or freezes the
  // gate), but it must not be silently swallowed either: same risk profile as migrationCollisionHold — SUPPRESSES
  // the merge (folded into `heldForManualReview`), never causes a CLOSE, only downgrades a would-merge into a
  // held-for-review state so a maintainer can act on the signal their installed app raised. Each entry names the
  // triggering check/app/conclusion so the hold reason (and the manual-review label's comment) is actionable.
  advisoryCheckHold?: ReadonlyArray<{ name: string; appSlug: string; conclusion: string }> | undefined;
  // #9810 follow-up: non-passing check-runs the maintainer listed in `gate.ignoredCheckRuns`, as seen on this
  // head. Used ONLY to decide whether a GitHub "unstable" mergeable_state is fully explained by them -- the
  // CI aggregate already excludes these from pass/fail, but mergeable_state is GitHub's own computation and
  // stays unstable while the check exists at all.
  ignoredCheckNonPassing?: ReadonlyArray<{ name: string; appSlug: string; conclusion: string }> | undefined;
  // Non-required failing checks/statuses (#8758, the #8711 silent-stall fix). The CI aggregate's
  // nonRequiredFailingDetails: red checks that are neither branch-protection-required nor declared advisory —
  // they never feed ciState or a close, but GitHub folds them into mergeable_state "unstable", which suppresses
  // the merge below (mergeableClean requires "clean"). Pre-#8758 nothing else accounted for that state: approve
  // still fired ("gate satisfied, CI green"), the ready-to-merge label landed, and the only record of WHY the
  // merge never came was an internal audit row. Threaded here purely to NAME the culprit check(s) in the
  // unstable hold's reason/comment; the hold itself keys on pr.mergeableState, not on this list (an unstable
  // state whose source the aggregate couldn't itemize still holds, with generic wording).
  nonRequiredCheckFailures?: ReadonlyArray<{ name: string; summary?: string | undefined; detailsUrl?: string | undefined }> | undefined;
  // Unlinked-issue guardrail (#unlinked-issue-guardrail, credibility-gate-farming defense). The trigger
  // (runAgentMaintenancePlanAndExecute) has already run the deterministic pre-filter + AI verification for a
  // PR that links NO issue -- this input is already the resolved "yes, hold this merge" verdict (or absent,
  // meaning no confirmed direct match was found). Same risk profile as migrationCollisionHold: SUPPRESSES
  // the merge (folded into `heldForManualReview`), never causes a CLOSE, and is the rare exception to "a
  // missing linked issue is never a close reason" -- it only ever downgrades a would-merge into a held-for-
  // review state so a human can confirm the match before it's credited.
  unlinkedIssueMatchHold?: { reason: string; comment: string } | undefined;
  // #9738: the linked `gittensor:priority` issue's eligibility window has not elapsed. Priority carries the
  // highest payout, so first-come pickup is only fair if everyone can see the issue before anyone can act on
  // it. Same risk profile as the two holds above -- SUPPRESSES the merge (folded into `heldForManualReview`),
  // never closes, and clears itself once the window passes with no action from the contributor.
  priorityEligibilityHold?: { reason: string; comment: string } | undefined;
  // #9881: the screenshot-table gate is configured to BLOCK and this PR carries no visual evidence. Same risk
  // profile as the holds above -- SUPPRESSES the merge, never closes. It exists because `close` and
  // `advisory` were the only options: a one-shot pipeline has no "changes requested, try again" for
  // contributor work, so an enforcing gate destroyed PRs that had simply not attached screenshots yet, and
  // the contributor cannot reopen. Clears itself the moment evidence appears (a table, or a bot capture).
  screenshotEvidenceHold?: { reason: string; comment: string } | undefined;
  // Same guardrail as unlinkedIssueMatchHold, but for a CONFIRMED REPEAT by the same contributor (tracked via
  // audit_events, see resolveUnlinkedIssueMatchDisposition) -- a second occurrence is no longer a coincidence
  // worth a human's benefit of the doubt, so this closes the PR one-shot instead of holding it. Deliberately
  // NOT `closeConcreteEvidence` (stays subject to the close-precision breaker): the underlying signal is an
  // AI semantic-match verdict, and a systematically-wrong match must not become breaker-proof just because
  // it repeated. Mutually exclusive with unlinkedIssueMatchHold -- the resolver only ever returns one.
  unlinkedIssueMatchClose?: { reason: string; comment: string } | undefined;
  // AI-review low-confidence guardrail (#4603). The trigger (runAgentMaintenancePlanAndExecute) has already run
  // resolveAiReviewLowConfidenceHold (src/rules/advisory.ts) against the gate evaluation -- this input is already
  // the resolved "yes, hold this close" verdict (or absent, meaning the gate didn't fail solely on a sub-floor
  // AI-judgment finding under the `hold_for_review` disposition). UNLIKE migrationCollisionHold/unlinkedIssueMatchHold
  // (which suppress a would-MERGE), this suppresses a would-CLOSE: `willClose` below narrows its own
  // `conclusion === "failure"` arm on this field so a genuinely different adverse signal (red CI, a base conflict)
  // still closes normally -- only the "verdict=failure, driven solely by this AI-judgment blocker" path is held. The
  // gate check itself still reports failure (the merge stays blocked) -- only the one-shot CLOSE is suppressed.
  aiReviewLowConfidenceHold?: { reason: string; comment: string } | undefined;
  // Screenshot-table gate (#2006): a DETERMINISTIC verdict (no AI, zero hallucination risk) that an in-scope
  // visual/frontend PR's body is missing a before/after screenshot table (or has an image outside a table, or
  // a screenshot committed to the repo instead of uploaded to the PR) AND (#4110) the bot's own visual-capture
  // pipeline did not already produce a real before/after render for this head -- either piece of evidence
  // satisfies the gate, so `matched` here is already false whenever the bot capture succeeded (see
  // evaluateScreenshotTableGate's `botCaptureSatisfied` input). Same zero-hallucination short-circuit shape as
  // blacklistMatch — fires ahead of ALL merit/CI/AI analysis, for a CONTRIBUTOR only, so its close is tagged
  // `closeKind: "screenshot_table"`. Absent / not-violated ⇒ no effect. The caller (processors.ts) only ever
  // populates this field when the gate's configured `action` is `"close"` — an `"advisory"` violation (#4535)
  // never reaches the planner at all, by construction (see ScreenshotTableGateAction).
  screenshotTableMatch?: { matched: boolean; reason: string | null } | undefined;
  /** #9462: the screenshot-table gate is violated in `close` mode but a bounded capture retry is still pending
   *  for this head, so the evidence is UNRESOLVED rather than absent. Holds the PR (no close, and critically no
   *  merge) until the retry settles. */
  screenshotTableEvidenceUnresolved?: boolean | undefined;
  pr: {
    mergeableState?: string | null | undefined;
    reviewDecision?: string | null | undefined;
    slopRisk?: number | null | undefined;
    labels: string[];
    linkedDuplicateCount?: number | undefined;
    // #dup-winner-credit: the elected winner's PR number, when the election is confident enough to name one (see
    // dupWinnerLinkedDuplicateWinnerNumber). Only read below when linkedDuplicateCount > 0; null/absent falls
    // back to the pre-existing generic "duplicate of another open PR" wording.
    linkedDuplicateWinnerNumber?: number | null | undefined;
    // RC3 terminal-fail merges: the live head SHA + the SHA at which a prior merge was terminally blocked
    // (perms/required-check/conflict). When they match, the merge can't complete for this commit → suppress it.
    headSha?: string | null | undefined;
    mergeBlockedSha?: string | null | undefined;
    // #9012: the human-readable reason the merge is blocked. Purely for surfacing — with review_state_label on,
    // a terminally-blocked PR used to keep a ready-to-merge label and no other signal anywhere, so a contributor
    // looking at a green, approved, "ready" PR had no way to learn it would never merge and no reason to push.
    mergeBlockedReason?: string | null | undefined;
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
    // The PR's linked/closing issue numbers (#priority-linked-issue-gate-ownership), threaded through ONLY for
    // the `assign` disposition below -- same "harmless when absent" reasoning as authorLogin just above.
    linkedIssues?: number[] | undefined;
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

// Exported for the close-audit holdout (#8831), whose hold conversion must resolve the SAME labels.
export function resolveAgentDispositionLabels(settings: AgentDispositionLabelSettings): ResolvedAgentDispositionLabels {
  return {
    manualReview: resolveNullableLabel(settings.manualReviewLabel, AGENT_LABEL_NEEDS_REVIEW),
    readyToMerge: resolveNullableLabel(settings.readyToMergeLabel, AGENT_LABEL_READY),
    changesRequested: resolveNullableLabel(settings.changesRequestedLabel, AGENT_LABEL_CHANGES),
    migrationCollision: resolveNullableLabel(settings.migrationCollisionLabel, AGENT_LABEL_MIGRATION_COLLISION),
    pendingClosure: resolveNullableLabel(settings.pendingClosureLabel, AGENT_LABEL_PENDING_CLOSURE),
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
/**
 * Add the manual-review hold label to a plan, dropping any planned REMOVE of that same label (#10164).
 *
 * Three post-plan transforms surface this hold -- the merge circuit-breaker, the close circuit-breaker, and
 * the close-audit holdout (#8831, in review/close-audit-holdout.ts). All three had the same idempotency
 * check, and all three had the same hole in it: it looks for an existing ADD (`labelOp !== "remove"`) and
 * therefore does not notice a planned REMOVE. When the planner has already decided to release the label --
 * which section 1b does whenever nothing it knows about still wants a hold -- the transform appended an add
 * NEXT TO that remove. One plan, both operations, same label.
 *
 * The executor performs both, so the label is removed and re-added every pass, forever. Observed on
 * JSONbored/loopover#10155 flapping roughly every 90 seconds: four add/remove cycles in eight minutes,
 * burning GitHub write quota and notifying subscribers each time.
 *
 * Section 1b cannot fix this from its side. Its doc calls `noManualReviewHoldWanted` "every reason that would
 * ADD this label, in one place", but these three run AFTER the planner, so their reasons are not knowable
 * there -- #8831 in particular was added long after that condition was written. Resolving the contradiction
 * where the add happens is what makes it structural instead of a list someone must remember to extend.
 *
 * The remove is dropped rather than the add skipped: a transform only reaches here because it has just
 * diverted a merge or a close, so the hold it is surfacing is strictly newer information than the release the
 * planner decided before that diversion.
 */
export function withManualReviewHoldLabel(
  planned: PlannedAgentAction[],
  labelSettings: AgentDispositionLabelSettings,
  action: Omit<PlannedAgentAction, "actionClass" | "label" | "labelOp">,
): PlannedAgentAction[] {
  const labels = resolveAgentDispositionLabels(labelSettings);
  if (labels.manualReview === null) return planned;
  const isThisLabel = (candidate: PlannedAgentAction): boolean =>
    candidate.actionClass === "label" && candidate.label === labels.manualReview;
  // Drop a planned release of the very label we are about to add -- the contradiction this exists to prevent.
  const next = planned.filter((candidate) => !(isThisLabel(candidate) && candidate.labelOp === "remove"));
  if (next.some((candidate) => isThisLabel(candidate) && candidate.labelOp !== "remove")) return next; // already adding it
  next.push({ ...action, actionClass: "label", label: labels.manualReview, labelOp: "add" });
  return next;
}

export function downgradeMergeToHold(planned: PlannedAgentAction[], holdOnly: boolean, labelSettings: AgentDispositionLabelSettings = {}): PlannedAgentAction[] {
  if (!holdOnly || !planned.some((action) => action.actionClass === "merge")) return planned;
  const labels = resolveAgentDispositionLabels(labelSettings);
  const next = planned.filter((action) => action.actionClass !== "merge");
  // The dropped merge implies the PR is review-good — re-label it for manual review (replacing a stale
  // ready-to-merge promise) so the held PR is clearly flagged for a person. Idempotent: only add when absent.
  const stagedMerge = planned.find((action) => action.actionClass === "merge");
  // #10164: via withManualReviewHoldLabel so a planned RELEASE of this same label is dropped rather than
  // fought with, which is what made the label flap every pass.
  const withHold = withManualReviewHoldLabel(next, labelSettings, {
    // Authorized by `merge` (the class actually being downgraded here), NOT `review_state_label` — mirrors
    // the guardrail-hold label above (#label-scoping) so this hold label posts whenever merge autonomy is
    // acting, independent of whether the repo has separately opted into the advisory review_state_label class.
    autonomyClass: "merge",
    requiresApproval: stagedMerge?.requiresApproval ?? false,
    reason: "accuracy circuit-breaker engaged (merge precision dropped) — would-merge held for human review",
  });
  // Drop any ready-to-merge label add (the auto-merge it promised is now suppressed).
  return withHold.filter((action) => !(labels.readyToMerge !== null && action.actionClass === "label" && action.label === labels.readyToMerge && action.labelOp !== "remove"));
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
 * #7986: the concrete-evidence exemption above is no longer UNCONDITIONAL. `untrustworthyRuleCodes` — the
 * set of blocker codes whose OWN measured close-precision has dropped below its floor over a real sample
 * (`rulesBelowClosePrecisionFloor` over `computeBlendedRuleGateEval`, #7984) — makes a close's concrete
 * evidence STOP counting as an exemption when EVERY code that justified it (`closeConcreteEvidenceCodes`) is
 * in that set. This fires INDEPENDENTLY of `closeHoldOnly` (the PROJECT-level flag): a single systematically
 * wrong rule can sit at 0% precision while diluted into an otherwise-healthy project aggregate (exactly the
 * class of bug #7984 exists to surface), so this rule-level check must not wait for the project flag to
 * engage. A code with an insufficient sample, or one that isn't in the set at all, keeps its exemption --
 * `rulesBelowClosePrecisionFloor`'s own "insufficient sample defaults to keeping the exemption" contract.
 * `untrustworthyRuleCodes` defaults to empty (byte-identical to pre-#7986 behavior when omitted).
 *
 * The existing changes-requested label is KEPT (it correctly says the PR is not mergeable). PURE + idempotent:
 * with `closeHoldOnly` false AND no untrustworthy-rule match, this returns the plan UNCHANGED (the common
 * path); with no downgradable close planned it is also a no-op. Only ever makes the system MORE cautious.
 */
export function downgradeCloseToHold(
  planned: PlannedAgentAction[],
  closeHoldOnly: boolean,
  labelSettings: AgentDispositionLabelSettings = {},
  untrustworthyRuleCodes: ReadonlySet<string> = new Set(),
): PlannedAgentAction[] {
  // #9086: the breaker exemption used to key on `closeKind === "heuristic"` alone, so all SIX non-heuristic
  // close paths (blacklist, contributor_cap, review_nag, copycat, screenshot_table, and the linked-issue hard
  // rule) were returned untouched by BOTH Reason A and Reason B — and none of them gets the executor-side live
  // recheck either, which is likewise gated on "heuristic".
  //
  // The stated justification ("zero-hallucination, deterministic") holds for the IDENTITY-based closes:
  // blacklist and contributor_cap read facts about an account, so a precision breaker has nothing to add. It
  // does NOT hold for the CONTENT-INSPECTION closes, whose "determinism" is a regex heuristic over free-text
  // markdown — screenshot_table is our single top close reason all-time. A deterministic rule can still be
  // systematically wrong, which is precisely what the breaker exists to catch.
  const CONTENT_INSPECTION_CLOSE_KINDS: ReadonlySet<string> = new Set(["screenshot_table", "review_nag", "copycat"]);
  const isBreakerEligibleClose = (action: PlannedAgentAction): boolean =>
    action.closeKind === "heuristic" || (action.closeKind !== undefined && CONTENT_INSPECTION_CLOSE_KINDS.has(action.closeKind));

  // Reason A (project-level, unchanged from before #7986): no concrete evidence at all, AND the project's
  // close-precision breaker has engaged.
  const noConcreteEvidenceUnderProjectBreaker = (action: PlannedAgentAction): boolean =>
    action.actionClass === "close" && isBreakerEligibleClose(action) && action.closeConcreteEvidence !== true && closeHoldOnly;
  // Reason B (#7986, per-rule, independent of closeHoldOnly): HAS concrete evidence, but every code that
  // justified it has its own bad track record. `.every` (not `.some`) so a close backed by a MIX of a
  // trustworthy code and an untrustworthy one keeps its exemption via the trustworthy code -- only a close
  // whose EVERY justifying code is known-bad loses it.
  const everyJustifyingCodeUntrustworthy = (action: PlannedAgentAction): boolean => {
    const codes = action.closeConcreteEvidenceCodes ?? [];
    return codes.length > 0 && codes.every((code) => untrustworthyRuleCodes.has(code));
  };
  const isDowngradableClose = (action: PlannedAgentAction): boolean =>
    action.actionClass === "close" &&
    isBreakerEligibleClose(action) &&
    (noConcreteEvidenceUnderProjectBreaker(action) || (action.closeConcreteEvidence === true && everyJustifyingCodeUntrustworthy(action)));
  if (!planned.some(isDowngradableClose)) return planned;
  // #9158 (label-close-split-brain, breaker-downgrade half): dropping a close here must ALSO drop any label
  // COUPLED to it -- the anti-abuse label pushed alongside a blacklist/contributor_cap/review_nag/copycat
  // close carries the SAME closeKind and is inseparable metadata on that close (see planContributorCapClose's/
  // the blacklist/review-nag/copycat closes' own doc comments: close is always pushed BEFORE its label, same
  // batch). The executor's own #label-close-split-brain correlation guard (agent-action-executor.ts's
  // coupledCloseOutcome) only fires when the close is STILL in the plan and denied/errored this pass -- once
  // the close is removed from the plan entirely (exactly what downgrading does), there is nothing left for
  // that guard to correlate against, so it silently lets the orphaned label through. Filtering it out HERE,
  // at the one place the close is actually dropped, closes that gap without needing the executor to guess
  // whether an absent close means "never coupled" (e.g. maybePlanCopycatLabel's label-only copycat tier, which
  // legitimately has no close to drop) or "was coupled but just got downgraded".
  const droppedCloseKinds = new Set(planned.filter(isDowngradableClose).map((action) => action.closeKind).filter((kind): kind is NonNullable<PlannedAgentAction["closeKind"]> => kind !== undefined));
  const isOrphanedCoupledLabel = (action: PlannedAgentAction): boolean => action.actionClass === "label" && action.closeKind !== undefined && droppedCloseKinds.has(action.closeKind);
  // Drop the downgradable close(s) AND any label coupled to one of them; a deterministic linked-issue-hard-rule
  // close/label pair (if any) is left intact -- isDowngradableClose never matches that closeKind (see this
  // function's own doc comment above), so it can never end up in droppedCloseKinds.
  const next = planned.filter((action) => !isDowngradableClose(action) && !isOrphanedCoupledLabel(action));
  // The dropped close means the PR is held for a person — surface the manual-review label. Idempotent: only add when
  // absent (e.g. a guarded-but-passing plan may already carry it). NEVER adds a merge/approve.
  const droppedClose = planned.find(isDowngradableClose);
  // #10164: see withManualReviewHoldLabel — drops a planned release of this label instead of racing it.
  // KEEP the changes-requested label (it correctly states the PR is not mergeable) and every other action.
  return withManualReviewHoldLabel(next, labelSettings, {
    // Authorized by `close` (the class actually being downgraded here), NOT `review_state_label` — same
    // reasoning as downgradeMergeToHold's own manual-review label above (#label-scoping).
    autonomyClass: "close",
    requiresApproval: droppedClose?.requiresApproval ?? false,
    reason: "close-precision circuit-breaker engaged — would-close held for human review",
  });
}

function closeMessage(reasons: string[]): string {
  return `LoopOver is closing this pull request on the maintainer's behalf (${reasons.join("; ")}). This is an automated maintenance action — to pursue this change, please open a new pull request with the issues resolved. Closed PRs may be analyzed later to improve review accuracy, but they are not automatically reopened or re-reviewed.`;
}

// The close comment for a blacklisted author (#1425). Do not interpolate maintainer-supplied blacklist metadata:
// reasons/evidence may come from private configuration, and this string is posted to the public PR thread.
function blacklistCloseMessage(): string {
  return "LoopOver is closing this pull request on the maintainer's behalf. This account is blocked from contributing to this repository, so the change was not reviewed on its merits. This is an automated maintenance action.";
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
  return `LoopOver closed this because @${authorLogin} has ${openCount} open ${itemNoun}, above ${scopeDescription} of ${cap}. Close or merge an existing one to open a new one. This is an automated maintenance action.`;
}

/**
 * Plan JUST the per-contributor open-item cap short-circuit (#7284-fix, resource-waste ordering) — factored
 * out of planAgentMaintenanceActions so a cheap, CI-independent caller (the PR-open webhook path in
 * processors.ts) can plan the SAME close+label actions the full disposition plan would eventually produce,
 * without needing gate/ciAggregate/blacklistEntry/etc — none of which this short-circuit ever reads. Pure,
 * deterministic, zero-hallucination, identical output to what planAgentMaintenanceActions itself produces for
 * the same contributorCapMatch input (that function calls this as its own first check, below).
 */
export function planContributorCapClose(input: {
  autonomy: AutonomyPolicy | null | undefined;
  authorIsOwner: boolean;
  authorIsAdmin: boolean;
  authorIsAutomationBot: boolean;
  contributorCapMatch: AgentActionPlanInput["contributorCapMatch"];
  contributorCapLabel: AgentActionPlanInput["contributorCapLabel"];
  pr: { headSha?: string | null | undefined };
}): PlannedAgentAction[] | null {
  const capContributor = !input.authorIsOwner && !input.authorIsAdmin && !input.authorIsAutomationBot;
  if (input.contributorCapMatch?.matched !== true || !capContributor) return null;
  const level = (actionClass: AgentActionClass) => resolveAutonomy(input.autonomy, actionClass);
  const acting = (actionClass: AgentActionClass) => isActingAutonomyLevel(level(actionClass));
  const approval = (actionClass: AgentActionClass) => autonomyRequiresApproval(level(actionClass));
  const { authorLogin, openCount, cap, itemKind, scope } = input.contributorCapMatch;
  const label = resolveNullableLabel(input.contributorCapLabel, DEFAULT_CONTRIBUTOR_CAP_LABEL);
  const actions: PlannedAgentAction[] = [];
  if (acting("close")) {
    actions.push({
      actionClass: "close",
      requiresApproval: approval("close"),
      reason: "over the per-contributor open-item cap",
      closeReasons: ["over the per-contributor open-item cap"],
      closeComment: sanitizePublicComment(contributorCapCloseMessage(authorLogin, openCount, cap, itemKind, scope)),
      closeKind: "contributor_cap",
      ...(input.pr.headSha ? { expectedHeadSha: input.pr.headSha } : {}),
    });
  }
  if (acting("close") && label !== null) actions.push({ actionClass: "label", autonomyClass: "close", closeKind: "contributor_cap", requiresApproval: approval("close"), reason: "over the per-contributor open-item cap", label, labelOp: "add" });
  return actions;
}

// The close comment for review-nag cooldown (#2463). DOES interpolate authorLogin/pingCount/maxPings — none of
// that is private (the author's own login and their own public @loopover ping count are already public/
// derivable from the PR thread itself), mirroring the contributor-cap close message's same reasoning.
function reviewNagCloseMessage(authorLogin: string, pingCount: number, maxPings: number): string {
  return `LoopOver closed this because @${authorLogin} pinged @loopover ${pingCount} times, above this repository's configured limit of ${maxPings}. Please wait for the cooldown window to pass before requesting review again. This is an automated maintenance action.`;
}

// The close comment for the copycat/plagiarism containment gate's `block` tier (#1969). `matchedPullNumber` is a
// PR number — already public on GitHub — so, unlike blacklistCloseMessage's deliberately-static text, it's safe
// to interpolate; the raw containment score/threshold are NOT interpolated (private scoring internals stay off
// the public surface, matching this repo's public-safe-comment convention).
function copycatCloseMessage(matchedPullNumber: number): string {
  return `LoopOver is closing this pull request on the maintainer's behalf. Its added code overlaps prior art already submitted in #${matchedPullNumber} above this repository's configured threshold. This is an automated maintenance action — to pursue original work, please open a new pull request.`;
}

// The close comment for the screenshot-table gate (#2006). `reason` is the repo-configured (or built-in
// default) templated contract message — already public-safe by construction (it is either the maintainer's own
// configured `.loopover.yml` text or the static DEFAULT_SCREENSHOT_CONTRACT_MESSAGE, never AI/user-derived),
// so it is interpolated directly, unlike blacklistCloseMessage's deliberately-static text.
function screenshotTableCloseMessage(reason: string): string {
  return `${reason} This is an automated maintenance action.`;
}

// #4372: name the advisory check-run(s) that forced a manual-review hold, for the label reason (audit) and the
// public comment. No vendor name is hardcoded — the values come from the maintainer's own `gate.advisoryCheckRuns`.
function advisoryHoldReason(holds: ReadonlyArray<{ name: string; appSlug: string; conclusion: string }>): string {
  const parts = holds.map((h) => `"${h.name}" (${h.appSlug}) concluded ${h.conclusion}`);
  return `advisory check-run held for manual review: ${parts.join("; ")}`;
}

function advisoryHoldComment(holds: ReadonlyArray<{ name: string; appSlug: string; conclusion: string }>): string {
  const parts = holds.map((h) => `\`${h.name}\` (from \`${h.appSlug}\`) concluded \`${h.conclusion}\``);
  return `Held for manual review: a maintainer-configured advisory check-run reported a non-passing result — ${parts.join("; ")}. This does not block CI, but a maintainer should review it. This is an automated maintenance action.`;
}

// #10116: `mergeUnstableHoldReason` and `mergeUnstableHoldComment` lived here. Both existed only to word the
// manual-review hold that a GitHub "unstable" mergeable state used to trigger; with no such hold there is no
// action left to hang either string on (there is no comment-only AgentActionClass — a comment always rides a
// label/approve/merge). `nonRequiredCheckFailures` stays on the planner input: the ignored-check
// reconciliation still reads it, and it is what #9810's `unstableExplainedByIgnoredChecks` is computed from.

/**
 * Plan best-effort assignment of the PR's opening contributor (#3182), independent of merge/close/CI outcome.
 * MUST run before the CI-pending settle-before-decide return below (#assign-before-ci-pending) — a PR that has
 * already been reviewed/evaluated (conclusion isn't "skipped") should get an assignee for triage even while an
 * unrelated check is still pending; assign has no bearing on mergeability so it never needs CI to settle first.
 * Gated purely on its own `assign` autonomy class, same as every other independent action here.
 *
 * Do NOT mirror this assignment to PR-body linked issues. Those issue numbers are contributor-controlled
 * closing references, while downstream linked-issue ownership checks intentionally treat issue assignees as a
 * maintainer-granted authorization signal.
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
 * Plan the copycat/plagiarism containment gate's `label` tier (#1969): unlike the `block` tier's short-circuit
 * above, `label` mode does NOT stop merit/CI/AI analysis — it only flags the PR with a label for a human to
 * look at while the normal pipeline continues untouched, so it rides its own `label` autonomy class (not
 * coupled to `close`) and is applied independently, like maybePlanAssign, regardless of CI/merge state.
 */
function maybePlanCopycatLabel(actions: PlannedAgentAction[], input: AgentActionPlanInput): void {
  if (input.copycatGateMode !== "label" || input.copycatMatch?.matched !== true) return;
  if (input.authorIsOwner || input.authorIsAdmin || input.authorIsAutomationBot) return;
  const label = resolveNullableLabel(input.copycatLabel, DEFAULT_COPYCAT_LABEL);
  if (label === null) return;
  const level = resolveAutonomy(input.autonomy, "label");
  if (!isActingAutonomyLevel(level)) return;
  actions.push({
    actionClass: "label",
    closeKind: "copycat",
    requiresApproval: autonomyRequiresApproval(level),
    reason: "copycat containment above threshold",
    label,
    labelOp: "add",
  });
}

/**
 * Plan the maintainer auto-maintain actions for one PR. Returns a COHERENT set (never both approve and
 * request-changes; never both merge and close), each entry already filtered to an acting autonomy class.
 * Ordered least → most irreversible: label, then the review, then the disposition.
 */

/**
 * PURE. The {@link PrDispositionInput} the planner feeds {@link derivePrDisposition}, extracted so a caller
 * that needs the HOLD CAUSE can recompute it from the same plan input (#9991).
 *
 * Extracted rather than threaded out of `planAgentMaintenanceActions`: that function returns
 * `PlannedAgentAction[]`, and a hold's defining shape is that NOTHING was planned -- so there is no action to
 * hang the cause on, and widening the return type would churn five production call sites and roughly thirty
 * test ones for a field only the ledger write needs. One shared builder, called twice, is cheaper and keeps
 * the two answers derived from the same expression rather than from two constructions that can drift.
 *
 * `derived` carries the four values the planner computes on its way here; every one is itself a function of
 * `input`, which is what makes recomputing this outside the planner sound rather than approximate.
 */
function buildPrDispositionInput(
  input: AgentActionPlanInput,
  derived: { reviewGood: boolean; guardrailHit: boolean; guardrailEscalationCleared: boolean; closeActing: boolean },
): PrDispositionInput {
  return {
    mergeableState: input.pr.mergeableState,
    reviewGood: derived.reviewGood,
    guardrailHit: derived.guardrailHit,
    guardrailEscalationCleared: derived.guardrailEscalationCleared,
    migrationCollisionHold: input.migrationCollisionHold !== undefined,
    unlinkedIssueMatchHold: input.unlinkedIssueMatchHold !== undefined,
    priorityEligibilityHold: input.priorityEligibilityHold !== undefined,
    screenshotEvidenceHold: input.screenshotEvidenceHold !== undefined,
    advisoryCheckHold: input.advisoryCheckHold !== undefined && input.advisoryCheckHold.length > 0,
    // Deliberately conjoined with "nothing else adverse": an unstable state is only attributed to the ignore
    // list when our own aggregate found NO failing check of any kind. If some other non-required check is
    // also red, failingDetails is non-empty and the hold stands -- an ignore must never mask a real failure.
    unstableExplainedByIgnoredChecks:
      input.ignoredCheckNonPassing !== undefined && input.ignoredCheckNonPassing.length > 0 && (input.nonRequiredCheckFailures ?? []).length === 0 && input.ciState !== "failed",
    unlinkedIssueMatchCloseWithoutCloseActing: input.unlinkedIssueMatchClose !== undefined && !derived.closeActing,
  };
}

/**
 * PURE. Which declared hold inputs are suppressing this PR's merge, in MERGE_HOLD_INPUTS declaration order.
 *
 * #9991: the ledger recorded `reason_code: "success"` for a held PR, because `deriveDecisionReasonCode` falls
 * through to the gate conclusion when there is no blocker and no policy close. On the production Orb that is
 * 518 holds across 146 pull requests filed under a value that is not a reason at all -- and #9729 cannot run a
 * per-path backtest clearance against a bucket conflating seven mechanisms.
 *
 * Recomputed from the plan input rather than returned by the planner, for the reason in
 * {@link buildPrDispositionInput}: a hold's defining shape is that no action was planned, so there is nothing
 * in `PlannedAgentAction[]` to carry it. Both call sites go through the same builder, so the cause recorded in
 * the ledger is the same expression that suppressed the merge, not a second opinion about it.
 *
 * Empty when nothing declared held it -- including when the only suppressor is the unstable mergeable state,
 * which is GitHub's computation rather than one of our declared inputs and is reported separately by
 * `heldForUnstableMergeState`.
 */
export function resolveHoldCause(input: AgentActionPlanInput): MergeHoldInput[] {
  const level = (actionClass: AgentActionClass) => resolveAutonomy(input.autonomy, actionClass);
  const guardrailHit = isGuardrailHit(input.changedPaths, input.hardGuardrailGlobs);
  const reviewGood = input.conclusion === "success" && input.ciState === "passed";
  const escalationConfigured =
    input.guardrailEscalationEffort != null ||
    input.guardrailEscalationSelfConsistencyRuns != null ||
    input.guardrailEscalationModel != null ||
    input.guardrailEscalationProvider != null;
  const guardrailEscalationCleared = guardrailHit && reviewGood && escalationConfigured && input.guardrailEscalationOnCleanReview === "proceed";
  return derivePrDisposition(
    buildPrDispositionInput(input, { reviewGood, guardrailHit, guardrailEscalationCleared, closeActing: isActingAutonomyLevel(level("close")) }),
  ).heldBy;
}

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
    const label = resolveNullableLabel(input.blacklistLabel, DEFAULT_BLACKLIST_LABEL);
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
  // fires ahead of ALL merit/CI/AI analysis, for a CONTRIBUTOR only. Delegates to planContributorCapClose
  // (#7284-fix) so the SAME short-circuit is also directly callable from a CI-independent caller (the PR-open
  // webhook path in processors.ts) without needing this function's other inputs (gate/ciAggregate/etc, none of
  // which this short-circuit reads).
  const capClose = planContributorCapClose({
    autonomy: input.autonomy,
    authorIsOwner: input.authorIsOwner,
    authorIsAdmin: input.authorIsAdmin,
    authorIsAutomationBot: input.authorIsAutomationBot,
    contributorCapMatch: input.contributorCapMatch,
    contributorCapLabel: input.contributorCapLabel,
    pr: input.pr,
  });
  if (capClose !== null) return capClose;

  // Review-nag cooldown (#2463): same zero-hallucination short-circuit shape as the blacklist above — fires
  // ahead of ALL merit/CI/AI analysis, for a CONTRIBUTOR only. The webhook trigger has already decided "this
  // ping crosses the threshold AND the repo's policy is close" before ever setting this input; the planner's
  // only job is to build the deterministic label+close plan under the repo's normal autonomy/dry-run/kill-switch
  // gates, exactly like every other action.
  const reviewNagContributor = !input.authorIsOwner && !input.authorIsAdmin && !input.authorIsAutomationBot;
  if (input.reviewNagMatch?.matched === true && reviewNagContributor) {
    const { authorLogin, pingCount, maxPings } = input.reviewNagMatch;
    // #label-scoping: same close-autonomy-gated, null-clearable shape as the blacklist label above.
    const label = resolveNullableLabel(input.reviewNagLabel, DEFAULT_REVIEW_NAG_LABEL);
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

  // Copycat/plagiarism containment, `block` tier only (#1969): same zero-hallucination short-circuit shape as
  // blacklist/contributor-cap/review-nag above — the containment engine already resolved "matched" precision-
  // first (unambiguous earlier-submission direction + score above threshold) before this input was built, so a
  // match at `block` mode fires ahead of ALL merit/CI/AI analysis, tagged `closeKind: "copycat"` so it feeds the
  // moderation-rules strike ledger the same way blacklist/contributor_cap/review_nag do. `label` mode does NOT
  // short-circuit here — see maybePlanCopycatLabel below, called from the normal (non-short-circuiting) part of
  // the pipeline instead.
  const copycatContributor = !input.authorIsOwner && !input.authorIsAdmin && !input.authorIsAutomationBot;
  if (input.copycatMatch?.matched === true && copycatContributor && input.copycatGateMode === "block") {
    const label = resolveNullableLabel(input.copycatLabel, DEFAULT_COPYCAT_LABEL);
    if (acting("close")) {
      actions.push({
        actionClass: "close",
        requiresApproval: approval("close"),
        reason: "copycat containment above threshold",
        closeReasons: ["copycat containment above threshold"],
        closeComment: sanitizePublicComment(copycatCloseMessage(input.copycatMatch.matchedPullNumber)),
        closeKind: "copycat",
        ...(input.pr.headSha ? { expectedHeadSha: input.pr.headSha } : {}),
      });
    }
    if (acting("close") && label !== null) actions.push({ actionClass: "label", autonomyClass: "close", closeKind: "copycat", requiresApproval: approval("close"), reason: "copycat containment above threshold", label, labelOp: "add" });
    return actions;
  }

  // Screenshot-table gate (#2006): same zero-hallucination short-circuit shape as the blacklist above — fires
  // ahead of ALL merit/CI/AI analysis, for a CONTRIBUTOR only. The trigger has already resolved scope (label/
  // path match) and run the deterministic body/diff-OR-bot-capture check (#4110) before ever setting this
  // input; the planner's only job is to build the close plan under the repo's normal autonomy/dry-run/kill-
  // switch gates. No coupled label (unlike blacklist/contributor-cap/review-nag) — the templated close comment
  // already IS the full contract, so a separate enforcement label would be redundant noise on a PR that's
  // about to be closed anyway.
  const screenshotTableContributor = !input.authorIsOwner && !input.authorIsAdmin && !input.authorIsAutomationBot;
  // #9462: the gate is violated in close mode but its evidence cannot be evaluated right now (the bot's own
  // capture pipeline has a bounded retry pending for this head). Previously this left screenshotTableMatch
  // undefined and the plan simply fell through to ordinary merit/CI evaluation -- so a green PR planned a
  // MERGE, with no finding, hold or blocker representing "screenshot evidence unresolved". That is a
  // disposition inversion: a PR the gate would have CLOSED could instead merge. Hold instead, mirroring
  // pre-merge-checks' PRE_MERGE_CHECK_UNRESOLVED_CODE, whose doc is explicit that an unresolvable enforced
  // check must never silently skip a hard requirement (an auto-merge bypass). Returning no actions is the hold:
  // neither the close (the evidence may yet arrive) nor the merge (it may yet not).
  if (input.screenshotTableEvidenceUnresolved === true && screenshotTableContributor) {
    return actions;
  }
  if (input.screenshotTableMatch?.matched === true && screenshotTableContributor) {
    if (acting("close")) {
      const reason = input.screenshotTableMatch.reason ?? "missing a before/after screenshot table";
      actions.push({
        actionClass: "close",
        requiresApproval: approval("close"),
        reason: "missing before/after screenshot table",
        closeReasons: ["missing before/after screenshot table"],
        closeComment: sanitizePublicComment(screenshotTableCloseMessage(reason)),
        closeKind: "screenshot_table",
        ...(input.pr.headSha ? { expectedHeadSha: input.pr.headSha } : {}),
      });
    }
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
  maybePlanCopycatLabel(actions, input);

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
  // #8759: the raw mergeable_state string is interpreted ONLY by assessMergeableState — one shared meaning.
  const isConflict = assessMergeableState(input.pr.mergeableState) === "conflict"; // conflicts with base — can't merge as-is
  // True when an unresolved GitHub review thread is (at least one of) this close's justifications -- the SAME
  // staleness class as isConflict above (#3863), just triggered by a contributor clicking "Resolve conversation"
  // on GitHub instead of the base branch becoming mergeable again. A mixed blocker set (thread + something else)
  // still counts: the thread recheck only re-verifies ITS OWN signal, so it's harmless to also gate on it here.
  const isReviewThreadJustified = (input.gateBlockerCodes ?? []).includes(REVIEW_THREAD_BLOCKER_CODE);
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
  //
  // A confirmed repeat unlinked-issue-match (unlinkedIssueMatchClose) is ALSO folded in here, but only when
  // `close` autonomy is NOT acting (gate-review finding): without this, a repo running `merge: auto` with
  // `close` unset/observe would see `unlinkedIssueMatchViolated` below evaluate false (it requires
  // `acting("close")`), and — since nothing else accounts for the confirmed repeat — an otherwise-green PR
  // would silently MERGE straight through the escalation instead of being held. When `close` IS acting, the
  // dedicated close branch below handles it and this term is redundant (harmless: both paths agree the PR
  // must not silently merge).
  // #8759: the hold/approve/merge core now comes from the SHARED disposition module — the same
  // derivation the unified comment's bridge reads — so the four surfaces can never again disagree on
  // what a raw mergeable_state means (#8711's root class). The unstable-hold semantics are #8758's,
  // unchanged (see derivePrDisposition's own doc + the MergeableAssessment contract): "dirty" stays the
  // close path, "behind" stays the rebase rail's, "blocked"/"unknown" stay approvable, "unstable" holds
  // loudly. The disposition's wouldApprove/wouldMerge feed the approve/merge gates below, still
  // conjoined with the planner-private terms (autonomy, idempotency, approvals, terminal-block) that
  // are not disposition. reviewGood is computed here (moved up from beside canMerge — same formula,
  // gate passes AND CI green) because the disposition needs it.
  const reviewGood = gatePassing && ciPassed;
  // #9808 second half: a clean ESCALATED review releases the guardrail hold -- full-autonomy mode. All four
  // conjuncts are load-bearing:
  //   - the mode is an explicit opt-in (`guardrailEscalation.onCleanReview: proceed`), default hold, layered
  //     global -> per-repo like every other manifest field, so an operator can flip one repo at a time;
  //   - at least one escalation knob must actually be SET -- the release is justified by extra scrutiny, so
  //     absent scrutiny there is nothing to vouch for the guarded path (fail-closed against a config that
  //     sets the mode but forgets the escalation);
  //   - reviewGood: the gate passed (which already folds in the AI verdict's blockers -- a consensus blocker
  //     fails the gate) AND CI is green;
  //   - guardrailHit, or there is nothing to clear.
  const escalationConfigured =
    input.guardrailEscalationEffort != null ||
    input.guardrailEscalationSelfConsistencyRuns != null ||
    input.guardrailEscalationModel != null ||
    input.guardrailEscalationProvider != null;
  const guardrailEscalationCleared =
    guardrailHit && reviewGood && escalationConfigured && input.guardrailEscalationOnCleanReview === "proceed";
  const disposition = derivePrDisposition(buildPrDispositionInput(input, { reviewGood, guardrailHit, guardrailEscalationCleared, closeActing: acting("close") }));
  const heldForManualReview = disposition.heldForManualReview;
  const mergeableStateUnstable = disposition.heldForUnstableMergeState;
  const labels = resolveAgentDispositionLabels(input);
  // Canonical (reviewbot non-content-gate) policy, tuned to the operator's minimize-manual goal: merge-or-close
  // with high accuracy; manual review is the RARE exception. A PR is "review-good" when the gate passes AND CI is
  // green — that's the only thing that earns an auto-merge or an approve. Everything else, for a CONTRIBUTOR, is a
  // one-shot CLOSE (taopedia model: resolve + open a fresh PR). The guardrail is handled SEPARATELY: it converts
  // would-approve/would-merge dispositions into a manual hold.
  const ciUnverified = input.ciState === "unverified";
  // RC3: a prior merge attempt failed terminally for THIS exact head SHA (403/405/409/conflict) → never re-plan
  // the merge; it can't complete for this commit. A new commit makes the live head differ from mergeBlockedSha.
  // The caller passes through only a block that is still IN EFFECT (#9012 — isMergeBlockInEffect resolves the
  // infra-scoped expiry against the clock), so this stays a plain head comparison and the planner stays pure.
  const mergeTerminallyBlocked = input.pr.mergeBlockedSha != null && input.pr.headSha != null && input.pr.mergeBlockedSha === input.pr.headSha;
  // Re-approval idempotency: this exact commit is already bot-approved when the stored approved-head SHA equals
  // the live head SHA → never re-post an approval for it (a GitHub App's own approval does not reliably flip
  // reviewDecision to APPROVED, so reviewDecision alone can't dedup). A new commit makes the heads differ →
  // approve may fire again. Absent approved-head SHA (never approved by the bot) ⇒ not idempotent-skipped.
  const alreadyApprovedThisHead = input.pr.approvedHeadSha != null && input.pr.headSha != null && input.pr.approvedHeadSha === input.pr.headSha;
  // #8759: disposition.wouldMerge = reviewGood && !held && exactly-clean — the shared core; the terms
  // conjoined here (autonomy, approvals, terminal-block) are planner-private state, not disposition.
  const canMerge = disposition.wouldMerge && acting("merge") && approvalsSatisfied && !mergeTerminallyBlocked;
  // CLOSE a contributor PR ONLY on a REAL adverse signal — a confirmed gate FAILURE, red CI, or a base
  // CONFLICT. NEVER close merely because CI is UNVERIFIED (a fork whose Actions await approval, or unreadable
  // checks) or otherwise not-yet-mergeable — those are HELD for review, not killed (#harm-stop fork-false-close).
  // Owner/automation PRs are never closed unless owner-close is explicitly enabled. Guardrails do not soften
  // blockers/conflicts/red CI; they hold only otherwise-ready PRs for manual review.
  // (Rebase-if-behind already ran above, so a red CI here is on the latest base — not a stale-base artifact.) (#ci-fail-closes-guarded)
  // aiReviewLowConfidenceHold (#4603) narrows ONLY the `conclusion === "failure"` arm -- ciFailed/isConflict still
  // close normally even when a sub-floor AI-judgment finding also happens to be present, matching how a real
  // guardrail hold never softens those two either (see the comment above).
  const willClose = closeEligible && acting("close") && (ciFailed || (conclusion === "failure" && input.aiReviewLowConfidenceHold === undefined) || isConflict);
  // Unlinked-issue-match REPEAT close (#unlinked-issue-guardrail-followup): a CONFIRMED repeat of the
  // credibility-gate-farming pattern (tracked via audit_events in resolveUnlinkedIssueMatchDisposition) — not
  // an immediate close on the first occurrence (that stays a hold, unlinkedIssueMatchHold), only once the same
  // contributor has done it before. Takes PRECEDENCE over merge below, same reasoning as the linked-issue
  // hard-rule close: a confirmed repeat offender must never auto-merge just because CI happens to be green.
  const unlinkedIssueMatchViolated = input.unlinkedIssueMatchClose !== undefined && closeEligible && acting("close");
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
  // Hoisted above section 1 (#stale-disposition-label-cleanup) so the review_state_label sibling-label
  // cleanup below can tell whether the owner/automation "not reviewGood" fallback hold (below, #1089) still
  // wants `labels.manualReview` this same pass, even when this ternary's own choice picks a different label
  // (e.g. ciUnverified: reviewGood is false, so the ternary below picks changesRequested, but the fallback
  // still separately wants manualReview) — without this, the cleanup would remove a label the fallback is
  // about to re-add later in this same pass. See its own doc comment at the (former) point of use below.
  const manualHoldReason =
    guardrailHit && !guardrailEscalationCleared
      ? `verdict=${conclusion}; ${guardrailReason}`
      : ciUnverified
        ? "CI could not be verified"
        : conclusion === "action_required"
          ? "review requires maintainer action"
          : !reviewGood && !willClose && (!closeEligible || acting("close"))
            ? `verdict=${conclusion}${ciReason ? `; ${ciReason}` : ""}`
            : null;

  // 1) manual-review label — a configurable, single-purpose label for guardrail holds. This is intentionally
  // separate from review_state_label so a one-shot repo can opt into `manual-review` without also enabling the
  // older ready/changes disposition labels. It is authorized by merge autonomy because it only fires when a
  // would-merge PR is held for a human by a guardrail.
  //
  // `!guardrailEscalationCleared` is load-bearing (#9808/#9869): the label announces a HOLD, and a cleared
  // escalation means there is no hold — the escalated review vouched for the guarded path and the merge below
  // proceeds. Without this term the planner emitted both in the same pass, merging the PR while also tagging it
  // for a human to look at, which is self-contradictory and leaves a manual-review label sitting on merged PRs
  // in exactly the full-autonomy mode this feature exists to enable.
  if (reviewGood && guardrailHit && !guardrailEscalationCleared && labels.manualReview !== null && acting("merge") && !hasLabelOrPlanned(input.pr.labels, actions, labels.manualReview)) {
    actions.push({
      actionClass: "label",
      autonomyClass: "merge",
      requiresApproval: approval("merge"),
      reason: `verdict=${conclusion}; ${guardrailReason}`,
      label: labels.manualReview,
      labelOp: "add",
    });
  }

  // 1b) #9939: LIFT a manual-review hold the planner itself applied, once nothing wants it any more.
  //
  // The sibling-label cleanup further down deliberately refuses to touch this label, because the same string
  // is also a maintainer's manual freeze and that cleanup has no way to tell them apart. Correct -- but it
  // made the label a ONE-WAY LATCH: applied on a pass where a hold was real, and never lifted once the hold
  // cleared. Observed on #9935, which was mergeable, green, and re-reviewed to zero findings, and still
  // refused to merge until a human removed the label by hand.
  //
  // `manualReviewLabelAppliedSha` is the missing provenance. Non-null means the PLANNER applied it, so the
  // planner may take it back; null means a human applied it (or it predates the column) and it is left
  // strictly alone. Deliberately not scoped to the recorded head: a rebase that resolves the cause is the
  // single most common way a hold goes stale, and refusing to lift it there would leave the #9935 case unfixed.
  //
  // `manualHoldReason === null` alone is NOT "nothing wants a hold". That ternary covers the guardrail hit,
  // unverified CI, an action_required conclusion and a not-review-good verdict -- but every one of the
  // would-MERGE holds in sections 1c-1g below fires on `reviewGood` with a SUCCESS conclusion, which is
  // precisely when manualHoldReason is null. Releasing on it alone therefore stripped the label while a
  // migration collision, an unlinked-issue match, a priority-eligibility hold, an unlinked-issue close or an
  // unstable merge state was still live -- and that label is the exact thing the executor checks to deny
  // merge and approve, so removing it removes the enforcement for the hold that is still standing.
  //
  // `noManualReviewHoldWanted` is the complete condition: every reason that would ADD this label, in one
  // place, so a new hold added below cannot silently fail to suppress the release.
  const noManualReviewHoldWanted =
    manualHoldReason === null &&
    input.migrationCollisionHold === undefined &&
    input.unlinkedIssueMatchHold === undefined &&
    input.priorityEligibilityHold === undefined &&
    input.screenshotEvidenceHold === undefined &&
    input.unlinkedIssueMatchClose === undefined &&
    // #10116: `!mergeableStateUnstable` deliberately REMOVED. An unstable state no longer applies this label,
    // so it must not block lifting one either — leaving it here would strand the label on any PR whose CI
    // happened to be red when an unrelated hold cleared. That is the latch #10098 was stuck in.
    !heldForManualReview &&
    !mergeTerminallyBlocked;
  if (
    noManualReviewHoldWanted &&
    labels.manualReview !== null &&
    input.manualReviewLabelAppliedSha != null &&
    hasLabel(input.pr.labels, labels.manualReview)
    // No "is an add already planned this pass?" guard: every site that ADDS this label requires a live hold
    // (a guardrail hit, the migration-collision fallback, the owner/automation fallback), and all of those
    // set manualHoldReason -- so the null check above already excludes every case where an add could be in
    // flight. A guard here would be an arm no input can reach.
  ) {
    actions.push({
      actionClass: "label",
      autonomyClass: "merge",
      requiresApproval: approval("merge"),
      reason: `manual-review hold resolved — clearing the "${labels.manualReview}" label the bot applied`,
      label: labels.manualReview,
      labelOp: "remove",
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
      requiresApproval: approval("merge"),
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
      requiresApproval: approval("merge"),
      reason: `verdict=${conclusion}; ${input.unlinkedIssueMatchHold.reason}`,
      label: labels.manualReview,
      labelOp: "add",
      comment: sanitizePublicComment(input.unlinkedIssueMatchHold.comment),
    });
  }

  // 1d-priority) priority-eligibility hold (#9738) — mirrors 1d exactly. The PR is EARLY, not wrong: it is
  // held with a neutral comment naming the moment work opens, and nothing else about it changes. The label
  // is the same generic manual-review one, so the hold is visible on the surfaces a maintainer already reads.
  // #9881: the merge-authorized fallback, mirroring priorityEligibilityHold's directly below. A repo that
  // enables merge autonomy WITHOUT review_state_label gets no disposition label from the ternary above, so
  // without this the block tier would suppress the merge and say nothing at all -- a silent stall, which is
  // the failure mode this tier exists to replace. Skipped when the ternary already planned the label
  // (hasLabelOrPlanned), so the two never double-add.
  if (reviewGood && input.screenshotEvidenceHold !== undefined && labels.manualReview !== null && acting("merge") && !hasLabelOrPlanned(input.pr.labels, actions, labels.manualReview)) {
    actions.push({
      actionClass: "label",
      autonomyClass: "merge",
      requiresApproval: approval("merge"),
      reason: `verdict=${conclusion}; ${input.screenshotEvidenceHold.reason}`,
      label: labels.manualReview,
      labelOp: "add",
      comment: sanitizePublicComment(input.screenshotEvidenceHold.comment),
    });
  }
  if (reviewGood && input.priorityEligibilityHold !== undefined && labels.manualReview !== null && acting("merge") && !hasLabelOrPlanned(input.pr.labels, actions, labels.manualReview)) {
    actions.push({
      actionClass: "label",
      autonomyClass: "merge",
      requiresApproval: approval("merge"),
      reason: `verdict=${conclusion}; ${input.priorityEligibilityHold.reason}`,
      label: labels.manualReview,
      labelOp: "add",
      comment: sanitizePublicComment(input.priorityEligibilityHold.comment),
    });
  }

  // 1e) unlinked-issue-match REPEAT manual-review fallback when `close` autonomy can't act (gate-review
  // finding): mirrors 1d, but for the escalated-repeat case folded into `heldForManualReview` above only
  // when close isn't acting — without this, a confirmed repeat would silently MERGE with no visible signal
  // at all (the dedicated close branch below never fires without `acting("close")`).
  if (reviewGood && input.unlinkedIssueMatchClose !== undefined && !acting("close") && !acting("review_state_label") && labels.manualReview !== null && acting("merge") && !hasLabelOrPlanned(input.pr.labels, actions, labels.manualReview)) {
    actions.push({
      actionClass: "label",
      autonomyClass: "merge",
      requiresApproval: approval("merge"),
      reason: `verdict=${conclusion}; ${input.unlinkedIssueMatchClose.reason}`,
      label: labels.manualReview,
      labelOp: "add",
      comment: sanitizePublicComment(input.unlinkedIssueMatchClose.comment),
    });
  }

  // 1f) REMOVED (#10116). This was the unstable-mergeable-state manual-review fallback (#8758): when
  // review_state_label was off but merge was acting, a would-merge suppressed only by GitHub's "unstable"
  // state got the manual-review label plus a comment naming the non-required check.
  //
  // It was the dominant source of spurious holds. `reviewGood` means the GATE passed and REQUIRED CI passed,
  // and `unstable` is GitHub's verdict on everything else — so the two are true together on any PR whose
  // non-required checks are red OR STILL RUNNING. That is most PRs, most of the time, and each one got an
  // ENFORCEMENT label: the executor denies merge and approve while it is present, and merge-train.ts evicts a
  // labelled sibling from the train entirely, so the PR was skipped rather than queued. Worse, section 1b's
  // release condition also tested this state, which made the label a LATCH — applied while CI was red, and
  // then not liftable *because* CI was red. Observed on JSONbored/loopover#10098, stuck until a human
  // removed the label by hand.
  //
  // Nothing replaces it, and that is deliberate. #8758's concern was the silent stall #8711 hit: approve
  // posted, merge never planned, nothing on the PR saying why. All three legs stay closed without summoning
  // anyone — `wouldApprove` conjoins `!unstableHolds` so no approval is posted, section 2 chooses NO
  // disposition label rather than `ready-to-merge`, and the unified comment still refuses "safe to merge" via
  // `mergeStateHeld`. Which checks are unhappy is on the PR's own Checks tab, where it is always current;
  // restating it in a bot comment on every in-flight PR is noise, and the state resolves itself on the next
  // push without anyone having read it.

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
    const label =
      linkedIssueCloseInFlight || unlinkedIssueMatchViolated || !reviewGood
        ? labels.changesRequested
        : input.migrationCollisionHold !== undefined
          ? labels.migrationCollision
          : heldForManualReview || mergeTerminallyBlocked
            ? labels.manualReview
            : // #10116: an unstable merge state gets NEITHER disposition label. It no longer summons a human
              // (see derivePrDisposition), but it must not claim `ready-to-merge` either — our own aggregate
              // can read CI green while GitHub still reports unstable for a non-required check (#9810), and
              // promising "ready" on a PR the merge then self-suppresses on is precisely #8711's "approved,
              // labeled ready, never merged, nobody told". No label is the honest state: the PR is not held
              // for a person and not ready to merge, it is waiting on checks. The unified comment still
              // refuses "safe to merge" (via `mergeStateHeld`) and the Checks tab names the culprits, so
              // nothing about this state is hidden from the contributor.
              mergeableStateUnstable
              ? null
              : labels.readyToMerge;
    const reason = linkedIssueCloseInFlight
      ? `linked-issue hard rule: ${linkedIssueHardRule?.reason ?? "ineligible linked issue"}`
      : unlinkedIssueMatchViolated
        ? `verdict=${conclusion}; ${input.unlinkedIssueMatchClose!.reason}`
        : !reviewGood
          ? `verdict=${conclusion}${ciReason ? `; ${ciReason}` : ""}`
          : input.migrationCollisionHold !== undefined
            ? `verdict=${conclusion}; ${input.migrationCollisionHold.reason}`
            : input.unlinkedIssueMatchHold !== undefined
              ? `verdict=${conclusion}; ${input.unlinkedIssueMatchHold.reason}`
              : input.unlinkedIssueMatchClose !== undefined
                ? `verdict=${conclusion}; ${input.unlinkedIssueMatchClose.reason}`
                : input.advisoryCheckHold !== undefined && input.advisoryCheckHold.length > 0
                  ? `verdict=${conclusion}; ${advisoryHoldReason(input.advisoryCheckHold)}`
                  : // #10116: the `mergeableStateUnstable` arm that used to sit HERE is gone. It PRECEDED
                    // `heldForManualReview`, so once an unstable state stopped being a hold of its own, the
                    // only way to reach it with a label attached was a PR held for some OTHER reason that
                    // happened to also be unstable — and it would then have recorded "mergeable_state is
                    // unstable" as the cause of a label the guardrail (or a migration collision, or a
                    // terminal merge block) actually caused. A hold reason lands in the ledger and drives
                    // #9729's per-path clearance; misattributing it is worse than the noise it replaced.
                    heldForManualReview
                    ? `verdict=${conclusion}; ${guardrailReason}`
                    : mergeTerminallyBlocked
                      ? // #9012: the ONE place a terminal merge block becomes visible to a human. Everything
                        // else about this PR reads healthy — gate passing, CI green, bot-approved — so
                        // without naming the block here the label says "needs review" with no reason and the
                        // maintainer has nothing to act on. mergeBlockedReason is executor-written and
                        // already length-capped at persist time (280 chars).
                        `verdict=${conclusion}; CI green, but a prior merge attempt failed and is held: ${input.pr.mergeBlockedReason ?? "reason unrecorded"}`
                      : `verdict=${conclusion}; CI green`;
    if (label !== null && !hasLabelOrPlanned(input.pr.labels, actions, label)) {
      actions.push({
        actionClass: "label",
        autonomyClass: "review_state_label",
        requiresApproval: approval("review_state_label"),
        reason,
        label,
        // Only a HOLD carries a comment here — the guardrail/ready/changes labels never did and still don't
        // (comment stays undefined, matching the pre-#2550 shape). Priority follows the label choice above.
        //
        // The eligibility guard is evaluated ONCE rather than repeated per arm: a linked-issue close in
        // flight and an unlinked-issue-match close each already carry their own full message, and a
        // not-review-good PR is not being held for any of these reasons. Restating it inside every arm (as
        // this chain did) made each copy structurally unreachable-false, because reaching a later arm already
        // proved the earlier one's identical guard true.
        ...(!linkedIssueCloseInFlight && !unlinkedIssueMatchViolated && reviewGood
          ? input.migrationCollisionHold !== undefined
            ? { comment: sanitizePublicComment(input.migrationCollisionHold.comment) }
            : input.unlinkedIssueMatchHold !== undefined
              ? { comment: sanitizePublicComment(input.unlinkedIssueMatchHold.comment) }
              : input.unlinkedIssueMatchClose !== undefined
                ? { comment: sanitizePublicComment(input.unlinkedIssueMatchClose.comment) }
                : input.advisoryCheckHold !== undefined && input.advisoryCheckHold.length > 0
                  ? { comment: sanitizePublicComment(advisoryHoldComment(input.advisoryCheckHold)) }
                  : // #9881: the block tier's point is that the hold is ACTIONABLE -- "held, not closed, here
                    // is what is missing". The disposition already emits the manual-review label for it, so
                    // the message belongs on THAT action; a competing second add would be skipped by
                    // hasLabelOrPlanned and the contributor would get a bare label with no reason.
                    input.screenshotEvidenceHold !== undefined
                    ? { comment: sanitizePublicComment(input.screenshotEvidenceHold.comment) }
                    : // #10116: the trailing `mergeableStateUnstable` arm is gone with the label that carried
                      // it. A comment here only reaches the PR when the ternary above chose a label, and an
                      // unstable state now chooses none — so the arm was reachable only on a PR held for an
                      // unrelated reason, where it would have replaced that hold's own message with one
                      // about checks.
                      {}
          : {}),
      });
    }
    // Stale disposition-label cleanup (#stale-disposition-label-cleanup): the review-state labels below
    // (readyToMerge/migrationCollision/changesRequested) are mutually exclusive bot dispositions — a PR should
    // carry at most one. But the ternary above only ever ADDS the current one; a label from a PRIOR pass
    // (e.g. changesRequested while CI was red) never got removed once the PR became healthy again, so it sat
    // on the PR forever alongside whatever the bot added next. Clear every OTHER configured sibling that is
    // still live on the PR. Intentionally do NOT remove `manualReview` here: that same label is also the live
    // maintainer safety hold/freeze, and the planner has no provenance bit proving it was only a stale bot
    // disposition rather than a human-applied hold. Only a maintainer removing the label should lift it.
    const dispositionLabelSiblings = [labels.readyToMerge, labels.migrationCollision, labels.changesRequested];
    const livePrLabels = new Set(input.pr.labels.map((l) => l.toLowerCase()));
    // Dedupe defensively: if a repo ever misconfigures two of the four settings to the identical label
    // string, only clear it once (still correct — the label either belongs here or it doesn't — just
    // avoids a redundant duplicate remove action for the same name).
    const alreadyHandled = new Set<string>();
    for (const stale of dispositionLabelSiblings) {
      if (stale === null || stale === label) continue;
      const staleLower = stale.toLowerCase();
      if (alreadyHandled.has(staleLower) || !livePrLabels.has(staleLower)) continue;
      alreadyHandled.add(staleLower);
      actions.push({
        actionClass: "label",
        autonomyClass: "review_state_label",
        requiresApproval: approval("review_state_label"),
        reason: `disposition resolved — clearing the stale "${stale}" label`,
        label: stale,
        labelOp: "remove",
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
  // Never APPROVE a base-conflicting PR: it is closed below (willClose on isConflict), so a "LoopOver approves —
  // safe to merge" review on a PR we're about to close is incoherent (and a stale approval strands the PR if it
  // later goes green). A `behind`/`blocked` PR is fine to approve (it is rebased pre-review or the approval clears
  // the block); only a hard `dirty` conflict is excluded here. (#ready-needs-mergeable, the #4220 report)
  // An `unstable` PR is excluded too, now via wouldApprove's OWN `!unstableHolds` term (#10116 — it used to
  // ride on heldForManualReview, until an unstable state stopped being a hold): the merge below would
  // self-suppress on it, and approve firing while merge silently never comes was exactly #8711's "approved,
  // labeled ready, never merged, nobody told" incident. #10116 dropped the manual-review LABEL for this state
  // but deliberately kept this suppression — the two answer different questions ("does a human need to act",
  // no; "may we say this is good to merge", not while GitHub disagrees). */
  // #8759: disposition.wouldApprove = reviewGood && !held && not-a-conflict — the shared core the executor's
  // live recheck mirrors; the terms conjoined here are planner-private (close-in-flight, autonomy, idempotency).
  if (disposition.wouldApprove && !linkedIssueCloseInFlight && acting("approve") && input.pr.reviewDecision !== "APPROVED" && !alreadyApprovedThisHead) {
    actions.push({
      actionClass: "approve",
      requiresApproval: approval("approve"),
      reason: "gate passed, CI green",
      reviewBody: "LoopOver approves — the gate is satisfied and CI is green.",
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
  } else if (unlinkedIssueMatchViolated) {
    // A confirmed REPEAT of the same-account issue-avoidance pattern (#unlinked-issue-guardrail-followup) —
    // close one-shot, same precedence-over-merge reasoning as the linked-issue hard-rule close above. Tagged
    // "heuristic" (NOT closeConcreteEvidence): the underlying match is an AI verdict, so a systematically-wrong
    // match must stay subject to the close-precision breaker even after it repeats.
    const reason = input.unlinkedIssueMatchClose!.reason;
    actions.push({
      actionClass: "close",
      requiresApproval: approval("close"),
      reason,
      closeReasons: [reason],
      closeComment: closeMessage([reason]),
      closeKind: "heuristic",
      // Never CI-driven (#2478 discipline: always explicit, never omitted, on every heuristic close) -- the
      // executor's live-CI re-check would otherwise treat an omitted value as a legacy row requiring CI to
      // still be red, wrongly denying this close on a green PR.
      closeRequiresCiState: "not_required",
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
    if ((input.pr.linkedDuplicateCount ?? 0) > 0)
      closeReasons.push(
        input.pr.linkedDuplicateWinnerNumber != null
          ? `duplicate of open PR #${input.pr.linkedDuplicateWinnerNumber}`
          : "duplicate of another open PR",
      );
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
      // #7986: preserved alongside the collapsed boolean above so downgradeCloseToHold can check this specific
      // close's justification against a live per-rule precision track record. Empty when the evidence above
      // came from ciFailed/isConflict/linkedDuplicateCount instead of a blocker code.
      closeConcreteEvidenceCodes: concreteCloseEvidenceCodes(input),
      // Pin like merge/approve (#2452): lets the accept-time supersede check detect a force-push after staging;
      // the executor's own step-6 live-CI re-check (#2128) separately covers the CI-driven reason above.
      ...(input.pr.headSha ? { expectedHeadSha: input.pr.headSha } : {}),
      // Always explicit (never omitted) -- see the field's doc comment (#2478): an omitted value on a REPLAYED
      // staged action must unambiguously mean "legacy row, predates this field", not "not CI-driven".
      closeRequiresCiState: ciFailed ? "failed" : "not_required",
      // Always explicit (never omitted), mirroring closeRequiresCiState's own discipline above.
      closeRequiresMergeableState: isConflict,
      // Always explicit (never omitted), mirroring closeRequiresCiState's own discipline above.
      closeRequiresThreadResolved: isReviewThreadJustified,
      // Always explicit (never omitted), mirroring closeRequiresMergeableState's own discipline -- a duplicate
      // justification depends on a SIBLING PR's live state, which can change independently of this PR between
      // planning and actuation (#dup-winner-staleness).
      closeRequiresDuplicateStillOpen: (input.pr.linkedDuplicateCount ?? 0) > 0,
      // Only set when the election named a SPECIFIC winning sibling -- omitted (not null) when there is none,
      // matching expectedHeadSha's own "absent, not null" convention for an optional pin.
      ...(input.pr.linkedDuplicateWinnerNumber != null ? { duplicateWinnerPrNumber: input.pr.linkedDuplicateWinnerNumber } : {}),
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
  // (manualHoldReason itself is now computed earlier, above section 1 — see its doc comment there.)
  const manualHoldAutonomyClass: AgentActionClass = reviewGood ? "merge" : "close";
  if (
    manualHoldReason !== null &&
    labels.manualReview !== null &&
    !actions.some((action) => action.actionClass === "merge" || action.actionClass === "close") &&
    !hasLabelOrPlanned(input.pr.labels, actions, labels.manualReview)
  ) {
    actions.push({
      actionClass: "label",
      autonomyClass: manualHoldAutonomyClass,
      requiresApproval: approval(manualHoldAutonomyClass),
      reason: manualHoldReason,
      label: labels.manualReview,
      labelOp: "add",
      // aiReviewLowConfidenceHold (#4603) is the only reason this generic fallback carries a comment -- it
      // mirrors the migrationCollisionHold/unlinkedIssueMatchHold fallbacks' own comment-attaching shape (section
      // 1c/1d above), but those apply only to a would-MERGE hold (reviewGood); this hold applies to a would-CLOSE
      // suppression instead, so it belongs in this generic not-review-good fallback, not sections 1c/1d.
      ...(!reviewGood && input.aiReviewLowConfidenceHold !== undefined ? { comment: sanitizePublicComment(input.aiReviewLowConfidenceHold.comment) } : {}),
    });
  }

  // #9009 (narrow scope): auto-clear manual-review when the caller's transient marker proves this exact hold
  // was applied because a prior pass lost the AI-review lock race, and this fresh pass shows the contention
  // has cleared. `manualHoldReason === null` is the load-bearing safety check here: it means NOTHING else this
  // pass (guardrail, migration collision, unverified CI, action-required conclusion, a not-review-good verdict,
  // ...) currently justifies the label, so removing it cannot silently drop a substantive or human-applied
  // hold that happens to coexist. If manualHoldReason is non-null, the block above already re-adds/keeps the
  // label for that OTHER reason this same pass, so this branch is naturally a no-op there.
  if (
    input.manualReviewLockContentionResolved === true &&
    manualHoldReason === null &&
    labels.manualReview !== null &&
    hasLabel(input.pr.labels, labels.manualReview) &&
    !actions.some((action) => action.actionClass === "label" && action.label?.toLowerCase() === labels.manualReview?.toLowerCase())
  ) {
    actions.push({
      actionClass: "label",
      autonomyClass: manualHoldAutonomyClass,
      requiresApproval: approval(manualHoldAutonomyClass),
      reason: "AI-review lock contention has cleared and nothing else currently holds this PR — removing the transient manual-review hold",
      label: labels.manualReview,
      labelOp: "remove",
    });
  }

  return actions;
}
