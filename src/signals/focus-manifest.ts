import { parse as parseYaml } from "yaml";
import type { GatePolicyPack, GateRuleMode, JsonValue, LinkedIssueHardRulesConfig, LinkedIssueLabelPropagationConfig, PrTypeLabelSet, RepositorySettings, ReviewCheckMode, UnlinkedIssueGuardrailConfig } from "../types";
import { normalizeAutonomyPolicy, normalizeAutoMaintainPolicy } from "../settings/autonomy";
import { normalizeCommandAuthorizationPolicy } from "../settings/command-authorization";
import { mergeContributorBlacklists, normalizeContributorBlacklist } from "../settings/contributor-blacklist";
import { normalizeAutoCloseExemptLogins } from "../settings/auto-close-exempt";
import { DEFAULT_TYPE_LABELS, MAX_TYPE_LABEL_NAME_LENGTH, normalizeTypeLabelSet } from "../settings/pr-type-label";
import { DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION, normalizeLinkedIssueLabelPropagationConfig, VALID_LINKED_ISSUE_LABEL_PROPAGATION_MODES } from "../review/linked-issue-label-propagation";
import { DEFAULT_LINKED_ISSUE_HARD_RULES, isLinkedIssueHardRuleMode, normalizeLinkedIssueHardRulesConfig } from "../review/linked-issue-hard-rules-config";
import { DEFAULT_UNLINKED_ISSUE_GUARDRAIL, isUnlinkedIssueGuardrailMode, normalizeUnlinkedIssueGuardrailConfig } from "../review/unlinked-issue-guardrail-config";
import { normalizeModerationLabel, normalizeModerationRules } from "../settings/moderation-rules";
import { REES_ANALYZER_NAME_SET, type ReesAnalyzerName } from "../review/enrichment-analyzer-names";
import { hasUnsafeWildcardCount } from "./change-guardrail";
import { PUBLIC_LOCAL_PATH_INLINE } from "./redaction";
import { classifyChangedFile } from "./path-matchers";
import { isSafeHttpUrl } from "../review/content-lane/safe-url";

export type FocusManifestSource = "repo_file" | "api_record" | "none";
export type FocusManifestLinkedIssuePolicy = "required" | "preferred" | "optional";
export type FocusManifestIssueDiscoveryPolicy = "encouraged" | "neutral" | "discouraged";

/**
 * Maintainer-authored gate configuration declared as code in `.gittensory.yml` under `gate:`. Each
 * field is `null` when the maintainer did not set it, so the resolver can layer the manifest OVER the
 * DB-backed RepositorySettings (manifest > DB > safe defaults) without clobbering unset values. All
 * of these flow through the SAME confirmed-contributor-gated `evaluateGateCheck` path — the manifest
 * only chooses which deterministic blockers are active, never who can be blocked. Turning the gate
 * itself on/off stays a repository setting (`gateCheckMode`); `.gittensory.yml gate:` refines the
 * blocker policy of an already-enabled gate. `checkMode` (#2852) is a separate, more expressive axis:
 * whether/how the "Gittensory Orb Review Agent" check-RUN publishes, independent of gate evaluation
 * itself (which always runs regardless of `checkMode`/`enabled`) — see {@link ReviewCheckMode}.
 */
export type FocusManifestGateConfig = {
  present: boolean;
  enabled: boolean | null;
  /** `gate.checkMode` (#2852): explicit required|visible|disabled review-check publish mode. Takes
   *  precedence over the legacy `enabled` boolean below when both are set (see resolveEffectiveSettings).
   *  null (unset) ⇒ fall back to `enabled`, then to `settings.reviewCheckMode` (DB/dashboard), then default. */
  checkMode: ReviewCheckMode | null;
  pack: GatePolicyPack | null;
  linkedIssue: GateRuleMode | null;
  duplicates: GateRuleMode | null;
  readinessMode: GateRuleMode | null;
  readinessMinScore: number | null;
  slopMode: GateRuleMode | null;
  slopMinScore: number | null;
  slopAiAdvisory: boolean | null;
  sizeMode: GateRuleMode | null;
  /** `gate.lockfileIntegrity` (#2563): off|advisory|block, off by default. When not off, a changed
   *  `package-lock.json` diff is scanned for a `resolved`/`integrity` change unaccompanied by a matching
   *  `package.json` version bump, or a `resolved` URL outside `registry.npmjs.org` — a `lockfile_tamper_risk`
   *  finding (`block` additionally hard-blocks). Config-as-code only — no DB column or dashboard toggle. */
  lockfileIntegrityMode: GateRuleMode | null;
  aiReviewMode: GateRuleMode | null;
  aiReviewByok: boolean | null;
  aiReviewProvider: "anthropic" | "openai" | null;
  aiReviewModel: string | null;
  aiReviewAllAuthors: boolean | null;
  /** `gate.aiReview.closeConfidence` (#7): minimum calibrated AI-reviewer confidence (0-1) for an AI defect to BLOCK
   *  under `aiReview.mode: block`. null (unset) ⇒ the gate's 0.93 default. Clamped to [0,1] at parse time. */
  aiReviewCloseConfidence: number | null;
  /** `gate.aiReview.combine` (#2567): per-repo override of the self-host operator's `AI_REVIEW_PLAN.combine`
   *  boot default (single/consensus/synthesis). null (unset) ⇒ the operator's plan (or `consensus`). A
   *  REFINEMENT only — see {@link aiReviewOnMerge} for the operator-floor clamp `runGittensoryAiReview` applies
   *  to the paired `onMerge` field; `combine` itself is not floor-clamped (the three strategies are not ordered
   *  by strictness, so there is no single "loosening" direction to clamp). */
  aiReviewCombine: import("../types").CombineStrategy | null;
  /** `gate.aiReview.onMerge` (#2567): per-repo override of the `synthesis` merge rule. `either` is the STRICTER
   *  rule (any one reviewer's blocker blocks/holds); `both` is more PERMISSIVE (requires every reviewer to
   *  agree). null (unset) ⇒ the operator's `AI_REVIEW_PLAN.onMerge`. A repo may only TIGHTEN the operator's
   *  floor (never loosen `either` down to `both`) — `runGittensoryAiReview` enforces the clamp at resolve time,
   *  since only it can see both the per-repo value and the operator's plan. */
  aiReviewOnMerge: import("../types").OnMerge | null;
  /** `gate.aiReview.reviewers` (#2567): per-repo override of the named reviewer pair(s) to run, in place of the
   *  operator's `AI_REVIEW_PLAN.reviewers` (or the free Workers-AI pair when the operator configured none). null
   *  (unset) ⇒ the operator's plan. No operator floor applies to WHICH reviewers run (only `onMerge` gates
   *  strictness), so this always wins unclamped when set. */
  aiReviewReviewers: ReadonlyArray<{ model: string; fallback?: string | null | undefined }> | null;
  mergeReadiness: GateRuleMode | null;
  manifestPolicy: GateRuleMode | null;
  selfAuthoredLinkedIssue: GateRuleMode | null;
  dryRun: boolean | null;
  firstTimeContributorGrace: boolean | null;
  /** `gate.premergeContentRecheck` (#2550): for a PR touching `migrations/**`, re-verify against a live,
   *  freshly-fetched tip of the base branch — unioned with this PR's own new migration filenames — for a
   *  migration-number collision immediately before an agent-driven merge, not just at CI time against the
   *  PR's own stale branch snapshot. On a live collision, the merge is suppressed and the PR is held with a
   *  rebase-needed comment instead of merging blind. null (unset) ⇒ off (byte-identical to today) — this
   *  costs one extra, uncached GitHub Trees-API call for any PR that touches migrations/**, so it is opt-in
   *  rather than a new default. */
  premergeContentRecheck: boolean | null;
  /** `gate.requireFreshRebaseWindow` (#2552, anti-race): minutes. When the base branch has advanced within
   *  this window of the actual merge-decision moment, an agent-driven merge forces an `update_branch` +
   *  fresh CI recheck cycle before merging, instead of trusting a `mergeableState: clean` read that may
   *  already be stale relative to a sibling commit that just landed on the base. null (unset) ⇒ never force
   *  (byte-identical to today) — a discrete positive-minutes count, not a score, so it is neither clamped
   *  nor rounded; an invalid value (fractional, non-positive, non-finite) is dropped with a warning. */
  requireFreshRebaseWindowMinutes: number | null;
  /** `gate.claMode` (#2564): off/advisory/block. null (unset) ⇒ off (byte-identical to today) — a repo must
   *  explicitly opt in before any CLA consent check runs. */
  claMode: GateRuleMode | null;
  /** `gate.cla.consentPhrase` (#2564): the required PR-body consent phrase. null (unset) ⇒ phrase-match
   *  detection is not configured. */
  claConsentPhrase: string | null;
  /** `gate.cla.checkRunName` (#2564): the CLA-bot check-run name to trust. null (unset) ⇒ check-run
   *  detection is not configured. */
  claCheckRunName: string | null;
  /** `gate.cla.checkRunAppSlug`: the trusted GitHub App slug that must produce `checkRunName`. null (unset) ⇒
   *  check-run detection remains unresolved rather than trusting a spoofable name-only match. */
  claCheckRunAppSlug: string | null;
  /** `gate.expectedCiContexts` (#selfhost-ci-verification): CI check/status context names to treat as
   *  required when GitHub branch-protection required-status-checks are unreadable or unconfigured. null
   *  (unset) ⇒ no generic fallback configured — the live-CI aggregate keeps today's fold-all behavior
   *  when branch protection is also unreadable. See {@link RepositorySettings.expectedCiContexts}. */
  expectedCiContexts: ReadonlyArray<string> | null;
};

// The converged per-PR review features a self-host operator toggles PER-REPO under `features:` in the private
// `.gittensory.yml`. Each feature ALSO has a GLOBAL env flag (GITTENSORY_REVIEW_*) that stays a master
// kill-switch (the feature never runs when its env flag is off, regardless of this block). See
// review/feature-activation.ts for the resolver (env kill-switch → per-repo override → env-allowlist default).
// NOTE: only the per-PR REVIEW features whose every activation site is migrated are listed here. grounding and
// screenshots stay on the GITTENSORY_REVIEW_REPOS allowlist for now (grounding is coupled to the merge/close
// DISPOSITION path; screenshots' capture path needs dedicated coverage) — a follow-up. contentLane got its own
// richer `contentLane:` block below (#2435) instead of a boolean here, since it resolves to a whole
// RegistryLaneSpec, not an on/off toggle — see resolveRegistryLaneSpec in review/content-lane/spec-resolver.ts.
export const CONVERGED_FEATURE_KEYS = ["rag", "reputation", "unifiedComment", "safety"] as const;
export type ConvergedFeatureKey = (typeof CONVERGED_FEATURE_KEYS)[number];

/** Per-repo activation overrides for the converged review features (`features:` block). `true`/`false` force the
 *  feature on/off for THIS repo (subject to the env kill-switch); `null` (unset) ⇒ the resolver falls back to the
 *  `GITTENSORY_REVIEW_REPOS` allowlist default, so an operator who sets nothing keeps today's behavior. */
export type FocusManifestFeaturesConfig = { present: boolean } & Record<ConvergedFeatureKey, boolean | null>;

/**
 * Per-repo registry-review lane configuration (`contentLane:` block, #2435) — lets a self-hosted maintainer
 * configure their OWN registry (structural file-scope patterns + entry-count cap + dedup fields) without a
 * gittensory code change. `entryFileGlob` and `collectionField` are the two REQUIRED fields to build a usable
 * spec; `present` is true only when both are set (a partial config degrades to "not configured," not a broken
 * half-spec — see `parseContentLaneConfig`). `validatorId` optionally references a code-registered domain
 * validator (`review/content-lane/spec-resolver.ts`'s `REGISTRY_VALIDATORS`); omitted ⇒ structural gating only
 * (scope/count/dedup), no domain-specific semantic check — see `RegistryLaneSpec.assessAppendedEntry`.
 */
export type FocusManifestContentLaneConfig = {
  present: boolean;
  entryFileGlob: string | null;
  providerFileGlob: string | null;
  artifactGlob: string | null;
  collectionField: string | null;
  maxAppendedEntries: number | null;
  duplicateKeyFields: string[];
  validatorId: string | null;
};

/** Which generated-file types the repo-doc generation roadmap (#2993) is allowed to touch for a repo.
 *  "agents" covers AGENTS.md/CLAUDE.md (#3000/#3004); "skills" covers generated Claude Code/Codex skill
 *  files once that generator lands (#3001) -- listed here now so a maintainer can opt in ahead of time. */
export type FocusManifestRepoDocGenerationScope = "agents" | "skills";

/**
 * Per-repo opt-in for the repo-doc generation roadmap (#2993/#3002), declared as code under
 * `repoDocGeneration:`. Purely a `.gittensory.yml` surface -- there is no DB-backed dashboard counterpart,
 * so precedence is simply "the manifest value, or the default below when unset" (no DB layer to overlay).
 * Defaults to fully disabled: a repo with no `repoDocGeneration:` block, or an explicit `enabled: false`,
 * is never touched by the generator. `allowOverwriteExisting` is a SEPARATE opt-in specifically for a repo
 * that already has a hand-maintained AGENTS.md/CLAUDE.md (no recognizable generated-content marker block,
 * per generated-doc-refresh.ts's `manual-review-required` outcome) -- without it, that repo is left alone
 * rather than proposed for a wholesale overwrite, even when `enabled` is true.
 */
export type FocusManifestRepoDocGenerationConfig = {
  present: boolean;
  enabled: boolean;
  scope: FocusManifestRepoDocGenerationScope[];
  allowOverwriteExisting: boolean;
  /** How many days must elapse between scheduled refresh attempts for this repo (#3003). Default 7 (weekly).
   *  Purely a rate-limiting knob on the SCHEDULED sweep -- it never affects correctness, since
   *  openRepoDocPullRequest's own no-change short-circuit already prevents a redundant PR regardless of how
   *  often it's invoked; this just avoids re-checking a stable repo more often than the operator wants. */
  refreshIntervalDays: number;
};

/**
 * Per-repo opt-in for the periodic maintainer review-recap digest (#1963), declared as code under
 * `reviewRecap:`. Mirrors `repoDocGeneration:` exactly: no DB-backed dashboard counterpart, so the parsed
 * value (or the default below when unset) IS the effective value — there is no DB layer to overlay onto.
 * Defaults to fully disabled: a repo with no `reviewRecap:` block, or an explicit `enabled: false`, never
 * gets a recap posted. Discord delivery ONLY for now (reuses the SAME per-repo webhook resolution as the
 * per-event notifier in notify-discord.ts, `resolveDiscordWebhook`) — Slack is a follow-up.
 */
export type FocusManifestReviewRecapConfig = {
  present: boolean;
  enabled: boolean;
  /** How many days of review activity each recap covers, and (once the scheduler follow-up lands) how often
   *  it is posted. Default 7 (weekly). A purely descriptive/rate-limiting knob today — this PR ships only
   *  the manually-triggerable builder + delivery, so `cadenceDays` currently just sets the report WINDOW;
   *  the scheduled cron trigger is a scoped follow-up (see the PR description). */
  cadenceDays: number;
};

/**
 * Generic repository-settings override declared in `.gittensory.yml` under `settings:`. A partial of
 * {@link RepositorySettings} — every behaviour a maintainer can toggle in the dashboard can be set here
 * as code. Unset fields are omitted so the resolver layers it OVER the DB-backed settings
 * (`.gittensory.yml` > dashboard settings > safe defaults). The friendly `gate:` block is a typed alias
 * for the gate-related subset and wins over `settings:` for those fields.
 */
export type FocusManifestSettings = Partial<
  Pick<
    RepositorySettings,
    | "commentMode"
    | "publicAudienceMode"
    | "publicSignalLevel"
    | "checkRunMode"
    | "checkRunDetailLevel"
    | "gateCheckMode"
    | "reviewCheckMode"
    | "autoProjectMilestoneMatch"
    | "autoProjectMilestoneMatchBackend"
    | "linkedIssueGateMode"
    | "duplicatePrGateMode"
    | "selfAuthoredLinkedIssueGateMode"
    | "qualityGateMode"
    | "qualityGateMinScore"
    | "aiReviewMode"
    | "aiReviewByok"
    | "aiReviewProvider"
    | "aiReviewModel"
    | "aiReviewAllAuthors"
    | "closeOwnerAuthors"
    | "autoLabelEnabled"
    | "typeLabelsEnabled"
    | "badgeEnabled"
    | "gittensorLabel"
    | "createMissingLabel"
    | "publicSurface"
    | "includeMaintainerAuthors"
    | "requireLinkedIssue"
    | "backfillEnabled"
    | "privateTrustEnabled"
    | "autonomy"
    | "autoMaintain"
    | "agentPaused"
    | "agentDryRun"
    | "commandAuthorization"
    | "contributorBlacklist"
    | "blacklistLabel"
    | "contributorOpenPrCap"
    | "contributorOpenIssueCap"
    | "contributorCapLabel"
    | "contributorCapCancelCi"
    | "reviewNagPolicy"
    | "reviewNagMaxPings"
    | "reviewNagCooldownDays"
    | "reviewNagLabel"
    | "reviewNagMonitoredMentions"
    | "autoCloseExemptLogins"
    | "hardGuardrailGlobs"
    | "manualReviewLabel"
    | "readyToMergeLabel"
    | "changesRequestedLabel"
    | "migrationCollisionLabel"
    | "pendingClosureLabel"
    | "accountAgeThresholdDays"
    | "newAccountLabel"
    | "commandRateLimitPolicy"
    | "commandRateLimitMaxPerWindow"
    | "commandRateLimitAiMaxPerWindow"
    | "commandRateLimitWindowHours"
    | "moderationGateMode"
    | "moderationRules"
    | "moderationWarningLabel"
    | "moderationBannedLabel"
    | "reviewEvasionProtection"
    | "reviewEvasionLabel"
    | "reviewEvasionComment"
  >
> & {
  // `typeLabels`/`linkedIssueLabelPropagation`/`linkedIssueHardRules` are declared PARTIAL here (not via the `Pick<RepositorySettings,
  // ...>` above, which would force a complete, defaults-filled object) so `resolveEffectiveSettings` can merge
  // them field-by-field against the DB value — a `.gittensory.yml` override naming only one key (e.g. just
  // `typeLabels.priority`) must inherit the OTHER keys from the DB-persisted value, not silently reset them to
  // the built-in default (#priority-linked-issue-gate), and can add arbitrary categories beyond the built-in
  // three (#label-modularity). `mappings` is still a complete replacement when present (arrays don't have
  // per-item precedence semantics, matching the private-config layer's own documented array-replace-wholesale
  // overlay behavior).
  // `typeLabels: null` (distinct from an omitted key OR a sparse-but-nonempty object) is a DELIBERATE signal
  // reserved for a manifest's literal `typeLabels: {}` — "zero configured categories for this repo" — the same
  // load-bearing-null idiom as `blacklistLabel`/`contributorCapLabel`/etc. This is NOT the same as a sparse
  // override whose named keys all failed validation (which still parses to `{}`, not `null`, and must NOT wipe
  // the DB value -- see `resolveEffectiveSettings`).
  typeLabels?: Partial<PrTypeLabelSet> | null | undefined;
  linkedIssueLabelPropagation?: Partial<LinkedIssueLabelPropagationConfig> | undefined;
  linkedIssueHardRules?: Partial<LinkedIssueHardRulesConfig> | undefined;
  unlinkedIssueGuardrail?: Partial<UnlinkedIssueGuardrailConfig> | undefined;
};

/** Field keys for the public review-panel rows a maintainer can show/hide via `review.fields`. */
export const REVIEW_FIELD_KEYS = ["linkedIssue", "relatedWork", "reviewLoad", "validationEvidence", "openPrQueue", "contributorContext", "gateResult"] as const;
export type ReviewFieldKey = (typeof REVIEW_FIELD_KEYS)[number];

// `review.profile` (#review-profile): how nitpicky the AI maintainer review is. `chill` = surface only blocking
// defects (bugs/security/breakage), suppress style nits; `assertive` = also raise minor improvements & nits;
// `balanced` (default / absent) leaves the reviewer prompt byte-identical. A presentation knob only — it NEVER
// changes the gate verdict, only how much advisory detail the review write-up carries.
export const REVIEW_PROFILES = ["chill", "balanced", "assertive"] as const;
export type ReviewProfile = (typeof REVIEW_PROFILES)[number];

export type ReviewFindingSeverity = "critical" | "major" | "minor" | "nitpick";

export const REVIEW_FINDING_SEVERITY_LADDER = ["critical", "major", "minor", "nitpick"] as const;

/**
 * Maintainer overrides for the public review-panel CONTENT, declared under `review:`. Customizes the
 * panel without changing what gittensory measures: a custom public-safe footer lead line, a custom intro
 * note, and per-row show/hide toggles. The Gittensor attribution + register link is ALWAYS appended to
 * the footer regardless (the growth surface is preserved); maintainer text that fails the public-safe
 * filter is dropped, never published.
 */
export type FocusManifestReviewConfig = {
  present: boolean;
  footerText: string | null;
  note: string | null;
  fields: Partial<Record<ReviewFieldKey, boolean>>;
  /** `review.enrichment`: per-repo REES enrichment-analyzer toggles (analyzer name → on/off). Only known analyzer
   *  keys are kept (unknown keys warn + drop at parse). Empty (default, absent) ⇒ the operator's default analyzer
   *  set runs unchanged (byte-identical). (#2050) */
  enrichmentAnalyzers: Partial<Record<ReesAnalyzerName, boolean>>;
  /** `review.profile`: chill / balanced / assertive. null (absent) = balanced = byte-identical reviewer prompt. */
  profile: ReviewProfile | null;
  /** `review.tone`: a bounded public-safe voice brief complementing `review.profile` (e.g. "concise, cite line numbers").
   *  Folded into the review-instructions slot at runtime. null (default, absent) ⇒ byte-identical prompt. (#2044) */
  tone: string | null;
  /** `review.security_focus`: when true, the AI reviewer is told to prioritize a security-defect category
   *  (injection, authn/authz bypass, secret handling, unsafe deserialization, SSRF, path traversal) with
   *  elevated scrutiny, ON TOP OF whatever `profile` volume is set — an orthogonal "what to prioritize" axis,
   *  not a fourth profile level. null/false (default, absent) = byte-identical reviewer prompt. (#review-security-focus) */
  securityFocus: boolean | null;
  /** `review.inline_comments`: when true, the AI reviewer ALSO leaves quiet, non-blocking inline PR comments on
   *  specific changed lines (in addition to the decision summary). null/false (default, absent) = no inline
   *  comments = byte-identical behavior. Operator-gated too (GITTENSORY_REVIEW_INLINE_COMMENTS + allowlist).
   *  (#inline-comments) */
  inlineComments: boolean | null;
  /** `review.suggestions`: when true, an inline finding whose AI-provided fix is precise enough to anchor to a
   *  single line is ALSO rendered as a GitHub-native ` ```suggestion ` block a contributor can commit in one
   *  click. Only takes effect when inline comments are already on (a suggestion has nothing to attach to
   *  otherwise) — this is an ADDITIONAL opt-in on top of `review.inline_comments`, not a replacement gate.
   *  null/false (default, absent) = no suggestion blocks = byte-identical behavior. (#1956) */
  suggestions: boolean | null;
  /** `review.changed_files_summary`: when true, the unified review comment (only rendered at all when the
   *  `unifiedComment` convergence feature is on) gains a deterministic, no-AI "Changed files" collapsible: one
   *  row per file category (source/test/docs/config/generated), with file counts and +/- totals, via the
   *  existing `classifyChangedFile` classifier (`src/review/changed-files-classify.ts`, built for this table
   *  under #2143). null/false (default, absent) = no changed-files section = byte-identical behavior. (#1957) */
  changedFilesSummary: boolean | null;
  /** `review.effort_score`: when true, the unified review comment (only rendered when the `unifiedComment`
   *  convergence feature is on) gains a compact "review effort: N/5 (~M min)" chip — a deterministic, no-AI
   *  complexity/time estimate from `estimateReviewEffort` (`src/review/review-effort.ts`), weighting each
   *  changed file's added lines by its category (source costs most; generated/vendored/lockfiles cost least)
   *  plus a fixed per-file overhead. Mirrors `changedFilesSummary` exactly: same table, same deterministic
   *  source, same display-only (never touches the AI prompt) shape. null/false (default, absent) = no chip =
   *  byte-identical behavior. (#1955) */
  effortScore: boolean | null;
  /** `review.test_generation` (#1972): when true, a diff that touches a small, precise set of boundary-condition
   *  patterns (off-by-one array/index bounds, null/undefined branches, empty-collection checks — see
   *  `src/signals/boundary-test-generation.ts`) with NO test evidence anywhere in the PR gets an additional
   *  advisory finding plus a boundary-safe LOCAL-execution test-generation action spec (criteria/hints only,
   *  never generated test code — mirrors the `src/mcp/local-write-tools.ts` no-cloud-write boundary). Purely
   *  additive and deterministic; it never changes what `missingTestEvidence` already does. null/false (default,
   *  absent) ⇒ byte-identical behavior — no boundary scan runs at all. */
  testGeneration: boolean | null;
  /** `review.finding_categories`: when true, an inline finding is ALSO tagged with a category (security/
   *  correctness/performance/maintainability/tests/style) — the AI reviewer is asked to self-categorize, with a
   *  deterministic path/keyword fallback (`classifyFindingCategory`) covering whatever it omits. Only takes
   *  effect when inline comments are already on (a category has nothing to categorize otherwise) — this is an
   *  ADDITIONAL opt-in on top of `review.inline_comments`, not a replacement gate, mirroring `review.suggestions`.
   *  null/false (default, absent) = no category tagging = byte-identical behavior. (#1958) */
  findingCategories: boolean | null;
  /** `review.min_finding_severity`: display-only floor for AI findings with a severity tier. Findings below the
   *  configured level are suppressed from inline comments — never from gate blockers. null (default, absent) ⇒ every
   *  finding shown = byte-identical behavior. (#2048) */
  minFindingSeverity: ReviewFindingSeverity | null;
  /** `review.max_findings`: optional caps on how many blocker/nit lines render in the unified review comment.
   *  Display-only — never removes a blocker from the gate decision. null sub-fields ⇒ no cap for that list.
   *  Default { blockers: null, nits: null } ⇒ byte-identical. (#2049) */
  maxFindings: MaxFindingsConfig;
  /** `review.comment_verbosity`: how much of the unified review comment's collapsible detail renders. `quiet`
   *  drops the Nits collapsible and every extra collapsible section (blockers/gate result/signals are never
   *  gated by this — only decorative detail is); `detailed` renders every collapsible pre-expanded. null/normal
   *  (default, absent) ⇒ byte-identical to today. Net-new vs the changed-files-summary (#1957) and effort-score
   *  (#1955) knobs. (#2047) */
  commentVerbosity: CommentVerbosity | null;
  /** `review.path_instructions`: per-path natural-language guidance handed to the AI reviewer when the PR's
   *  changed files match the glob. Empty (default) ⇒ byte-identical reviewer prompt. (#review-path-instructions) */
  pathInstructions: ReviewPathInstruction[];
  /** `review.instructions`: a repo-level natural-language brief handed to the AI reviewer on EVERY review (vs the
   *  per-path path_instructions) — the maintainer's conventions/voice for this repo. Bounded + public-safe at parse
   *  time (so it stays cost-cheap, unlike ingesting a whole CLAUDE.md). null (default, absent) ⇒ byte-identical
   *  reviewer prompt. (#review-instructions) */
  instructions: string | null;
  /** `review.exclude_paths`: globs whose matching files are EXCLUDED from the AI review (diff + grounding + RAG)
   *  — generated/vendored/lockfiles the maintainer doesn't want reviewed. Empty (default) ⇒ every file is
   *  reviewed (byte-identical). Gate/slop/secret-scan are UNAFFECTED — this only narrows the AI review.
   *  (#review-exclude-paths) */
  excludePaths: string[];
  /** `review.path_filters`: include + `!`-negation globs that POSITIVELY scope the AI review AFTER
   *  `exclude_paths`. Include entries restrict to matching paths; leading `!` entries subtract matches.
   *  Both `*` and `**` cross slashes (see `compileManifestPathMatcher`). Empty (default) ⇒ every non-excluded
   *  file is reviewed (byte-identical). Gate/slop/secret-scan are UNAFFECTED. (#2043) */
  pathFilters: string[];
  /** `review.pre_merge_checks`: maintainer-declared DETERMINISTIC content assertions (title/description must
   *  contain a phrase, a label must be present), optionally gated to a path glob. Each FAILED check surfaces an
   *  advisory finding; a check with `enforce: true` becomes a hard gate blocker. Empty (default) ⇒ no finding
   *  (byte-identical). No AI judgment is involved. (#review-pre-merge-checks) */
  preMergeChecks: PreMergeCheck[];
  /** `review.auto_review`: deterministic eligibility filters that skip the AI review (never a gate failure).
   *  Empty/default ⇒ every PR is reviewed (byte-identical). (#1954 / #2038–#2041) */
  autoReview: AutoReviewConfig;
  /** `review.labeling_rules`: deterministic `{label, when}` rules that SUGGEST a non-scoring label when a PR's
   *  changed paths / title / description match. Surfaced as advisory suggestions, and auto-applied only when the
   *  repo's `autoLabelEnabled` is set. Reserved `gittensor:` labels are refused at parse. Empty (default) ⇒ no
   *  suggestion (byte-identical). (#2045, part of #1959) */
  labelingRules: LabelingRule[];
  /** `review.ai_model`: per-repo self-host reviewer model/effort overrides (claude-code / codex). Self-host only
   *  — a hosted (Workers-AI) repo ignores this entirely. All-null (default, absent) ⇒ the operator's global
   *  CLAUDE_AI_MODEL/CLAUDE_AI_EFFORT/CODEX_AI_MODEL/CODEX_AI_EFFORT env vars apply unchanged (byte-identical).
   *  (#selfhost-ai-model-override) */
  aiModel: SelfHostAiModelConfig;
  /** `review.visual`: per-repo before/after screenshot-capture config (#3609 preview / #3610 routes).
   *  All-empty (default, absent) ⇒ byte-identical to today (GitHub-native preview discovery, automatic
   *  file-to-route inference, built-in route cap). Only takes effect when the operator has also enabled
   *  GITTENSORY_REVIEW_SCREENSHOTS + the repo cutover allowlist — this config narrows/redirects that
   *  feature, it never turns it on by itself. */
  visual: VisualConfig;
  /** `review.linkedIssueSatisfaction`: how strictly a linked issue must actually be SATISFIED by the PR — `off`
   *  (default; not evaluated), `advisory` (surface a finding), or `block` (can become a hard blocker). CONFIG SLICE
   *  ONLY (#2173, for #1961): parsed + normalized here; the merge/close decision that reads this mode is a separate
   *  maintainer-only slice. null (default, absent) ⇒ byte-identical to today. */
  linkedIssueSatisfaction: LinkedIssueSatisfactionMode | null;
};

/** `review.linkedIssueSatisfaction` modes (#2173). `off` = not evaluated (same as unset). */
export const LINKED_ISSUE_SATISFACTION_MODES = ["off", "advisory", "block"] as const;
export type LinkedIssueSatisfactionMode = (typeof LINKED_ISSUE_SATISFACTION_MODES)[number];

/** `review.comment_verbosity` levels (#2047). `normal` = today's behavior (same as unset). */
export const COMMENT_VERBOSITY_LEVELS = ["quiet", "normal", "detailed"] as const;
export type CommentVerbosity = (typeof COMMENT_VERBOSITY_LEVELS)[number];

/** One `review.labeling_rules[]` entry: a non-reserved `label` plus the deterministic `when` criteria that must ALL
 *  match for it to fire. A rule always has at least one criterion (enforced at parse). */
export type LabelingRule = {
  label: string;
  whenPaths: string[];
  titleContains: string | null;
  descriptionContains: string | null;
};

/** Per-repo AI review eligibility knobs under `review.auto_review`. Unset fields are byte-identical defaults. */
export type AutoReviewConfig = {
  /** `review.auto_review.skip_drafts`: when true, draft PRs skip AI review. null (default) ⇒ drafts reviewed as today. (#2038) */
  skipDrafts: boolean | null;
  /** `review.auto_review.ignore_authors`: author-login globs whose PRs skip AI review. Empty ⇒ every author. (#2039) */
  ignoreAuthors: string[];
  /** `review.auto_review.ignore_title_keywords`: case-insensitive title substrings that skip AI review. Empty ⇒ no skip. (#2040) */
  ignoreTitleKeywords: string[];
  /** `review.auto_review.skip_labels`: case-insensitive PR label names that skip AI review. Empty ⇒ no skip. (#2062) */
  skipLabels: string[];
  /** `review.auto_review.skip_docs_only`: when true, PRs whose every changed file classifies as docs skip AI review.
   *  null (default) ⇒ docs PRs reviewed as today. Empty changed-file list ⇒ NOT docs-only (fail-safe eligible). (#2063) */
  skipDocsOnly: boolean | null;
  /** `review.auto_review.max_added_lines`: skip AI review when total added lines exceed this cap. 0 (default) ⇒ no cap. (#2065) */
  maxAddedLines: number;
  /** `review.auto_review.max_files`: skip AI review when changed-file count exceeds this cap. 0 (default) ⇒ no cap. (#2065) */
  maxFiles: number;
  /** `review.auto_review.base_branches`: base-ref globs whose PRs ARE reviewed; empty/unset ⇒ every base. (#2041) */
  baseBranches: string[];
  /** `review.auto_review.auto_pause_after_reviewed_commits`: after N published AI reviews on this PR, pause further
   *  re-reviews. null/0 ⇒ byte-identical (re-review every sync). (#2042) */
  autoPauseAfterReviewedCommits: number | null;
};

export type MaxFindingsConfig = {
  blockers: number | null;
  nits: number | null;
};

export const EMPTY_MAX_FINDINGS_CONFIG: MaxFindingsConfig = { blockers: null, nits: null };

export const EMPTY_AUTO_REVIEW_CONFIG: AutoReviewConfig = {
  skipDrafts: null,
  ignoreAuthors: [],
  ignoreTitleKeywords: [],
  skipLabels: [],
  skipDocsOnly: null,
  maxAddedLines: 0,
  maxFiles: 0,
  baseBranches: [],
  autoPauseAfterReviewedCommits: null,
};

/** Per-repo self-host reviewer model/effort overrides under `review.ai_model`. Each field independently overrides
 *  the matching global env var (CLAUDE_AI_MODEL / CLAUDE_AI_EFFORT / CODEX_AI_MODEL / CODEX_AI_EFFORT) for THIS
 *  repo only — it never widens what the operator's own env already permits, only narrows/redirects it, so a
 *  compromised repo config can change which model reviews it but not grant itself a new credential or provider.
 *  (#selfhost-ai-model-override) */
export type SelfHostAiModelConfig = {
  /** `review.ai_model.claude_model`: overrides CLAUDE_AI_MODEL for this repo's claude-code reviewer. null (default) ⇒ the operator's global env var, then the provider's own default. */
  claudeModel: string | null;
  /** `review.ai_model.claude_effort`: overrides CLAUDE_AI_EFFORT for this repo's claude-code reviewer. null (default) ⇒ the operator's global env var, then "medium". */
  claudeEffort: string | null;
  /** `review.ai_model.codex_model`: overrides CODEX_AI_MODEL for this repo's codex reviewer. null (default) ⇒ the operator's global env var, then the account default. */
  codexModel: string | null;
  /** `review.ai_model.codex_effort`: overrides CODEX_AI_EFFORT for this repo's codex reviewer. null (default) ⇒ the operator's global env var, then "medium". */
  codexEffort: string | null;
};

export const EMPTY_SELF_HOST_AI_MODEL_CONFIG: SelfHostAiModelConfig = {
  claudeModel: null,
  claudeEffort: null,
  codexModel: null,
  codexEffort: null,
};

/** Per-repo before/after screenshot-capture config under `review.visual` (#3609 / #3610). Generic by design —
 *  every self-hoster wires their OWN repo's preview-deploy setup and route shape with config, not code. */
export type VisualConfig = {
  preview: VisualPreviewConfig;
  routes: VisualRoutesConfig;
  themes: VisualTheme[];
  /** `review.visual.gif`: capture a short scroll-through GIF (#3612) alongside the static before/after
   *  screenshots — evidence for scroll-linked behavior (parallax, reveal-on-scroll, a sticky header) that a
   *  single static shot can't show. Self-host only (see src/review/visual/scroll-gif.ts) and the heaviest
   *  capture mode this pipeline has (up to 6 extra renders per side) — false (default, every existing
   *  manifest) ⇒ byte-identical to today, no scroll frames captured at all. */
  gif: boolean;
};

/** A `prefers-color-scheme` value the capture pipeline can emulate before rendering (#3678). */
export type VisualTheme = "light" | "dark";

export type VisualPreviewConfig = {
  /** `review.visual.preview.url_template`: the repo's "after" preview URL, with `{number}` (PR number),
   *  `{head_sha}` (full commit SHA), and `{head_sha_short}` (first 7 chars) placeholders substituted at
   *  capture time — e.g. `https://pr-{number}.myapp.workers.dev`. ALWAYS wins over GitHub-native preview
   *  discovery (the Deployments API / commit checks / cloudflare-bot PR comment) when set — an explicit,
   *  maintainer-configured template is a stronger signal than inference, and is the only option for a
   *  provider (e.g. Cloudflare Workers Builds' non-production branch builds) that doesn't surface a
   *  GitHub-visible deployment at all. null (default) ⇒ byte-identical to today (discovery unchanged).
   *  Validated at parse time against the same SSRF guard the renderer itself applies (isSafeHttpUrl) with
   *  placeholders substituted for a dummy value, so a malformed template warns at config-read time instead
   *  of only failing silently at render time — this is redundant with (not a replacement for) the
   *  renderer's own unconditional isSafeHttpUrl check on every resolved URL, regardless of source. */
  urlTemplate: string | null;
};

export type VisualRoutesConfig = {
  /** `review.visual.routes.paths`: an explicit, always-screenshotted route list. When non-empty, this
   *  REPLACES automatic file-to-route inference entirely — for repos whose routing convention isn't
   *  gittensory-ui's TanStack file-based one, an explicit list is simpler and more robust than trying to
   *  infer one. Empty (default) ⇒ automatic inference (falling back to "/" when nothing matches). */
  paths: string[];
  /** `review.visual.routes.max_routes`: overrides the built-in cap (2) on how many routes get screenshotted
   *  per PR. null (default) ⇒ built-in default. Applies whether routes come from `paths` above or from
   *  automatic inference. */
  maxRoutes: number | null;
};

export const EMPTY_VISUAL_CONFIG: VisualConfig = {
  preview: { urlTemplate: null },
  routes: { paths: [], maxRoutes: null },
  themes: [],
  gif: false,
};

/** One `review.path_instructions[]` entry: a manifest path glob + the public-safe instructions to apply when a
 *  changed file matches it. */
export type ReviewPathInstruction = { path: string; instructions: string };

/** One `review.pre_merge_checks[]` entry — a DETERMINISTIC pre-merge assertion. `whenPaths` (empty ⇒ always
 *  applies) gates the check to PRs that touch a matching path. The check PASSES only when EVERY configured
 *  assertion holds: the PR title contains `titleContains`, the body contains `descriptionContains`, and the
 *  `requireLabel` label is present (case-insensitive substring / label match). `enforce` ⇒ a failure is a hard
 *  gate blocker; default (false) ⇒ advisory only. All strings are public-safe-filtered at parse time. */
export type PreMergeCheck = {
  name: string;
  whenPaths: string[];
  titleContains: string | null;
  descriptionContains: string | null;
  requireLabel: string | null;
  enforce: boolean;
};

// A hard cap so a hostile/huge manifest can't bloat the reviewer prompt (mirrors REVIEW_FIELD_KEYS discipline).
const MAX_PATH_INSTRUCTIONS = 50;

/**
 * Normalized maintainer focus manifest. Repo owners declare which work areas are wanted,
 * preferred, and how PRs should present validation. Path-based manual review is intentionally
 * not part of this manifest anymore; use `settings.hardGuardrailGlobs` for that single
 * authoritative control. `maintainerNotes` are private review context and must never reach a public
 * GitHub surface; `publicNotes` are explicitly opted into public output by the maintainer.
 */
export type FocusManifest = {
  present: boolean;
  source: FocusManifestSource;
  wantedPaths: string[];
  preferredLabels: string[];
  linkedIssuePolicy: FocusManifestLinkedIssuePolicy;
  testExpectations: string[];
  issueDiscoveryPolicy: FocusManifestIssueDiscoveryPolicy;
  maintainerNotes: string[];
  publicNotes: string[];
  gate: FocusManifestGateConfig;
  settings: FocusManifestSettings;
  review: FocusManifestReviewConfig;
  features: FocusManifestFeaturesConfig;
  contentLane: FocusManifestContentLaneConfig;
  repoDocGeneration: FocusManifestRepoDocGenerationConfig;
  reviewRecap: FocusManifestReviewRecapConfig;
  warnings: string[];
};

export type FocusManifestFinding = {
  code:
    | "manifest_off_focus"
    | "manifest_preferred_path"
    | "manifest_missing_preferred_label"
    | "manifest_linked_issue_required"
    | "manifest_linked_issue_preferred"
    | "manifest_missing_tests"
    | "manifest_issue_discovery_discouraged"
    | "manifest_malformed";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  action?: string | undefined;
};

export type FocusManifestGuidance = {
  present: boolean;
  source: FocusManifestSource;
  linkedIssuePolicy: FocusManifestLinkedIssuePolicy;
  issueDiscoveryPolicy: FocusManifestIssueDiscoveryPolicy;
  matchedWantedPaths: string[];
  preferredLabelHits: string[];
  findings: FocusManifestFinding[];
  publicNextSteps: string[];
  warnings: string[];
  summary: string;
};

const MAX_LIST_ITEMS = 200;
const MAX_ITEM_LENGTH = 300;
const MAX_GLOBSTAR_SLASH_ALTERNATIVES = 128;
export const MAX_FOCUS_MANIFEST_BYTES = 64 * 1024;

const EMPTY_GATE_CONFIG: FocusManifestGateConfig = {
  present: false,
  enabled: null,
  checkMode: null,
  pack: null,
  linkedIssue: null,
  duplicates: null,
  readinessMode: null,
  readinessMinScore: null,
  slopMode: null,
  slopMinScore: null,
  slopAiAdvisory: null,
  sizeMode: null,
  lockfileIntegrityMode: null,
  aiReviewMode: null,
  aiReviewByok: null,
  aiReviewProvider: null,
  aiReviewModel: null,
  aiReviewAllAuthors: null,
  aiReviewCloseConfidence: null,
  aiReviewCombine: null,
  aiReviewOnMerge: null,
  aiReviewReviewers: null,
  mergeReadiness: null,
  manifestPolicy: null,
  selfAuthoredLinkedIssue: null,
  dryRun: null,
  firstTimeContributorGrace: null,
  premergeContentRecheck: null,
  requireFreshRebaseWindowMinutes: null,
  claMode: null,
  claConsentPhrase: null,
  claCheckRunName: null,
  claCheckRunAppSlug: null,
  expectedCiContexts: null,
};

const EMPTY_FEATURES_CONFIG: FocusManifestFeaturesConfig = {
  present: false,
  rag: null,
  reputation: null,
  unifiedComment: null,
  safety: null,
};

const EMPTY_CONTENT_LANE_CONFIG: FocusManifestContentLaneConfig = {
  present: false,
  entryFileGlob: null,
  providerFileGlob: null,
  artifactGlob: null,
  collectionField: null,
  maxAppendedEntries: null,
  duplicateKeyFields: [],
  validatorId: null,
};

const DEFAULT_REPO_DOC_REFRESH_INTERVAL_DAYS = 7;

const EMPTY_REPO_DOC_GENERATION_CONFIG: FocusManifestRepoDocGenerationConfig = {
  present: false,
  enabled: false,
  scope: ["agents"],
  allowOverwriteExisting: false,
  refreshIntervalDays: DEFAULT_REPO_DOC_REFRESH_INTERVAL_DAYS,
};

const DEFAULT_REVIEW_RECAP_CADENCE_DAYS = 7;

const EMPTY_REVIEW_RECAP_CONFIG: FocusManifestReviewRecapConfig = {
  present: false,
  enabled: false,
  cadenceDays: DEFAULT_REVIEW_RECAP_CADENCE_DAYS,
};

const EMPTY_MANIFEST: FocusManifest = {
  present: false,
  source: "none",
  wantedPaths: [],
  preferredLabels: [],
  linkedIssuePolicy: "optional",
  testExpectations: [],
  issueDiscoveryPolicy: "neutral",
  maintainerNotes: [],
  publicNotes: [],
  gate: { ...EMPTY_GATE_CONFIG },
  settings: {},
  review: { present: false, footerText: null, note: null, fields: {}, enrichmentAnalyzers: {}, profile: null, tone: null, securityFocus: null, inlineComments: null, suggestions: null, changedFilesSummary: null, effortScore: null, testGeneration: null, findingCategories: null, minFindingSeverity: null, maxFindings: { ...EMPTY_MAX_FINDINGS_CONFIG }, commentVerbosity: null, pathInstructions: [], instructions: null, excludePaths: [], pathFilters: [], preMergeChecks: [], autoReview: { ...EMPTY_AUTO_REVIEW_CONFIG }, labelingRules: [], aiModel: { ...EMPTY_SELF_HOST_AI_MODEL_CONFIG }, visual: { ...EMPTY_VISUAL_CONFIG }, linkedIssueSatisfaction: null },
  features: { ...EMPTY_FEATURES_CONFIG },
  contentLane: { ...EMPTY_CONTENT_LANE_CONFIG },
  repoDocGeneration: { ...EMPTY_REPO_DOC_GENERATION_CONFIG },
  reviewRecap: { ...EMPTY_REVIEW_RECAP_CONFIG },
  warnings: [],
};

// This surface's economic/identity term vocabulary is intentionally richer than the canonical
// PUBLIC_UNSAFE_TERMS (extra phrases like "public score estimate"), so it stays a local literal. The local
// filesystem paths, however, compose from the canonical PUBLIC_LOCAL_PATH_INLINE in redaction.ts (which also
// covers `/var/`, previously missed here, plus `/root/` and the forward-slash Windows form `C:/Users/`) so this
// guard cannot drift from the canonical boundary on a leaking root.
const FOCUS_MANIFEST_TERMS = /\b(reward\w*|score\w*|wallets?|hotkeys?|coldkeys?|seed[-\s]?phrases?|mnemonics?|private[-\s]?keys?|farming|payouts?|rankings?|raw[-\s]?trust(?:[-\s]?scores?)?|trust[-\s]?scores?|private[-\s]?reviewability|reviewability(?:[-\s]?internals?)?|private[-\s]?scoreability|scoreability|public[-\s]?score[-\s]?(?:estimate|prediction|claim)s?|estimated[-\s]?scores?|score[-\s]?(?:estimate|prediction|preview)s?)\b/i;
const FOCUS_MANIFEST_LOCAL_PATH_PATTERN = new RegExp(PUBLIC_LOCAL_PATH_INLINE, "i");

/**
 * Public-safe redaction guard shared with the local-branch packet renderer. Public manifest
 * text must not leak reward, wallet/key, ranking, or local filesystem path material.
 */
export function isFocusManifestPublicSafe(text: string): boolean {
  return !FOCUS_MANIFEST_TERMS.test(text) && !FOCUS_MANIFEST_LOCAL_PATH_PATTERN.test(text);
}

function emptyManifest(source: FocusManifestSource, warnings: string[] = []): FocusManifest {
  return {
    ...EMPTY_MANIFEST,
    source,
    warnings,
    gate: { ...EMPTY_GATE_CONFIG },
    settings: {},
    review: { present: false, footerText: null, note: null, fields: {}, enrichmentAnalyzers: {}, profile: null, tone: null, securityFocus: null, inlineComments: null, suggestions: null, changedFilesSummary: null, effortScore: null, testGeneration: null, findingCategories: null, minFindingSeverity: null, maxFindings: { ...EMPTY_MAX_FINDINGS_CONFIG }, commentVerbosity: null, pathInstructions: [], instructions: null, excludePaths: [], pathFilters: [], preMergeChecks: [], autoReview: { ...EMPTY_AUTO_REVIEW_CONFIG }, labelingRules: [], aiModel: { ...EMPTY_SELF_HOST_AI_MODEL_CONFIG }, visual: { ...EMPTY_VISUAL_CONFIG }, linkedIssueSatisfaction: null },
    features: { ...EMPTY_FEATURES_CONFIG },
    contentLane: { ...EMPTY_CONTENT_LANE_CONFIG },
    repoDocGeneration: { ...EMPTY_REPO_DOC_GENERATION_CONFIG },
    reviewRecap: { ...EMPTY_REVIEW_RECAP_CONFIG },
  };
}

function normalizeStringList(value: JsonValue | undefined, field: string, warnings: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Manifest field "${field}" must be a list; ignoring a ${typeof value} value.`);
    return [];
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      warnings.push(`Manifest field "${field}" skipped a non-string entry.`);
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Truncate in place, then flow through the same de-dup and cap logic. Falling through (rather than
    // `continue`-ing) keeps over-long entries subject to both limits, so untrusted manifests cannot
    // bypass de-duplication or the MAX_LIST_ITEMS safety cap via pathological long entries.
    let normalized = trimmed;
    if (normalized.length > MAX_ITEM_LENGTH) {
      warnings.push(`Manifest field "${field}" truncated an over-long entry.`);
      normalized = normalized.slice(0, MAX_ITEM_LENGTH);
    }
    if (!result.includes(normalized)) result.push(normalized);
    if (result.length >= MAX_LIST_ITEMS) {
      warnings.push(`Manifest field "${field}" exceeded ${MAX_LIST_ITEMS} entries; extra entries ignored.`);
      break;
    }
  }
  return result;
}

/** Like {@link normalizeStringList}, but returns `null` (not `[]`) when unset or when nothing survives
 *  validation — the convention every OTHER `FocusManifestGateConfig` field uses for "not configured", so
 *  the resolver's `!== null` overlay checks work uniformly. */
function normalizeOptionalStringList(value: JsonValue | undefined, field: string, warnings: string[]): ReadonlyArray<string> | null {
  if (value === undefined || value === null) return null;
  const list = normalizeStringList(value, field, warnings);
  return list.length > 0 ? list : null;
}

function normalizeEnum<T extends string>(value: JsonValue | undefined, field: string, allowed: readonly T[], fallback: T, warnings: string[]): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    warnings.push(`Manifest field "${field}" must be one of ${allowed.join(", ")}; falling back to "${fallback}".`);
    return fallback;
  }
  return value as T;
}

function normalizeSource(raw: FocusManifestSource | undefined, value: JsonValue | undefined, warnings: string[]): FocusManifestSource {
  if (raw) return raw;
  return normalizeEnum<FocusManifestSource>(value, "source", ["repo_file", "api_record", "none"], "api_record", warnings);
}

function normalizeOptionalGateMode(value: JsonValue | undefined, field: string, warnings: string[]): GateRuleMode | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "off" || normalized === "advisory" || normalized === "block") return normalized;
  }
  warnings.push(`Manifest gate field "${field}" must be one of off, advisory, block; ignoring "${String(value)}".`);
  return null;
}

/** `gate.readiness.mode` (and its `settings.qualityGateMode` alias below) is documented and parsed as the shared
 *  off/advisory/block tri-state, but buildQualityGateWarning (src/rules/advisory.ts) always produces a
 *  warning-severity finding — never a blocker — and isConfiguredGateBlocker has no branch for it: readiness/
 *  quality is intentionally informational-only and can never hard-block a PR. Without this, a maintainer who
 *  sets `mode: block` believes a real quality floor is enforced when the effective behavior is silently
 *  advisory-only (#2267). Downgrade "block" to "advisory" here, with a clear deprecation warning, so the parsed
 *  config always matches what the gate actually does. Exported so the settings-write API routes (the
 *  dashboard/API path for the SAME `qualityGateMode` field) can apply the identical downgrade before persisting. */
export function normalizeReadinessGateMode(value: JsonValue | undefined, field: string, warnings: string[]): GateRuleMode | null {
  const mode = normalizeOptionalGateMode(value, field, warnings);
  if (mode !== "block") return mode;
  warnings.push(`Manifest gate field "${field}" no longer accepts "block" — readiness/quality is informational-only and can never hard-block a PR; downgrading to "advisory". Use gate.manifestPolicy or another enforceable gate for a real quality floor.`);
  return "advisory";
}

function normalizeOptionalBoolean(value: JsonValue | undefined, field: string, warnings: string[]): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  warnings.push(`Manifest gate field "${field}" must be a boolean; ignoring a ${typeof value} value.`);
  return null;
}

function normalizeOptionalScore(value: JsonValue | undefined, field: string, warnings: string[]): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`Manifest gate field "${field}" must be a number between 0 and 100; ignoring it.`);
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeOptionalNonNegativeInt(value: JsonValue | undefined, field: string, warnings: string[]): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    warnings.push(`Manifest field "${field}" must be a non-negative integer; ignoring it.`);
    return null;
  }
  return value;
}

/** Parse auto-review size caps where 0 means disabled (byte-identical default). (#2065) */
function normalizeAutoReviewSizeCap(value: JsonValue | undefined, field: string, warnings: string[]): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    warnings.push(`Manifest field "${field}" must be a non-negative integer; ignoring it.`);
    return 0;
  }
  return value;
}

/** Normalize an optional confidence threshold in [0,1] (#7) — a fractional value (NOT a 0-100 score), so it is
 *  clamped into range WITHOUT rounding. Absent/null ⇒ null (the resolver leaves the gate's 0.93 default in place);
 *  a non-finite/non-number value is ignored with a warning. */
function normalizeOptionalConfidence(value: JsonValue | undefined, field: string, warnings: string[]): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`Manifest gate field "${field}" must be a number between 0 and 1; ignoring it.`);
    return null;
  }
  return Math.max(0, Math.min(1, value));
}

// A hard cap on `gate.aiReview.reviewers` entries — the combiner only ever addresses reviewer[0]/[1] (single runs
// one, consensus/synthesis run two), so anything beyond 2 is inert; capping at 4 leaves headroom without letting a
// hostile/huge manifest bloat the parsed config for no functional gain.
const MAX_AI_REVIEW_REVIEWERS = 4;

/** Normalize `gate.aiReview.reviewers` (#2567) — a list of `{ model, fallback? }` entries naming self-host
 *  providers (e.g. `claude-code`, `codex`) to run in place of the operator's `AI_REVIEW_PLAN.reviewers`. Each
 *  entry needs a non-empty string `model`; `fallback` is optional and, when present, must also be a non-empty
 *  string. Invalid entries are dropped with a warning rather than failing the whole list, mirroring the other
 *  manifest list parsers. Absent/empty/all-invalid ⇒ null (so the resolver's `??` fallback to the operator's
 *  plan is untouched). */
function normalizeOptionalReviewers(
  value: JsonValue | undefined,
  field: string,
  warnings: string[],
): ReadonlyArray<{ model: string; fallback?: string | null | undefined }> | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    warnings.push(`Manifest gate field "${field}" must be a list of { model, fallback? }; ignoring it.`);
    return null;
  }
  const out: Array<{ model: string; fallback?: string | null | undefined }> = [];
  for (const [index, entry] of value.entries()) {
    if (out.length >= MAX_AI_REVIEW_REVIEWERS) {
      warnings.push(`Manifest gate field "${field}" is capped at ${MAX_AI_REVIEW_REVIEWERS} entries; dropping the rest.`);
      break;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`Manifest gate field "${field}[${index}]" must be a mapping with a "model" string; ignoring it.`);
      continue;
    }
    const e = entry as Record<string, JsonValue>;
    const model = typeof e.model === "string" ? e.model.trim() : "";
    if (!model) {
      warnings.push(`Manifest gate field "${field}[${index}].model" must be a non-empty string; ignoring the entry.`);
      continue;
    }
    const fallback = typeof e.fallback === "string" && e.fallback.trim() ? e.fallback.trim() : undefined;
    out.push(fallback ? { model, fallback } : { model });
  }
  return out.length > 0 ? out : null;
}

/**
 * Parse the optional `gate:` mapping. Every field stays `null` when unset so the resolver can layer
 * this OVER DB settings without clobbering. A nested `readiness: { mode, minScore }` block is accepted.
 */
function parseGateConfig(value: JsonValue | undefined, warnings: string[]): FocusManifestGateConfig {
  if (value === undefined || value === null) return { ...EMPTY_GATE_CONFIG };
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Manifest field "gate" must be a mapping; ignoring it.`);
    return { ...EMPTY_GATE_CONFIG };
  }
  const record = value as Record<string, JsonValue>;
  const readiness = record.readiness;
  const readinessRecord = readiness !== null && typeof readiness === "object" && !Array.isArray(readiness) ? (readiness as Record<string, JsonValue>) : undefined;
  if (readiness !== undefined && readiness !== null && readinessRecord === undefined) {
    warnings.push(`Manifest gate field "gate.readiness" must be a mapping; ignoring it.`);
  }
  const aiReview = record.aiReview;
  const aiReviewRecord = aiReview !== null && typeof aiReview === "object" && !Array.isArray(aiReview) ? (aiReview as Record<string, JsonValue>) : undefined;
  if (aiReview !== undefined && aiReview !== null && aiReviewRecord === undefined) {
    warnings.push(`Manifest gate field "gate.aiReview" must be a mapping; ignoring it.`);
  }
  const slop = record.slop;
  const slopRecord = slop !== null && typeof slop === "object" && !Array.isArray(slop) ? (slop as Record<string, JsonValue>) : undefined;
  if (slop !== undefined && slop !== null && slopRecord === undefined) {
    warnings.push(`Manifest gate field "gate.slop" must be a mapping; ignoring it.`);
  }
  const size = record.size;
  const sizeRecord = size !== null && typeof size === "object" && !Array.isArray(size) ? (size as Record<string, JsonValue>) : undefined;
  if (size !== undefined && size !== null && sizeRecord === undefined) {
    warnings.push(`Manifest gate field "gate.size" must be a mapping; ignoring it.`);
  }
  const cla = record.cla;
  const claRecord = cla !== null && typeof cla === "object" && !Array.isArray(cla) ? (cla as Record<string, JsonValue>) : undefined;
  if (cla !== undefined && cla !== null && claRecord === undefined) {
    warnings.push(`Manifest gate field "gate.cla" must be a mapping; ignoring it.`);
  }
  const gate: FocusManifestGateConfig = {
    present: false,
    enabled: normalizeOptionalBoolean(record.enabled, "gate.enabled", warnings),
    checkMode: normalizeOptionalEnum(record.checkMode, "gate.checkMode", ["required", "visible", "disabled"] as const, warnings),
    pack: normalizeOptionalEnum(record.pack, "gate.pack", ["gittensor", "oss-anti-slop"] as const, warnings),
    linkedIssue: normalizeOptionalGateMode(record.linkedIssue, "gate.linkedIssue", warnings),
    duplicates: normalizeOptionalGateMode(record.duplicates, "gate.duplicates", warnings),
    readinessMode: normalizeReadinessGateMode(readinessRecord?.mode, "gate.readiness.mode", warnings),
    readinessMinScore: normalizeOptionalScore(readinessRecord?.minScore, "gate.readiness.minScore", warnings),
    slopMode: normalizeOptionalGateMode(slopRecord?.mode, "gate.slop.mode", warnings),
    slopMinScore: normalizeOptionalScore(slopRecord?.minScore, "gate.slop.minScore", warnings),
    slopAiAdvisory: normalizeOptionalBoolean(slopRecord?.aiAdvisory, "gate.slop.aiAdvisory", warnings),
    sizeMode: normalizeOptionalGateMode(sizeRecord?.mode, "gate.size.mode", warnings),
    lockfileIntegrityMode: normalizeOptionalGateMode(record.lockfileIntegrity, "gate.lockfileIntegrity", warnings),
    aiReviewMode: normalizeOptionalGateMode(aiReviewRecord?.mode, "gate.aiReview.mode", warnings),
    aiReviewByok: normalizeOptionalBoolean(aiReviewRecord?.byok, "gate.aiReview.byok", warnings),
    aiReviewProvider: normalizeOptionalEnum(aiReviewRecord?.provider, "gate.aiReview.provider", ["anthropic", "openai"] as const, warnings),
    aiReviewModel: normalizeOptionalString(aiReviewRecord?.model, "gate.aiReview.model", warnings),
    aiReviewAllAuthors: normalizeOptionalBoolean(aiReviewRecord?.allAuthors, "gate.aiReview.allAuthors", warnings),
    aiReviewCloseConfidence: normalizeOptionalConfidence(aiReviewRecord?.closeConfidence, "gate.aiReview.closeConfidence", warnings),
    aiReviewCombine: normalizeOptionalEnum(aiReviewRecord?.combine, "gate.aiReview.combine", ["single", "consensus", "synthesis"] as const, warnings),
    aiReviewOnMerge: normalizeOptionalEnum(aiReviewRecord?.onMerge, "gate.aiReview.onMerge", ["either", "both"] as const, warnings),
    aiReviewReviewers: normalizeOptionalReviewers(aiReviewRecord?.reviewers, "gate.aiReview.reviewers", warnings),
    mergeReadiness: normalizeOptionalGateMode(record.mergeReadiness, "gate.mergeReadiness", warnings),
    manifestPolicy: normalizeOptionalGateMode(record.manifestPolicy, "gate.manifestPolicy", warnings),
    selfAuthoredLinkedIssue: normalizeOptionalGateMode(record.selfAuthoredLinkedIssue, "gate.selfAuthoredLinkedIssue", warnings),
    dryRun: normalizeOptionalBoolean(record.dryRun, "gate.dryRun", warnings),
    firstTimeContributorGrace: normalizeOptionalBoolean(record.firstTimeContributorGrace, "gate.firstTimeContributorGrace", warnings),
    premergeContentRecheck: normalizeOptionalBoolean(record.premergeContentRecheck, "gate.premergeContentRecheck", warnings),
    requireFreshRebaseWindowMinutes: normalizeOptionalPositiveInteger(record.requireFreshRebaseWindow, "gate.requireFreshRebaseWindow", warnings),
    claMode: normalizeOptionalGateMode(record.claMode, "gate.claMode", warnings),
    claConsentPhrase: parsePublicSafeText(claRecord?.consentPhrase, "gate.cla.consentPhrase", warnings),
    claCheckRunName: parsePublicSafeText(claRecord?.checkRunName, "gate.cla.checkRunName", warnings),
    claCheckRunAppSlug: parsePublicSafeText(claRecord?.checkRunAppSlug, "gate.cla.checkRunAppSlug", warnings),
    expectedCiContexts: normalizeOptionalStringList(record.expectedCiContexts, "gate.expectedCiContexts", warnings),
  };
  // #2266: the flag is parsed, clamped, and threaded end-to-end, but the gate evaluator never reads it — a
  // maintainer who sets it to true believing it softens a blocker for newcomers gets no such effect. Surface
  // that inertness at parse time rather than leaving it silently no-op; `false`/unset matches the (also inert)
  // default, so only an explicit `true` is worth flagging.
  if (gate.firstTimeContributorGrace === true) {
    warnings.push(`Manifest field "gate.firstTimeContributorGrace" is currently reserved/inert — it does not soften a blocker outcome for first-time contributors.`);
  }
  gate.present =
    gate.enabled !== null ||
    gate.checkMode !== null ||
    gate.pack !== null ||
    gate.linkedIssue !== null ||
    gate.duplicates !== null ||
    gate.readinessMode !== null ||
    gate.readinessMinScore !== null ||
    gate.slopMode !== null ||
    gate.slopMinScore !== null ||
    gate.slopAiAdvisory !== null ||
    gate.sizeMode !== null ||
    gate.lockfileIntegrityMode !== null ||
    gate.aiReviewMode !== null ||
    gate.aiReviewByok !== null ||
    gate.aiReviewProvider !== null ||
    gate.aiReviewModel !== null ||
    gate.aiReviewAllAuthors !== null ||
    gate.aiReviewCloseConfidence !== null ||
    gate.aiReviewCombine !== null ||
    gate.aiReviewOnMerge !== null ||
    gate.aiReviewReviewers !== null ||
    gate.mergeReadiness !== null ||
    gate.manifestPolicy !== null ||
    gate.selfAuthoredLinkedIssue !== null ||
    gate.dryRun !== null ||
    gate.firstTimeContributorGrace !== null ||
    gate.premergeContentRecheck !== null ||
    gate.requireFreshRebaseWindowMinutes !== null ||
    gate.claMode !== null ||
    gate.claConsentPhrase !== null ||
    gate.claCheckRunName !== null ||
    gate.claCheckRunAppSlug !== null ||
    gate.expectedCiContexts !== null;
  return gate;
}

/**
 * Serialize a gate config back into the parse-compatible `gate:` shape so a cached manifest snapshot
 * round-trips through {@link parseGateConfig} unchanged. Returns null when nothing is configured.
 */
export function gateConfigToJson(gate: FocusManifestGateConfig): JsonValue {
  if (!gate.present) return null;
  const out: Record<string, JsonValue> = {};
  if (gate.enabled !== null) out.enabled = gate.enabled;
  if (gate.checkMode !== null) out.checkMode = gate.checkMode;
  if (gate.pack !== null) out.pack = gate.pack;
  if (gate.linkedIssue !== null) out.linkedIssue = gate.linkedIssue;
  if (gate.duplicates !== null) out.duplicates = gate.duplicates;
  if (gate.readinessMode !== null || gate.readinessMinScore !== null) {
    const readiness: Record<string, JsonValue> = {};
    if (gate.readinessMode !== null) readiness.mode = gate.readinessMode;
    if (gate.readinessMinScore !== null) readiness.minScore = gate.readinessMinScore;
    out.readiness = readiness;
  }
  if (gate.sizeMode !== null) out.size = { mode: gate.sizeMode };
  if (gate.lockfileIntegrityMode !== null) out.lockfileIntegrity = gate.lockfileIntegrityMode;
  if (gate.slopMode !== null || gate.slopMinScore !== null || gate.slopAiAdvisory !== null) {
    const slop: Record<string, JsonValue> = {};
    if (gate.slopMode !== null) slop.mode = gate.slopMode;
    if (gate.slopMinScore !== null) slop.minScore = gate.slopMinScore;
    if (gate.slopAiAdvisory !== null) slop.aiAdvisory = gate.slopAiAdvisory;
    out.slop = slop;
  }
  if (
    gate.aiReviewMode !== null ||
    gate.aiReviewByok !== null ||
    gate.aiReviewProvider !== null ||
    gate.aiReviewModel !== null ||
    gate.aiReviewAllAuthors !== null ||
    gate.aiReviewCloseConfidence !== null ||
    gate.aiReviewCombine !== null ||
    gate.aiReviewOnMerge !== null ||
    gate.aiReviewReviewers !== null
  ) {
    const aiReview: Record<string, JsonValue> = {};
    if (gate.aiReviewMode !== null) aiReview.mode = gate.aiReviewMode;
    if (gate.aiReviewByok !== null) aiReview.byok = gate.aiReviewByok;
    if (gate.aiReviewProvider !== null) aiReview.provider = gate.aiReviewProvider;
    if (gate.aiReviewModel !== null) aiReview.model = gate.aiReviewModel;
    if (gate.aiReviewAllAuthors !== null) aiReview.allAuthors = gate.aiReviewAllAuthors;
    if (gate.aiReviewCloseConfidence !== null) aiReview.closeConfidence = gate.aiReviewCloseConfidence;
    if (gate.aiReviewCombine !== null) aiReview.combine = gate.aiReviewCombine;
    if (gate.aiReviewOnMerge !== null) aiReview.onMerge = gate.aiReviewOnMerge;
    if (gate.aiReviewReviewers !== null) {
      aiReview.reviewers = gate.aiReviewReviewers.map((r) =>
        r.fallback ? { model: r.model, fallback: r.fallback } : { model: r.model },
      ) as JsonValue;
    }
    out.aiReview = aiReview;
  }
  if (gate.mergeReadiness !== null) out.mergeReadiness = gate.mergeReadiness;
  if (gate.manifestPolicy !== null) out.manifestPolicy = gate.manifestPolicy;
  if (gate.selfAuthoredLinkedIssue !== null) out.selfAuthoredLinkedIssue = gate.selfAuthoredLinkedIssue;
  if (gate.dryRun !== null) out.dryRun = gate.dryRun;
  if (gate.firstTimeContributorGrace !== null) out.firstTimeContributorGrace = gate.firstTimeContributorGrace;
  if (gate.premergeContentRecheck !== null) out.premergeContentRecheck = gate.premergeContentRecheck;
  if (gate.requireFreshRebaseWindowMinutes !== null) out.requireFreshRebaseWindow = gate.requireFreshRebaseWindowMinutes;
  if (gate.claMode !== null) out.claMode = gate.claMode;
  if (gate.claConsentPhrase !== null || gate.claCheckRunName !== null || gate.claCheckRunAppSlug !== null) {
    const cla: Record<string, JsonValue> = {};
    if (gate.claConsentPhrase !== null) cla.consentPhrase = gate.claConsentPhrase;
    if (gate.claCheckRunName !== null) cla.checkRunName = gate.claCheckRunName;
    if (gate.claCheckRunAppSlug !== null) cla.checkRunAppSlug = gate.claCheckRunAppSlug;
    out.cla = cla;
  }
  if (gate.expectedCiContexts !== null) out.expectedCiContexts = gate.expectedCiContexts as JsonValue;
  return out;
}

/**
 * Parse the optional `features:` mapping — per-repo activation overrides for the converged review features.
 * Each recognized key becomes a tri-state (`true`/`false`/`null`); unknown keys and non-boolean values are
 * dropped with a warning. `present` is true when at least one key was explicitly set, so an operator can make
 * the manifest "present" with only a `features:` block.
 */
function parseFeaturesConfig(value: JsonValue | undefined, warnings: string[]): FocusManifestFeaturesConfig {
  const features: FocusManifestFeaturesConfig = { ...EMPTY_FEATURES_CONFIG };
  if (value === undefined || value === null) return features;
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push('Manifest "features" must be a mapping; ignoring it.');
    return features;
  }
  const record = value as Record<string, JsonValue>;
  for (const key of CONVERGED_FEATURE_KEYS) {
    features[key] = normalizeOptionalBoolean(record[key], `features.${key}`, warnings);
  }
  features.present = CONVERGED_FEATURE_KEYS.some((key) => features[key] !== null);
  return features;
}

/** Serialize a features config back into the parse-compatible `features:` shape so a cached snapshot round-trips
 *  through {@link parseFeaturesConfig} unchanged. Returns null when nothing is configured. */
export function featuresConfigToJson(features: FocusManifestFeaturesConfig): JsonValue {
  if (!features.present) return null;
  const out: Record<string, JsonValue> = {};
  for (const key of CONVERGED_FEATURE_KEYS) {
    if (features[key] !== null) out[key] = features[key];
  }
  return out;
}

/** A positive INTEGER count (not a score/confidence) — e.g. `contentLane.maxAppendedEntries` counts discrete
 *  surfaces[] entries, so a fractional value (a likely typo) would render a nonsensical contributor-facing close
 *  message ("append between 1 and 2.5 entries"). Rejects fractional and non-positive values alike. */
function normalizeOptionalPositiveInteger(value: JsonValue | undefined, field: string, warnings: string[]): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  warnings.push(`Manifest field "${field}" must be a positive whole number; ignoring it.`);
  return null;
}

const REVIEW_VISUAL_MAX_ROUTES_LIMIT = 5;

function normalizeOptionalVisualMaxRoutes(value: JsonValue | undefined, warnings: string[]): number | null {
  const maxRoutes = normalizeOptionalPositiveInteger(value, "review.visual.routes.max_routes", warnings);
  if (maxRoutes === null) return null;
  if (maxRoutes <= REVIEW_VISUAL_MAX_ROUTES_LIMIT) return maxRoutes;
  warnings.push(`Manifest field "review.visual.routes.max_routes" must be at most ${REVIEW_VISUAL_MAX_ROUTES_LIMIT}; clamping it.`);
  return REVIEW_VISUAL_MAX_ROUTES_LIMIT;
}

/** Normalize + bound a maintainer-supplied glob string: trims/length-caps like any other string field, AND
 *  rejects one globToRegExp (review/content-lane/spec-resolver.ts's reuse of the guardrail-path compiler) would
 *  itself refuse to compile safely. Reuses `hasUnsafeWildcardCount` — globToRegExp's OWN safety predicate —
 *  rather than a locally-counted threshold: a caller that counts wildcards differently (e.g. raw `*` characters,
 *  which double-counts a `**` pair as 2 groups instead of 1) can accept a glob globToRegExp then silently
 *  compiles to NEVER_MATCHES, configuring a lane that is "present" but can never activate on any changed file
 *  (#confirmed-bug). A glob over the cap is REJECTED (warns, returns null) rather than truncated — silently
 *  cutting wildcards out of a maintainer's pattern would silently change its meaning, which is worse than making
 *  them fix an over-complex glob. */
function normalizeOptionalGlob(value: JsonValue | undefined, field: string, warnings: string[]): string | null {
  const normalized = normalizeOptionalString(value, field, warnings);
  if (normalized === null) return null;
  if (normalized.length > MAX_ITEM_LENGTH) {
    // REJECT, not truncate: cutting characters out of a glob changes which files it matches (e.g. a
    // mid-directory-name cut can turn a narrow, intended pattern into one that matches an unrelated path
    // prefix, or one that never matches anything) — silently compiling a DIFFERENT pattern than the
    // maintainer configured is worse than making them shorten an over-complex glob.
    warnings.push(`Manifest field "${field}" is an over-long glob (${normalized.length} > ${MAX_ITEM_LENGTH} chars); ignoring it.`);
    return null;
  }
  if (hasUnsafeWildcardCount(normalized)) {
    warnings.push(`Manifest field "${field}" has too many wildcards to compile safely; ignoring it.`);
    return null;
  }
  return normalized;
}

/**
 * Parse the optional `contentLane:` mapping — per-repo registry-review lane configuration (#2435). `entryFileGlob`
 * and `collectionField` are REQUIRED to build a usable spec; a config missing either — including a glob rejected
 * by `normalizeOptionalGlob`'s wildcard cap — degrades to "not configured" (a warning, falling through to the
 * allowlist default) rather than a broken half-spec. Glob fields stay plain strings here — compiling them to
 * RegExp is the resolver's job (`review/content-lane/spec-resolver.ts`), not the parser's, so this file stays
 * free of a RegExp-from-config compile step; it's still this file's job to keep an over-complex glob from ever
 * reaching that compile step at all.
 */
function parseContentLaneConfig(value: JsonValue | undefined, warnings: string[]): FocusManifestContentLaneConfig {
  if (value === undefined || value === null) return { ...EMPTY_CONTENT_LANE_CONFIG };
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push('Manifest field "contentLane" must be a mapping; ignoring it.');
    return { ...EMPTY_CONTENT_LANE_CONFIG };
  }
  const record = value as Record<string, JsonValue>;
  const entryFileGlob = normalizeOptionalGlob(record.entryFileGlob, "contentLane.entryFileGlob", warnings);
  const providerFileGlob = normalizeOptionalGlob(record.providerFileGlob, "contentLane.providerFileGlob", warnings);
  const artifactGlob = normalizeOptionalGlob(record.artifactGlob, "contentLane.artifactGlob", warnings);
  const collectionField = normalizeOptionalString(record.collectionField, "contentLane.collectionField", warnings);
  const maxAppendedEntries = normalizeOptionalPositiveInteger(record.maxAppendedEntries, "contentLane.maxAppendedEntries", warnings);
  const duplicateKeyFields = normalizeStringList(record.duplicateKeyFields, "contentLane.duplicateKeyFields", warnings);
  const validatorId = normalizeOptionalString(record.validatorId, "contentLane.validatorId", warnings);
  if (!entryFileGlob || !collectionField) {
    warnings.push('Manifest field "contentLane" requires both entryFileGlob and collectionField; ignoring it.');
    return { ...EMPTY_CONTENT_LANE_CONFIG };
  }
  return { present: true, entryFileGlob, providerFileGlob, artifactGlob, collectionField, maxAppendedEntries, duplicateKeyFields, validatorId };
}

/** Serialize a contentLane config back into the parse-compatible `contentLane:` shape so a cached snapshot
 *  round-trips through {@link parseContentLaneConfig} unchanged. Returns null when nothing is configured. */
export function contentLaneConfigToJson(contentLane: FocusManifestContentLaneConfig): JsonValue {
  if (!contentLane.present || !contentLane.entryFileGlob || !contentLane.collectionField) return null;
  const out: Record<string, JsonValue> = { entryFileGlob: contentLane.entryFileGlob, collectionField: contentLane.collectionField };
  if (contentLane.providerFileGlob !== null) out.providerFileGlob = contentLane.providerFileGlob;
  if (contentLane.artifactGlob !== null) out.artifactGlob = contentLane.artifactGlob;
  if (contentLane.maxAppendedEntries !== null) out.maxAppendedEntries = contentLane.maxAppendedEntries;
  if (contentLane.duplicateKeyFields.length > 0) out.duplicateKeyFields = contentLane.duplicateKeyFields;
  if (contentLane.validatorId !== null) out.validatorId = contentLane.validatorId;
  return out;
}

const REPO_DOC_GENERATION_SCOPES: readonly FocusManifestRepoDocGenerationScope[] = ["agents", "skills"];

/** `undefined`/`null` (key omitted) falls back to the default scope; a non-list value is a genuine type error
 *  and ALSO falls back to the default (rather than emptying it out, which would silently disable an otherwise
 *  `enabled: true` config); an actual list -- even an explicitly empty one, or one where every entry is
 *  invalid -- is respected as "nothing in scope", since that is a deliberate, well-typed value. */
function parseRepoDocGenerationScope(value: JsonValue | undefined, warnings: string[]): FocusManifestRepoDocGenerationScope[] {
  if (value === undefined || value === null) return [...EMPTY_REPO_DOC_GENERATION_CONFIG.scope];
  if (!Array.isArray(value)) {
    warnings.push('Manifest field "repoDocGeneration.scope" must be a list; falling back to the default scope.');
    return [...EMPTY_REPO_DOC_GENERATION_CONFIG.scope];
  }
  const raw = normalizeStringList(value, "repoDocGeneration.scope", warnings);
  return raw.filter((entry): entry is FocusManifestRepoDocGenerationScope => {
    if ((REPO_DOC_GENERATION_SCOPES as readonly string[]).includes(entry)) return true;
    warnings.push(`Manifest field "repoDocGeneration.scope" has an unrecognized entry "${entry}"; ignoring it.`);
    return false;
  });
}

/**
 * Parse the optional `repoDocGeneration:` mapping (#3002). Unlike `gate:`/`settings:`, every field here has a
 * concrete default rather than a null "unconfigured" sentinel -- there is no DB layer to overlay onto, so the
 * parsed value (or the default, when a key is omitted) IS the effective value. An explicitly empty `scope: []`
 * is honored as "nothing in scope" (not coerced back to the default); only an OMITTED `scope` key falls back to
 * `["agents"]`, mirroring how `undefined`/`null` mean "unset" everywhere else in this file.
 */
function parseRepoDocGenerationConfig(value: JsonValue | undefined, warnings: string[]): FocusManifestRepoDocGenerationConfig {
  if (value === undefined || value === null) return { ...EMPTY_REPO_DOC_GENERATION_CONFIG };
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push('Manifest field "repoDocGeneration" must be a mapping; ignoring it.');
    return { ...EMPTY_REPO_DOC_GENERATION_CONFIG };
  }
  const record = value as Record<string, JsonValue>;
  const enabled = normalizeOptionalBoolean(record.enabled, "repoDocGeneration.enabled", warnings) ?? false;
  const allowOverwriteExisting = normalizeOptionalBoolean(record.allowOverwriteExisting, "repoDocGeneration.allowOverwriteExisting", warnings) ?? false;
  const scope = parseRepoDocGenerationScope(record.scope, warnings);
  const refreshIntervalDays = normalizeOptionalPositiveInteger(record.refreshIntervalDays, "repoDocGeneration.refreshIntervalDays", warnings) ?? DEFAULT_REPO_DOC_REFRESH_INTERVAL_DAYS;
  return { present: true, enabled, scope, allowOverwriteExisting, refreshIntervalDays };
}

/** Serialize a repoDocGeneration config back into the parse-compatible shape so a cached snapshot round-trips
 *  through {@link parseRepoDocGenerationConfig} unchanged. Returns null when nothing is configured. */
export function repoDocGenerationConfigToJson(config: FocusManifestRepoDocGenerationConfig): JsonValue {
  if (!config.present) return null;
  return { enabled: config.enabled, scope: config.scope, allowOverwriteExisting: config.allowOverwriteExisting, refreshIntervalDays: config.refreshIntervalDays };
}

/**
 * Parse the optional `reviewRecap:` mapping (#1963). Mirrors {@link parseRepoDocGenerationConfig}: every
 * field has a concrete default (no DB layer to overlay onto), so the parsed value IS the effective value.
 */
function parseReviewRecapConfig(value: JsonValue | undefined, warnings: string[]): FocusManifestReviewRecapConfig {
  if (value === undefined || value === null) return { ...EMPTY_REVIEW_RECAP_CONFIG };
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push('Manifest field "reviewRecap" must be a mapping; ignoring it.');
    return { ...EMPTY_REVIEW_RECAP_CONFIG };
  }
  const record = value as Record<string, JsonValue>;
  const enabled = normalizeOptionalBoolean(record.enabled, "reviewRecap.enabled", warnings) ?? false;
  const cadenceDays = normalizeOptionalPositiveInteger(record.cadenceDays, "reviewRecap.cadenceDays", warnings) ?? DEFAULT_REVIEW_RECAP_CADENCE_DAYS;
  return { present: true, enabled, cadenceDays };
}

/** Serialize a reviewRecap config back into the parse-compatible shape so a cached snapshot round-trips
 *  through {@link parseReviewRecapConfig} unchanged. Returns null when nothing is configured. */
export function reviewRecapConfigToJson(config: FocusManifestReviewRecapConfig): JsonValue {
  if (!config.present) return null;
  return { enabled: config.enabled, cadenceDays: config.cadenceDays };
}

function normalizeOptionalEnum<T extends string>(value: JsonValue | undefined, field: string, allowed: readonly T[], warnings: string[]): T | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  warnings.push(`Manifest settings field "${field}" must be one of ${allowed.join(", ")}; ignoring "${String(value)}".`);
  return null;
}

function normalizeOptionalString(value: JsonValue | undefined, field: string, warnings: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  warnings.push(`Manifest settings field "${field}" must be a non-empty string; ignoring it.`);
  return null;
}

// Keep the review-nag lookback operationally bounded so repo-controlled config cannot overflow Date
// arithmetic. Duplicated from settings/agent-actions.ts's own MAX_REVIEW_NAG_COOLDOWN_DAYS (same value,
// same rationale) rather than imported: this module is part of the UI package's typechecked closure, and
// agent-actions.ts transitively imports github/commands.ts -> utils/crypto.ts, pulling a heavier
// GitHub-App-specific dependency chain into the UI build for one small constant.
const MAX_REVIEW_NAG_COOLDOWN_DAYS = 365;

/**
 * Parse the optional `settings:` mapping — a partial repository-settings override. Only recognized
 * fields are kept; unknown/invalid values are dropped with a warning and never throw.
 */
function parseSettingsOverride(value: JsonValue | undefined, warnings: string[]): FocusManifestSettings {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Manifest field "settings" must be a mapping; ignoring it.`);
    return {};
  }
  const r = value as Record<string, JsonValue>;
  const out: FocusManifestSettings = {};
  const commentMode = normalizeOptionalEnum(r.commentMode, "settings.commentMode", ["off", "detected_contributors_only", "all_prs"] as const, warnings);
  if (commentMode !== null) out.commentMode = commentMode;
  const publicAudienceMode = normalizeOptionalEnum(r.publicAudienceMode, "settings.publicAudienceMode", ["oss_maintainer", "gittensor_only"] as const, warnings);
  if (publicAudienceMode !== null) out.publicAudienceMode = publicAudienceMode;
  const publicSignalLevel = normalizeOptionalEnum(r.publicSignalLevel, "settings.publicSignalLevel", ["minimal", "standard"] as const, warnings);
  if (publicSignalLevel !== null) out.publicSignalLevel = publicSignalLevel;
  const checkRunMode = normalizeOptionalEnum(r.checkRunMode, "settings.checkRunMode", ["off", "enabled"] as const, warnings);
  if (checkRunMode !== null) out.checkRunMode = checkRunMode;
  const checkRunDetailLevel = normalizeOptionalEnum(r.checkRunDetailLevel, "settings.checkRunDetailLevel", ["minimal", "standard", "deep"] as const, warnings);
  if (checkRunDetailLevel !== null) out.checkRunDetailLevel = checkRunDetailLevel;
  const gateCheckMode = normalizeOptionalEnum(r.gateCheckMode, "settings.gateCheckMode", ["off", "enabled"] as const, warnings);
  if (gateCheckMode !== null) out.gateCheckMode = gateCheckMode;
  // Same tri-state field as gate.checkMode above (the friendly gate alias overlays onto it in
  // resolveEffectiveSettings, and wins when both are set).
  const reviewCheckMode = normalizeOptionalEnum(r.reviewCheckMode, "settings.reviewCheckMode", ["required", "visible", "disabled"] as const, warnings);
  if (reviewCheckMode !== null) out.reviewCheckMode = reviewCheckMode;
  const autoProjectMilestoneMatch = normalizeOptionalEnum(r.autoProjectMilestoneMatch, "settings.autoProjectMilestoneMatch", ["off", "suggest", "auto"] as const, warnings);
  if (autoProjectMilestoneMatch !== null) out.autoProjectMilestoneMatch = autoProjectMilestoneMatch;
  const autoProjectMilestoneMatchBackend = normalizeOptionalEnum(r.autoProjectMilestoneMatchBackend, "settings.autoProjectMilestoneMatchBackend", ["github", "linear"] as const, warnings);
  if (autoProjectMilestoneMatchBackend !== null) out.autoProjectMilestoneMatchBackend = autoProjectMilestoneMatchBackend;
  const linkedIssueGateMode = normalizeOptionalGateMode(r.linkedIssueGateMode, "settings.linkedIssueGateMode", warnings);
  if (linkedIssueGateMode !== null) out.linkedIssueGateMode = linkedIssueGateMode;
  const duplicatePrGateMode = normalizeOptionalGateMode(r.duplicatePrGateMode, "settings.duplicatePrGateMode", warnings);
  if (duplicatePrGateMode !== null) out.duplicatePrGateMode = duplicatePrGateMode;
  const selfAuthoredLinkedIssueGateMode = normalizeOptionalGateMode(r.selfAuthoredLinkedIssueGateMode, "settings.selfAuthoredLinkedIssueGateMode", warnings);
  if (selfAuthoredLinkedIssueGateMode !== null) out.selfAuthoredLinkedIssueGateMode = selfAuthoredLinkedIssueGateMode;
  // Same tri-state field as gate.readiness.mode above (the friendly gate alias overlays onto it in
  // resolveEffectiveSettings) — apply the identical "block" → "advisory" downgrade here too, so a maintainer
  // setting `settings.qualityGateMode: block` directly hits the same deprecation warning (#2267).
  const qualityGateMode = normalizeReadinessGateMode(r.qualityGateMode, "settings.qualityGateMode", warnings);
  if (qualityGateMode !== null) out.qualityGateMode = qualityGateMode;
  const qualityGateMinScore = normalizeOptionalScore(r.qualityGateMinScore, "settings.qualityGateMinScore", warnings);
  if (qualityGateMinScore !== null) out.qualityGateMinScore = qualityGateMinScore;
  const aiReviewMode = normalizeOptionalGateMode(r.aiReviewMode, "settings.aiReviewMode", warnings);
  if (aiReviewMode !== null) out.aiReviewMode = aiReviewMode;
  const aiReviewProvider = normalizeOptionalEnum(r.aiReviewProvider, "settings.aiReviewProvider", ["anthropic", "openai"] as const, warnings);
  if (aiReviewProvider !== null) out.aiReviewProvider = aiReviewProvider;
  const aiReviewModel = normalizeOptionalString(r.aiReviewModel, "settings.aiReviewModel", warnings);
  if (aiReviewModel !== null) out.aiReviewModel = aiReviewModel;
  const gittensorLabel = normalizeOptionalString(r.gittensorLabel, "settings.gittensorLabel", warnings);
  if (gittensorLabel !== null) out.gittensorLabel = gittensorLabel;
  // #label-scoping: an explicit yml `null` is load-bearing (closes WITHOUT any label), matching
  // contributorOpenPrCap's own null-vs-omitted distinction — must be checked BEFORE normalizeOptionalString,
  // which otherwise collapses null and undefined to the same "unset" result.
  if (r.blacklistLabel === null) {
    out.blacklistLabel = null;
  } else {
    const blacklistLabel = normalizeOptionalString(r.blacklistLabel, "settings.blacklistLabel", warnings);
    if (blacklistLabel !== null) out.blacklistLabel = blacklistLabel;
  }
  const publicSurface = normalizeOptionalEnum(r.publicSurface, "settings.publicSurface", ["off", "comment_and_label", "comment_only", "label_only"] as const, warnings);
  if (publicSurface !== null) out.publicSurface = publicSurface;
  for (const key of ["aiReviewByok", "aiReviewAllAuthors", "closeOwnerAuthors", "autoLabelEnabled", "typeLabelsEnabled", "badgeEnabled", "createMissingLabel", "includeMaintainerAuthors", "requireLinkedIssue", "backfillEnabled", "privateTrustEnabled", "agentPaused", "agentDryRun"] as const) {
    const flag = normalizeOptionalBoolean(r[key], `settings.${key}`, warnings);
    if (flag !== null) out[key] = flag;
  }
  // Agent-layer autonomy dial (#773): `settings.autonomy` maps each action class to a level. Only set it
  // when at least one valid class→level pair survives normalization, so a malformed block never blanks the
  // DB-configured policy via the resolver's `{...dbSettings, ...manifest.settings}` overlay.
  if (r.autonomy !== undefined) {
    const autonomy = normalizeAutonomyPolicy(r.autonomy);
    if (Object.keys(autonomy).length > 0) out.autonomy = autonomy;
  }
  // Auto-maintain policy (#774): `settings.autoMaintain` declares the full policy (defaults fill any unset
  // field) and overlays the DB value via the resolver. Only a mapping is honoured; anything else is ignored.
  if (typeof r.autoMaintain === "object" && r.autoMaintain !== null && !Array.isArray(r.autoMaintain)) {
    out.autoMaintain = normalizeAutoMaintainPolicy(r.autoMaintain);
  }
  // Command authorization policy (#2268 config-as-code parity): `settings.commandAuthorization` declares the
  // full role policy the same way `autoMaintain` does — the normalizer fills any unset/invalid FIELD from
  // DEFAULT_COMMAND_AUTHORIZATION_POLICY, so a partially-valid mapping yields a complete, safe policy that
  // overlays the DB value via the resolver's `{...dbSettings, ...manifest.settings}` spread. But an invalid
  // TOP-LEVEL shape (not a mapping at all) is a different case: normalizeCommandAuthorizationPolicy's own
  // fallback there is meant for callers with no DB value to fall back to, not for this overlay — applying it
  // here would let a typo'd config silently overwrite a stricter DB-persisted policy with the built-in
  // default. So only apply the normalized policy when the raw value was actually a mapping; otherwise warn
  // and leave `out.commandAuthorization` unset so the resolver preserves whatever the DB already has.
  if (typeof r.commandAuthorization === "object" && r.commandAuthorization !== null && !Array.isArray(r.commandAuthorization)) {
    const { policy, warnings: commandAuthorizationWarnings } = normalizeCommandAuthorizationPolicy(r.commandAuthorization);
    warnings.push(...commandAuthorizationWarnings);
    out.commandAuthorization = policy;
  } else if (r.commandAuthorization !== undefined) {
    warnings.push(`Manifest "settings.commandAuthorization" must be an object; ignoring it and keeping any existing policy.`);
  }
  // TYPE label category overrides (#priority-linked-issue-gate, #label-modularity): unlike
  // commandAuthorization/autoMaintain above, this is deliberately kept SPARSE -- only the keys actually
  // present AND validly-shaped in the raw YAML are copied onto `out.typeLabels` (via
  // `normalizeTypeLabelSet`, which still fills in the built-in bug/feature/priority keys to run its own
  // shape checks, but those defaults-filled values are discarded here). A manifest naming only
  // `typeLabels.priority` must inherit `bug`/`feature` from the DB-persisted value in
  // `resolveEffectiveSettings`, not have them silently reset to the built-in gittensor:* names -- assigning
  // the normalizer's complete object here would do exactly that via the resolver's wholesale
  // `{...dbSettings, ...manifest.settings}` spread. The per-field shape check below (not just "is the key
  // present") matters too: a malformed value (e.g. `typeLabels.priority: 123`) is present but invalid, so
  // `normalizeTypeLabelSet` warns and reports its OWN built-in-default fallback for that key -- copying
  // that fallback into the sparse override would silently overwrite a DB-customized value with the
  // built-in default on a config typo, instead of leaving the DB value alone. The loop is generic over
  // whatever keys the raw object actually has (not hardcoded to bug/feature/priority), so an arbitrary
  // custom category (e.g. `security`) sparse-overrides exactly like a built-in one. The normalizer
  // enforces the category-count and label-name caps before a sparse key can survive into the override.
  if (typeof r.typeLabels === "object" && r.typeLabels !== null && !Array.isArray(r.typeLabels)) {
    const rawTypeLabels = r.typeLabels as Record<string, unknown>;
    if (Object.keys(rawTypeLabels).length === 0) {
      // A literal `typeLabels: {}` is a DELIBERATE, complete declaration -- "zero configured categories
      // for this repo" -- distinct from a sparse override whose named keys all failed validation (the
      // `else` branch below, which must NOT wipe the DB value). Represented as `null` so
      // `resolveEffectiveSettings` can tell the two apart even though both would otherwise collapse to
      // the same empty-object shape (#label-modularity).
      out.typeLabels = null;
    } else {
      const validated = normalizeTypeLabelSet(rawTypeLabels, warnings);
      const isValidLabelName = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_TYPE_LABEL_NAME_LENGTH;
      const sparseTypeLabels: Partial<PrTypeLabelSet> = {};
      for (const key of Object.keys(rawTypeLabels)) {
        if (isValidLabelName(rawTypeLabels[key]) && validated[key] !== undefined) sparseTypeLabels[key] = validated[key];
      }
      out.typeLabels = sparseTypeLabels;
    }
  } else if (r.typeLabels !== undefined) {
    warnings.push(`Manifest "settings.typeLabels" must be an object; ignoring it and keeping any existing label names.`);
  }
  // Linked-issue label propagation (#priority-linked-issue-gate): same sparse-partial shape as typeLabels
  // above, for the same reason -- this is the ONLY mechanism that can ever select a maintainer-reward
  // label like gittensor:priority (never inferred from title/files/AI/PR-labels), so a manifest overriding
  // just one field (e.g. `enabled`) must not silently reset `mappings` back to the built-in empty default
  // and discard a DB-configured mapping list. Each field is gated on its OWN raw shape being valid (not
  // just "is the key present"), for the same reason as typeLabels above -- e.g. a typo'd
  // `mappings: "oops"` must never silently replace a DB-configured mapping list with the normalizer's
  // empty-array fallback. A validly-shaped `mappings` array is still a complete replacement when present
  // (arrays have no per-item precedence semantics here, and any individually-invalid entries inside it
  // are dropped by the normalizer, not the array itself), matching the array-replace-wholesale overlay
  // behavior documented for the private-config layer.
  if (typeof r.linkedIssueLabelPropagation === "object" && r.linkedIssueLabelPropagation !== null && !Array.isArray(r.linkedIssueLabelPropagation)) {
    const rawPropagation = r.linkedIssueLabelPropagation as Record<string, unknown>;
    const validated = normalizeLinkedIssueLabelPropagationConfig(rawPropagation, warnings);
    const sparsePropagation: Partial<LinkedIssueLabelPropagationConfig> = {};
    if (typeof rawPropagation.enabled === "boolean") sparsePropagation.enabled = validated.enabled;
    if (typeof rawPropagation.mode === "string" && (VALID_LINKED_ISSUE_LABEL_PROPAGATION_MODES as readonly string[]).includes(rawPropagation.mode)) {
      sparsePropagation.mode = validated.mode;
    }
    if (Array.isArray(rawPropagation.mappings)) sparsePropagation.mappings = validated.mappings;
    out.linkedIssueLabelPropagation = sparsePropagation;
  } else if (r.linkedIssueLabelPropagation !== undefined) {
    warnings.push(`Manifest "settings.linkedIssueLabelPropagation" must be an object; ignoring it and keeping any existing policy.`);
  }
  // Linked-issue hard rules: same sparse-partial overlay contract as linkedIssueLabelPropagation. A global config
  // can enable the policy and set label lists; a repo override can toggle one mode without resetting those lists.
  if (typeof r.linkedIssueHardRules === "object" && r.linkedIssueHardRules !== null && !Array.isArray(r.linkedIssueHardRules)) {
    const rawRules = r.linkedIssueHardRules as Record<string, unknown>;
    const validated = normalizeLinkedIssueHardRulesConfig(rawRules, warnings);
    const sparseRules: Partial<LinkedIssueHardRulesConfig> = {};
    if (isLinkedIssueHardRuleMode(rawRules.ownerAssignedClose)) sparseRules.ownerAssignedClose = validated.ownerAssignedClose;
    if (isLinkedIssueHardRuleMode(rawRules.assignedIssueClose)) sparseRules.assignedIssueClose = validated.assignedIssueClose;
    if (isLinkedIssueHardRuleMode(rawRules.missingPointLabelClose)) sparseRules.missingPointLabelClose = validated.missingPointLabelClose;
    if (isLinkedIssueHardRuleMode(rawRules.maintainerOnlyLabelClose)) sparseRules.maintainerOnlyLabelClose = validated.maintainerOnlyLabelClose;
    if (Array.isArray(rawRules.pointBearingLabels)) sparseRules.pointBearingLabels = validated.pointBearingLabels;
    if (Array.isArray(rawRules.maintainerOnlyLabels)) sparseRules.maintainerOnlyLabels = validated.maintainerOnlyLabels;
    if (typeof rawRules.defaultLabelRepo === "boolean") sparseRules.defaultLabelRepo = validated.defaultLabelRepo;
    if (typeof rawRules.verifyBeforeClose === "boolean") sparseRules.verifyBeforeClose = validated.verifyBeforeClose;
    if (typeof rawRules.closeDelaySeconds === "number" && Number.isFinite(rawRules.closeDelaySeconds) && rawRules.closeDelaySeconds >= 0) {
      sparseRules.closeDelaySeconds = validated.closeDelaySeconds;
    }
    out.linkedIssueHardRules = sparseRules;
  } else if (r.linkedIssueHardRules !== undefined) {
    warnings.push(`Manifest "settings.linkedIssueHardRules" must be an object; ignoring it and keeping any existing policy.`);
  }
  // Unlinked-issue guardrail (#unlinked-issue-guardrail): same sparse-partial overlay contract as
  // linkedIssueHardRules above -- a repo naming only `mode` must not silently reset `minConfidence` back to
  // the built-in default.
  if (typeof r.unlinkedIssueGuardrail === "object" && r.unlinkedIssueGuardrail !== null && !Array.isArray(r.unlinkedIssueGuardrail)) {
    const rawGuardrail = r.unlinkedIssueGuardrail as Record<string, unknown>;
    const validated = normalizeUnlinkedIssueGuardrailConfig(rawGuardrail, warnings);
    const sparseGuardrail: Partial<UnlinkedIssueGuardrailConfig> = {};
    if (isUnlinkedIssueGuardrailMode(rawGuardrail.mode)) sparseGuardrail.mode = validated.mode;
    if (typeof rawGuardrail.minConfidence === "number" && Number.isFinite(rawGuardrail.minConfidence) && rawGuardrail.minConfidence >= 0 && rawGuardrail.minConfidence <= 1) {
      sparseGuardrail.minConfidence = validated.minConfidence;
    }
    out.unlinkedIssueGuardrail = sparseGuardrail;
  } else if (r.unlinkedIssueGuardrail !== undefined) {
    warnings.push(`Manifest "settings.unlinkedIssueGuardrail" must be an object; ignoring it and keeping any existing policy.`);
  }
  // Contributor blacklist (#1425): `settings.contributorBlacklist` is a list of banned-login entries. Only set it
  // when at least one VALID entry survives normalization, so a malformed block never blanks the DB-configured
  // list via the resolver's `{...dbSettings, ...manifest.settings}` overlay. Normalization warnings are folded in.
  if (r.contributorBlacklist !== undefined) {
    const { entries, warnings: blacklistWarnings } = normalizeContributorBlacklist(r.contributorBlacklist);
    warnings.push(...blacklistWarnings);
    if (entries.length > 0) out.contributorBlacklist = entries;
  }
  // Per-contributor open PR/issue caps (#2270): discrete counts, not scores — reuse the same positive-integer
  // normalizer as contentLane.maxAppendedEntries so a fractional/non-positive typo is dropped with a warning
  // instead of configuring a nonsensical cap. UNLIKE contributorBlacklist above, an explicit yml `null` here is
  // load-bearing (not the same as omitting the key): the documented `yml > DB > null` precedence means a
  // maintainer must be able to force a DB-configured cap back to "no cap" via `.gittensory.yml` without deleting
  // the DB row. `normalizeOptionalPositiveInteger` collapses "absent" and "null" to the same silent `null`
  // return, so that distinction has to be made HERE, before calling it: a literal `null` sets the key to `null`
  // (clears); omitted (`undefined`) leaves the key unset (preserves the DB value via the resolver's spread); an
  // invalid non-null value (fractional/non-positive/wrong type) warns and also leaves the key unset.
  if (r.contributorOpenPrCap === null) {
    out.contributorOpenPrCap = null;
  } else {
    const contributorOpenPrCap = normalizeOptionalPositiveInteger(r.contributorOpenPrCap, "settings.contributorOpenPrCap", warnings);
    if (contributorOpenPrCap !== null) out.contributorOpenPrCap = contributorOpenPrCap;
  }
  if (r.contributorOpenIssueCap === null) {
    out.contributorOpenIssueCap = null;
  } else {
    const contributorOpenIssueCap = normalizeOptionalPositiveInteger(r.contributorOpenIssueCap, "settings.contributorOpenIssueCap", warnings);
    if (contributorOpenIssueCap !== null) out.contributorOpenIssueCap = contributorOpenIssueCap;
  }
  // #label-scoping: same load-bearing-null idiom as blacklistLabel above.
  if (r.contributorCapLabel === null) {
    out.contributorCapLabel = null;
  } else {
    const contributorCapLabel = normalizeOptionalString(r.contributorCapLabel, "settings.contributorCapLabel", warnings);
    if (contributorCapLabel !== null) out.contributorCapLabel = contributorCapLabel;
  }
  // CI-run cancellation on a contributor_cap close (#2462): an explicit yml `null` is load-bearing (clears a
  // DB-configured value back to "unset", falling through to the CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT env var),
  // matching contributorOpenPrCap's own null-vs-omitted distinction above.
  if (r.contributorCapCancelCi === null) {
    out.contributorCapCancelCi = null;
  } else {
    const contributorCapCancelCi = normalizeOptionalBoolean(r.contributorCapCancelCi, "settings.contributorCapCancelCi", warnings);
    if (contributorCapCancelCi !== null) out.contributorCapCancelCi = contributorCapCancelCi;
  }
  // Review-request nagging cooldown (#2463): throttle a contributor repeatedly pinging @gittensory for review.
  const reviewNagPolicy = normalizeOptionalEnum(r.reviewNagPolicy, "settings.reviewNagPolicy", ["off", "hold", "close"] as const, warnings);
  if (reviewNagPolicy !== null) out.reviewNagPolicy = reviewNagPolicy;
  const reviewNagMaxPings = normalizeOptionalPositiveInteger(r.reviewNagMaxPings, "settings.reviewNagMaxPings", warnings);
  if (reviewNagMaxPings !== null) out.reviewNagMaxPings = reviewNagMaxPings;
  const reviewNagCooldownDays = normalizeOptionalPositiveInteger(r.reviewNagCooldownDays, "settings.reviewNagCooldownDays", warnings);
  if (reviewNagCooldownDays !== null && reviewNagCooldownDays <= MAX_REVIEW_NAG_COOLDOWN_DAYS) out.reviewNagCooldownDays = reviewNagCooldownDays;
  if (reviewNagCooldownDays !== null && reviewNagCooldownDays > MAX_REVIEW_NAG_COOLDOWN_DAYS) {
    warnings.push(`Manifest field "settings.reviewNagCooldownDays" must be at most ${MAX_REVIEW_NAG_COOLDOWN_DAYS}; ignoring it.`);
  }
  // #label-scoping: same load-bearing-null idiom as blacklistLabel above.
  if (r.reviewNagLabel === null) {
    out.reviewNagLabel = null;
  } else {
    const reviewNagLabel = normalizeOptionalString(r.reviewNagLabel, "settings.reviewNagLabel", warnings);
    if (reviewNagLabel !== null) out.reviewNagLabel = reviewNagLabel;
  }
  // Maintainer-mention nag moderation (#label-scoping): GitHub logins ALSO throttled under the review-nag
  // cooldown above, on top of the bot's own @gittensory handle. Only set it when at least one VALID login
  // survives normalization, so a malformed block never blanks the DB-configured list via the resolver's
  // `{...dbSettings, ...manifest.settings}` overlay (same reasoning as autoCloseExemptLogins below).
  if (r.reviewNagMonitoredMentions !== undefined) {
    const { logins: monitoredMentions, warnings: monitoredMentionWarnings } = normalizeAutoCloseExemptLogins(r.reviewNagMonitoredMentions);
    warnings.push(...monitoredMentionWarnings);
    if (monitoredMentions.length > 0) out.reviewNagMonitoredMentions = monitoredMentions;
  }
  // Shared repo-scoped exemption list (#2463): only set it when at least one VALID login survives
  // normalization, so a malformed block never blanks the DB-configured list via the resolver's overlay.
  if (r.autoCloseExemptLogins !== undefined) {
    const { logins, warnings: exemptWarnings } = normalizeAutoCloseExemptLogins(r.autoCloseExemptLogins);
    warnings.push(...exemptWarnings);
    if (logins.length > 0) out.autoCloseExemptLogins = logins;
  }
  // Hard manual-review guardrails are config-as-code only. Arrays replace lower layers wholesale, so only an
  // explicit [] or a non-empty valid list replaces a private global setting. Null/malformed values are ignored
  // instead of clearing.
  if (Array.isArray(r.hardGuardrailGlobs)) {
    const hardGuardrailGlobs = normalizeStringList(r.hardGuardrailGlobs, "settings.hardGuardrailGlobs", warnings);
    if (r.hardGuardrailGlobs.length === 0 || hardGuardrailGlobs.length > 0) {
      out.hardGuardrailGlobs = hardGuardrailGlobs;
    } else {
      warnings.push(`Manifest "settings.hardGuardrailGlobs" did not contain any valid path globs; ignoring it and keeping any existing guardrails.`);
    }
  } else if (r.hardGuardrailGlobs !== undefined) {
    warnings.push(`Manifest "settings.hardGuardrailGlobs" must be an array of path globs; ignoring it and keeping any existing guardrails.`);
  }
  // Manual-review label is deliberately separate from review_state_label so operators can use one hold label
  // without enabling the old ready/changes disposition labels. Null disables only the label, not the hold.
  if (r.manualReviewLabel === null) {
    out.manualReviewLabel = null;
  } else {
    const manualReviewLabel = normalizeOptionalString(r.manualReviewLabel, "settings.manualReviewLabel", warnings);
    if (manualReviewLabel !== null) out.manualReviewLabel = manualReviewLabel;
  }
  if (r.readyToMergeLabel === null) {
    out.readyToMergeLabel = null;
  } else {
    const readyToMergeLabel = normalizeOptionalString(r.readyToMergeLabel, "settings.readyToMergeLabel", warnings);
    if (readyToMergeLabel !== null) out.readyToMergeLabel = readyToMergeLabel;
  }
  if (r.changesRequestedLabel === null) {
    out.changesRequestedLabel = null;
  } else {
    const changesRequestedLabel = normalizeOptionalString(r.changesRequestedLabel, "settings.changesRequestedLabel", warnings);
    if (changesRequestedLabel !== null) out.changesRequestedLabel = changesRequestedLabel;
  }
  if (r.migrationCollisionLabel === null) {
    out.migrationCollisionLabel = null;
  } else {
    const migrationCollisionLabel = normalizeOptionalString(r.migrationCollisionLabel, "settings.migrationCollisionLabel", warnings);
    if (migrationCollisionLabel !== null) out.migrationCollisionLabel = migrationCollisionLabel;
  }
  if (r.pendingClosureLabel === null) {
    out.pendingClosureLabel = null;
  } else {
    const pendingClosureLabel = normalizeOptionalString(r.pendingClosureLabel, "settings.pendingClosureLabel", warnings);
    if (pendingClosureLabel !== null) out.pendingClosureLabel = pendingClosureLabel;
  }
  // Account-age throttle (#2561): an explicit yml `null` is load-bearing (clears a DB-configured threshold
  // back to "off"), matching contributorOpenPrCap's own null-vs-omitted distinction above.
  if (r.accountAgeThresholdDays === null) {
    out.accountAgeThresholdDays = null;
  } else {
    const accountAgeThresholdDays = normalizeOptionalPositiveInteger(r.accountAgeThresholdDays, "settings.accountAgeThresholdDays", warnings);
    if (accountAgeThresholdDays !== null) out.accountAgeThresholdDays = accountAgeThresholdDays;
  }
  const newAccountLabel = normalizeOptionalString(r.newAccountLabel, "settings.newAccountLabel", warnings);
  if (newAccountLabel !== null) out.newAccountLabel = newAccountLabel;
  // Per-command @gittensory rate limit (#2560): generalizes review-nag's cooldown pattern to every command.
  const commandRateLimitPolicy = normalizeOptionalEnum(r.commandRateLimitPolicy, "settings.commandRateLimitPolicy", ["off", "hold"] as const, warnings);
  if (commandRateLimitPolicy !== null) out.commandRateLimitPolicy = commandRateLimitPolicy;
  const commandRateLimitMaxPerWindow = normalizeOptionalPositiveInteger(r.commandRateLimitMaxPerWindow, "settings.commandRateLimitMaxPerWindow", warnings);
  if (commandRateLimitMaxPerWindow !== null) out.commandRateLimitMaxPerWindow = commandRateLimitMaxPerWindow;
  const commandRateLimitAiMaxPerWindow = normalizeOptionalPositiveInteger(r.commandRateLimitAiMaxPerWindow, "settings.commandRateLimitAiMaxPerWindow", warnings);
  if (commandRateLimitAiMaxPerWindow !== null) out.commandRateLimitAiMaxPerWindow = commandRateLimitAiMaxPerWindow;
  const commandRateLimitWindowHours = normalizeOptionalPositiveInteger(r.commandRateLimitWindowHours, "settings.commandRateLimitWindowHours", warnings);
  if (commandRateLimitWindowHours !== null) out.commandRateLimitWindowHours = commandRateLimitWindowHours;
  // Moderation-rules engine (#selfhost-mod-engine): per-repo override of the global moderation config.
  const moderationGateMode = normalizeOptionalEnum(r.moderationGateMode, "settings.moderationGateMode", ["inherit", "off", "enabled"] as const, warnings);
  if (moderationGateMode !== null) out.moderationGateMode = moderationGateMode;
  // #gate-flagged: normalizeModerationRules returns an EMPTY rules array for two semantically different
  // inputs -- a genuinely empty yml list (`moderationRules: []`, an intentional "opt every rule out for this
  // repo") and a MALFORMED one (a non-array, or an array where every entry fails validation) that degrades to
  // empty as its safe fallback. Applying the malformed case as an override would silently disable every rule
  // for this repo instead of leaving the DB-configured value intact, so the two must be told apart by the RAW
  // input's own shape -- not just the normalized result -- before assigning. A PARTIAL list (some valid, some
  // invalid entries) still applies the surviving valid subset, mirroring autoCloseExemptLogins' behavior.
  if (r.moderationRules !== undefined) {
    const { rules, warnings: moderationRuleWarnings } = normalizeModerationRules(r.moderationRules);
    warnings.push(...moderationRuleWarnings);
    const intentionalEmptyList = Array.isArray(r.moderationRules) && r.moderationRules.length === 0;
    if (rules.length > 0 || intentionalEmptyList) out.moderationRules = rules;
  }
  const moderationWarningLabel = normalizeModerationLabel(r.moderationWarningLabel);
  if (moderationWarningLabel !== undefined) out.moderationWarningLabel = moderationWarningLabel;
  const moderationBannedLabel = normalizeModerationLabel(r.moderationBannedLabel);
  if (moderationBannedLabel !== undefined) out.moderationBannedLabel = moderationBannedLabel;
  // Review-evasion protection (#review-evasion-protection): a contributor closing/converting-to-draft their
  // own PR while gittensory has an active review pass running is dodging the one-shot review.
  const reviewEvasionProtection = normalizeOptionalEnum(r.reviewEvasionProtection, "settings.reviewEvasionProtection", ["off", "close"] as const, warnings);
  if (reviewEvasionProtection !== null) out.reviewEvasionProtection = reviewEvasionProtection;
  // #label-scoping: same load-bearing-null idiom as blacklistLabel above.
  if (r.reviewEvasionLabel === null) {
    out.reviewEvasionLabel = null;
  } else {
    const reviewEvasionLabel = normalizeOptionalString(r.reviewEvasionLabel, "settings.reviewEvasionLabel", warnings);
    if (reviewEvasionLabel !== null) out.reviewEvasionLabel = reviewEvasionLabel;
  }
  const reviewEvasionComment = normalizeOptionalBoolean(r.reviewEvasionComment, "settings.reviewEvasionComment", warnings);
  if (reviewEvasionComment !== null) out.reviewEvasionComment = reviewEvasionComment;
  return out;
}

/** Serialize the settings override for the cache round-trip; returns null when nothing is set. */
export function settingsOverrideToJson(settings: FocusManifestSettings): JsonValue {
  if (Object.keys(settings).length === 0) return null;
  return { ...settings } as Record<string, JsonValue>;
}

/** A bounded, PUBLIC-SAFE maintainer string (footer/note). Trimmed, length-capped, and rejected with a
 *  warning if it contains any forbidden public term — it is then dropped, never published. */
function parsePublicSafeText(value: JsonValue | undefined, field: string, warnings: string[]): string | null {
  const text = normalizeOptionalString(value, field, warnings);
  if (text === null) return null;
  const bounded = text.length > MAX_ITEM_LENGTH ? text.slice(0, MAX_ITEM_LENGTH) : text;
  if (!isFocusManifestPublicSafe(bounded)) {
    warnings.push(`Manifest "${field}" contains content that is not public-safe; ignoring it.`);
    return null;
  }
  return bounded;
}

/**
 * Parse the optional `review:` block — maintainer overrides for the public review-panel content. Never
 * throws; invalid/unsafe values are dropped with warnings.
 */
function parseReviewConfig(value: JsonValue | undefined, warnings: string[]): FocusManifestReviewConfig {
  const empty: FocusManifestReviewConfig = { present: false, footerText: null, note: null, fields: {}, enrichmentAnalyzers: {}, profile: null, tone: null, securityFocus: null, inlineComments: null, suggestions: null, changedFilesSummary: null, effortScore: null, testGeneration: null, findingCategories: null, minFindingSeverity: null, maxFindings: { ...EMPTY_MAX_FINDINGS_CONFIG }, commentVerbosity: null, pathInstructions: [], instructions: null, excludePaths: [], pathFilters: [], preMergeChecks: [], autoReview: { ...EMPTY_AUTO_REVIEW_CONFIG }, labelingRules: [], aiModel: { ...EMPTY_SELF_HOST_AI_MODEL_CONFIG }, visual: { ...EMPTY_VISUAL_CONFIG }, linkedIssueSatisfaction: null };
  if (value === undefined || value === null) return empty;
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Manifest field "review" must be a mapping; ignoring it.`);
    return empty;
  }
  const r = value as Record<string, JsonValue>;
  const footerRecord = r.footer !== null && typeof r.footer === "object" && !Array.isArray(r.footer) ? (r.footer as Record<string, JsonValue>) : undefined;
  if (r.footer !== undefined && r.footer !== null && footerRecord === undefined) warnings.push(`Manifest "review.footer" must be a mapping; ignoring it.`);
  const fieldsRecord = r.fields !== null && typeof r.fields === "object" && !Array.isArray(r.fields) ? (r.fields as Record<string, JsonValue>) : undefined;
  if (r.fields !== undefined && r.fields !== null && fieldsRecord === undefined) warnings.push(`Manifest "review.fields" must be a mapping; ignoring it.`);
  const fields: Partial<Record<ReviewFieldKey, boolean>> = {};
  if (fieldsRecord) {
    for (const key of REVIEW_FIELD_KEYS) {
      const flag = normalizeOptionalBoolean(fieldsRecord[key], `review.fields.${key}`, warnings);
      if (flag !== null) fields[key] = flag;
    }
  }
  const enrichmentRecord = r.enrichment !== null && typeof r.enrichment === "object" && !Array.isArray(r.enrichment) ? (r.enrichment as Record<string, JsonValue>) : undefined;
  if (r.enrichment !== undefined && r.enrichment !== null && enrichmentRecord === undefined) warnings.push(`Manifest "review.enrichment" must be a mapping; ignoring it.`);
  const enrichmentAnalyzers: Partial<Record<ReesAnalyzerName, boolean>> = {};
  if (enrichmentRecord) {
    for (const key of Object.keys(enrichmentRecord)) {
      if (!REES_ANALYZER_NAME_SET.has(key)) {
        warnings.push(`Manifest "review.enrichment" has unknown analyzer "${key}"; ignoring it.`);
        continue;
      }
      const flag = normalizeOptionalBoolean(enrichmentRecord[key], `review.enrichment.${key}`, warnings);
      if (flag !== null) enrichmentAnalyzers[key as ReesAnalyzerName] = flag;
    }
  }
  const footerText = footerRecord ? parsePublicSafeText(footerRecord.text, "review.footer.text", warnings) : null;
  const note = parsePublicSafeText(r.note, "review.note", warnings);
  const profile = parseReviewProfile(r.profile, warnings);
  const tone = parsePublicSafeText(r.tone, "review.tone", warnings);
  const securityFocus = normalizeOptionalBoolean(r.security_focus, "review.security_focus", warnings);
  const inlineComments = normalizeOptionalBoolean(r.inline_comments, "review.inline_comments", warnings);
  const suggestions = normalizeOptionalBoolean(r.suggestions, "review.suggestions", warnings);
  const changedFilesSummary = normalizeOptionalBoolean(r.changed_files_summary, "review.changed_files_summary", warnings);
  const effortScore = normalizeOptionalBoolean(r.effort_score, "review.effort_score", warnings);
  const testGeneration = normalizeOptionalBoolean(r.test_generation, "review.test_generation", warnings);
  const findingCategories = normalizeOptionalBoolean(r.finding_categories, "review.finding_categories", warnings);
  const minFindingSeverity = normalizeOptionalEnum(
    r.min_finding_severity,
    "review.min_finding_severity",
    REVIEW_FINDING_SEVERITY_LADDER,
    warnings,
  );
  const maxFindings = parseMaxFindingsConfig(r.max_findings, warnings);
  const commentVerbosity = normalizeOptionalEnum(r.comment_verbosity, "review.comment_verbosity", COMMENT_VERBOSITY_LEVELS, warnings);
  const pathInstructions = parseReviewPathInstructions(r.path_instructions, warnings);
  const instructions = parsePublicSafeText(r.instructions, "review.instructions", warnings);
  const excludePaths = parseReviewExcludePaths(r.exclude_paths, warnings);
  const pathFilters = parseReviewPathFilters(r.path_filters, warnings);
  const preMergeChecks = parseReviewPreMergeChecks(r.pre_merge_checks, warnings);
  const autoReview = parseAutoReviewConfig(r.auto_review, warnings);
  const labelingRules = parseReviewLabelingRules(r.labeling_rules, warnings);
  const aiModel = parseSelfHostAiModelConfig(r.ai_model, warnings);
  const visual = parseVisualConfig(r.visual, warnings);
  const linkedIssueSatisfaction = normalizeOptionalEnum(r.linkedIssueSatisfaction, "review.linkedIssueSatisfaction", LINKED_ISSUE_SATISFACTION_MODES, warnings);
  return {
    present:
      footerText !== null ||
      note !== null ||
      profile !== null ||
      tone !== null ||
      securityFocus !== null ||
      inlineComments !== null ||
      suggestions !== null ||
      changedFilesSummary !== null ||
      effortScore !== null ||
      testGeneration !== null ||
      findingCategories !== null ||
      minFindingSeverity !== null ||
      maxFindingsPresent(maxFindings) ||
      commentVerbosity !== null ||
      pathInstructions.length > 0 ||
      instructions !== null ||
      excludePaths.length > 0 ||
      pathFilters.length > 0 ||
      preMergeChecks.length > 0 ||
      autoReviewPresent(autoReview) ||
      labelingRules.length > 0 ||
      selfHostAiModelPresent(aiModel) ||
      visualConfigPresent(visual) ||
      linkedIssueSatisfaction !== null ||
      Object.keys(fields).length > 0 ||
      Object.keys(enrichmentAnalyzers).length > 0,
    footerText,
    note,
    fields,
    autoReview,
    aiModel,
    visual,
    linkedIssueSatisfaction,
    enrichmentAnalyzers,
    profile,
    tone,
    securityFocus,
    inlineComments,
    suggestions,
    changedFilesSummary,
    effortScore,
    testGeneration,
    findingCategories,
    minFindingSeverity,
    maxFindings,
    commentVerbosity,
    pathInstructions,
    instructions,
    excludePaths,
    pathFilters,
    preMergeChecks,
    labelingRules,
  };
}

function maxFindingsPresent(config: MaxFindingsConfig): boolean {
  return config.blockers !== null || config.nits !== null;
}

/** Parse `review.max_findings` — optional non-negative caps for blockers/nits display in the unified comment. */
function parseMaxFindingsConfig(value: JsonValue | undefined, warnings: string[]): MaxFindingsConfig {
  if (value === undefined || value === null) return { ...EMPTY_MAX_FINDINGS_CONFIG };
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Manifest "review.max_findings" must be a mapping; ignoring it.`);
    return { ...EMPTY_MAX_FINDINGS_CONFIG };
  }
  const record = value as Record<string, JsonValue>;
  return {
    blockers: normalizeOptionalNonNegativeInt(record.blockers, "review.max_findings.blockers", warnings),
    nits: normalizeOptionalNonNegativeInt(record.nits, "review.max_findings.nits", warnings),
  };
}

/** The reserved label namespace Gittensor uses for scoring/type/priority (`gittensor:bug`, `gittensor:feature`,
 *  `gittensor:priority`, …). A maintainer's `labeling_rules` must not drive these — they're managed by the scorer
 *  and the type-labeler, never by ad-hoc manifest rules — so any `gittensor:`-prefixed label is refused at parse. */
const RESERVED_LABEL_PREFIX = "gittensor:";

function parseReviewLabelingRules(value: JsonValue | undefined, warnings: string[]): LabelingRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Manifest "review.labeling_rules" must be a list of rules; ignoring it.`);
    return [];
  }
  const out: LabelingRule[] = [];
  for (const [index, entry] of value.entries()) {
    if (out.length >= MAX_PATH_INSTRUCTIONS) {
      warnings.push(`Manifest "review.labeling_rules" is capped at ${MAX_PATH_INSTRUCTIONS} entries; dropping the rest.`);
      break;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`Manifest "review.labeling_rules[${index}]" must be a mapping; ignoring it.`);
      continue;
    }
    const e = entry as Record<string, JsonValue>;
    const label = e.label === undefined || e.label === null ? null : parsePublicSafeText(e.label, `review.labeling_rules[${index}].label`, warnings);
    if (label === null) {
      if (e.label === undefined || e.label === null) warnings.push(`Manifest "review.labeling_rules[${index}].label" is required; ignoring the entry.`);
      continue; // non-string / empty / not-public-safe already warned by parsePublicSafeText
    }
    if (label.toLowerCase().startsWith(RESERVED_LABEL_PREFIX)) {
      warnings.push(`Manifest "review.labeling_rules[${index}].label" ("${label}") uses the reserved "${RESERVED_LABEL_PREFIX}" namespace; ignoring the entry.`);
      continue;
    }
    const titleContains = e.title_contains === undefined || e.title_contains === null ? null : parsePublicSafeText(e.title_contains, `review.labeling_rules[${index}].title_contains`, warnings);
    const descriptionContains = e.description_contains === undefined || e.description_contains === null ? null : parsePublicSafeText(e.description_contains, `review.labeling_rules[${index}].description_contains`, warnings);
    const whenPaths = parseManifestGlobList(e.when_paths, `review.labeling_rules[${index}].when_paths`, warnings);
    if (whenPaths.length === 0 && titleContains === null && descriptionContains === null) {
      warnings.push(`Manifest "review.labeling_rules[${index}]" needs at least one of when_paths / title_contains / description_contains; ignoring it.`);
      continue;
    }
    out.push({ label, whenPaths, titleContains, descriptionContains });
  }
  return out;
}

function autoReviewPresent(config: AutoReviewConfig): boolean {
  return (
    config.skipDrafts !== null ||
    config.ignoreAuthors.length > 0 ||
    config.ignoreTitleKeywords.length > 0 ||
    config.skipLabels.length > 0 ||
    config.skipDocsOnly !== null ||
    config.maxAddedLines > 0 ||
    config.maxFiles > 0 ||
    config.baseBranches.length > 0 ||
    config.autoPauseAfterReviewedCommits !== null
  );
}

/** Parse `review.auto_review` — deterministic AI review eligibility filters. (#1954 / #2038–#2041) */
function parseAutoReviewConfig(value: JsonValue | undefined, warnings: string[]): AutoReviewConfig {
  if (value === undefined || value === null) return { ...EMPTY_AUTO_REVIEW_CONFIG };
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Manifest field "review.auto_review" must be a mapping; ignoring it.`);
    return { ...EMPTY_AUTO_REVIEW_CONFIG };
  }
  const record = value as Record<string, JsonValue>;
  return {
    skipDrafts: normalizeOptionalBoolean(record.skip_drafts, "review.auto_review.skip_drafts", warnings),
    ignoreAuthors: parseManifestGlobList(record.ignore_authors, "review.auto_review.ignore_authors", warnings),
    ignoreTitleKeywords: parseAutoReviewTitleKeywords(record.ignore_title_keywords, warnings),
    skipLabels: parseAutoReviewSkipLabels(record.skip_labels, warnings),
    skipDocsOnly: normalizeOptionalBoolean(record.skip_docs_only, "review.auto_review.skip_docs_only", warnings),
    maxAddedLines: normalizeAutoReviewSizeCap(record.max_added_lines, "review.auto_review.max_added_lines", warnings),
    maxFiles: normalizeAutoReviewSizeCap(record.max_files, "review.auto_review.max_files", warnings),
    baseBranches: parseManifestGlobList(record.base_branches, "review.auto_review.base_branches", warnings),
    autoPauseAfterReviewedCommits: normalizeOptionalNonNegativeInt(
      record.auto_pause_after_reviewed_commits,
      "review.auto_review.auto_pause_after_reviewed_commits",
      warnings,
    ),
  };
}

function selfHostAiModelPresent(config: SelfHostAiModelConfig): boolean {
  return (
    config.claudeModel !== null ||
    config.claudeEffort !== null ||
    config.codexModel !== null ||
    config.codexEffort !== null
  );
}

/** Parse `review.ai_model` — per-repo self-host reviewer model/effort overrides. Values are opaque, bounded,
 *  public-safe strings (like `review.tone`) — never validated against a fixed model/effort enum here, so this
 *  parser never drifts from the provider's own effort allowlist (`src/selfhost/ai.ts`); an invalid effort value
 *  degrades the SAME way an invalid env-sourced one already does (falls back to "medium" at resolve time).
 *  (#selfhost-ai-model-override) */
function parseSelfHostAiModelConfig(value: JsonValue | undefined, warnings: string[]): SelfHostAiModelConfig {
  if (value === undefined || value === null) return { ...EMPTY_SELF_HOST_AI_MODEL_CONFIG };
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Manifest field "review.ai_model" must be a mapping; ignoring it.`);
    return { ...EMPTY_SELF_HOST_AI_MODEL_CONFIG };
  }
  const record = value as Record<string, JsonValue>;
  return {
    claudeModel: parsePublicSafeText(record.claude_model, "review.ai_model.claude_model", warnings),
    claudeEffort: parsePublicSafeText(record.claude_effort, "review.ai_model.claude_effort", warnings),
    codexModel: parsePublicSafeText(record.codex_model, "review.ai_model.codex_model", warnings),
    codexEffort: parsePublicSafeText(record.codex_effort, "review.ai_model.codex_effort", warnings),
  };
}

function visualConfigPresent(config: VisualConfig): boolean {
  return config.preview.urlTemplate !== null || config.routes.paths.length > 0 || config.routes.maxRoutes !== null || config.themes.length > 0 || config.gif;
}

const VISUAL_THEME_VALUES: readonly VisualTheme[] = ["light", "dark"];

/** Parse `review.visual.themes` — which `prefers-color-scheme` variants to capture (#3678). Empty/default ⇒
 *  the capture pipeline falls back to a single light-theme render, byte-identical to today. Unlike
 *  `routes.paths` (an open-ended glob list), this is a closed 2-value enum, so entries are validated against
 *  it directly rather than reusing the generic glob-list parser. */
function parseVisualThemes(value: JsonValue | undefined, warnings: string[]): VisualTheme[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Manifest "review.visual.themes" must be a list of "light"/"dark"; ignoring it.`);
    return [];
  }
  const out: VisualTheme[] = [];
  for (const [index, entry] of value.entries()) {
    const theme = typeof entry === "string" ? (entry.trim().toLowerCase() as VisualTheme) : undefined;
    if (!theme || !VISUAL_THEME_VALUES.includes(theme)) {
      warnings.push(`Manifest "review.visual.themes[${index}]" must be "light" or "dark"; ignoring it.`);
      continue;
    }
    if (!out.includes(theme)) out.push(theme);
  }
  return out;
}

// `{number}`/`{head_sha}`/`{head_sha_short}` are GitHub-controlled facts about the PR (never attacker-supplied
// free text), so substitution itself carries no injection risk. The dummy values here exist only to make the
// TEMPLATE STRING (which a maintainer authored, and could still typo) validate as a well-formed HTTPS URL
// before it's ever used — see parseVisualUrlTemplate below.
const VISUAL_URL_TEMPLATE_DUMMY_VARS: Record<string, string> = {
  "{number}": "1",
  "{head_sha_short}": "0000000",
  "{head_sha}": "0000000000000000000000000000000000000000",
};

/** Parse `review.visual.preview.url_template` — validated at CONFIG-READ time against the exact same SSRF
 *  guard (`isSafeHttpUrl`) the renderer itself unconditionally applies to every URL it navigates to,
 *  regardless of source (`src/review/visual/shot.ts`). This is deliberately redundant with that runtime
 *  check, not a replacement for it — it exists so a maintainer sees a warning immediately for a malformed
 *  template (e.g. a typo'd scheme, or an accidental internal host) instead of only discovering it later as
 *  a silently-blank "after" cell. Placeholders are substituted with dummy values before validation since the
 *  raw template (e.g. `https://pr-{number}.example.com`) is not itself a parseable URL. */
function parseVisualUrlTemplate(value: JsonValue | undefined, warnings: string[]): string | null {
  const template = parsePublicSafeText(value, "review.visual.preview.url_template", warnings);
  if (template === null) return null;
  let probe = template;
  for (const [placeholder, dummy] of Object.entries(VISUAL_URL_TEMPLATE_DUMMY_VARS)) probe = probe.split(placeholder).join(dummy);
  if (!isSafeHttpUrl(probe)) {
    warnings.push(`Manifest "review.visual.preview.url_template" must be a valid HTTPS URL (with {number}/{head_sha}/{head_sha_short} placeholders substituted) targeting a public host; ignoring it.`);
    return null;
  }
  return template;
}

/** Parse `review.visual` — per-repo before/after screenshot-capture config (#3609 preview / #3610 routes /
 *  #3678 themes). */
function parseVisualConfig(value: JsonValue | undefined, warnings: string[]): VisualConfig {
  if (value === undefined || value === null) return { ...EMPTY_VISUAL_CONFIG };
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Manifest field "review.visual" must be a mapping; ignoring it.`);
    return { ...EMPTY_VISUAL_CONFIG };
  }
  const record = value as Record<string, JsonValue>;

  const previewRecord = record.preview !== null && typeof record.preview === "object" && !Array.isArray(record.preview) ? (record.preview as Record<string, JsonValue>) : undefined;
  if (record.preview !== undefined && record.preview !== null && previewRecord === undefined) {
    warnings.push(`Manifest "review.visual.preview" must be a mapping; ignoring it.`);
  }
  const urlTemplate = previewRecord ? parseVisualUrlTemplate(previewRecord.url_template, warnings) : null;

  const routesRecord = record.routes !== null && typeof record.routes === "object" && !Array.isArray(record.routes) ? (record.routes as Record<string, JsonValue>) : undefined;
  if (record.routes !== undefined && record.routes !== null && routesRecord === undefined) {
    warnings.push(`Manifest "review.visual.routes" must be a mapping; ignoring it.`);
  }
  const paths = routesRecord ? parseManifestGlobList(routesRecord.paths, "review.visual.routes.paths", warnings) : [];
  const maxRoutes = routesRecord ? normalizeOptionalVisualMaxRoutes(routesRecord.max_routes, warnings) : null;

  const themes = parseVisualThemes(record.themes, warnings);
  const gif = normalizeOptionalBoolean(record.gif, "review.visual.gif", warnings) === true;

  return { preview: { urlTemplate }, routes: { paths, maxRoutes }, themes, gif };
}

function parseAutoReviewTitleKeywords(value: JsonValue | undefined, warnings: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Manifest "review.auto_review.ignore_title_keywords" must be a list of strings; ignoring it.`);
    return [];
  }
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (out.length >= MAX_PATH_INSTRUCTIONS) {
      warnings.push(`Manifest "review.auto_review.ignore_title_keywords" is capped at ${MAX_PATH_INSTRUCTIONS} entries; dropping the rest.`);
      break;
    }
    const raw = typeof entry === "string" ? entry.trim() : "";
    if (!raw) {
      warnings.push(`Manifest "review.auto_review.ignore_title_keywords[${index}]" must be a non-empty string; ignoring it.`);
      continue;
    }
    const safe = parsePublicSafeText(raw, `review.auto_review.ignore_title_keywords[${index}]`, warnings);
    if (safe !== null) out.push(safe);
  }
  return out;
}

function parseAutoReviewSkipLabels(value: JsonValue | undefined, warnings: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Manifest "review.auto_review.skip_labels" must be a list of strings; ignoring it.`);
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (out.length >= MAX_PATH_INSTRUCTIONS) {
      warnings.push(`Manifest "review.auto_review.skip_labels" is capped at ${MAX_PATH_INSTRUCTIONS} entries; dropping the rest.`);
      break;
    }
    const raw = typeof entry === "string" ? entry.trim() : "";
    if (!raw) {
      warnings.push(`Manifest "review.auto_review.skip_labels[${index}]" must be a non-empty string; ignoring it.`);
      continue;
    }
    const safe = parsePublicSafeText(raw, `review.auto_review.skip_labels[${index}]`, warnings);
    if (safe === null) continue;
    const key = safe.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Parse `review.pre_merge_checks` — an array of DETERMINISTIC pre-merge assertions. Each entry needs a non-empty
 *  public-safe `name` and at least ONE assertion (`title_contains` / `description_contains` / `require_label`,
 *  each public-safe); `when_paths` (optional) gates the check to PRs touching a matching glob; `enforce` (default
 *  false) makes a failure a hard blocker. Invalid entries are dropped with a warning; capped at
 *  MAX_PATH_INSTRUCTIONS so a hostile manifest can't bloat the gate. (#review-pre-merge-checks) */
function parseReviewPreMergeChecks(value: JsonValue | undefined, warnings: string[]): PreMergeCheck[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Manifest "review.pre_merge_checks" must be a list of checks; ignoring it.`);
    return [];
  }
  const out: PreMergeCheck[] = [];
  for (const [index, entry] of value.entries()) {
    if (out.length >= MAX_PATH_INSTRUCTIONS) {
      warnings.push(`Manifest "review.pre_merge_checks" is capped at ${MAX_PATH_INSTRUCTIONS} entries; dropping the rest.`);
      break;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`Manifest "review.pre_merge_checks[${index}]" must be a mapping; ignoring it.`);
      continue;
    }
    const e = entry as Record<string, JsonValue>;
    if (e.name === undefined || e.name === null) {
      warnings.push(`Manifest "review.pre_merge_checks[${index}].name" is required; ignoring the entry.`);
      continue;
    }
    const name = parsePublicSafeText(e.name, `review.pre_merge_checks[${index}].name`, warnings);
    if (name === null) continue; // non-string / empty / not-public-safe → already warned
    const titleContains = e.title_contains === undefined || e.title_contains === null ? null : parsePublicSafeText(e.title_contains, `review.pre_merge_checks[${index}].title_contains`, warnings);
    const descriptionContains = e.description_contains === undefined || e.description_contains === null ? null : parsePublicSafeText(e.description_contains, `review.pre_merge_checks[${index}].description_contains`, warnings);
    const requireLabel = e.require_label === undefined || e.require_label === null ? null : parsePublicSafeText(e.require_label, `review.pre_merge_checks[${index}].require_label`, warnings);
    if (titleContains === null && descriptionContains === null && requireLabel === null) {
      warnings.push(`Manifest "review.pre_merge_checks[${index}]" needs at least one of title_contains / description_contains / require_label; ignoring it.`);
      continue;
    }
    const whenPaths = parseManifestGlobList(e.when_paths, `review.pre_merge_checks[${index}].when_paths`, warnings);
    const enforce = normalizeOptionalBoolean(e.enforce, `review.pre_merge_checks[${index}].enforce`, warnings) === true;
    out.push({ name, whenPaths, titleContains, descriptionContains, requireLabel, enforce });
  }
  return out;
}

/** Parse a manifest glob list (e.g. `review.exclude_paths`, a check's `when_paths`) — an array of non-empty
 *  string globs; blanks/non-strings are dropped with a warning. Capped at MAX_PATH_INSTRUCTIONS so a hostile
 *  manifest can't bloat the matcher. `fieldLabel` makes the warnings name the right field. */
function parseManifestGlobList(value: JsonValue | undefined, fieldLabel: string, warnings: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Manifest "${fieldLabel}" must be a list of path globs; ignoring it.`);
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const glob = typeof entry === "string" ? entry.trim() : "";
    if (!glob) {
      warnings.push(`Manifest "${fieldLabel}[${index}]" must be a non-empty string; ignoring it.`);
      continue;
    }
    if (glob.length > MAX_ITEM_LENGTH) {
      warnings.push(`Manifest "${fieldLabel}[${index}]" exceeds ${MAX_ITEM_LENGTH} chars; ignoring it.`);
      continue;
    }
    const key = glob.toLowerCase();
    if (seen.has(key)) continue;
    if (out.length >= MAX_PATH_INSTRUCTIONS) {
      warnings.push(`Manifest "${fieldLabel}" is capped at ${MAX_PATH_INSTRUCTIONS} entries; dropping the rest.`);
      break;
    }
    seen.add(key);
    out.push(glob);
  }
  return out;
}

/** Parse `review.exclude_paths` — globs whose matching files are excluded from the AI review. (#review-exclude-paths) */
function parseReviewExcludePaths(value: JsonValue | undefined, warnings: string[]): string[] {
  return parseManifestGlobList(value, "review.exclude_paths", warnings);
}

/** Parse `review.path_filters` — include globs plus optional leading-`!` negation entries. (#2043) */
function parseReviewPathFilters(value: JsonValue | undefined, warnings: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Manifest "review.path_filters" must be a list of path globs; ignoring it.`);
    return [];
  }
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (out.length >= MAX_PATH_INSTRUCTIONS) {
      warnings.push(`Manifest "review.path_filters" is capped at ${MAX_PATH_INSTRUCTIONS} entries; dropping the rest.`);
      break;
    }
    const raw = typeof entry === "string" ? entry.trim() : "";
    if (!raw) {
      warnings.push(`Manifest "review.path_filters[${index}]" must be a non-empty string; ignoring it.`);
      continue;
    }
    const negated = raw.startsWith("!");
    const glob = negated ? raw.slice(1).trim() : raw;
    if (!glob) {
      warnings.push(`Manifest "review.path_filters[${index}]" must include a glob after a leading '!'; ignoring it.`);
      continue;
    }
    if (glob.length > MAX_ITEM_LENGTH) {
      warnings.push(`Manifest "review.path_filters[${index}]" exceeds ${MAX_ITEM_LENGTH} chars; ignoring it.`);
      continue;
    }
    out.push(negated ? `!${glob}` : glob);
  }
  return out;
}

/** Parse `review.path_instructions` — an array of `{ path, instructions }` entries. Each must have a non-empty
 *  string `path` (a manifest glob) and PUBLIC-SAFE string `instructions`; invalid/unsafe entries are dropped with
 *  a warning. Capped at MAX_PATH_INSTRUCTIONS so a huge manifest can't bloat the reviewer prompt. */
function parseReviewPathInstructions(value: JsonValue | undefined, warnings: string[]): ReviewPathInstruction[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Manifest "review.path_instructions" must be a list of { path, instructions }; ignoring it.`);
    return [];
  }
  const out: ReviewPathInstruction[] = [];
  for (const [index, entry] of value.entries()) {
    if (out.length >= MAX_PATH_INSTRUCTIONS) {
      warnings.push(`Manifest "review.path_instructions" is capped at ${MAX_PATH_INSTRUCTIONS} entries; dropping the rest.`);
      break;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`Manifest "review.path_instructions[${index}]" must be a mapping with path + instructions; ignoring it.`);
      continue;
    }
    const e = entry as Record<string, JsonValue>;
    const path = typeof e.path === "string" ? e.path.trim() : "";
    if (!path) {
      warnings.push(`Manifest "review.path_instructions[${index}].path" must be a non-empty string; ignoring the entry.`);
      continue;
    }
    if (path.length > MAX_ITEM_LENGTH) {
      warnings.push(`Manifest "review.path_instructions[${index}].path" exceeds ${MAX_ITEM_LENGTH} chars; ignoring the entry.`);
      continue;
    }
    if (e.instructions === undefined || e.instructions === null) {
      warnings.push(`Manifest "review.path_instructions[${index}].instructions" is required; ignoring the entry.`);
      continue;
    }
    const instructions = parsePublicSafeText(e.instructions, `review.path_instructions[${index}].instructions`, warnings);
    if (instructions === null) continue; // non-string / empty / not-public-safe → already warned
    out.push({ path, instructions });
  }
  return out;
}

/** Parse `review.profile` — one of chill / balanced / assertive (case-insensitive). `balanced` normalizes to
 *  null (the default, so the reviewer prompt stays byte-identical). Any other value is ignored with a warning. */
function parseReviewProfile(value: JsonValue | undefined, warnings: string[]): ReviewProfile | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    warnings.push(`Manifest "review.profile" must be a string (chill | balanced | assertive); ignoring it.`);
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "balanced") return null; // default → no prompt change
  if (normalized === "chill" || normalized === "assertive") return normalized;
  warnings.push(`Manifest "review.profile" must be one of chill / balanced / assertive; ignoring "${value.slice(0, 32)}".`);
  return null;
}

/** Serialize the review config for the cache round-trip; returns null when nothing is set. */
export function reviewConfigToJson(review: FocusManifestReviewConfig): JsonValue {
  if (!review.present) return null;
  const out: Record<string, JsonValue> = {};
  if (review.footerText !== null) out.footer = { text: review.footerText };
  if (review.note !== null) out.note = review.note;
  if (review.profile !== null) out.profile = review.profile;
  if (review.tone !== null) out.tone = review.tone;
  if (review.securityFocus !== null) out.security_focus = review.securityFocus;
  if (review.inlineComments !== null) out.inline_comments = review.inlineComments;
  if (review.suggestions !== null) out.suggestions = review.suggestions;
  if (review.changedFilesSummary !== null) out.changed_files_summary = review.changedFilesSummary;
  if (review.effortScore !== null) out.effort_score = review.effortScore;
  if (review.testGeneration !== null) out.test_generation = review.testGeneration;
  if (review.findingCategories !== null) out.finding_categories = review.findingCategories;
  if (review.minFindingSeverity !== null) out.min_finding_severity = review.minFindingSeverity;
  if (maxFindingsPresent(review.maxFindings)) {
    const maxFindings: Record<string, JsonValue> = {};
    if (review.maxFindings.blockers !== null) maxFindings.blockers = review.maxFindings.blockers;
    if (review.maxFindings.nits !== null) maxFindings.nits = review.maxFindings.nits;
    out.max_findings = maxFindings;
  }
  if (review.commentVerbosity !== null) out.comment_verbosity = review.commentVerbosity;
  if (review.instructions !== null) out.instructions = review.instructions;
  if (review.pathInstructions.length > 0) out.path_instructions = review.pathInstructions.map((entry) => ({ path: entry.path, instructions: entry.instructions }));
  if (review.excludePaths.length > 0) out.exclude_paths = [...review.excludePaths];
  if (review.pathFilters.length > 0) out.path_filters = [...review.pathFilters];
  if (autoReviewPresent(review.autoReview)) {
    const autoReview: Record<string, JsonValue> = {};
    if (review.autoReview.skipDrafts !== null) autoReview.skip_drafts = review.autoReview.skipDrafts;
    if (review.autoReview.ignoreAuthors.length > 0) autoReview.ignore_authors = [...review.autoReview.ignoreAuthors];
    if (review.autoReview.ignoreTitleKeywords.length > 0) autoReview.ignore_title_keywords = [...review.autoReview.ignoreTitleKeywords];
    if (review.autoReview.skipLabels.length > 0) autoReview.skip_labels = [...review.autoReview.skipLabels];
    if (review.autoReview.skipDocsOnly !== null) autoReview.skip_docs_only = review.autoReview.skipDocsOnly;
    if (review.autoReview.maxAddedLines > 0) autoReview.max_added_lines = review.autoReview.maxAddedLines;
    if (review.autoReview.maxFiles > 0) autoReview.max_files = review.autoReview.maxFiles;
    if (review.autoReview.baseBranches.length > 0) autoReview.base_branches = [...review.autoReview.baseBranches];
    if (review.autoReview.autoPauseAfterReviewedCommits !== null) {
      autoReview.auto_pause_after_reviewed_commits = review.autoReview.autoPauseAfterReviewedCommits;
    }
    out.auto_review = autoReview;
  }
  if (review.preMergeChecks.length > 0) {
    out.pre_merge_checks = review.preMergeChecks.map((check) => {
      const entry: Record<string, JsonValue> = { name: check.name };
      if (check.whenPaths.length > 0) entry.when_paths = [...check.whenPaths];
      if (check.titleContains !== null) entry.title_contains = check.titleContains;
      if (check.descriptionContains !== null) entry.description_contains = check.descriptionContains;
      if (check.requireLabel !== null) entry.require_label = check.requireLabel;
      if (check.enforce) entry.enforce = true;
      return entry;
    });
  }
  if (Object.keys(review.fields).length > 0) out.fields = { ...review.fields } as Record<string, JsonValue>;
  if (Object.keys(review.enrichmentAnalyzers).length > 0) out.enrichment = { ...review.enrichmentAnalyzers } as Record<string, JsonValue>;
  if (review.labelingRules.length > 0) {
    out.labeling_rules = review.labelingRules.map((rule) => {
      const entry: Record<string, JsonValue> = { label: rule.label };
      if (rule.whenPaths.length > 0) entry.when_paths = [...rule.whenPaths];
      if (rule.titleContains !== null) entry.title_contains = rule.titleContains;
      if (rule.descriptionContains !== null) entry.description_contains = rule.descriptionContains;
      return entry;
    });
  }
  if (selfHostAiModelPresent(review.aiModel)) {
    const aiModel: Record<string, JsonValue> = {};
    if (review.aiModel.claudeModel !== null) aiModel.claude_model = review.aiModel.claudeModel;
    if (review.aiModel.claudeEffort !== null) aiModel.claude_effort = review.aiModel.claudeEffort;
    if (review.aiModel.codexModel !== null) aiModel.codex_model = review.aiModel.codexModel;
    if (review.aiModel.codexEffort !== null) aiModel.codex_effort = review.aiModel.codexEffort;
    out.ai_model = aiModel;
  }
  if (visualConfigPresent(review.visual)) {
    const visual: Record<string, JsonValue> = {};
    if (review.visual.preview.urlTemplate !== null) visual.preview = { url_template: review.visual.preview.urlTemplate };
    if (review.visual.routes.paths.length > 0 || review.visual.routes.maxRoutes !== null) {
      const routes: Record<string, JsonValue> = {};
      if (review.visual.routes.paths.length > 0) routes.paths = [...review.visual.routes.paths];
      if (review.visual.routes.maxRoutes !== null) routes.max_routes = review.visual.routes.maxRoutes;
      visual.routes = routes;
    }
    if (review.visual.themes.length > 0) visual.themes = [...review.visual.themes];
    if (review.visual.gif) visual.gif = true;
    out.visual = visual;
  }
  if (review.linkedIssueSatisfaction !== null) out.linkedIssueSatisfaction = review.linkedIssueSatisfaction;
  return out;
}

/**
 * Resolve the `review.path_instructions` that APPLY to a PR — those whose glob matches at least one changed path
 * — into a single prompt section for the AI reviewer, or "" when none match (so the prompt stays byte-identical).
 * Pure; uses the same manifest path-glob semantics (`matchesManifestPath`) as the rest of the manifest. Capped to
 * keep the prompt bounded. (#review-path-instructions)
 */
export function resolveReviewPathInstructions(pathInstructions: ReviewPathInstruction[], changedPaths: string[]): string {
  if (pathInstructions.length === 0 || changedPaths.length === 0) return "";
  const applicable = pathInstructions.filter((entry) => changedPaths.some((path) => matchesManifestPath(path, entry.path)));
  if (applicable.length === 0) return "";
  const lines = applicable.map((entry) => `- \`${entry.path}\`: ${entry.instructions}`);
  return `\n\nPath-specific review instructions from the maintainer — apply these to the changed files that match each glob:\n${lines.join("\n")}`;
}

export function resolveAutoReviewConfig(manifest: FocusManifest | null): AutoReviewConfig {
  return manifest?.review.autoReview ?? { ...EMPTY_AUTO_REVIEW_CONFIG };
}

export type AutoReviewEligibilityInput = {
  isDraft: boolean;
  author: string | null;
  title: string;
  labels: readonly string[];
  changedPaths: readonly string[];
  addedLineCount: number;
  changedFileCount: number;
  baseRef: string | null;
  reviewedCommitCount: number;
};

/** Evaluate `review.auto_review` eligibility. Returns a quiet skip reason string, or null when AI review should proceed. (#1954) */
export function evaluateAutoReviewSkipReason(config: AutoReviewConfig, input: AutoReviewEligibilityInput): string | null {
  if (config.skipDrafts === true && input.isDraft) return "review skipped (draft)";
  if (input.author && config.ignoreAuthors.length > 0) {
    const author = input.author.toLowerCase();
    if (config.ignoreAuthors.some((glob) => matchesManifestPath(author, glob.toLowerCase()))) {
      return "review skipped (ignored author)";
    }
  }
  if (config.ignoreTitleKeywords.length > 0) {
    const titleLower = input.title.toLowerCase();
    if (config.ignoreTitleKeywords.some((keyword) => titleLower.includes(keyword.toLowerCase()))) {
      return "review skipped (WIP title)";
    }
  }
  if (config.skipLabels.length > 0 && input.labels.length > 0) {
    const prLabels = new Set(input.labels.map((label) => label.toLowerCase()));
    if (config.skipLabels.some((label) => prLabels.has(label))) {
      return "review skipped (label)";
    }
  }
  if (config.skipDocsOnly === true && input.changedPaths.length > 0) {
    if (input.changedPaths.every((path) => classifyChangedFile(path) === "docs")) {
      return "review skipped (docs only)";
    }
  }
  if (config.maxAddedLines > 0 && input.addedLineCount > config.maxAddedLines) {
    return "review skipped (too large)";
  }
  if (config.maxFiles > 0 && input.changedFileCount > config.maxFiles) {
    return "review skipped (too large)";
  }
  if (config.baseBranches.length > 0) {
    const baseRef = input.baseRef?.trim() ?? "";
    if (!baseRef || !config.baseBranches.some((glob) => matchesManifestPath(baseRef, glob))) {
      return "review skipped (base branch out of scope)";
    }
  }
  if (config.autoPauseAfterReviewedCommits !== null && config.autoPauseAfterReviewedCommits > 0) {
    if (input.reviewedCommitCount >= config.autoPauseAfterReviewedCommits) {
      return "review paused (commit threshold)";
    }
  }
  return null;
}

/** Known auto-review skip reason tokens returned by `evaluateAutoReviewSkipReason`. (#2067) */
export type AutoReviewSkipReason =
  | "review skipped (draft)"
  | "review skipped (ignored author)"
  | "review skipped (WIP title)"
  | "review skipped (label)"
  | "review skipped (docs only)"
  | "review skipped (too large)"
  | "review skipped (base branch out of scope)"
  | "review paused (commit threshold)";

/** Public-safe one-line summaries for each auto-review skip reason — mirrors settings-preview `SKIP_SUMMARY`. (#2067) */
export const AUTO_REVIEW_SKIP_SUMMARY: Record<AutoReviewSkipReason, string> = {
  "review skipped (draft)": "AI review is skipped for draft pull requests while review.auto_review.skip_drafts is enabled.",
  "review skipped (ignored author)": "The author matches review.auto_review.ignore_authors, so AI review is skipped.",
  "review skipped (WIP title)": "The title matches review.auto_review.ignore_title_keywords, so AI review is skipped.",
  "review skipped (label)": "A configured review.auto_review.skip_labels label is present, so AI review is skipped.",
  "review skipped (docs only)": "Every changed file is documentation while review.auto_review.skip_docs_only is enabled, so AI review is skipped.",
  "review skipped (too large)": "The pull request exceeds review.auto_review.max_added_lines or max_files, so AI review is skipped.",
  "review skipped (base branch out of scope)": "The base branch is outside review.auto_review.base_branches, so AI review is skipped.",
  "review paused (commit threshold)": "Published AI review count reached review.auto_review.auto_pause_after_reviewed_commits, so further AI review is paused.",
};

export function isContributorControlledAutoReviewSkipReason(skipReason: string): boolean {
  return skipReason === "review skipped (WIP title)" || skipReason === "review skipped (base branch out of scope)";
}

export function resolveAutoReviewSkipSummary(skipReason: string): string {
  if (Object.prototype.hasOwnProperty.call(AUTO_REVIEW_SKIP_SUMMARY, skipReason)) {
    return AUTO_REVIEW_SKIP_SUMMARY[skipReason as AutoReviewSkipReason];
  }
  return skipReason;
}

export function resolvePullRequestAutoReviewSkipReason(args: {
  forceAiReview?: boolean | undefined;
  manifest: FocusManifest | null;
  isDraft: boolean;
  author: string | null;
  title: string;
  labels?: readonly string[] | undefined;
  changedPaths?: readonly string[] | undefined;
  addedLineCount?: number | undefined;
  changedFileCount?: number | undefined;
  baseRef: string | null;
  reviewedCommitCount?: number | undefined;
}): string | null {
  if (args.forceAiReview === true) return null;
  return evaluateAutoReviewSkipReason(resolveAutoReviewConfig(args.manifest), {
    isDraft: args.isDraft,
    author: args.author,
    title: args.title,
    labels: args.labels ?? [],
    changedPaths: args.changedPaths ?? [],
    addedLineCount: args.addedLineCount ?? 0,
    changedFileCount: args.changedFileCount ?? 0,
    baseRef: args.baseRef,
    reviewedCommitCount: args.reviewedCommitCount ?? 0,
  });
}

/** Fold `review.tone` into the repo-instructions slot alongside `review.instructions` so both inherit the same
 *  public-safe system append in the AI reviewer. Null/empty tone ⇒ instructions unchanged (byte-identical). (#2044) */
export function composeManifestReviewInstructions(instructions: string | null, tone: string | null): string | null {
  const toneText = tone?.trim() || null;
  const instructionText = instructions?.trim() || null;
  if (!toneText) return instructionText;
  const toneSection = `Review tone (maintainer voice brief — complements review.profile): ${toneText}`;
  if (!instructionText) return toneSection;
  return `${toneSection}\n\n${instructionText}`;
}

/** Resolve the AI-reviewer overrides (`review.profile` + `review.tone` + `review.security_focus` + `review.path_instructions` +
 *  `review.exclude_paths` + `review.path_filters` + `review.ai_model`) from a possibly-null manifest (null = load
 *  failure). A null manifest yields the byte-identical defaults. Centralized so the AI-review caller threads them
 *  in one place with the null-manifest branch covered here (unit-tested) rather than inline in the processor.
 *  (#review-profile / #review-tone / #review-security-focus / #review-path-instructions / #review-exclude-paths / #2043 / #selfhost-ai-model-override / #1956) */
export function resolveReviewPromptOverrides(manifest: FocusManifest | null): { profile: ReviewProfile | null; tone: string | null; securityFocus: boolean; inlineComments: boolean; suggestions: boolean; changedFilesSummary: boolean; effortScore: boolean; findingCategories: boolean; minFindingSeverity: ReviewFindingSeverity | null; maxFindings: MaxFindingsConfig; commentVerbosity: CommentVerbosity | null; pathInstructions: ReviewPathInstruction[]; instructions: string | null; excludePaths: string[]; pathFilters: string[]; selfHostAiModel: SelfHostAiModelConfig } {
  // inlineComments resolves to a strict boolean — true ONLY when the manifest explicitly set review.inline_comments:
  // true; null/false/absent ⇒ false. The caller ANDs this per-repo toggle with the operator flag + cutover allowlist.
  // securityFocus resolves the same way — true ONLY when the manifest explicitly set review.security_focus: true.
  // suggestions resolves the same way (#1956) — the caller further ANDs it with the already-resolved
  // inlineComments gate, since a suggestion has nothing to attach to without an inline comment.
  // changedFilesSummary resolves the same way (#1957) — independent of inlineComments/suggestions; it only
  // needs the unified-comment convergence feature itself to be on (the caller's own outer gate).
  // effortScore resolves the same way (#1955) — like changedFilesSummary, it is deterministic/display-only
  // (never touches the AI prompt) and only needs the unified-comment convergence feature to be on.
  // findingCategories resolves the same way (#1958) — like suggestions, the caller further ANDs it with the
  // already-resolved inlineComments gate, since a category has nothing to categorize without an inline finding.
  // commentVerbosity resolves the same way (#2047) — deterministic/display-only, independent of every other
  // knob here; absent (null) ⇒ the caller applies "normal" (byte-identical).
  return { profile: manifest?.review.profile ?? null, tone: manifest?.review.tone ?? null, securityFocus: manifest?.review.securityFocus === true, inlineComments: manifest?.review.inlineComments === true, suggestions: manifest?.review.suggestions === true, changedFilesSummary: manifest?.review.changedFilesSummary === true, effortScore: manifest?.review.effortScore === true, findingCategories: manifest?.review.findingCategories === true, minFindingSeverity: manifest?.review.minFindingSeverity ?? null, maxFindings: manifest?.review.maxFindings ?? { ...EMPTY_MAX_FINDINGS_CONFIG }, commentVerbosity: manifest?.review.commentVerbosity ?? null, pathInstructions: manifest?.review.pathInstructions ?? [], instructions: manifest?.review.instructions ?? null, excludePaths: manifest?.review.excludePaths ?? [], pathFilters: manifest?.review.pathFilters ?? [], selfHostAiModel: resolveReviewSelfHostAiModel(manifest) };
}

/** Resolve `review.pre_merge_checks` from a possibly-null manifest (null = load failure ⇒ no checks). Centralized
 *  so the gate caller resolves them in one place with the null-manifest branch covered here (unit-tested) rather
 *  than inline in the processor. (#review-pre-merge-checks) */
export function resolveReviewPreMergeChecks(manifest: FocusManifest | null): PreMergeCheck[] {
  return manifest?.review.preMergeChecks ?? [];
}

/** Resolve `review.test_generation` (#1972) from a possibly-null manifest (null = load failure ⇒ off). Deterministic/
 *  display-only like `resolveReviewPreMergeChecks` — this never touches the AI reviewer prompt, only whether the
 *  boundary-test-generation finding/spec (`src/signals/boundary-test-generation.ts`) is computed at all. Resolves to
 *  a strict boolean — true ONLY when the manifest explicitly set `review.test_generation: true`; null/false/absent ⇒
 *  false (byte-identical to today, no boundary scan runs). */
export function resolveTestGenerationEnabled(manifest: FocusManifest | null): boolean {
  return manifest?.review.testGeneration === true;
}

/** Resolve `review.enrichment` analyzer toggles from a possibly-null manifest (null = load failure ⇒ no toggles ⇒
 *  the operator's default analyzer set runs unchanged). Centralized so the enrichment caller threads them in one
 *  place with the null-manifest branch covered here (unit-tested) rather than inline in the processor. (#2050) */
/** Resolve `review.auto_review` from a possibly-null manifest (null = load failure => no ignored authors). The
 *  runtime eligibility check then fails open instead of suppressing review output on an ambiguous manifest read.
 *  (#2060) */
export function resolveReviewAutoReviewConfig(manifest: FocusManifest | null): AutoReviewConfig {
  return manifest?.review.autoReview ?? { ...EMPTY_AUTO_REVIEW_CONFIG };
}

/** Resolve `review.ai_model` from a possibly-null manifest (null = load failure ⇒ no per-repo override). The
 *  self-host AI layer then falls back to its own global env vars / hardcoded defaults, same as an explicit
 *  all-null config — a manifest read failure never blocks a review, it just loses the per-repo override for
 *  that one pass. (#selfhost-ai-model-override) */
export function resolveReviewSelfHostAiModel(manifest: FocusManifest | null): SelfHostAiModelConfig {
  return manifest?.review.aiModel ?? { ...EMPTY_SELF_HOST_AI_MODEL_CONFIG };
}

/** Resolve `review.visual` from a possibly-null manifest (null = load failure ⇒ no per-repo override). The
 *  capture pipeline then falls back to GitHub-native preview discovery + automatic route inference, same as
 *  an explicit all-empty config — a manifest read failure never blocks a review or a capture attempt, it
 *  just loses the per-repo override for that one pass. (#3609 / #3610) */
export function resolveReviewVisualConfig(manifest: FocusManifest | null): VisualConfig {
  return manifest?.review.visual ?? { ...EMPTY_VISUAL_CONFIG };
}

export function resolveEnrichmentAnalyzerToggles(manifest: FocusManifest | null): Partial<Record<ReesAnalyzerName, boolean>> {
  return manifest?.review.enrichmentAnalyzers ?? {};
}

/** Load a repo's `review.enrichment` toggles fail-safely: a manifest load error is swallowed to `null`, so a broken
 *  or unreachable manifest degrades to no toggles ⇒ the operator's default analyzer set runs. The loader is injected
 *  so both the success and the load-failure path are unit-tested here rather than inline at the enrichment call
 *  site. (#2050) */
export async function resolveRepoEnrichmentToggles(loadManifest: () => Promise<FocusManifest>): Promise<Partial<Record<ReesAnalyzerName, boolean>>> {
  const manifest = await loadManifest().catch(() => null);
  return resolveEnrichmentAnalyzerToggles(manifest);
}

/** One per-repo review SKILL (#review-skills): a maintainer-maintained rubric module loaded from the container-private
 *  config dir (`<repo>/review/skills/*.md`). `when` is "always" (repo-wide) or a path glob / brace-list that gates it to
 *  matching changed files (cost: only relevant skills are injected). */
export type RepoReviewSkill = { name: string; when: string; body: string };
/** The per-repo review CONTEXT (#review-skills): an always-on `review/AGENTS.md` / `review/CLAUDE.md` guide + skills. */
export type RepoReviewContext = { guide: string | null; skills: RepoReviewSkill[] };

/** Hard cap on the injected per-repo review context — a cost guard so a runaway guide/skills set can't bloat every
 *  prompt. The maintained files are concise by design; this only bites pathological inputs. */
const MAX_REVIEW_CONTEXT_CHARS = 16_000;

/** True when a skill's `when` applies to this PR: "always"/empty ⇒ yes; otherwise the (possibly brace-listed) glob must
 *  match at least one changed path. Reuses the manifest path matcher so it behaves exactly like path_instructions. */
function reviewSkillApplies(when: string, changedPaths: string[]): boolean {
  const w = when.trim();
  if (!w || w.toLowerCase() === "always") return true;
  const patterns = w
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return patterns.some((pat) =>
    changedPaths.some((path) => matchesManifestPath(path, pat)),
  );
}

/** Compose the per-repo review context into a prompt section (#review-skills): the always-on guide + every skill whose
 *  `when` applies to this PR's changed files. Bounded for cost. Null/empty ⇒ "" (byte-identical reviewer prompt). The
 *  caller folds the result into the `review.instructions` slot, so it inherits the same prompt wrapper + public-safe
 *  handling. */
export function composeRepoReviewContext(
  context: RepoReviewContext | null,
  changedPaths: string[],
): string {
  if (!context) return "";
  const parts: string[] = [];
  if (context.guide?.trim()) parts.push(context.guide.trim());
  for (const skill of context.skills) {
    if (reviewSkillApplies(skill.when, changedPaths) && skill.body.trim())
      parts.push(`## skill: ${skill.name}\n${skill.body.trim()}`);
  }
  if (parts.length === 0) return "";
  const joined = parts.join("\n\n");
  return joined.length > MAX_REVIEW_CONTEXT_CHARS
    ? joined.slice(0, MAX_REVIEW_CONTEXT_CHARS)
    : joined;
}

/** Filter a PR's changed files down to the set the AI review should see — dropping any whose path matches a
 *  `review.exclude_paths` glob (generated/vendored/lockfiles). Empty `excludePaths` ⇒ the same array (byte-identical
 *  review). Pure; the gate/slop/secret-scan operate on the unfiltered files. (#review-exclude-paths) */
export function excludeReviewPaths<T extends { path: string }>(files: T[], excludePaths: string[]): T[] {
  if (excludePaths.length === 0) return files;
  return files.filter((file) => !excludePaths.some((glob) => matchesManifestPath(file.path, glob)));
}

/** Apply `review.path_filters` after `exclude_paths`: include globs restrict the set; leading-`!` entries
 *  subtract matches. Empty `pathFilters` ⇒ the same array (byte-identical). (#2043) */
export function applyReviewPathFilters<T extends { path: string }>(files: T[], pathFilters: string[]): T[] {
  if (pathFilters.length === 0) return files;
  const includes: string[] = [];
  const negations: string[] = [];
  for (const entry of pathFilters) {
    if (entry.startsWith("!")) negations.push(entry.slice(1));
    else includes.push(entry);
  }
  let filtered = files;
  if (includes.length > 0) {
    filtered = filtered.filter((file) => includes.some((glob) => matchesManifestPath(file.path, glob)));
  }
  if (negations.length > 0) {
    filtered = filtered.filter((file) => !negations.some((glob) => matchesManifestPath(file.path, glob)));
  }
  return filtered;
}

/** Filter changed files for the AI review path: drop `exclude_paths`, then apply `path_filters`. (#2043) */
export function filterReviewFilesForAi<T extends { path: string }>(
  files: T[],
  excludePaths: string[],
  pathFilters: string[],
): T[] {
  return applyReviewPathFilters(excludeReviewPaths(files, excludePaths), pathFilters);
}

/**
 * Apply the typed `gate:` alias's overrides onto already-spread effective settings, mutating `effective` in
 * place. Split out of resolveEffectiveSettings purely for readability — this stays the ONLY place a `gate.*`
 * field maps onto its `RepositorySettings` counterpart. `gate:` still WINS over an overlapping `settings:`
 * value (the caller runs this AFTER the `{ ...dbSettings, ...manifest.settings }` spread), matching the
 * documented precedence (self-hosting-configuration docs: "the typed gate: block ... wins over the generic
 * settings: block for those same fields"). Every field here is independently null-gated — a `gate:` field
 * absent from the parsed manifest is `null` (see parseGateConfig below) and leaves `effective` untouched, so a
 * repo with no `gate:` block resolves byte-identically to before this was split out.
 */
function applyGateConfigOverrides(effective: RepositorySettings, gate: FocusManifestGateConfig): void {
  if (gate.enabled !== null) effective.gateCheckMode = gate.enabled ? "enabled" : "off";
  // reviewCheckMode (#2852) resolution: explicit `gate.checkMode` is the most-specific signal and always wins
  // when set. Otherwise fall back to the legacy `gate.enabled` boolean alias, mapped symmetrically so it keeps
  // its historical effect (true -> the check publishes and may be required; false -> it never publishes) even
  // though it no longer drives `gateCheckMode` alone. When NEITHER is set, `effective.reviewCheckMode` already
  // holds `settings.reviewCheckMode` (yml `settings:` override, else the DB value) from the caller's spread.
  if (gate.checkMode !== null) effective.reviewCheckMode = gate.checkMode;
  else if (gate.enabled !== null) effective.reviewCheckMode = gate.enabled ? "required" : "disabled";
  if (gate.pack !== null) effective.gatePack = gate.pack;
  if (gate.linkedIssue !== null) effective.linkedIssueGateMode = gate.linkedIssue;
  if (gate.duplicates !== null) effective.duplicatePrGateMode = gate.duplicates;
  if (gate.readinessMode !== null) effective.qualityGateMode = gate.readinessMode;
  if (gate.readinessMinScore !== null) effective.qualityGateMinScore = gate.readinessMinScore;
  if (gate.sizeMode !== null) effective.sizeGateMode = gate.sizeMode;
  if (gate.lockfileIntegrityMode !== null) effective.lockfileIntegrityGateMode = gate.lockfileIntegrityMode;
  if (gate.slopMode !== null) effective.slopGateMode = gate.slopMode;
  if (gate.slopMinScore !== null) effective.slopGateMinScore = gate.slopMinScore;
  if (gate.slopAiAdvisory !== null) effective.slopAiAdvisory = gate.slopAiAdvisory;
  if (gate.aiReviewMode !== null) effective.aiReviewMode = gate.aiReviewMode;
  if (gate.aiReviewByok !== null) effective.aiReviewByok = gate.aiReviewByok;
  if (gate.aiReviewProvider !== null) effective.aiReviewProvider = gate.aiReviewProvider;
  if (gate.aiReviewModel !== null) effective.aiReviewModel = gate.aiReviewModel;
  if (gate.aiReviewAllAuthors !== null) effective.aiReviewAllAuthors = gate.aiReviewAllAuthors;
  if (gate.aiReviewCloseConfidence !== null) effective.aiReviewCloseConfidence = gate.aiReviewCloseConfidence;
  // Dual-AI combine/onMerge/reviewers overrides (#2567) are projected onto `effective` unclamped here — they are
  // a REFINEMENT of the operator's AI_REVIEW_PLAN, not a replacement for it, so the actual operator-floor clamp
  // (onMerge can only TIGHTEN, never loosen) happens where both the per-repo value AND the operator's plan are
  // visible: `resolveEffectiveAiReviewOnMerge` in services/ai-review.ts, called from the review call site. This
  // resolver has no access to `env.AI_REVIEW_PLAN`, so it cannot itself enforce the floor.
  if (gate.aiReviewCombine !== null) effective.aiReviewCombine = gate.aiReviewCombine;
  if (gate.aiReviewOnMerge !== null) effective.aiReviewOnMerge = gate.aiReviewOnMerge;
  if (gate.aiReviewReviewers !== null) effective.aiReviewReviewers = gate.aiReviewReviewers;
  if (gate.mergeReadiness !== null) effective.mergeReadinessGateMode = gate.mergeReadiness;
  if (gate.manifestPolicy !== null) effective.manifestPolicyGateMode = gate.manifestPolicy;
  if (gate.selfAuthoredLinkedIssue !== null) effective.selfAuthoredLinkedIssueGateMode = gate.selfAuthoredLinkedIssue;
  if (gate.dryRun !== null) effective.gateDryRun = gate.dryRun;
  if (gate.firstTimeContributorGrace !== null) effective.firstTimeContributorGrace = gate.firstTimeContributorGrace;
  if (gate.premergeContentRecheck !== null) effective.premergeContentRecheck = gate.premergeContentRecheck;
  if (gate.requireFreshRebaseWindowMinutes !== null) effective.requireFreshRebaseWindowMinutes = gate.requireFreshRebaseWindowMinutes;
  if (gate.claMode !== null) effective.claGateMode = gate.claMode;
  if (gate.claConsentPhrase !== null) effective.claConsentPhrase = gate.claConsentPhrase;
  if (gate.claCheckRunName !== null) effective.claCheckRunName = gate.claCheckRunName;
  if (gate.claCheckRunAppSlug !== null) effective.claCheckRunAppSlug = gate.claCheckRunAppSlug;
  if (gate.expectedCiContexts !== null) effective.expectedCiContexts = gate.expectedCiContexts;
}

/**
 * Resolve the EFFECTIVE repository settings a webhook should act on: `.gittensory.yml` > DB settings >
 * safe defaults. The generic `settings:` override applies first; the friendly `gate:` alias then wins
 * for its fields. This single resolver makes the whole gittensory configuration — gate on/off, blocker
 * modes, comments, labels, surface, audience — controllable from the repo's `.gittensory.yml`.
 */
export function resolveEffectiveSettings(
  dbSettings: RepositorySettings,
  manifest: FocusManifest,
  sharedContributorBlacklist: RepositorySettings["contributorBlacklist"] = [],
): RepositorySettings {
  // `typeLabels`/`linkedIssueLabelPropagation`/`linkedIssueHardRules` are parsed as SPARSE partials (see
  // parseFocusManifest above),
  // unlike every other `manifest.settings` field, which is always a complete value ready to overlay the DB
  // value wholesale via the spread below. Pull them out of the spread and merge each field individually,
  // manifest override > DB value > built-in default, so a `.gittensory.yml` naming only one key (e.g.
  // `typeLabels.priority`) can never silently reset the others back to the built-in default and discard a
  // DB-customized value (#priority-linked-issue-gate), and an arbitrary custom category (e.g. `security`)
  // layers in alongside the DB value rather than requiring it too (#label-modularity).
  const {
    typeLabels: typeLabelsOverride,
    linkedIssueLabelPropagation: linkedIssueLabelPropagationOverride,
    linkedIssueHardRules: linkedIssueHardRulesOverride,
    unlinkedIssueGuardrail: unlinkedIssueGuardrailOverride,
    ...restManifestSettings
  } = manifest.settings;
  const effective: RepositorySettings = { ...dbSettings, ...restManifestSettings };
  if (typeLabelsOverride !== undefined) {
    // `null` is parseFocusManifest's distinct signal for a literal `typeLabels: {}` -- a deliberate
    // "zero configured categories for this repo" that REPLACES the DB value wholesale, rather than a
    // sparse override merged over it (#label-modularity). Any other (possibly-empty-if-all-invalid)
    // object is a sparse layer: its present keys win, every other key (built-in or custom) is inherited
    // from the DB value -- a plain object spread generalizes the old per-key `?? ` merge to an arbitrary
    // key set for free, and an override with zero surviving keys (e.g. every named key failed validation)
    // spreads in nothing, leaving the DB value completely unchanged.
    // The cast is safe: every key parseFocusManifest actually sets on the sparse override already
    // passed normalizeTypeLabelSet's non-empty-string validation (see the sparse-copy loop above), so
    // no value here is ever `undefined` at runtime -- only `Partial<PrTypeLabelSet>`'s TYPE (not its
    // actual contents) admits that possibility.
    effective.typeLabels = typeLabelsOverride === null ? {} : ({ ...(dbSettings.typeLabels ?? DEFAULT_TYPE_LABELS), ...typeLabelsOverride } as PrTypeLabelSet);
  }
  if (linkedIssueLabelPropagationOverride !== undefined) {
    const base = dbSettings.linkedIssueLabelPropagation ?? DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION;
    effective.linkedIssueLabelPropagation = {
      enabled: linkedIssueLabelPropagationOverride.enabled ?? base.enabled,
      mode: linkedIssueLabelPropagationOverride.mode ?? base.mode,
      mappings: linkedIssueLabelPropagationOverride.mappings ?? base.mappings,
    };
  }
  if (linkedIssueHardRulesOverride !== undefined) {
    const base = dbSettings.linkedIssueHardRules ?? DEFAULT_LINKED_ISSUE_HARD_RULES;
    effective.linkedIssueHardRules = {
      ownerAssignedClose: linkedIssueHardRulesOverride.ownerAssignedClose ?? base.ownerAssignedClose,
      assignedIssueClose: linkedIssueHardRulesOverride.assignedIssueClose ?? base.assignedIssueClose,
      missingPointLabelClose: linkedIssueHardRulesOverride.missingPointLabelClose ?? base.missingPointLabelClose,
      maintainerOnlyLabelClose: linkedIssueHardRulesOverride.maintainerOnlyLabelClose ?? base.maintainerOnlyLabelClose,
      pointBearingLabels: linkedIssueHardRulesOverride.pointBearingLabels ?? base.pointBearingLabels,
      maintainerOnlyLabels: linkedIssueHardRulesOverride.maintainerOnlyLabels ?? base.maintainerOnlyLabels,
      defaultLabelRepo: linkedIssueHardRulesOverride.defaultLabelRepo ?? base.defaultLabelRepo,
      verifyBeforeClose: linkedIssueHardRulesOverride.verifyBeforeClose ?? base.verifyBeforeClose,
      closeDelaySeconds: linkedIssueHardRulesOverride.closeDelaySeconds ?? base.closeDelaySeconds,
    };
  }
  if (unlinkedIssueGuardrailOverride !== undefined) {
    const base = dbSettings.unlinkedIssueGuardrail ?? DEFAULT_UNLINKED_ISSUE_GUARDRAIL;
    effective.unlinkedIssueGuardrail = {
      mode: unlinkedIssueGuardrailOverride.mode ?? base.mode,
      minConfidence: unlinkedIssueGuardrailOverride.minConfidence ?? base.minConfidence,
    };
  }
  applyGateConfigOverrides(effective, manifest.gate);
  // The dashboard "Require linked issue" toggle must not silently diverge from gate blocking: when the
  // boolean is on but linkedIssueGateMode is still off, treat it as a block requirement (#797).
  if (effective.requireLinkedIssue && effective.linkedIssueGateMode === "off") {
    effective.linkedIssueGateMode = "block";
  }
  // Readiness/quality can never hard-block a PR (buildQualityGateWarning is always advisory-severity;
  // isConfiguredGateBlocker has no branch for it). The write-time guards (the settings.qualityGateMode /
  // gate.readiness.mode parsers above, and the settings-write API routes) stop a NEW "block" value from being
  // introduced, but a repo whose DB row already has quality_gate_mode = "block" from before those guards
  // existed would still resolve to it here. Downgrade it at this single resolver too, so the EFFECTIVE settings
  // the gate/review pipeline AND the settings-preview dashboard read (both call this function) can never carry
  // a value that implies enforcement it doesn't have, regardless of when or where it was written (#2267).
  if (effective.qualityGateMode === "block") effective.qualityGateMode = "advisory";
  effective.contributorBlacklist = mergeContributorBlacklists(effective.contributorBlacklist ?? [], sharedContributorBlacklist);
  return effective;
}

/**
 * Tolerantly normalize an already-parsed manifest object into a {@link FocusManifest}.
 * Never throws: malformed shapes degrade to safe defaults and accumulate warnings so callers
 * can surface them instead of crashing.
 */
export function parseFocusManifest(raw: unknown, source?: FocusManifestSource): FocusManifest {
  if (raw === undefined || raw === null) return emptyManifest(source ?? "none");
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return emptyManifest(source ?? "api_record", ["Manifest must be a mapping of fields; ignoring malformed manifest and falling back to deterministic signals."]);
  }
  const record = raw as Record<string, JsonValue>;
  const warnings: string[] = [];
  const manifest: FocusManifest = {
    present: true,
    source: normalizeSource(source, record.source, warnings),
    wantedPaths: normalizeStringList(record.wantedPaths, "wantedPaths", warnings),
    preferredLabels: normalizeStringList(record.preferredLabels, "preferredLabels", warnings),
    linkedIssuePolicy: normalizeEnum(record.linkedIssuePolicy, "linkedIssuePolicy", ["required", "preferred", "optional"] as const, "optional", warnings),
    testExpectations: normalizeStringList(record.testExpectations, "testExpectations", warnings),
    issueDiscoveryPolicy: normalizeEnum(record.issueDiscoveryPolicy, "issueDiscoveryPolicy", ["encouraged", "neutral", "discouraged"] as const, "neutral", warnings),
    maintainerNotes: normalizeStringList(record.maintainerNotes, "maintainerNotes", warnings),
    publicNotes: normalizeStringList(record.publicNotes, "publicNotes", warnings).filter(isFocusManifestPublicSafe),
    gate: parseGateConfig(record.gate, warnings),
    settings: parseSettingsOverride(record.settings, warnings),
    review: parseReviewConfig(record.review, warnings),
    features: parseFeaturesConfig(record.features, warnings),
    contentLane: parseContentLaneConfig(record.contentLane, warnings),
    repoDocGeneration: parseRepoDocGenerationConfig(record.repoDocGeneration, warnings),
    reviewRecap: parseReviewRecapConfig(record.reviewRecap, warnings),
    warnings,
  };
  if (
    manifest.wantedPaths.length === 0 &&
    manifest.preferredLabels.length === 0 &&
    manifest.testExpectations.length === 0 &&
    manifest.maintainerNotes.length === 0 &&
    manifest.publicNotes.length === 0 &&
    manifest.linkedIssuePolicy === "optional" &&
    manifest.issueDiscoveryPolicy === "neutral" &&
    !manifest.gate.present &&
    Object.keys(manifest.settings).length === 0 &&
    !manifest.review.present &&
    !manifest.features.present &&
    !manifest.contentLane.present &&
    !manifest.repoDocGeneration.present &&
    !manifest.reviewRecap.present
  ) {
    warnings.push("Manifest contained no recognized focus fields; falling back to deterministic signals.");
    manifest.present = false;
  }
  return manifest;
}

/**
 * Parse raw manifest file/record content (JSON or YAML). Malformed content degrades to an empty
 * manifest with a warning rather than throwing, so a broken `.gittensory` config never breaks analysis.
 */
export function parseFocusManifestContent(content: string | null | undefined, source: FocusManifestSource = "repo_file"): FocusManifest {
  if (content === undefined || content === null || content.trim() === "") return emptyManifest(source);
  if (content.length > MAX_FOCUS_MANIFEST_BYTES || new TextEncoder().encode(content).byteLength > MAX_FOCUS_MANIFEST_BYTES) {
    return emptyManifest(source, [`Manifest content exceeded ${MAX_FOCUS_MANIFEST_BYTES} bytes; ignoring it and falling back to deterministic signals.`]);
  }
  const trimmed = content.trim();
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  let parsed: unknown;
  try {
    parsed = looksLikeJson ? JSON.parse(trimmed) : parseYaml(trimmed);
  } catch {
    return emptyManifest(source, [
      looksLikeJson
        ? "Manifest content was not valid JSON; ignoring it and falling back to deterministic signals."
        : "Manifest content was not valid YAML; ignoring it and falling back to deterministic signals.",
    ]);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyManifest(source, ["Manifest must be a mapping of fields; ignoring malformed manifest and falling back to deterministic signals."]);
  }
  return parseFocusManifest(parsed, source);
}

function normalizePathForMatch(path: string): string {
  return String(path).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
}

/**
 * LINEAR-TIME wildcard matcher for a `*`-glob pattern over an already-normalized path. `*` (and a collapsed
 * run of `*`) matches any run of characters INCLUDING `/` (gittensory globs cross slashes). Implemented as a
 * prefix + suffix + ordered-substring (indexOf) scan rather than a `.*`-per-star regex: the old regex
 * (`^.*a.*a...$`) backtracks catastrophically on a near-miss path and could hang the gate for an entire repo
 * (a manifest glob with many non-adjacent `*`). This algorithm is O(path × parts) with NO backtracking.
 */
function linearGlobMatcher(pattern: string): (path: string) => boolean {
  // The caller only compiles this for a pattern that contains a wildcard, so split always yields >= 2 parts.
  const parts = pattern.split(/\*+/); // literal segments between (collapsed) wildcard runs
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const middles = parts.slice(1, -1).filter((part) => part.length > 0);
  return (path) => {
    if (!path.startsWith(first) || !path.endsWith(last)) return false;
    let idx = first.length;
    for (const part of middles) {
      const found = path.indexOf(part, idx);
      if (found === -1) return false;
      idx = found + part.length;
    }
    return path.length - last.length >= idx; // the suffix must not overlap the consumed prefix/middles
  };
}

/**
 * Compile a manifest path pattern into a predicate over an ALREADY-normalized path. Supports exact paths,
 * directory prefixes (`src/` or `src`), and `*` wildcards (`*` and a double-star both match any run of chars
 * across `/`). A double-star-then-separator prefix means "zero or more path segments", so the mandatory slash
 * is absorbed and a double-star glob also matches a ROOT-level (zero-depth) file, not only nested ones.
 * Compiling once lets a caller test many paths against one pattern without recompiling per path — see
 * {@link matchedPatterns}. An empty/blank pattern never matches.
 */
function expandGlobstarSlash(pattern: string): string[] {
  const alternatives = [""];
  for (let idx = 0; idx < pattern.length; ) {
    if (pattern.startsWith("**/", idx)) {
      const count = alternatives.length;
      const canKeepRootAlternatives = count * 2 <= MAX_GLOBSTAR_SLASH_ALTERNATIVES;
      for (let altIdx = count - 1; altIdx >= 0; altIdx -= 1) {
        const prefix = alternatives[altIdx]!;
        alternatives[altIdx] = `${prefix}*/`;
        if (canKeepRootAlternatives) alternatives.push(prefix);
      }
      idx += 3;
      continue;
    }
    for (let altIdx = 0; altIdx < alternatives.length; altIdx += 1) alternatives[altIdx] += pattern[idx]!;
    idx += 1;
  }
  return alternatives;
}

function compileManifestPathMatcher(pattern: string): (normalizedPath: string) => boolean {
  const normalizedPattern = normalizePathForMatch(pattern);
  if (!normalizedPattern) return () => false;
  if (normalizedPattern.includes("*")) {
    // `**/` means zero or more whole path segments. Keep the slash in the non-root alternative so
    // basename globs (e.g. `**/safe.ts`) do not degrade into suffix globs that match `unsafe.ts`.
    const matchers = expandGlobstarSlash(normalizedPattern).map((globbed) =>
      globbed.includes("*") ? linearGlobMatcher(globbed) : (normalizedPath: string) => normalizedPath === globbed,
    );
    return (normalizedPath) => matchers.some((matcher) => matcher(normalizedPath));
  }
  const dirPattern = normalizedPattern.endsWith("/") ? normalizedPattern : `${normalizedPattern}/`;
  return (normalizedPath) => normalizedPath === normalizedPattern || normalizedPath.startsWith(dirPattern);
}

/**
 * Match a changed path against a manifest path pattern. Supports exact paths, directory
 * prefixes (`src/` or `src`), and `*` wildcards (`**` collapses to `*`).
 */
export function matchesManifestPath(path: string, pattern: string): boolean {
  const normalizedPath = normalizePathForMatch(path);
  if (!normalizedPath) return false;
  return compileManifestPathMatcher(pattern)(normalizedPath);
}

function matchedPatterns(paths: string[], patterns: string[]): string[] {
  // Normalize each path once and compile each pattern once, instead of redoing both for every (path,
  // pattern) pair — the wildcard regex was previously recompiled per path.
  const normalizedPaths = paths.map(normalizePathForMatch).filter(Boolean);
  return patterns.filter((pattern) => {
    const matches = compileManifestPathMatcher(pattern);
    return normalizedPaths.some((normalizedPath) => matches(normalizedPath));
  });
}

/**
 * Build deterministic, public-safe guidance from a focus manifest for a concrete change set.
 * Explains why changed paths are preferred or discouraged and surfaces manifest-driven blockers
 * without leaking maintainer-private notes into public next steps.
 */
export function buildFocusManifestGuidance(args: {
  manifest: FocusManifest;
  changedPaths: string[];
  labels?: string[] | undefined;
  linkedIssueCount?: number | undefined;
  testFileCount?: number | undefined;
  passedValidationCount?: number | undefined;
}): FocusManifestGuidance {
  const { manifest } = args;
  const changedPaths = args.changedPaths.filter((path) => typeof path === "string" && path.length > 0);
  const labels = (args.labels ?? []).map((label) => label.toLowerCase());
  const linkedIssueCount = Math.max(0, args.linkedIssueCount ?? 0);
  const testFileCount = Math.max(0, args.testFileCount ?? 0);
  const passedValidationCount = Math.max(0, args.passedValidationCount ?? 0);

  const matchedWantedPaths = matchedPatterns(changedPaths, manifest.wantedPaths);
  const preferredLabelHits = manifest.preferredLabels.filter((label) => labels.includes(label.toLowerCase()));

  const findings: FocusManifestFinding[] = [];
  const publicNextSteps: string[] = [];

  if (!manifest.present) {
    for (const warning of manifest.warnings) {
      findings.push({ code: "manifest_malformed", severity: "info", title: "Maintainer focus manifest not applied", detail: warning });
    }
    return {
      present: false,
      source: manifest.source,
      linkedIssuePolicy: manifest.linkedIssuePolicy,
      issueDiscoveryPolicy: manifest.issueDiscoveryPolicy,
      matchedWantedPaths: [],
      preferredLabelHits: [],
      findings,
      publicNextSteps: [],
      warnings: manifest.warnings,
      summary: "No maintainer focus manifest applied; using deterministic signals only.",
    };
  }

  if (manifest.wantedPaths.length > 0 && matchedWantedPaths.length === 0 && changedPaths.length > 0) {
    findings.push({
      code: "manifest_off_focus",
      severity: "warning",
      title: "Change is outside maintainer-wanted areas",
      detail: `No changed path matches the maintainer-wanted patterns (${manifest.wantedPaths.slice(0, 5).join(", ")}).`,
      action: "Refocus the change onto a maintainer-wanted area or explain why this out-of-focus work is needed.",
    });
    publicNextSteps.push("Refocus onto the maintainer-wanted areas, or explain why this out-of-focus change is needed.");
  }

  if (matchedWantedPaths.length > 0) {
    findings.push({
      code: "manifest_preferred_path",
      severity: "info",
      title: "Change aligns with maintainer-wanted areas",
      detail: `Changed paths match maintainer-wanted patterns: ${matchedWantedPaths.slice(0, 5).join(", ")}.`,
    });
    publicNextSteps.push("Changed paths align with the maintainer's wanted areas for this repo.");
  }

  if (manifest.preferredLabels.length > 0 && preferredLabelHits.length === 0) {
    findings.push({
      code: "manifest_missing_preferred_label",
      severity: "info",
      title: "No maintainer-preferred label applied",
      detail: `Maintainer prefers labels: ${manifest.preferredLabels.slice(0, 5).join(", ")}.`,
      action: "Consider applying a maintainer-preferred label so triage stays aligned.",
    });
    publicNextSteps.push(`Consider a maintainer-preferred label (${manifest.preferredLabels.slice(0, 3).join(", ")}).`);
  }

  if (manifest.linkedIssuePolicy === "required" && linkedIssueCount === 0) {
    findings.push({
      code: "manifest_linked_issue_required",
      severity: "warning",
      title: "Maintainer requires a linked issue",
      detail: "This repo's maintainer focus manifest requires every PR to reference a tracked issue.",
      action: "Link the relevant issue (for example `Closes #123`) before opening the PR.",
    });
    publicNextSteps.push("Link the relevant tracked issue; the maintainer requires linked issues on PRs.");
  } else if (manifest.linkedIssuePolicy === "preferred" && linkedIssueCount === 0) {
    findings.push({
      code: "manifest_linked_issue_preferred",
      severity: "info",
      title: "Maintainer prefers a linked issue",
      detail: "This repo's maintainer focus manifest prefers PRs to reference a tracked issue.",
      action: "Link a tracked issue if one exists.",
    });
    publicNextSteps.push("Link a tracked issue if one exists; the maintainer prefers linked issues.");
  }

  if (manifest.testExpectations.length > 0 && testFileCount === 0 && passedValidationCount === 0) {
    const safeExpectations = manifest.testExpectations.filter(isFocusManifestPublicSafe).slice(0, 3);
    const expectationDetail = safeExpectations.length > 0 ? ` Expected evidence: ${safeExpectations.join("; ")}.` : "";
    findings.push({
      code: "manifest_missing_tests",
      severity: "warning",
      title: "Configured validation evidence missing",
      detail: `No changed test files or passing validation evidence were detected for this PR.${expectationDetail}`,
      action: "Add regression/invariant coverage, update relevant tests, or attach passing validation output that satisfies the repo's configured expectations.",
    });
    publicNextSteps.push("Add relevant tests or passing validation evidence that matches the repo's configured expectations.");
  }

  if (manifest.issueDiscoveryPolicy === "discouraged") {
    findings.push({
      code: "manifest_issue_discovery_discouraged",
      severity: "info",
      title: "Maintainer discourages issue-discovery reports",
      detail: "This repo's maintainer focus manifest discourages new issue-discovery reports; prefer direct fixes.",
      action: "Prefer a direct PR over filing a new issue-discovery report here.",
    });
    publicNextSteps.push("This repo prefers direct fixes over new issue-discovery reports.");
  }

  const safePublicNotes = manifest.publicNotes.filter(isFocusManifestPublicSafe);
  const safeNextSteps = [...new Set([...publicNextSteps, ...safePublicNotes])].filter(isFocusManifestPublicSafe);

  return {
    present: true,
    source: manifest.source,
    linkedIssuePolicy: manifest.linkedIssuePolicy,
    issueDiscoveryPolicy: manifest.issueDiscoveryPolicy,
    matchedWantedPaths,
    preferredLabelHits,
    findings,
    publicNextSteps: safeNextSteps,
    warnings: manifest.warnings,
    summary: summarize(manifest, matchedWantedPaths),
  };
}

function summarize(manifest: FocusManifest, wanted: string[]): string {
  if (wanted.length > 0) return "Maintainer focus manifest: change aligns with a wanted area.";
  if (manifest.wantedPaths.length > 0) return "Maintainer focus manifest: change is outside the wanted areas.";
  return "Maintainer focus manifest applied with no path-specific verdict.";
}

// ─── Focus Manifest Policy Schema ────────────────────────────────────────────

/** Preference signal for a contribution lane derived from the focus manifest. */
export type FocusManifestLanePreference = "preferred" | "neutral" | "discouraged";

export type FocusManifestPolicyContributionLane = {
  id: string;
  preference: "preferred" | "neutral" | "discouraged";
  title: string;
  summary: string;
  preferredPaths: string[];
  discouragedPaths: string[];
  validationExpectations: string[];
  publicNotes: string[];
};

export type FocusManifestPolicyLabelPolicy = {
  preferredLabels: string[];
  required: boolean;
};

export type FocusManifestPolicyValidation = {
  expectations: string[];
  linkedIssuePolicy: FocusManifestLinkedIssuePolicy;
};

export type FocusManifestPolicy = {
  repoFullName: string;
  generatedAt: string;
  source: FocusManifestSource;
  present: boolean;
  publicSafe: {
    contributionLanes: FocusManifestPolicyContributionLane[];
    labelPolicy: FocusManifestPolicyLabelPolicy;
    validation: FocusManifestPolicyValidation;
    issueDiscoveryPolicy: FocusManifestIssueDiscoveryPolicy;
    publicNotes: string[];
    readinessWarnings: string[];
    entryGuidance: string[];
    summary: string;
  };
  authenticated: {
    manifestSource: FocusManifestSource;
    privateNoteCount: number;
    manifestWarningCount: number;
    parseWarnings: string[];
    readinessWarnings: string[];
    maintainerContext: string[];
  };
};

/**
 * Compile a normalized {@link FocusManifest} into a deterministic, machine-readable
 * {@link FocusManifestPolicy}. Public-safe fields are segregated from authenticated
 * (owner-only) fields. No reward, wallet, hotkey, raw trust, or private scoring
 * language is allowed in public-safe output — unsafe strings are silently dropped.
 *
 * `repoFullName` is optional — when omitted it defaults to an empty string. Callers
 * that persist the policy should supply the full name; single-manifest analysis
 * callers may omit it.
 */
export function compileFocusManifestPolicy(manifest: FocusManifest, options?: { generatedAt?: string }): FocusManifestPolicy;
export function compileFocusManifestPolicy(repoFullName: string, manifest: FocusManifest, options?: { generatedAt?: string }): FocusManifestPolicy;
export function compileFocusManifestPolicy(
  repoFullNameOrManifest: string | FocusManifest,
  manifestOrOptions?: FocusManifest | { generatedAt?: string },
  options: { generatedAt?: string } = {},
): FocusManifestPolicy {
  let repoFullName: string;
  let manifest: FocusManifest;
  if (typeof repoFullNameOrManifest === "string") {
    repoFullName = repoFullNameOrManifest;
    manifest = manifestOrOptions as FocusManifest;
  } else {
    repoFullName = "";
    manifest = repoFullNameOrManifest;
    options = (manifestOrOptions as { generatedAt?: string }) ?? {};
  }

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const safePublicNotes = manifest.publicNotes.filter(isFocusManifestPublicSafe);
  const contributionLanes = buildPolicyContributionLanes(manifest);
  const readinessWarnings = buildPolicyReadinessWarnings(manifest);
  const entryGuidance = buildPolicyEntryGuidance(manifest);
  const summary = buildPolicySummary(manifest);

  return {
    repoFullName,
    generatedAt,
    source: manifest.source,
    present: manifest.present,
    publicSafe: {
      contributionLanes,
      labelPolicy: {
        preferredLabels: manifest.preferredLabels.filter(isFocusManifestPublicSafe),
        required: manifest.linkedIssuePolicy !== "optional",
      },
      validation: {
        expectations: manifest.testExpectations.filter(isFocusManifestPublicSafe),
        linkedIssuePolicy: manifest.linkedIssuePolicy,
      },
      issueDiscoveryPolicy: manifest.issueDiscoveryPolicy,
      publicNotes: safePublicNotes,
      readinessWarnings,
      entryGuidance,
      summary,
    },
    authenticated: {
      manifestSource: manifest.source,
      privateNoteCount: manifest.maintainerNotes.length,
      manifestWarningCount: manifest.warnings.length,
      parseWarnings: manifest.warnings,
      readinessWarnings,
      maintainerContext: manifest.maintainerNotes,
    },
  };
}

function buildPolicyEntryGuidance(manifest: FocusManifest): string[] {
  const guidance: string[] = [];
  // Build the sentence from the public-safe subset (as preferredLabels and publicNotes below already do, and
  // as the sibling buildPolicyContributionLanes does for preferredPaths). Joining the raw wantedPaths means a
  // single reserved-word path (e.g. `src/ranking/`) fails the all-or-nothing public-safety filter at the end
  // and silently drops the entire focus-areas guidance line instead of surfacing the safe paths.
  const safeWantedPaths = manifest.wantedPaths.filter(isFocusManifestPublicSafe);
  if (safeWantedPaths.length > 0) {
    guidance.push(`Focus changes on maintainer-wanted areas: ${safeWantedPaths.slice(0, 5).join(", ")}.`);
  }
  if (manifest.linkedIssuePolicy === "required") guidance.push("Link a tracked issue before opening a pull request.");
  else if (manifest.linkedIssuePolicy === "preferred") guidance.push("Linking a tracked issue is preferred before opening a pull request.");
  if (manifest.preferredLabels.length > 0) {
    const safeLabels = manifest.preferredLabels.filter(isFocusManifestPublicSafe);
    if (safeLabels.length > 0) guidance.push(`Apply a maintainer-preferred label: ${safeLabels.slice(0, 3).join(", ")}.`);
  }
  guidance.push(...manifest.publicNotes.filter(isFocusManifestPublicSafe));
  return [...new Set(guidance)].filter(isFocusManifestPublicSafe);
}

function buildPolicySummary(manifest: FocusManifest): string {
  if (!manifest.present) return "No maintainer focus manifest; contribution guidance is not constrained.";
  if (manifest.issueDiscoveryPolicy === "encouraged") return "Issue-discovery is the preferred contribution mode for this repo.";
  if (manifest.issueDiscoveryPolicy === "discouraged") return "Direct PRs are preferred; issue-discovery submissions are discouraged.";
  if (manifest.wantedPaths.length > 0) return "Direct PRs on the maintainer-wanted areas are preferred.";
  return "Contribution guidance is derived from the maintainer focus manifest.";
}

function buildPolicyContributionLanes(manifest: FocusManifest): FocusManifestPolicyContributionLane[] {
  if (!manifest.present) return [];

  const lanes: FocusManifestPolicyContributionLane[] = [];
  const safeWantedPaths = manifest.wantedPaths.filter(isFocusManifestPublicSafe);
  const safeTestExpectations = manifest.testExpectations.filter(isFocusManifestPublicSafe);

  // Derive the public preference only from public-safe signals: use the SAME filtered list that surfaces in
  // validationExpectations below, not the raw testExpectations. Otherwise a manifest whose only test expectation is
  // public-unsafe (e.g. a wallet/seed phrase) is redacted from the lane yet still flips the public preference to
  // "preferred" ("…with required validation evidence"), a self-contradictory verdict with no visible basis.
  const directPrPreference: "preferred" | "neutral" | "discouraged" =
    manifest.issueDiscoveryPolicy === "encouraged" ? "discouraged"
    : safeWantedPaths.length > 0 || safeTestExpectations.length > 0 ? "preferred"
    : "neutral";

  lanes.push({
    id: "direct-pr",
    preference: directPrPreference,
    title: "Direct pull request lane",
    summary:
      directPrPreference === "discouraged"
        ? "Direct pull requests are discouraged; issue discovery is the preferred entry mode."
        : directPrPreference === "preferred"
          ? "Contribute changes in maintainer-wanted areas with required validation evidence."
          : "Direct pull requests are accepted when they stay inside maintainer-wanted scope.",
    preferredPaths: safeWantedPaths,
    discouragedPaths: [],
    validationExpectations: safeTestExpectations,
    publicNotes: manifest.publicNotes.filter(isFocusManifestPublicSafe),
  });

  const issueDiscoveryPreference: "preferred" | "neutral" | "discouraged" =
    manifest.issueDiscoveryPolicy === "encouraged" ? "preferred"
    : manifest.issueDiscoveryPolicy === "discouraged" ? "discouraged"
    : "neutral";

  lanes.push({
    id: "issue-discovery",
    preference: issueDiscoveryPreference,
    title: "Issue discovery lane",
    summary:
      issueDiscoveryPreference === "preferred"
        ? "File well-scoped issue reports that the maintainer has indicated are welcome."
        : issueDiscoveryPreference === "discouraged"
          ? "The maintainer has indicated this repo prefers direct fixes over new issue reports."
          : "Issue discovery is optional; confirm maintainer scope before filing new issues.",
    preferredPaths: [],
    discouragedPaths: [],
    validationExpectations: [],
    publicNotes: [],
  });

  return lanes;
}

function buildPolicyReadinessWarnings(manifest: FocusManifest): string[] {
  if (!manifest.present) return [];
  const warnings: string[] = [];
  if (manifest.wantedPaths.length === 0 && manifest.preferredLabels.length === 0) {
    warnings.push("Focus manifest does not define wanted paths or preferred labels; contribution scope may be unclear to contributors.");
  }
  if (manifest.testExpectations.length === 0) {
    warnings.push("Focus manifest does not define validation expectations; contributors may not know what tests to run.");
  }
  return warnings.filter(isFocusManifestPublicSafe);
}

// ---------------------------------------------------------------------------
// Contribution lane derivation
// ---------------------------------------------------------------------------

export type ContributionLanePreference = "preferred" | "neutral" | "discouraged";

export type ContributionLanes = {
  present: boolean;
  source: FocusManifestSource;
  directPrLane: ContributionLanePreference;
  issueDiscoveryLane: ContributionLanePreference;
  preferredEntryPaths: string[];
  discouragedEntryPaths: string[];
  validationExpectations: string[];
  issueEntryGuidance: string[];
  prEntryGuidance: string[];
  guidanceText: string[];
  warnings: string[];
  summary: string;
};

/**
 * Derive public-safe {@link ContributionLanes} from a focus manifest. Output is
 * deterministic: identical manifests produce identical lanes. No private scoring,
 * reward context, or trust data is included.
 */
export function deriveContributionLanes(manifest: FocusManifest): ContributionLanes {
  if (!manifest.present) {
    return {
      present: false,
      source: manifest.source,
      directPrLane: "neutral",
      issueDiscoveryLane: "neutral",
      preferredEntryPaths: [],
      discouragedEntryPaths: [],
      validationExpectations: [],
      issueEntryGuidance: [],
      prEntryGuidance: [],
      guidanceText: [],
      warnings: manifest.warnings,
      summary: "No maintainer focus manifest; contribution lanes are not constrained (using neutral lane defaults).",
    };
  }

  const safeWanted = manifest.wantedPaths.filter(isFocusManifestPublicSafe);
  const safePublicNotes = manifest.publicNotes.filter(isFocusManifestPublicSafe);

  const validationExpectations: string[] = [];
  if (manifest.linkedIssuePolicy === "required") validationExpectations.push("Link a tracked issue before opening a PR.");
  else if (manifest.linkedIssuePolicy === "preferred") validationExpectations.push("Link a tracked issue if one exists.");
  for (const e of manifest.testExpectations) {
    if (isFocusManifestPublicSafe(e)) validationExpectations.push(e);
  }

  const directPrLane: ContributionLanePreference =
    manifest.issueDiscoveryPolicy === "encouraged" ? "discouraged"
    : safeWanted.length > 0 ? "preferred"
    : "neutral";

  const issueDiscoveryLane: ContributionLanePreference =
    manifest.issueDiscoveryPolicy === "encouraged" ? "preferred"
    : manifest.issueDiscoveryPolicy === "discouraged" ? "discouraged"
    : "neutral";

  const issueEntryGuidance: string[] = [];
  if (manifest.issueDiscoveryPolicy === "encouraged") {
    issueEntryGuidance.push("Issue discovery reports are welcomed; search for gaps before opening a PR.");
  } else if (manifest.issueDiscoveryPolicy === "discouraged") {
    issueEntryGuidance.push("Prefer direct fixes over new issue reports; this repo discourages issue-discovery submissions.");
  }
  if (manifest.linkedIssuePolicy === "required") {
    issueEntryGuidance.push("Issues must be linked to a PR before it is opened.");
  } else if (manifest.linkedIssuePolicy === "preferred") {
    issueEntryGuidance.push("Link an existing issue to your PR when one is available.");
  }

  const prEntryGuidance: string[] = [];
  if (safeWanted.length > 0) {
    prEntryGuidance.push(`Focus changes on maintainer-wanted areas: ${manifest.wantedPaths.slice(0, 5).join(", ")}.`);
  }
  if (manifest.preferredLabels.length > 0) {
    const safeLabels = manifest.preferredLabels.filter(isFocusManifestPublicSafe);
    if (safeLabels.length > 0) {
      prEntryGuidance.push(`Apply a maintainer-preferred label to your PR: ${safeLabels.slice(0, 3).join(", ")}.`);
    }
  }
  prEntryGuidance.push(...safePublicNotes);
  const safeprEntryGuidance = [...new Set(prEntryGuidance)].filter(isFocusManifestPublicSafe);

  const guidanceText: string[] = [];
  if (manifest.linkedIssuePolicy === "required") {
    guidanceText.push("Link a tracked issue before opening a pull request.");
  } else if (manifest.linkedIssuePolicy === "preferred") {
    guidanceText.push("Linking a tracked issue is preferred before opening a pull request.");
  }
  if (manifest.preferredLabels.length > 0) {
    const safeLabels = manifest.preferredLabels.filter(isFocusManifestPublicSafe);
    if (safeLabels.length > 0) {
      guidanceText.push(`Apply a maintainer-preferred label: ${safeLabels.slice(0, 3).join(", ")}.`);
    }
  }
  guidanceText.push(...safePublicNotes);

  const warnings: string[] = [];
  if (safeWanted.length === 0 && manifest.preferredLabels.length === 0) {
    warnings.push("Contribution scope is unclear; focus manifest lacks wanted paths and preferred labels.");
  }
  if (manifest.testExpectations.filter(isFocusManifestPublicSafe).length === 0) {
    warnings.push("Validation expectations are not defined in the focus manifest.");
  }

  const summary = buildLanesSummary(manifest, directPrLane, issueDiscoveryLane);

  return {
    present: true,
    source: manifest.source,
    directPrLane,
    issueDiscoveryLane,
    preferredEntryPaths: safeWanted,
    discouragedEntryPaths: [],
    validationExpectations,
    issueEntryGuidance: issueEntryGuidance.filter(isFocusManifestPublicSafe),
    prEntryGuidance: safeprEntryGuidance,
    guidanceText: guidanceText.filter(isFocusManifestPublicSafe),
    warnings,
    summary,
  };
}

function buildLanesSummary(manifest: FocusManifest, directPrLane: ContributionLanePreference, issueDiscoveryLane: ContributionLanePreference): string {
  if (issueDiscoveryLane === "preferred" && directPrLane === "discouraged") return "Issue-discovery is the preferred contribution mode for this repo.";
  if (issueDiscoveryLane === "discouraged" && manifest.wantedPaths.length > 0) return "Direct PRs focused on the wanted areas are the preferred contribution mode.";
  if (directPrLane === "preferred") return "Direct PRs on the maintainer-wanted areas are preferred.";
  if (issueDiscoveryLane === "discouraged") return "Direct PRs are preferred; issue-discovery submissions are discouraged.";
  return "Contribution lanes are guided by the maintainer focus manifest.";
}

// ─── Focus Manifest Policy Schema ────────────────────────────────────────────
