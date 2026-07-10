// Type mirrors from `src/types.ts` needed by focus-manifest parse/compile core and its
// engine-local settings normalizers. The engine package cannot import across into `src/` — keep in sync
// by hand. `JsonValue` is sourced from `scoring/types.ts`.

export type { JsonValue } from "../scoring/types.js";

export type GateRuleMode = "off" | "advisory" | "block";

export type ReviewCheckMode = "required" | "visible" | "disabled";

export type ProjectMilestoneMatchMode = "off" | "suggest" | "auto";

export type ProjectMilestoneMatchBackend = "github" | "linear";

export type GatePolicyPack = "gittensor" | "oss-anti-slop";

export type CombineStrategy = "single" | "consensus" | "synthesis";

export type OnMerge = "either" | "both";

// Disposition for a sub-aiReviewCloseConfidence-floor ai_consensus_defect/ai_review_split finding (#4603) --
// see src/types.ts's mirror of this type (AiReviewLowConfidenceDisposition) for the full semantics of each value.
export type AiReviewLowConfidenceDisposition = "one_shot" | "hold_for_review" | "advisory_only";

// #4110: `request_changes`/`comment` were REMOVED (see src/types.ts's mirror of this type for why).
// `"advisory"` (#4535) is a NEW, actually-wired value -- see src/types.ts's mirror for the full rationale.
export type ScreenshotTableGateAction = "close" | "advisory";

export type ScreenshotTableGateConfig = {
  enabled: boolean;
  whenLabels: string[];
  whenPaths: string[];
  action: ScreenshotTableGateAction;
  // Full replacement for the rejection reason -- see src/types.ts's mirror of this type for the full
  // rationale (unset ⇒ auto-generated message + skillFileUrl; set ⇒ used verbatim, skillFileUrl ignored).
  message?: string | undefined;
  // Viewport x theme completeness matrix (#4535) -- see src/types.ts's mirror of this type for the full
  // rationale.
  requireViewports: string[];
  requireThemes: string[];
  // Contributor skill-file link appended to the auto-generated message (#4540 follow-up) -- see
  // src/types.ts's mirror of this type for the full rationale.
  skillFileUrl?: string | undefined;
};

export type CommandAuthorizationRole = "maintainer" | "collaborator" | "pr_author" | "confirmed_miner";

export type RepositoryCommandAuthorizationPolicy = {
  default: CommandAuthorizationRole[];
  commands: Record<string, CommandAuthorizationRole[]>;
};

export type PrTypeLabelSet = Record<string, string>;

export type LinkedIssueLabelPropagationMapping = {
  issueLabel: string;
  prLabel: string;
  removeOtherTypeLabels: boolean;
  /** Allow this mapping to fire off a linked issue authored by the repo's owner/admin/write-collaborator
   *  even when the PR author neither opened nor is assigned to that issue (#priority-linked-issue-gate-
   *  ownership). Defaults to `false`/unset (strict author-or-assignee-only behavior) -- a maintainer-reward
   *  mapping like `gittensor:priority` should never set this. Mirrors `src/types.ts`'s copy of this type;
   *  see `review/linked-issue-label-propagation-fetch.ts`'s `isRepoMaintainerLogin` (app-side only, not
   *  duplicated into this engine package since it needs GitHub/fetch/Env access). */
  trustMaintainerAuthoredIssue?: boolean | undefined;
  /** Like `trustMaintainerAuthoredIssue`, but for a mapping that DOES carry real reward weight
   *  (#priority-reward-maintainer-trust) -- e.g. `gittensor:priority`. Mirrors `src/types.ts`'s copy of
   *  this type; see that copy's doc comment for the full rationale. */
  trustMaintainerAuthoredIssueForReward?: boolean | undefined;
};

export type LinkedIssueLabelPropagationMode = "exclusive_type_label";

export type LinkedIssueLabelPropagationConfig = {
  enabled: boolean;
  mode: LinkedIssueLabelPropagationMode;
  mappings: LinkedIssueLabelPropagationMapping[];
};

export type LinkedIssueHardRulesMode = "block" | "off";

export type LinkedIssueHardRulesConfig = {
  ownerAssignedClose: LinkedIssueHardRulesMode;
  /** Close when an open linked issue is assigned to someone other than the PR author. */
  assignedIssueClose: LinkedIssueHardRulesMode;
  missingPointLabelClose: LinkedIssueHardRulesMode;
  maintainerOnlyLabelClose: LinkedIssueHardRulesMode;
  pointBearingLabels: string[];
  maintainerOnlyLabels: string[];
  defaultLabelRepo: boolean;
  verifyBeforeClose: boolean;
  closeDelaySeconds: number;
};

export type UnlinkedIssueGuardrailMode = "hold" | "off";

export type UnlinkedIssueGuardrailConfig = {
  mode: UnlinkedIssueGuardrailMode;
  minConfidence: number;
};

/** Per-capability opt-in to the local-inference AI_ADVISORY binding (#4364): each of these four ADVISORY-ONLY
 *  (never gate-blocking) capabilities independently decides whether it routes through env.AI_ADVISORY (when
 *  configured) instead of the shared frontier env.AI chain. Config-as-code only -- no DB column, resolved
 *  purely from `.gittensory.yml` `settings.advisoryAiRouting` (global default in the shared/root manifest,
 *  per-repo override), the same "config-as-code only" shape as unlinkedIssueGuardrail above. Every field
 *  defaults to false: an operator must deliberately opt EACH capability in, and even then a repo only
 *  actually routes through AI_ADVISORY when the binding itself is configured (env.AI_ADVISORY unset ⇒ every
 *  capability stays on env.AI regardless of this config, byte-identical to before this existed). */
export type AdvisoryAiRoutingConfig = {
  slop: boolean;
  e2eTestGen: boolean;
  planner: boolean;
  summaries: boolean;
};

export type ContributorBlacklistEntry = {
  login: string;
  /** Why the account is blocked. Free-text maintainer metadata; not published in automated close comments. */
  reason?: string | undefined;
  /** PR/issue URLs (or other maintainer refs) evidencing the block. */
  evidence?: string[] | undefined;
  /** ISO-8601 date the entry was added. */
  addedAt?: string | undefined;
};

export type AutonomyLevel = "observe" | "suggest" | "propose" | "auto_with_approval" | "auto";

export type AgentActionClass = "review" | "request_changes" | "approve" | "merge" | "close" | "label" | "review_state_label" | "update_branch" | "assign";

export type AutonomyPolicy = Partial<Record<AgentActionClass, AutonomyLevel>>;

export type AutoMergeMethod = "merge" | "squash" | "rebase";

export type AutoMaintainPolicy = {
  requireApprovals: number;
  mergeMethod: AutoMergeMethod;
};

export type RepositorySettings = {
  repoFullName: string;
  commentMode: "off" | "detected_contributors_only" | "all_prs";
  publicAudienceMode: "oss_maintainer" | "gittensor_only";
  publicSignalLevel: "minimal" | "standard";
  checkRunMode: "off" | "enabled";
  checkRunDetailLevel: "minimal" | "standard" | "deep";
  gateCheckMode: "off" | "enabled";
  /** Scheduled re-gate sweep candidate ordering (#3815). `staleness` (default) picks whichever open PR the
   *  sweep has gone longest WITHOUT re-gating (see selectRegateCandidates), which is what gives the sweep its
   *  documented full-coverage-in-ceil(open/max)-ticks convergence guarantee even under dry-run/pause (when
   *  GitHub's own `updatedAt` writes are suppressed). `oldest-first` instead always picks the oldest-created
   *  open PRs first, for an operator who wants deterministic creation-order draining over that guarantee.
   *  Selection-time only — real-time webhook-driven review is not gated by this and can process any PR at
   *  any time regardless of the chosen order. */
  regateSweepOrderMode: "staleness" | "oldest-first";
  /** The actual runtime authority for whether the "Gittensory Orb Review Agent" check-run publishes (#2852).
   *  See {@link ReviewCheckMode}. `gateCheckMode` above stays wired for API/back-compat display but no longer
   *  drives the publish decision on its own. */
  reviewCheckMode: ReviewCheckMode;
  /** Auto-project/milestone matching (#3183). See {@link ProjectMilestoneMatchMode}. Always populated by the DB
   *  layer (default `"off"`); optional so existing settings fixtures/callers need not be touched. */
  autoProjectMilestoneMatch?: ProjectMilestoneMatchMode | undefined;
  /** Which backend {@link ProjectMilestoneMatchMode} matches against (#3186). See {@link ProjectMilestoneMatchBackend}.
   *  Always populated by the DB layer (default `"github"`); optional so existing settings fixtures/callers need
   *  not be touched. */
  autoProjectMilestoneMatchBackend?: ProjectMilestoneMatchBackend | undefined;
  /** Policy pack the gate evaluates under (#692). Default `gittensor` (registry-aware; threads confirmed
   *  status for scoring only). `oss-anti-slop` runs the deterministic rules against any author on any repo. */
  gatePack: GatePolicyPack;
  linkedIssueGateMode: GateRuleMode;
  duplicatePrGateMode: GateRuleMode;
  qualityGateMode: GateRuleMode;
  qualityGateMinScore?: number | null | undefined;
  /** Deterministic anti-slop signal (#530/#532). `off` = no slop score; `advisory` = surface the slop
   *  score + warnings in context; `block` = ALSO hard-block when slopRisk >= slopGateMinScore (deterministic
   *  only, applies to every author like every blocker). Default `off` — opt-in via .gittensory.yml. */
  slopGateMode: GateRuleMode;
  /** PR-size manual-review HOLD (#gate-size). `off` (default/absent) = no size hold; `advisory`/`block` = a PR with
   *  >= 10 changed files OR >= 1000 changed (added+deleted) lines that would otherwise pass is HELD for manual review
   *  (neutral gate → "manual" verdict), never auto-merged and never a hard failure. Opt-in via `gate.size.mode`. */
  sizeGateMode?: GateRuleMode | undefined;
  /** Lockfile-tamper-risk gate (#2563). `off` (default/absent) = no scan; `advisory`/`block` = a changed
   *  `package-lock.json` whose diff changes a `resolved`/`integrity` value WITHOUT the same package's version
   *  changing in a changed `package.json`, or whose `resolved` URL points outside `registry.npmjs.org`, produces
   *  a `lockfile_tamper_risk` finding (`block` additionally hard-blocks). Distinct from the OSV.dev CVE analyzer
   *  in review-enrichment — this is a tamper/integrity-substitution check, not a known-CVE check. Config-as-code
   *  only — no DB column or dashboard toggle; set via `.gittensory.yml gate.lockfileIntegrity`. */
  lockfileIntegrityGateMode?: GateRuleMode | undefined;
  /** CLA / license-compatibility gate (#2564). `off` (default/absent) = no CLA check at all; `advisory`/`block` =
   *  evaluate the configured detection method(s) (`claConsentPhrase` and/or `claCheckRunName` + `claCheckRunAppSlug`) and raise a
   *  `cla_consent_missing` finding when neither confirms consent — `block` also hard-blocks the gate. Config-as-code
   *  only (no DB column, mirrors sizeGateMode) — set via `.gittensory.yml gate.claMode`. */
  claGateMode?: GateRuleMode | undefined;
  /** `gate.cla.consentPhrase`: a public-safe-filtered phrase a maintainer requires somewhere in the PR body (e.g.
   *  "I have read and agree to the CLA"), matched case-insensitively. `null`/absent ⇒ phrase-match detection is not
   *  configured. Config-as-code only, alongside {@link claGateMode}. */
  claConsentPhrase?: string | null | undefined;
  /** `gate.cla.checkRunName`: the name of a separate CLA-bot check-run this repo also runs (e.g. "CLA Assistant
   *  Lite"). A `success`/`neutral` conclusion for a check-run with this exact name (case-insensitive), produced
   *  by `claCheckRunAppSlug`, also satisfies consent. `null`/absent ⇒ check-run detection is not configured.
   *  Config-as-code only, alongside {@link claGateMode}. */
  claCheckRunName?: string | null | undefined;
  /** `gate.cla.checkRunAppSlug`: the trusted GitHub App slug that must have produced `claCheckRunName`. Required
   *  for check-run detection so contributor-controlled same-name runs cannot satisfy a blocking CLA gate. */
  claCheckRunAppSlug?: string | null | undefined;
  /** Copycat/plagiarism detection (#1969). `off` (default/absent) = no check; `warn`/`label`/`block` are
   *  escalating tiers a future containment/similarity engine would act on. Config-as-code only — no DB column
   *  or dashboard toggle; set via `.gittensory.yml gate.copycat.mode`. CURRENTLY INERT: parsed and threaded
   *  end-to-end, but no detection engine reads it yet. */
  copycatGateMode?: "off" | "warn" | "label" | "block" | undefined;
  /** `gate.copycat.minScore`: containment/similarity score (0-100) at/above which `copycatGateMode` would act,
   *  once the detection engine exists. Config-as-code only, alongside {@link copycatGateMode}. */
  copycatGateMinScore?: number | null | undefined;
  /** `gate.expectedCiContexts` (#selfhost-ci-verification): maintainer-declared CI check/status context names to
   *  treat as required when GitHub branch protection returns no readable required-status-checks (unconfigured,
   *  or a 403 from a token lacking `administration:read` — common for GitHub App installations). Merged with any
   *  branch-protection required contexts when both exist; used ALONE when branch protection is null/empty; a
   *  repo with neither configured keeps the existing fold-all fail-closed behavior. A context missing from the
   *  commit ⇒ pending; a completed red check for a listed context ⇒ failed; every listed context settled clean
   *  ⇒ verified passed (no `ciCompletenessWarning`). Config-as-code only — no DB column; set via
   *  `.gittensory.yml gate.expectedCiContexts`. */
  expectedCiContexts?: ReadonlyArray<string> | null | undefined;
  /** Dry-run disposition (#gate-dryrun). When true, the gate renders the would-be merge/close/manual verdict (every
   *  advisory sub-gate promoted to block) WITHOUT enforcing — the posted check stays non-blocking. Lets advisory mode
   *  preview exactly what it would do before the maintainer flips to real enforcement. Default off. */
  gateDryRun?: boolean | undefined;
  /** Live premerge migrations/** collision recheck (#2550). When true, an agent-driven merge of a PR that
   *  touches migrations/** is preceded by a fresh GitHub Trees-API read of the base branch's CURRENT migration
   *  filenames — unioned with this PR's own new migration filenames — checked for a live numeric collision.
   *  A collision suppresses the merge and holds the PR with a rebase-needed label + comment instead of merging
   *  blind. Config-as-code only (no DB column, mirrors gateDryRun) — set via `.gittensory.yml`
   *  `gate.premergeContentRecheck`. Default off/undefined — opt-in, since it costs one extra, uncached
   *  GitHub API call for any PR that touches migrations/**. */
  premergeContentRecheck?: boolean | undefined;
  /** Merge-readiness gate (#merge-readiness). `off`/`advisory`/`block`. No min-score. Default `off`. */
  mergeReadinessGateMode: GateRuleMode;
  /** Focus-manifest policy gate (#555). When `block`, the focus manifest's declared policy (required-linked
   *  issue and test expectations) becomes an enforceable review-agent blocker. Path-based manual-review holds
   *  are configured separately through `settings.hardGuardrailGlobs`. An
   *  INDEPENDENT dimension, deliberately not folded into the merge-readiness composite. Default `off` — opt-in. */
  manifestPolicyGateMode: GateRuleMode;
  /** Self-authored linked-issue gate. When `block`, the gate closes a PR where the contributor also
   *  opened the linked issue (`pr.authorLogin === issue.authorLogin`). Defaults to `advisory` — the finding
   *  is surfaced in the review panel but never blocks unless the maintainer opts in. */
  selfAuthoredLinkedIssueGateMode: GateRuleMode;
  /** First-time-contributor grace (#552). RESERVED / currently INERT (#2266): parsed, clamped, and threaded
   *  end-to-end, but the gate evaluator never reads it — a genuine newcomer with a real blocker is still
   *  one-shot closed exactly like a repeat contributor (blocker findings must remain closure outcomes).
   *  Setting this true has no runtime effect today; kept for potential future use. Default false. */
  firstTimeContributorGrace: boolean;
  /** Slop-risk threshold (0-100) at/above which `slopGateMode: block` blocks. Default 60 (the `high` band). */
  slopGateMinScore?: number | null | undefined;
  /** AI-assisted slop advisory (the `slopAiAdvisory` capability). When true AND `slopGateMode != off`, a
   *  free/default-reviewer pass (the configured self-host provider, or the legacy Workers-AI pair when
   *  none is configured) adds an ADVISORY-only `ai_slop_advisory` finding for semantic slop the
   *  deterministic detector cannot quantify. It NEVER feeds slopRisk or the gate (only the deterministic
   *  core blocks). Default false — opt-in via `.gittensory.yml gate.slop.aiAdvisory`. */
  slopAiAdvisory: boolean;
  /** AI maintainer review. `off` = no AI; `advisory` = post AI review notes only; `block` = ALSO let a
   *  dual-model high-confidence consensus defect become a gate blocker (confirmed-contributors only,
   *  like every other blocker). Default `off` — AI is opt-in. */
  aiReviewMode: GateRuleMode;
  /** Bring-your-own-key: when true and a provider key is configured for the repo, the advisory AI review
   *  is generated by the maintainer's frontier model (Anthropic/OpenAI) instead of the free/default
   *  reviewer. The consensus blocker always uses the free/default reviewer pair regardless (the configured
   *  self-host provider, or the legacy Workers-AI pair when none is configured), so BYOK never changes who
   *  can be blocked. Default false. */
  aiReviewByok: boolean;
  /** Config-as-code BYOK provider for the advisory write-up. `null` = use the configured key's own
   *  provider. When set, it must match the stored key's provider or BYOK is skipped (falls back to the
   *  free/default reviewer). The secret key itself is never here — only via the encrypted key store. */
  aiReviewProvider?: "anthropic" | "openai" | null | undefined;
  /** Config-as-code model override for the BYOK advisory write-up (e.g. "claude-3-5-sonnet-latest").
   *  `null` = use the key record's model, else a conservative per-provider default. */
  aiReviewModel?: string | null | undefined;
  /** Review EVERY PR's author, not only confirmed Gittensor contributors. The AI maintainer review is
   *  confirmed-contributor-gated by default (an AI-spend guard). When true the review runs for any author —
   *  intended for a self-host operator who wants real reviews on all PRs (incl. their own) and pays for the
   *  AI themselves. Default false — opt-in via `.gittensory.yml gate.aiReview.allAuthors`. Independent of
   *  `aiReviewMode`: `off` still means no AI; this only widens WHO an enabled review covers. */
  aiReviewAllAuthors: boolean;
  /** Configured AI-reviewer confidence floor (0-1) for close calibration (#7). Under `aiReviewMode: block`, AI
   *  defect findings remain blockers even when their confidence is below this floor; the floor is retained as
   *  configurable context, not a manual-review downgrade. Config-as-code only — set via `.gittensory.yml
   *  gate.aiReview.closeConfidence` (no dashboard/DB column); unset ⇒ the gate uses the 0.93 default. Clamped to
   *  [0,1] at parse time. */
  aiReviewCloseConfidence?: number | null | undefined;
  /** Per-repo dual-AI combine-strategy override (#2567). Config-as-code only — set via `.gittensory.yml
   *  gate.aiReview.combine` (no dashboard/DB column); unset ⇒ the self-host operator's `AI_REVIEW_PLAN.combine`
   *  boot config (or `consensus` if the operator set nothing). A REFINEMENT of the operator's plan, not a
   *  bypass — `runGittensoryAiReview` clamps the resolved `onMerge` to the operator's floor (see
   *  {@link aiReviewOnMerge}); `combine` itself carries no floor semantics (single/consensus/synthesis are not
   *  ordered by strictness). */
  aiReviewCombine?: CombineStrategy | null | undefined;
  /** Per-repo `synthesis` merge-rule override (#2567): `either` blocks on ANY one reviewer's blocker (the
   *  STRICTER rule); `both` blocks only when every reviewer agrees (the more PERMISSIVE rule). Config-as-code
   *  only — set via `.gittensory.yml gate.aiReview.onMerge` (no dashboard/DB column). A repo override can only
   *  TIGHTEN the operator's `AI_REVIEW_PLAN.onMerge` floor (e.g. `either` → `either` is a no-op; `both` → an
   *  attempted loosening is clamped back to `either`). When the operator has not set an `onMerge` floor, any
   *  per-repo value is honored unclamped. See `resolveEffectiveAiReviewOnMerge` in `services/ai-review.ts`. */
  aiReviewOnMerge?: OnMerge | null | undefined;
  /** Per-repo reviewer-pair override (#2567): named self-host providers (e.g. `{ model: "claude-code" }`,
   *  `{ model: "codex" }`) to run instead of the operator's `AI_REVIEW_PLAN.reviewers` (or the free Workers-AI
   *  pair when the operator configured none). Config-as-code only — set via `.gittensory.yml
   *  gate.aiReview.reviewers` (no dashboard/DB column). Unlike {@link aiReviewOnMerge}, WHICH reviewers run
   *  carries no operator floor to violate (the floor is what triggers a hold/block, not who evaluates it), so a
   *  repo override always wins unclamped when set. */
  aiReviewReviewers?: ReadonlyArray<{ model: string; fallback?: string | null | undefined }> | null | undefined;
  /** When TRUE, the repo OWNER's (and maintainer's) own PRs are eligible for auto-CLOSE like a contributor's
   *  (still subject to the `close` autonomy class + the same adverse-signal conditions). Default FALSE — owner
   *  PRs are exempt from auto-close (merge or manual-hold only). Per-repo configurable so maintainers choose
   *  rather than inheriting a hardwired opinion. */
  closeOwnerAuthors: boolean;
  autoLabelEnabled: boolean;
  gittensorLabel: string;
  createMissingLabel: boolean;
  /** #label-decoupling: independently gates the per-PR TYPE/taxonomy label (bug/feature by the PR
   *  title, or priority via linked-issue label propagation — see `resolvePrTypeLabel` in
   *  `settings/pr-type-label.ts`). Distinct from {@link autoLabelEnabled} (which governs only the
   *  base {@link gittensorLabel} context label) and from `decidePublicSurface`'s public-surface gate
   *  (miner detection / `publicAudienceMode` / `includeMaintainerAuthors` / bot-author exclusion) —
   *  type labels are internal triage metadata applied unconditionally to every PR, not a
   *  contributor-facing signal, so neither of those public-surface conditions should suppress them.
   *  Default TRUE (matches the prior de-facto behavior before this field existed, when type labels
   *  were gated by `autoLabelEnabled` nested inside the public-surface check). Always populated by
   *  the DB layer; optional so existing settings fixtures/callers need not be touched. */
  typeLabelsEnabled?: boolean | undefined;
  /** Per-repo override of the TYPE/taxonomy label NAMES, keyed by category (#priority-linked-issue-gate,
   *  #label-modularity). Defaults to `DEFAULT_TYPE_LABELS` (`gittensor:bug`/`gittensor:feature`/
   *  `gittensor:priority`) in `settings/pr-type-label.ts` — a repo can override just one name (e.g. only
   *  `priority`) and keep the others default, AND/OR add arbitrary additional categories beyond the
   *  built-in three (e.g. `security: "area:security"`) for its own taxonomy. Always populated by the DB
   *  layer; optional so existing settings fixtures/callers need not be touched. */
  typeLabels?: PrTypeLabelSet | undefined;
  /** Linked-issue label propagation (#priority-linked-issue-gate): the ONLY mechanism that can ever
   *  select the configured priority label (or any other configured mapping's PR label) — never
   *  inferred from a PR's title, changed files, AI output, or existing PR labels. Default disabled
   *  (`enabled: false`, no mappings) — a self-hoster opts in per repo. Always populated by the DB
   *  layer; optional so existing settings fixtures/callers need not be touched. */
  linkedIssueLabelPropagation?: LinkedIssueLabelPropagationConfig | undefined;
  /** Deterministic linked-issue hard rules. Config-as-code only; set with
   *  `.gittensory.yml settings.linkedIssueHardRules` in private/global or per-repo config. These rules close
   *  contributor PRs that link ineligible issues before spending AI review budget: owner/other-assigned,
   *  maintainer-only, or missing point-label issues. Defaults all-off so self-hosters opt into their own policy. */
  linkedIssueHardRules?: LinkedIssueHardRulesConfig | undefined;
  /** Same-account issue-avoidance guardrail (#unlinked-issue-guardrail). Config-as-code only; set with
   *  `.gittensory.yml settings.unlinkedIssueGuardrail` in private/global or per-repo config. Defaults
   *  all-off so a self-hoster opts into their own credibility-gate-farming defense. */
  unlinkedIssueGuardrail?: UnlinkedIssueGuardrailConfig | undefined;
  /** Per-capability local-inference routing (#4364). Config-as-code only; set with `.gittensory.yml
   *  settings.advisoryAiRouting` in shared/global or per-repo config (global default + per-repo override,
   *  the same deep-merge precedence every other settings field uses). Defaults all-false so every advisory
   *  capability stays on the shared frontier env.AI chain until an operator opts each one in. */
  advisoryAiRouting?: AdvisoryAiRoutingConfig | undefined;
  publicSurface: "off" | "comment_and_label" | "comment_only" | "label_only";
  includeMaintainerAuthors: boolean;
  requireLinkedIssue: boolean;
  backfillEnabled: boolean;
  /** Opt-in for the public, unauthenticated README status badge (#541). Always populated by the DB layer
   *  (default false); optional so existing settings fixtures/callers need not be touched. */
  badgeEnabled?: boolean | undefined;
  /** Opt-in for the public per-repo review-quality page (#2568). Always populated by the DB layer
   *  (default false); optional so existing settings fixtures/callers need not be touched. */
  publicQualityMetrics?: boolean | undefined;
  commandAuthorization?: RepositoryCommandAuthorizationPolicy | undefined;
  /** Per-repo contributor blacklist (#1425, anti-abuse): banned GitHub logins whose PRs/issues the engine
   *  deterministically closes ahead of merit review. Layered the same as other settings (`.gittensory.yml` >
   *  DB) and unioned with the shared/global list at the point of use. Always populated by the DB layer
   *  (default `[]`); optional so existing settings fixtures/callers need not be touched. */
  contributorBlacklist?: ContributorBlacklistEntry[] | undefined;
  /** The label applied to a blacklisted contributor's PR (#1425). Configurable per-repo (dashboard/DB +
   *  `.gittensory.yml` `settings.blacklistLabel`); defaults to `"slop"` so the disposition works regardless of
   *  the label a repo sets. Explicit `null` closes WITHOUT applying any label (the same load-bearing-null idiom
   *  as {@link contributorOpenPrCap}) -- distinct from omitted/undefined, which uses the default. Always
   *  populated by the DB layer (default `"slop"`); optional so existing settings fixtures/callers need not be
   *  touched (mirrors the sibling `contributorBlacklist`). */
  blacklistLabel?: string | null | undefined;
  /** Per-contributor open-PR cap (#2270, anti-abuse): the max PRs a single non-owner/admin/bot contributor may
   *  have open on this repo at once. `null`/absent (default) = no cap, byte-identical to today. Layered like
   *  every other settings field (`.gittensory.yml` `settings.contributorOpenPrCap` > DB > `null`). Enforcement
   *  (closing the newest PR(s) over the cap) is a separate follow-up; this field only carries the threshold. */
  contributorOpenPrCap?: number | null | undefined;
  /** Per-contributor open-issue cap (#2270, anti-abuse): same shape and precedence as {@link contributorOpenPrCap},
   *  applied to open issues instead of open PRs. `null`/absent (default) = no cap. */
  contributorOpenIssueCap?: number | null | undefined;
  /** The label applied to a PR/issue closed for exceeding a per-contributor open-item cap (#2270). Same
   *  configurable-with-fallback shape as {@link blacklistLabel} (including the explicit-`null`-closes-without-a-
   *  label idiom); defaults to `"over-contributor-limit"` so the disposition works regardless of the label a
   *  repo sets. Always populated by the DB layer; optional so existing settings fixtures/callers need not be
   *  touched. */
  contributorCapLabel?: string | null | undefined;
  /** Cancel in-flight CI runs on a contributor_cap close (#2462, anti-abuse): when true, after a PR is
   *  auto-closed for exceeding {@link contributorOpenPrCap}, gittensory lists and cancels that PR's
   *  in-progress/queued Actions runs at its head SHA. Requires the App installation to have granted
   *  `actions: write` -- degrades gracefully (skipped + logged, never blocks the close) when it hasn't.
   *  `null`/undefined (the DB-layer default) means "unset" and falls back to the
   *  `CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT` env var -- unlike most boolean toggles, this one is nullable so an
   *  explicit `false` (opt back out) is distinguishable from "not configured" for that fallback. */
  contributorCapCancelCi?: boolean | null | undefined;
  /** Review-request nagging cooldown (#2463, anti-abuse): throttle a contributor repeatedly pinging
   *  `@gittensory` (any command) on this repo. `"off"` (default) is a no-op; `"hold"` posts a deterministic
   *  cooldown reply and takes no further action; `"close"` additionally closes the thread (PR threads only in
   *  v1 — a plain issue thread degrades to `"hold"` behavior until #2493's `closeIssue` primitive lands).
   *  Always populated by the DB layer (default `"off"`); optional so existing settings fixtures/callers need
   *  not be touched. */
  reviewNagPolicy?: "off" | "hold" | "close" | undefined;
  /** Review-nag cooldown (#2463): how many `@gittensory` pings a contributor may make on this repo within
   *  {@link reviewNagCooldownDays} before the (N+1)th is throttled. Always populated by the DB layer (default
   *  `3`); optional so existing settings fixtures/callers need not be touched. Only meaningful when
   *  {@link reviewNagPolicy} is not `"off"`. */
  reviewNagMaxPings?: number | undefined;
  /** Review-nag cooldown (#2463): the rolling window (in days) {@link reviewNagMaxPings} counts against. Always
   *  populated by the DB layer (default `5`); optional so existing settings fixtures/callers need not be
   *  touched. */
  reviewNagCooldownDays?: number | undefined;
  /** The label applied to a thread closed for review-nag cooldown (#2463), mirroring {@link blacklistLabel}'s
   *  configurable-with-fallback shape (including the explicit-`null`-closes-without-a-label idiom). Always
   *  populated by the DB layer (default `"review-nag-cooldown"`); optional so existing settings
   *  fixtures/callers need not be touched. */
  reviewNagLabel?: string | null | undefined;
  /** Maintainer-mention nag moderation: GitHub logins to ALSO throttle under the review-nag cooldown when the
   *  thread author repeatedly @-mentions them (on top of the bot's own `@gittensory` handle) -- e.g. a
   *  maintainer login instead of the bot, for a contributor who keeps tagging a specific person for review.
   *  Counted independently per mentioned login and independently of the `@gittensory` counter, but reuses the
   *  SAME {@link reviewNagPolicy}/{@link reviewNagMaxPings}/{@link reviewNagCooldownDays}/{@link reviewNagLabel}
   *  thresholds/action/label -- one cooldown policy, multiple watched mention targets. `[]`/undefined (default)
   *  = no logins watched, zero behavior change. Never fires for the repo owner, admin logins, automation bots,
   *  or a login on {@link autoCloseExemptLogins}. */
  reviewNagMonitoredMentions?: string[] | undefined;
  /** Shared repo-scoped exemption list (#2463, anti-abuse): GitHub logins that are NEVER throttled or closed by
   *  gittensory's deterministic anti-abuse mechanisms (review-nag and the per-contributor open-item cap above),
   *  on top of the standing owner/admin/automation-bot exemption. Always populated by the DB layer (default
   *  `[]`); optional so existing settings fixtures/callers need not be touched. */
  autoCloseExemptLogins?: string[] | undefined;
  /** Hard manual-review guardrail globs. Config-as-code only: set in private/global or per-repo
   *  `.gittensory.yml` under `settings.hardGuardrailGlobs`. Absent means no path guardrails. Arrays are
   *  replacement overlays, so a repo can clear a global default with `[]`. */
  hardGuardrailGlobs?: string[] | null | undefined;
  /** Label applied when an otherwise-ready PR is held for manual review by a guardrail. Config-as-code only;
   *  `null` disables the label while keeping the hold. Distinct from `review_state_label`, so operators can
   *  apply one manual-review label without enabling ready/changes-requested disposition labels. */
  manualReviewLabel?: string | null | undefined;
  /** Optional review-state label names. Config-as-code only; each `null` disables that specific label. These are
   *  deliberately generic defaults rather than `gittensory:*` names so self-hosters can opt into their own
   *  taxonomy without inheriting project-specific labels. */
  readyToMergeLabel?: string | null | undefined;
  changesRequestedLabel?: string | null | undefined;
  migrationCollisionLabel?: string | null | undefined;
  pendingClosureLabel?: string | null | undefined;
  /** Force-rebase-before-merge window in minutes (#2552, anti-race). When a base branch has advanced within
   *  this many minutes of the actual merge-decision moment, an agent-driven merge forces an `update_branch` +
   *  fresh CI recheck cycle first, rather than trusting a `mergeableState: clean` read that may already be
   *  stale relative to a sibling commit that just landed on the base. `null`/undefined (default) = never
   *  force -- a `mergeable_state: clean` read is trusted exactly as it is today. Layered like every other
   *  settings field (`.gittensory.yml` `gate.requireFreshRebaseWindow` > DB > `null`). */
  requireFreshRebaseWindowMinutes?: number | null | undefined;
  /** Account-age throttle (#2561, anti-abuse): an account younger than this many days gets the
   *  {@link newAccountLabel} and a tighter effective contributor cap — friction/visibility, NEVER an
   *  automatic close on account age alone. `null`/undefined (default) = off. Never fires for the repo
   *  owner, admin logins, or automation bots. Applies on both PR and issue contributor-cap paths. */
  accountAgeThresholdDays?: number | null | undefined;
  /** The label applied to a below-threshold-age account's PR (#2561), mirroring {@link blacklistLabel}'s
   *  configurable-with-fallback shape. Always populated by the DB layer (default `"new-account"`); optional so
   *  existing settings fixtures/callers need not be touched. */
  newAccountLabel?: string | undefined;
  /** Per-command @gittensory rate limit (#2560, anti-abuse): generalizes the review-nag cooldown's counting
   *  pattern (the audit-events ledger) to EVERY `@gittensory` command, keyed by `(actor, command, targetKey)` --
   *  independent of, and complementary to, review-nag's own narrower thread-author-only scope. `"off"` (default)
   *  is a no-op; `"hold"` posts a deterministic cooldown reply and skips the command's own dispatch. Always
   *  populated by the DB layer (default `"off"`); optional so existing settings fixtures/callers need not be
   *  touched. */
  commandRateLimitPolicy?: "off" | "hold" | undefined;
  /** Per-command rate limit (#2560): how many invocations of a single command an actor may make within
   *  {@link commandRateLimitWindowHours} before the (N+1)th is throttled -- for a CHEAP command (cache-only,
   *  no AI orchestrator call). Always populated by the DB layer (default `20`); optional so existing settings
   *  fixtures/callers need not be touched. Only meaningful when {@link commandRateLimitPolicy} is not `"off"`. */
  commandRateLimitMaxPerWindow?: number | undefined;
  /** Per-command rate limit (#2560): the same threshold as {@link commandRateLimitMaxPerWindow}, but for an
   *  AI-cost-bearing command (dispatches to a real orchestrator call: `ask`, `blockers`, `preflight`,
   *  `reviewability`, `packet`, `duplicate-check`, `next-action`, `repo-fit`). Deliberately tighter than the
   *  cheap-command default. Always populated by the DB layer (default `5`); optional so existing settings
   *  fixtures/callers need not be touched. */
  commandRateLimitAiMaxPerWindow?: number | undefined;
  /** Per-command rate limit (#2560): the rolling window (in hours) both {@link commandRateLimitMaxPerWindow}
   *  and {@link commandRateLimitAiMaxPerWindow} count against. Always populated by the DB layer (default `24`);
   *  optional so existing settings fixtures/callers need not be touched. */
  commandRateLimitWindowHours?: number | undefined;
  /** Agent-layer autonomy dial (#773): per-action-class level. Always populated by the DB layer (default
   *  `{}` = deny-by-default = "observe" for every class); optional so existing settings fixtures/callers
   *  need not be touched. The single source the action layer (#778) reads via `resolveAutonomy`. */
  autonomy?: AutonomyPolicy | undefined;
  /** Auto-maintain policy (#774): merge method + approval count. Always populated by the DB layer with
   *  defaults (squash / 1 approval); optional so existing settings fixtures/callers need not be touched. */
  autoMaintain?: AutoMaintainPolicy | undefined;
  /** Per-repo agent kill-switch (#776): when true, the action layer takes NO action on this repo (the
   *  global env switch overrides this too). Default false. */
  agentPaused?: boolean | undefined;
  /** Per-repo dry-run/shadow mode (#776): when true, the action layer records what it WOULD do without
   *  performing any GitHub mutation. Default false. */
  agentDryRun?: boolean | undefined;
  /** Per-repo override of the global DB-backed agent freeze (#4372): when true, this repo's actions execute
   *  even while `global_agent_controls.frozen` is set, so an operator can re-activate one repo at a time
   *  without lifting the fleet-wide brake. Never overrides the `AGENT_ACTIONS_PAUSED` env var, and
   *  {@link agentPaused} on this same repo still wins over it. Default false. */
  agentGlobalFreezeOverride?: boolean | undefined;
  /** Moderation-rules engine (#selfhost-mod-engine): whether the whole layer runs on THIS repo. `"inherit"`
   *  (the DB default) defers to `global_moderation_config.enabled`; `"off"`/`"enabled"` force this repo
   *  regardless of the global default. Always populated by the DB layer; optional so existing settings
   *  fixtures/callers need not be touched. */
  moderationGateMode?: "inherit" | "off" | "enabled" | undefined;
  /** Moderation-rules engine: a per-repo override of WHICH of the anti-abuse mechanisms (contributor cap,
   *  blacklist, review-nag, review-evasion) feed a contributor's shared, cross-repo violation tally.
   *  `undefined`/absent ⇒ inherit the global rule set (`resolveEffectiveModerationRules`'s default shape). */
  moderationRules?: ("contributor_cap" | "blacklist" | "review_nag" | "review_evasion")[] | undefined;
  /** Moderation-rules engine: per-repo override of the label applied at >=1 lifetime violation. `undefined` ⇒
   *  the global config's `warningLabel` (itself defaulting to `"mod:warning"`). */
  moderationWarningLabel?: string | undefined;
  /** Moderation-rules engine: per-repo override of the label applied at >= the ban threshold. `undefined` ⇒
   *  the global config's `bannedLabel` (itself defaulting to `"mod:banned"`). */
  moderationBannedLabel?: string | undefined;
  /** Review-evasion protection (#review-evasion-protection): a contributor closing or converting their OWN
   *  PR to draft while gittensory has an ACTIVE review pass running against it is dodging the one-shot
   *  review process. `"off"` (the default) disables detection entirely; `"close"` reopens (if needed) and
   *  re-closes as the App -- a close the contributor cannot themselves reopen (#one-shot-reopen) -- applies
   *  the configured label/comment, and records a `review_evasion` moderation strike. */
  reviewEvasionProtection?: "off" | "close" | undefined;
  /** Review-evasion protection: label applied alongside the enforcement close, gated on `close` autonomy
   *  like every other anti-abuse label (#label-scoping), mirroring {@link blacklistLabel}'s shape. `undefined`
   *  ⇒ the `"review-evasion"` default; explicit `null` ⇒ close without any label. */
  reviewEvasionLabel?: string | null | undefined;
  /** Review-evasion protection: whether to post the public explanation comment before the enforcement close.
   *  Default true. */
  reviewEvasionComment?: boolean | undefined;
  /** Merge-train FIFO gate (#selfhost-merge-train): `"off"` keeps current behavior, `"audit"` logs would-hold
   *  decisions, and `"enforce"` defers a merge behind a still-viable older sibling. */
  mergeTrainMode?: "off" | "audit" | "enforce" | undefined;
  /** Config-driven before/after screenshot-table gate (#2006): a DETERMINISTIC check (no AI, zero hallucination
   *  risk) that a contributor visual/frontend PR's body contains a markdown table with before/after image
   *  markup, scoped to the repo's configured labels/paths (`whenLabels`/`whenPaths`, OR-matched). Off by
   *  default (`enabled: false`) -- opt in per repo, mirroring every other anti-abuse mechanism's shape. See
   *  `review/screenshot-table-gate.ts` for the normalizer and the pure evaluator. */
  screenshotTableGate?: ScreenshotTableGateConfig | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
};
