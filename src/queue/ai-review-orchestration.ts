// AI-review orchestration (#4013 step 9 -- extracted from processors.ts, ninth step of the file's own
// module-split sequence, after transient-locks.ts, signal-snapshot.ts, duplicate-detection.ts,
// slop-detection.ts, review-evasion.ts, ci-resolution.ts, retention.ts, and gate-checks.ts). Pure move.
//
// The pieces here were not fully contiguous in the original file -- shouldStartAiReviewForAdvisory /
// shouldRequirePublicAiReviewForAdvisory / resolveReviewManifestForAiReview / resolveReviewEnrichmentGithubToken
// were interspersed with unrelated auto-review-skip / visual-capture helpers that stay in processors.ts -- but
// all four feed directly into runAiReviewForAdvisory below and have no caller besides processors.ts's own
// disposition/publish call sites, so they group cleanly here. A pre-existing misplaced doc comment ("Run the
// opt-in AI maintainer review...", originally floating above shouldStartAiReviewForAdvisory in the source file
// despite describing runAiReviewForAdvisory) is relocated to sit above the function it actually describes,
// since both are moving to this same file anyway. splitRepoForRag (a trivial repoFullName-split helper, was
// the last function in processors.ts) moves here too -- its only two callers are elsewhere in processors.ts
// (staying) and this file's own runAiReviewForAdvisory, so processors.ts imports it back rather than this
// file importing it from processors.ts, keeping the dependency one-directional.

import {
  claimTransientLock,
  releaseTransientLockIfOwner,
  type TransientLockClaim,
} from "./transient-locks";
import { buildPullRequestAdvisory } from "../rules/advisory";
import { getDecryptedRepositoryAiKey, getRepository, listCheckSummaries, listPullRequestFiles } from "../db/repositories";
import { createInstallationToken } from "../github/app";
import type { AgentActionMode } from "../settings/agent-execution";
import { buildAiReviewDiff } from "../review/review-diff";
import {
  filterReviewFilesForAi,
  resolveRepoEnrichmentToggles,
  resolveReviewPathInstructions,
  type FocusManifest,
  type ReviewPathInstruction,
  type ReviewProfile,
  type SelfHostAiModelConfig,
} from "../signals/focus-manifest";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import {
  hasPublicReviewAssessment,
  isEnabled,
  runGittensoryAiReview,
  type ImprovementMagnitude,
  type InlineFinding,
} from "../services/ai-review";
import { shouldRenderFindingCategories, shouldRequestInlineFindings } from "../review/inline-comments";
import { buildReviewGroundingText, isGroundingEnabled } from "../review/grounding-wire";
import { attributeReviewRagTelemetry, buildReviewRagContextWithMetrics, emptyReviewRagTelemetry, isRagEnabled } from "../review/rag-wire";
import { createReviewAdapters } from "../review/adapters";
import { extractChangedSymbols } from "../review/impact-symbols";
import { computeImpactMap, type ImpactMapEntry } from "../review/impact-map";
import { formatImpactMapPromptSection, shouldComputeImpactMap } from "../review/impact-map-wire";
import { buildRepoCultureProfileContext, shouldApplyRepoCultureProfile } from "../review/repo-culture-profile-wire";
import {
  buildReviewEnrichment,
  isEnrichmentEnabled,
  isReesGithubTokenForwardingEnabled,
  resolveEnrichmentLinkedIssue,
  resolveEnrichmentLinkedIssueNumbers,
} from "../review/enrichment-wire";
import { captureReviewFailure } from "../selfhost/sentry";
import { isReputationEnabled, shouldSkipAiForReputation } from "../review/reputation-wire";
import { isConvergenceRepoAllowed } from "../review/cutover-gate";
import { resolveConvergedFeature } from "../review/feature-activation";
import type { AdvisoryFinding, RepositorySettings } from "../types";
import { errorMessage } from "../utils/json";

/** Split `owner/name` into the project/repo key shape shared by RAG indexing and retrieval. */
export function splitRepoForRag(repoFullName: string): [string, string] {
  const slash = repoFullName.indexOf("/");
  return slash === -1
    ? ["", repoFullName]
    : [repoFullName.slice(0, slash), repoFullName.slice(slash + 1)];
}

// Per-(repo, PR, head SHA) advisory lock around runAiReviewForAdvisory's expensive grounding/RAG/enrichment/LLM
// section (#confirmed-bug: a webhook pass and an agent-regate-pr sweep pass can independently reach this same
// code for the SAME PR at the SAME head SHA, both miss the cache, and both fire a real LLM call — which can
// return DIFFERENT verdicts). The TTL is a crash-safety backstop only (see AI_REVIEW_LOCK_TTL_SECONDS below), not
// a throughput bound — same philosophy as PR_ACTUATION_LOCK_TTL_SECONDS (#2129/#2368). Deliberately its OWN lock
// namespace, not the shared pr-actuation-lock above: this guards an expensive read-and-cache (dedup a redundant
// LLM call for the identical head+mode), not a GitHub-mutating actuation, so it has different scoping (keyed by
// head SHA + mode, not just PR) and a much longer TTL (an LLM call legitimately runs far longer than a close).
const AI_REVIEW_LOCK_TTL_SECONDS = 1_800; // 30 minutes — see justification below.

// #regate-churn: how long a non-durably-cacheable AI review outcome may be reused by a scheduled re-gate at the
// IDENTICAL head+fingerprint+mode before a fresh LLM call is paid for again. Covers TWO distinct non-cacheable
// sources, both of which used to have NO retry bound at all: (1) a genuine non-cacheable verdict (consensus
// defect / inconclusive / lock-contention placeholder) that the durable cache (see #1 above) correctly never
// stores as a reusable result, and (2) a dynamic-context repo (grounding/RAG/enrichment/reputation), which
// previously bypassed the cache unconditionally on every single call. Root-caused in production: a single PR
// with RAG enabled generated 259 of 281 AI review calls in 24h via (2) at an UNCHANGED head, plus another 24 via
// (1) — 281 calls total, ~1 every 5 minutes, forever, with nothing ever throttling the retry. This bounds that
// retry cadence without ever treating either outcome as a durable, indefinitely-trustworthy result — it still
// expires and retries periodically (the LLM's own non-determinism may resolve a dispute; dynamic external
// context may genuinely have drifted), and any REAL state change (a new head, a changed review-input
// fingerprint) bypasses this bound immediately regardless of age. Matches AI_REVIEW_LOCK_TTL_SECONDS's
// 30-minute order of magnitude — same "crash/dispute backstop, not a throughput bound" philosophy.
export const AI_REVIEW_NON_CACHEABLE_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

function aiReviewLockKey(repoFullName: string, prNumber: number, headSha: string, mode: string): string {
  return `ai-review-lock:${repoFullName.toLowerCase()}#${prNumber}@${headSha.toLowerCase()}:${mode}`;
}

/**
 * Claim the per-(repo, PR, head SHA, mode) advisory lock before the expensive grounding/RAG/enrichment/LLM
 * section of runAiReviewForAdvisory. Returns false when another pass already holds it for this exact head (the
 * caller must treat this as "another pass is already reviewing this head" and return the inconclusive-hold shape
 * below — the next webhook/sweep tick, or the pass that IS running, is the backstop that populates the cache).
 * A missing cache or cache hiccup fails OPEN (returns true — the lock is defense-in-depth, never the primary
 * safety gate, and must never itself block a real review from running).
 */
export async function claimAiReviewLock(
  env: Env,
  repoFullName: string,
  prNumber: number,
  headSha: string,
  mode: string,
): Promise<TransientLockClaim> {
  return claimTransientLock(
    env,
    aiReviewLockKey(repoFullName, prNumber, headSha, mode),
    AI_REVIEW_LOCK_TTL_SECONDS,
  );
}

/** Best-effort release, called from a finally block so the lock frees promptly instead of waiting out the TTL. */
export async function releaseAiReviewLock(
  env: Env,
  repoFullName: string,
  prNumber: number,
  headSha: string,
  mode: string,
  ownerToken: string | null,
): Promise<void> {
  await releaseTransientLockIfOwner(env, aiReviewLockKey(repoFullName, prNumber, headSha, mode), ownerToken);
}

/**
 * The inconclusive-hold shape a pass returns when it lost the {@link claimAiReviewLock} race (#regate-dup-prep):
 * another pass already owns this exact (repo, PR, head, mode) lock, so THIS pass defers entirely rather than
 * racing it. Shared by both lock-claim sites that guard runAiReviewForAdvisory's expensive section — the
 * caller-side claim in maybePublishPrPublicSurface (wraps the cache-read decision itself, so a loser never even
 * reaches the cache-miss log) and runAiReviewForAdvisory's own claim (the historical, narrower placement, kept for
 * any other/direct caller) — so both produce byte-identical advisory findings and gate disposition instead of two
 * hand-written "another pass is running" messages drifting apart over time. `persistable: false` (not merely
 * `cacheable: false`): the concurrent pass this call deferred to persists the REAL result within seconds, so this
 * placeholder must never be written even non-durably — a later read within the non-cacheable retry cooldown could
 * otherwise replay a stale "another pass is running" long after that pass finished.
 */
export function aiReviewLockContendedResult(
  advisory: Pick<Awaited<ReturnType<typeof buildPullRequestAdvisory>>, "findings">,
): Awaited<ReturnType<typeof runAiReviewForAdvisory>> {
  const findings: AdvisoryFinding[] = [
    {
      code: "ai_review_inconclusive",
      severity: "warning",
      title: "AI review already in progress for this PR head",
      detail: "Another Gittensory pass is already running the AI review for this exact PR head. This pass is skipping to avoid a duplicate LLM call.",
      action: "The gate is held for a human reviewer rather than passed automatically; it re-evaluates once the in-flight review completes or on the next update.",
    },
  ];
  advisory.findings.push(...findings);
  return {
    notes: "AI review is already running for this PR head in another LoopOver pass. LoopOver is holding this PR for manual review until that pass completes.",
    reviewerCount: 0,
    inlineFindings: [],
    findings,
    cacheable: false,
    persistable: false,
  };
}

export async function shouldStartAiReviewForAdvisory(
  env: Env,
  args: {
    settings: RepositorySettings;
    advisory: Pick<Awaited<ReturnType<typeof buildPullRequestAdvisory>>, "headSha">;
    repoFullName: string;
    author: string | null;
    confirmedContributor: boolean;
    skipAiReview?: boolean | undefined;
    // #4507: the caller's own already-computed shouldSkipAiForReputation result, from the SAME gate condition
    // this function uses below (isReputationEnabled && isConvergenceRepoAllowed) -- threaded in so this call makes
    // no second REPUTATION_WINDOW_ROW_CAP-bounded review_targets scan when the caller already ran one this pass.
    // Absent (every existing/direct caller) ⇒ computed here exactly as before.
    preComputedReputationSkip?: boolean | undefined;
  },
): Promise<boolean> {
  if (!shouldRequirePublicAiReviewForAdvisory(env, args)) return false;
  if (args.settings.aiReviewAllAuthors) return true;
  if (!(isReputationEnabled(env) && isConvergenceRepoAllowed(env, args.repoFullName))) return true;
  const reputationSkip =
    args.preComputedReputationSkip ??
    (await shouldSkipAiForReputation(env, { project: args.repoFullName, submitter: args.author }));
  return !reputationSkip;
}

export function shouldRequirePublicAiReviewForAdvisory(
  env: Env,
  args: {
    settings: RepositorySettings;
    advisory: Pick<Awaited<ReturnType<typeof buildPullRequestAdvisory>>, "headSha">;
    repoFullName: string;
    author: string | null;
    confirmedContributor: boolean;
    skipAiReview?: boolean | undefined;
  },
): boolean {
  const packAllowsAnyAuthorBlockingReview =
    args.settings.gatePack === "oss-anti-slop" &&
    args.settings.aiReviewMode === "block";
  const reviewableAuthor =
    args.confirmedContributor ||
    packAllowsAnyAuthorBlockingReview ||
    args.settings.aiReviewAllAuthors;
  if (
    args.skipAiReview ||
    args.settings.aiReviewMode === "off" ||
    !reviewableAuthor ||
    !args.advisory.headSha ||
    !isEnabled(env.AI_SUMMARIES_ENABLED) ||
    !isEnabled(env.AI_PUBLIC_COMMENTS_ENABLED) ||
    !env.AI
  )
    return false;
  return true;
}

/** Reuse a cached review manifest when present; otherwise load fail-safely for the AI review pass. (#1954) */
export async function resolveReviewManifestForAiReview(
  env: Env,
  repoFullName: string,
  cachedManifest: FocusManifest | null,
): Promise<FocusManifest | null> {
  return cachedManifest ?? (await loadRepoFocusManifest(env, repoFullName).catch(() => null));
}

export async function resolveReviewEnrichmentGithubToken(
  env: Env,
  repoFullName: string,
): Promise<string | undefined> {
  const repo = await getRepository(env, repoFullName);
  const installationToken = repo?.installationId
    ? await createInstallationToken(env, repo.installationId).catch(
        () => undefined,
      )
    : undefined;
  return installationToken ?? env.GITHUB_PUBLIC_TOKEN;
}

/**
 * Run the opt-in AI maintainer review and fold it into the gate + panel. Mutates `advisory.findings`
 * with a dual-model consensus defect (when `aiReviewMode: block` and the free Workers-AI pair agrees with
 * high confidence) so it can become a gate blocker BEFORE evaluateGateCheck runs. The default `gittensor`
 * pack keeps AI spend confirmed-contributor gated; `oss-anti-slop` may run the blocking review for any
 * author because that pack is explicitly author-agnostic. Returns the advisory notes for the public panel.
 * Fully fail-safe: disabled / ineligible author / no head SHA / non-ok AI / any thrown error → no finding
 * and no notes.
 */
export async function runAiReviewForAdvisory(
  env: Env,
  args: {
    // The caller's already-resolved resolveRepoActionMode() result (#token-bleed-spend-gate): a "paused" repo
    // must NEVER reach the LLM call below, full stop -- not just have its GitHub publish suppressed. Every
    // feature-specific gate below (aiReviewMode, confirmedContributor, ...) is independent of this and was, on
    // its own, insufficient: a fleet-wide freeze or per-repo pause with aiReviewMode still "block"/"advisory"
    // spent real tokens for hours on frozen repos before this field existed. "dry_run" still computes (so a
    // maintainer can validate decision logic locally); only "paused" stops spend.
    mode: AgentActionMode;
    settings: RepositorySettings;
    advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>;
    installationId?: number | null | undefined;
    repoFullName: string;
    pr: {
      number: number;
      title: string;
      body?: string | null | undefined;
      baseSha?: string | null | undefined;
      linkedIssues?: number[] | undefined;
    };
    author: string | null;
    confirmedContributor: boolean;
    // Pre-resolved PR files (the caller's resolvePullRequestFilesForReview output). When provided, the AI
    // review + grounding + RAG use these instead of re-reading the stored rows — so a review that fired before
    // detail-sync still sees the REAL diff (FIX B). Omitted (e.g. unit tests) → fall back to the stored read.
    files?: Awaited<ReturnType<typeof listPullRequestFiles>> | undefined;
    // `.gittensory.yml` review.profile (#review-profile), resolved by the caller from the (already-cached)
    // manifest. Threaded in (not loaded here) so the AI review path makes no extra manifest fetch — absent ⇒
    // null ⇒ balanced ⇒ the reviewer prompt is byte-identical.
    reviewProfile?: ReviewProfile | null | undefined;
    // `.gittensory.yml` review.security_focus (#review-security-focus), resolved by the caller from the
    // (already-cached) manifest. Orthogonal to reviewProfile — composes with it rather than replacing it.
    // Absent/false ⇒ the reviewer prompt is byte-identical.
    reviewSecurityFocus?: boolean | undefined;
    // `.gittensory.yml` review.path_instructions (#review-path-instructions), resolved by the caller from the
    // cached manifest. The CONFIG (not a fetch) is threaded in; the per-PR glob match against `files` happens
    // here (pure), so the AI path makes no extra manifest fetch. Absent/empty ⇒ byte-identical reviewer prompt.
    reviewPathInstructions?: ReviewPathInstruction[] | undefined;
    // `.gittensory.yml` review.instructions (#review-instructions): a repo-level maintainer brief, resolved by the
    // caller from the cached manifest, handed to the reviewer on EVERY review (bounded + public-safe at parse time).
    // Absent/null ⇒ byte-identical reviewer prompt.
    reviewInstructions?: string | null | undefined;
    // `.gittensory.yml` review.exclude_paths (#review-exclude-paths), resolved by the caller from the cached
    // manifest. Globs whose files are dropped from the AI review (diff + grounding + RAG) — generated/lockfiles
    // the maintainer doesn't want reviewed. Empty ⇒ every file is reviewed (byte-identical). The gate is unaffected.
    reviewExcludePaths?: string[] | undefined;
    // `.gittensory.yml` review.path_filters (#2043): include + `!`-negation globs applied AFTER exclude_paths to
    // positively scope the AI review. Empty ⇒ every non-excluded file is reviewed (byte-identical). Gate unaffected.
    reviewPathFilters?: string[] | undefined;
    // `.gittensory.yml` review.inline_comments (#inline-comments), resolved by the caller from the cached manifest
    // (the per-repo toggle). Precedence (#4099): the operator flag is a master kill-switch, never bypassable by
    // config; an explicit true/false here now fully controls the feature, bypassing the cutover allowlist; unset
    // stays byte-identical to every repo's behavior before this change (the allowlist alone was never sufficient
    // on its own). Absent ⇒ the reviewer prompt is byte-identical (no findings) for every repo untouched by this.
    reviewInlineComments?: boolean | undefined;
    // `.gittensory.yml` review.finding_categories (#1958), resolved by the caller from the cached manifest. ANDed
    // here with reviewInlineComments (a category has nothing to categorize without an inline finding) to decide
    // whether to ASK the model to self-categorize each inlineFindings item. Absent/false ⇒ byte-identical prompt.
    reviewFindingCategories?: boolean | undefined;
    // `.gittensory.yml` review.ai_model (#selfhost-ai-model-override), resolved by the caller from the cached
    // manifest. Self-host only — overrides that repo's claude-code/codex model+effort, taking priority over the
    // operator's global env vars. Absent/all-null ⇒ byte-identical (global env var, then provider default).
    reviewSelfHostAiModel?: SelfHostAiModelConfig | undefined;
    // `.gittensory.yml` review.impact_map (#2184/#2186), resolved by the caller from the cached manifest. ANDed
    // here with the operator's GITTENSORY_REVIEW_IMPACT_MAP flag (shouldComputeImpactMap) to decide whether to
    // compute the deterministic impact map and splice it into the reviewer prompt as additive reference
    // context. Absent/false ⇒ byte-identical reviewer prompt (no impact-map computation, no RAG query for it).
    reviewImpactMap?: boolean | undefined;
    // `.gittensory.yml` review.culture_profile (#2995), resolved by the caller from the cached manifest. ANDed
    // here with the GITTENSORY_REVIEW_CULTURE_PROFILE global flag to decide whether to append the repo's
    // quality-culture reference block (typical merged-PR size + common labels) to the reviewer prompt. Absent/
    // false ⇒ byte-identical (no section, no extra D1 read).
    reviewCultureProfile?: boolean | undefined;
    // `.gittensory.yml` `features.improvementSignal` (#4744, first real caller of #4738's activation wiring),
    // resolved by the caller via `convergedFeatureActive`/`resolveConvergedFeature` -- NOT resolved internally
    // here (unlike reputation/rag/grounding above), mirroring reviewProfile/reviewImpactMap/reviewCultureProfile
    // above, which are ALL caller-resolved rather than looked up internally (see `ModelReview.valueAssessment`'s
    // own doc comment in services/ai-review.ts for why `improvementSignal` -- a read-only advisory signal, not a
    // security control -- follows that majority pattern rather than `safety`'s internal-resolution exception).
    // Threaded straight into runGittensoryAiReview's own `improvementSignal` gate (#4743) for the LLM tier's
    // value-assessment prompt addition. Absent/false ⇒ the prompt is byte-identical (no valueAssessment
    // requested) -- the only reachable value until this PR started resolving the feature.
    improvementSignal?: boolean | undefined;
    // The inbound webhook delivery id that triggered this review (#codex-timeout-fields) — forwarded to a
    // self-host provider's failure log purely for operator correlation; never read by any review logic. Absent
    // (e.g. a sweep/repair fan-out with no single originating delivery, or a unit test) ⇒ the log line omits it.
    deliveryId?: string | undefined;
    // A {@link claimAiReviewLock} claim the CALLER already acquired (#regate-dup-prep) before its own cache-read
    // decision, so the (repo, PR, head, mode) mutex covers that cache-read too — not just this function's
    // expensive section. When supplied and `.acquired`, this function trusts it, skips its OWN claim below
    // entirely, and — critically — does NOT release it in its `finally` (release stays the claiming caller's job,
    // so the lock keeps covering the caller's own post-return cache WRITE too; releasing here the instant this
    // function returns would reopen a narrower version of the exact race this lock exists to close). Absent (the
    // default, and every existing caller) ⇒ this function claims + releases its own lock exactly as before —
    // byte-identical to today.
    preAcquiredAiReviewLock?: TransientLockClaim | undefined;
    // #4507: the caller's own already-computed shouldSkipAiForReputation result, threaded in exactly like
    // preAcquiredAiReviewLock above, so this function's OWN reputationActive gate (below) reuses it instead of
    // re-deriving a second REPUTATION_WINDOW_ROW_CAP-bounded review_targets scan -- but ONLY when it's actually
    // present. Absent (the caller's own plain-allowlist gate condition didn't apply, or a direct/test caller
    // that doesn't thread it) ⇒ this function computes its own, independently authoritative check exactly as
    // before -- correctly handling a per-repo manifest override that disagrees with the allowlist (the
    // divergent-config case where only one of the two call sites' gates evaluates true in practice, so the
    // other's threaded value is never populated to begin with).
    preComputedReputationSkip?: boolean | undefined;
  },
): Promise<
  | {
      notes: string;
      reviewerCount: number;
      inlineFindings: InlineFinding[];
      // Deterministic impact-map entries this pass computed for the AI prompt (#1971), threaded out so the
      // publish site can ALSO render them as the unified comment's "Impact map" collapsible. Empty when the
      // feature is off (flag/manifest) — the render arm keys on `.length`, so off ⇒ no section.
      impactMap?: ImpactMapEntry[] | undefined;
      findings: AdvisoryFinding[];
      metadata?: Record<string, unknown> | undefined;
      cacheable?: boolean | undefined;
      // #regate-churn: distinct from `cacheable` — false ONLY for the lock-contention placeholder below (another
      // pass is concurrently reviewing this exact head RIGHT NOW). That placeholder describes a transient
      // scheduling race, not a real AI opinion, and the concurrent pass it deferred to will itself persist the
      // real result within seconds — so it must never be written at all (not even non-durably), or a later read
      // within the bounded cooldown could replay "another pass is running" long after that pass finished.
      // Defaults to true (persistable) for every other outcome, cacheable or not.
      persistable?: boolean | undefined;
      // The LLM tier's composed improvement/value judgment (#4743/#4744) -- present ONLY on a FRESH review
      // (cache miss) with `improvementSignal` requested and at least one reviewer emitting a usable, public-safe
      // judgment. Absent on a cache hit: exactly like `inlineFindings`/`impactMap` above, `ai_review_cache`
      // never persists this field (getCachedAiReview/putCachedAiReview, db/repositories.ts, have no column for
      // it), so a re-served cached review has no LLM-tier judgment to show on that particular render. The
      // deterministic tier is unaffected -- it is computed fresh every pass, never cached.
      valueAssessment?: { magnitude: ImprovementMagnitude; rationale: string } | undefined;
    }
  | undefined
> {
  const packAllowsAnyAuthorBlockingReview =
    args.settings.gatePack === "oss-anti-slop" &&
    args.settings.aiReviewMode === "block";
  // `aiReviewAllAuthors` (per-repo opt-in, default false) widens the AI-spend gate to EVERY author — a self-host
  // operator who wants real reviews on all PRs (incl. their own / unconfirmed contributors) and pays for the AI
  // themselves. Default false ⇒ the confirmed-contributor gate is byte-identical to today.
  const reviewableAuthor =
    args.confirmedContributor ||
    packAllowsAnyAuthorBlockingReview ||
    args.settings.aiReviewAllAuthors;
  if (
    args.mode === "paused" ||
    args.settings.aiReviewMode === "off" ||
    !reviewableAuthor ||
    !args.advisory.headSha
  )
    return undefined;
  // Per-repo cutover gate (GITTENSORY_REVIEW_REPOS): the converged review features (reputation AI-skip,
  // grounding, RAG) activate for THIS repo only when it is allowlisted. Computed once and ANDed into each
  // feature's global flag below. Empty/unset allowlist → false → every converged branch here is unreachable
  // (byte-identical to today) regardless of the global flags.
  const convergedRepoAllowed = isConvergenceRepoAllowed(env, args.repoFullName);
  // Per-repo feature overrides (phase 2): reputation + RAG + grounding (#4100) honor the container-private
  // `.gittensory.yml` `features:` block, falling back to the `convergedRepoAllowed` allowlist when unset
  // (byte-identical default). The (cached) manifest is loaded once and shared, and ONLY when at least one of the
  // three features is globally enabled — so a deploy with all three flags off does no extra read (preserves the
  // no-op default).
  const featureManifest =
    isReputationEnabled(env) || isRagEnabled(env) || isGroundingEnabled(env)
      ? await loadRepoFocusManifest(env, args.repoFullName).catch(() => null)
      : null;
  const reputationActive = resolveConvergedFeature(
    env,
    featureManifest,
    "reputation",
    args.repoFullName,
  );
  const ragActive = resolveConvergedFeature(
    env,
    featureManifest,
    "rag",
    args.repoFullName,
  );
  const groundingActive = resolveConvergedFeature(
    env,
    featureManifest,
    "grounding",
    args.repoFullName,
  );
  // Reputation anti-abuse (convergence, flag-gated by GITTENSORY_REVIEW_REPUTATION). Extends the AI-spend gate above:
  // an INTERNAL low-reputation / burst / new submitter is downgraded to a DETERMINISTIC-ONLY review — the
  // (paid) AI neurons are skipped here exactly as they are for an unconfirmed contributor, so a serial abuser
  // can't make the project spend AI on a flood of low-quality PRs. STRICTLY INTERNAL: the reputation is never
  // surfaced — this only routes the private AI-spend decision. Flag-OFF (default) is an immediate no-op (no DB
  // read, no new branch) → the AI-spend gate is byte-identical to today. Fail-safe (the read degrades to
  // neutral → false on any error).
  if (
    reputationActive &&
    !args.settings.aiReviewAllAuthors &&
    (args.preComputedReputationSkip ??
      (await shouldSkipAiForReputation(env, {
        project: args.repoFullName,
        submitter: args.author,
      })))
  )
    return undefined;
  // Per-(repo, PR, head SHA, mode) advisory lock (#confirmed-bug, mirrors #2129/#2368's claimPrActuationLock):
  // a webhook pass and an agent-regate-pr sweep pass can independently reach this point for the SAME PR at the
  // SAME head, both miss the cache (neither has written yet), and both fire a real, wasteful LLM call that can
  // return different verdicts. Claim before the expensive section below; a pass that loses the race returns the
  // same inconclusive-hold shape the "AI produced no usable verdict" path already returns, so the gate is held
  // (neutral) for a human rather than either pass's independently-decided verdict racing the other's cache write.
  // #regate-dup-prep: prefer the caller's OWN claim (args.preAcquiredAiReviewLock) when it already did one — the
  // caller wraps its own cache-read decision in the SAME lock key, so claiming again here would be this function
  // contending against its own caller's claim (always losing) rather than against a genuinely different pass.
  // Absent (every existing/direct caller) ⇒ claim it here exactly as before.
  const selfClaimedAiReviewLock = args.preAcquiredAiReviewLock === undefined;
  const aiReviewLock =
    args.preAcquiredAiReviewLock ??
    (await claimAiReviewLock(
      env,
      args.repoFullName,
      args.pr.number,
      args.advisory.headSha,
      args.settings.aiReviewMode,
    ));
  if (!aiReviewLock.acquired) return aiReviewLockContendedResult(args.advisory);
  try {
    // BYOK: decrypt the maintainer's provider key only for confirmed contributors when opted in. Falls back to free Workers AI when
    // no key is configured or the encryption secret is unavailable (getDecryptedRepositoryAiKey → null).
    // Apply config-as-code provider/model: a declared provider must match the stored key's provider (else
    // skip BYOK → Workers-AI fallback); a declared model overrides the stored/default model.
    const storedKey =
      args.confirmedContributor && args.settings.aiReviewByok
        ? await getDecryptedRepositoryAiKey(env, args.repoFullName)
        : null;
    const providerKey =
      storedKey &&
      (!args.settings.aiReviewProvider ||
        args.settings.aiReviewProvider === storedKey.provider)
        ? {
            provider: storedKey.provider,
            key: storedKey.key,
            model: args.settings.aiReviewModel ?? storedKey.model,
          }
        : null;
    // FIX B: prefer the caller's pre-resolved files (real diff even on a pre-sync first review); fall back to
    // the stored read when the caller didn't pass them (e.g. unit tests calling this function directly).
    // review.exclude_paths + review.path_filters (#review-exclude-paths / #2043): advisory-mode prose can skip
    // generated/lockfiles and positively scope review targets, but block mode is gate-relevant and must review the
    // full diff so filtered paths cannot bypass AI consensus blockers.
    const allFiles =
      args.files ??
      (await listPullRequestFiles(env, args.repoFullName, args.pr.number));
    const files =
      args.settings.aiReviewMode === "block"
        ? allFiles
        : filterReviewFilesForAi(allFiles, args.reviewExcludePaths ?? [], args.reviewPathFilters ?? []);
    // Grounding (convergence, flag-gated by GITTENSORY_REVIEW_GROUNDING; per-repo `features.grounding` override,
    // #4100). Build the FINISHED CI status + the full content of the changed files so the reviewer verifies its
    // claims against reality instead of guessing. Flag-OFF (default) → we take no new branch at all: NO
    // check/repo load, NO file fetch, and `grounding` is left undefined so the prompt handed to the model is
    // byte-identical to today. Fully fail-safe.
    const grounding =
      groundingActive
        ? await buildReviewGroundingText(env, {
            repoFullName: args.repoFullName,
            headSha: args.advisory.headSha,
            files,
            checks: await listCheckSummaries(
              env,
              args.repoFullName,
              args.pr.number,
            ),
            installationId:
              (await getRepository(env, args.repoFullName))?.installationId ??
              null,
          })
        : undefined;
    // RAG retrieval (convergence, flag-gated by GITTENSORY_REVIEW_RAG). Query the codebase vector index for code/docs
    // semantically related to the changed files and append them as additive reference context — exactly like
    // grounding. Flag-OFF (default) → NO new branch: no adapter use, no vector query, and `ragContext` is left
    // undefined so the prompt is byte-identical to today. Fully fail-safe (a missing/cold index degrades to "").
    const ragContextResult = ragActive
      ? await buildReviewRagContextWithMetrics(env, {
          repoFullName: args.repoFullName,
          title: args.pr.title,
          files: files.map((file) => ({
            path: file.path,
            patch:
              typeof file.payload?.patch === "string"
                ? file.payload.patch
                : undefined,
          })),
        })
      : undefined;
    const ragTelemetry =
      ragContextResult?.telemetry ?? emptyReviewRagTelemetry(false);
    // Deterministic impact map (#2184/#2186), ANDed operator env flag + per-repo review.impact_map opt-in
    // (shouldComputeImpactMap). Reuses the SAME changed files this pass already resolved — no extra fetch.
    // Flag-OFF (default) → NO new branch: no symbol extraction, no RAG query, and `impactMapContext` is left
    // undefined so the prompt is byte-identical to today. Fully fail-safe (computeImpactMap never throws; a
    // missing/cold RAG index degrades to an empty impact map, which formats to "" and appends nothing).
    let impactMapContext: string | undefined;
    // The computed entries are ALSO threaded out of this function (#1971) so the publish site can render the
    // "Impact map" collapsible from the exact same array — no second RAG query. Empty when the feature is off.
    let impactMapEntries: ImpactMapEntry[] = [];
    if (shouldComputeImpactMap(env, args.reviewImpactMap === true)) {
      const [impactMapProject, impactMapRepo] = splitRepoForRag(args.repoFullName);
      const changedSymbols = extractChangedSymbols(
        files.map((file) => ({
          path: file.path,
          patch: typeof file.payload?.patch === "string" ? file.payload.patch : undefined,
        })),
      );
      impactMapEntries = await computeImpactMap(env, changedSymbols, {
        infra: createReviewAdapters(env),
        project: impactMapProject,
        repo: impactMapRepo,
      });
      impactMapContext = formatImpactMapPromptSection(impactMapEntries);
    }
    // Repo quality-culture profile (#2995, flag-gated by GITTENSORY_REVIEW_CULTURE_PROFILE AND the per-repo
    // `review.culture_profile` opt-in). Derives a compact reference block from the repo's OWN merge history
    // (typical PR size, common accepted labels) and appends it as additive grounding — exactly like RAG. Both
    // gates OFF (default) → NO new branch: no D1 read, and `cultureProfileContext` is left undefined so the
    // prompt is byte-identical to today. Fully fail-safe (any error/insufficient-history degrades to "").
    const cultureProfileContext = shouldApplyRepoCultureProfile(env, args.reviewCultureProfile === true)
      ? await buildRepoCultureProfileContext(env, args.repoFullName)
      : undefined;
    // Review-enrichment (#1472, flag-gated by GITTENSORY_REVIEW_ENRICHMENT + REES_URL). POST the PR to the external
    // REES for the heavy/external analysis the reviewer can't run (dependency CVEs, secrets, license/EOL/supply-chain);
    // its public-safe brief splices into the prompt next to grounding + RAG. Flag-OFF (default) → no call, no branch,
    // byte-identical prompt. Fully fail-safe (any timeout/error/empty → undefined → review proceeds).
    const enrichmentDiff = buildAiReviewDiff(files);
    const enrichment =
      isEnrichmentEnabled(env) && convergedRepoAllowed
        ? await buildReviewEnrichment(env, {
            repoFullName: args.repoFullName,
            prNumber: args.pr.number,
            headSha: args.advisory.headSha,
            baseSha: args.pr.baseSha ?? null,
            title: args.pr.title,
            body: args.pr.body ?? undefined,
            author: args.author,
            linkedIssue: await resolveEnrichmentLinkedIssue(
              env,
              args.repoFullName,
              resolveEnrichmentLinkedIssueNumbers(
                args.pr.linkedIssues,
                args.pr.body,
                args.repoFullName,
              ),
            ),
            githubToken: isReesGithubTokenForwardingEnabled(env)
              ? await resolveReviewEnrichmentGithubToken(
                  env,
                  args.repoFullName,
                )
              : undefined,
            // The AI-review path loads the focus manifest later (inside runGittensoryAiReview), not before this
            // enrichment call, so there is no already-resolved manifest to pass here; loadRepoFocusManifest is
            // cached per repo, so this is a cache hit rather than an extra fetch. resolveRepoEnrichmentToggles is
            // exactly the load-and-swallow caller (a load error ⇒ no toggles ⇒ default analyzer set).
            enrichmentAnalyzers: await resolveRepoEnrichmentToggles(() =>
              loadRepoFocusManifest(env, args.repoFullName),
            ),
            files,
            diff: enrichmentDiff,
          })
        : undefined;
    // Resolved once and reused for BOTH inlineFindings itself and the finding-categories opt-in layered on top
    // of it (#1958) — a category has nothing to categorize without an inline finding to attach it to.
    const inlineFindingsRequested = shouldRequestInlineFindings(
      env,
      args.repoFullName,
      args.reviewInlineComments,
    );
    const result = await runGittensoryAiReview(env, {
      repoFullName: args.repoFullName,
      prNumber: args.pr.number,
      title: args.pr.title,
      body: args.pr.body ?? undefined,
      diff: enrichmentDiff,
      actor: args.author,
      mode: args.settings.aiReviewMode === "block" ? "block" : "advisory",
      jobId: args.deliveryId,
      providerKey,
      grounding,
      ragContext: ragContextResult?.text,
      cultureProfileContext,
      observability: { rag: ragTelemetry },
      impactMapContext,
      enrichment,
      profile: args.reviewProfile ?? null,
      // Per-repo dual-AI combine/onMerge/reviewers overrides (#2567), resolved by resolveEffectiveSettings from
      // `.gittensory.yml gate.aiReview.*` onto `args.settings`. Absent ⇒ undefined ⇒ runGittensoryAiReview falls
      // back to the operator's AI_REVIEW_PLAN (byte-identical to today). `onMerge` is clamped to the operator's
      // floor INSIDE runGittensoryAiReview (resolveEffectiveAiReviewOnMerge), not here.
      combine: args.settings.aiReviewCombine ?? undefined,
      onMerge: args.settings.aiReviewOnMerge ?? undefined,
      reviewers: args.settings.aiReviewReviewers ?? undefined,
      securityFocus: args.reviewSecurityFocus === true,
      // Self-host per-repo model/effort override (#selfhost-ai-model-override): absent/null fields fall through
      // runGittensoryAiReview -> runWorkersOpinion -> the self-host provider's own global-env/hardcoded default,
      // exactly as if review.ai_model had never been set.
      claudeModel: args.reviewSelfHostAiModel?.claudeModel ?? null,
      claudeEffort: args.reviewSelfHostAiModel?.claudeEffort ?? null,
      codexModel: args.reviewSelfHostAiModel?.codexModel ?? null,
      codexEffort: args.reviewSelfHostAiModel?.codexEffort ?? null,
      ollamaModel: args.reviewSelfHostAiModel?.ollamaModel ?? null,
      openaiModel: args.reviewSelfHostAiModel?.openaiModel ?? null,
      openaiCompatibleModel: args.reviewSelfHostAiModel?.openaiCompatibleModel ?? null,
      anthropicModel: args.reviewSelfHostAiModel?.anthropicModel ?? null,
      // Inline comments (#inline-comments): ask the model for line-anchored findings only when the operator flag,
      // the cutover allowlist, AND the per-repo manifest toggle all pass. Otherwise the prompt is byte-identical.
      inlineFindings: inlineFindingsRequested,
      // review.finding_categories (#1958): ask the model to ALSO self-categorize each inlineFindings item, only
      // when inline findings themselves are being requested (a category has nothing to categorize otherwise).
      findingCategories: shouldRenderFindingCategories(inlineFindingsRequested, args.reviewFindingCategories),
      pathGuidance: resolveReviewPathInstructions(
        args.reviewPathInstructions ?? [],
        files.map((file) => file.path),
      ),
      repoInstructions: args.reviewInstructions ?? null,
      changedFiles: files,
      // improvementSignal (#4744): ask the model for the ordinal value/improvement judgment (#4743) only when
      // the caller resolved the feature on for this repo. Absent/false ⇒ byte-identical prompt.
      improvementSignal: args.improvementSignal === true,
    });
    if (result.status !== "ok") return undefined;
    const findings: AdvisoryFinding[] = [];
    if (result.consensusDefect) {
      findings.push({
        code: "ai_consensus_defect",
        severity: "critical",
        title: `AI reviewers agree on a likely critical defect: ${result.consensusDefect.title}`,
        detail: result.consensusDefect.detail,
        action:
          "Resolve the flagged defect, or override if the AI reviewers are mistaken, then re-run the gate.",
        // Calibrated confidence (#8). This finding ALWAYS blocks under aiReviewGateMode: block regardless of
        // where it falls relative to aiReviewCloseConfidence (isConfiguredGateBlocker never refutes a blocker
        // on confidence alone) -- what varies below the floor is the DISPOSITION (#4603,
        // aiReviewLowConfidenceDisposition): hold_for_review (default) routes the would-be close to manual
        // review instead of one-shot-closing; advisory_only drops it to non-blocking; one_shot ignores the
        // floor. See resolveAiReviewLowConfidenceHold in src/rules/advisory.ts.
        confidence: result.consensusDefect.confidence,
      });
    } else if (result.split) {
      // The reviewers DISAGREED — exactly one flagged a blocking defect. reviewbot's quorum treats any reviewer
      // rejection as a configured AI defect; advisory.ts gates `ai_review_split` like a consensus defect, with
      // the same confidence floor deciding block vs human-review hold. (#ai-review-split)
      findings.push({
        code: "ai_review_split",
        severity: "critical",
        title: "An AI reviewer flagged a likely blocking defect",
        detail:
          "One AI reviewer independently flagged a concrete must-fix defect in this change (the other did not). Under the quorum rule, a single rejection closes the PR; see the review notes for specifics.",
        action:
          "Resolve the flagged defect and open a new pull request, or override if the reviewers are mistaken.",
        // Calibrated confidence (#8) of the lone flagging reviewer. Like the consensus-defect finding above, this
        // ALWAYS blocks under aiReviewGateMode: block regardless of the aiReviewCloseConfidence floor -- the
        // floor only selects the DISPOSITION of a sub-floor finding (#4603, aiReviewLowConfidenceDisposition):
        // hold_for_review (default) holds instead of one-shot-closing; advisory_only drops it to non-blocking;
        // one_shot ignores the floor. A consensus split ALWAYS carries this (combineReviews sets it whenever
        // split is true), so the spread is effectively unconditional; the guard is a defensive belt-and-braces —
        // an absent value degrades to 1.0 in the threshold check (advisory.ts `?? 1`), matching an at-or-above-floor
        // confidence.
        /* v8 ignore next 3 -- a split always carries splitConfidence; the absent arm is an unreachable guard. */
        ...(result.splitConfidence !== undefined
          ? { confidence: result.splitConfidence }
          : {}),
      });
    } else if (result.inconclusive) {
      // Fail-CLOSED (#ai-fail-closed): block-mode AI could not return a usable verdict. Hold the PR for a human
      // (an evaluation-blocker code → neutral gate) rather than letting it pass to auto-merge uncertified.
      findings.push({
        code: "ai_review_inconclusive",
        severity: "warning",
        title: "AI review could not be completed",
        detail:
          "The dual-model AI review did not return a usable verdict for this change.",
        action:
          "The gate is held for a human reviewer rather than passed automatically; it re-evaluates on the next update.",
      });
      // A review that could not be produced is a real failure the maintainer must SEE — surface it to Sentry as an
      // ERROR (this also covers the INCOHERENT_DIFF bail, which parses to a missing opinion → inconclusive). (#1468)
      captureReviewFailure(new Error("AI review inconclusive — no usable verdict for the PR head"), {
        kind: "review",
        reason: "ai_review_inconclusive",
        installationId: args.installationId,
        owner: args.repoFullName.split("/")[0],
        repo: args.repoFullName,
        pr: args.pr.number,
        head_sha: args.advisory.headSha,
        ai_review_mode: args.settings.aiReviewMode,
        reviewer_count: result.reviewerCount,
        public_notes: hasPublicReviewAssessment(result.advisoryNotes),
        /* v8 ignore next -- current review runner always supplies diagnostics for completed AI attempts. */
        review_diagnostics: result.reviewDiagnostics ?? [],
      }, "ai_review_inconclusive");
    }
    args.advisory.findings.push(...findings);
    const metadataFor = (
      notes: string | null | undefined,
      inlineFindings: InlineFinding[],
    ): Record<string, unknown> => ({
      rag: attributeReviewRagTelemetry(ragTelemetry, {
        notes,
        findings,
        inlineFindings,
      }),
    });
    if (result.inconclusive && hasPublicReviewAssessment(result.advisoryNotes)) {
      return {
        notes: result.advisoryNotes!,
        reviewerCount: result.reviewerCount,
        inlineFindings: [],
        findings,
        metadata: metadataFor(result.advisoryNotes, []),
        cacheable: false,
        valueAssessment: result.valueAssessment ?? undefined,
      };
    }
    if (hasPublicReviewAssessment(result.advisoryNotes)) {
      return {
        notes: result.advisoryNotes!,
        reviewerCount: result.reviewerCount,
        inlineFindings: result.inlineFindings,
        impactMap: impactMapEntries,
        findings,
        metadata: metadataFor(result.advisoryNotes, result.inlineFindings),
        valueAssessment: result.valueAssessment ?? undefined,
      };
    }
    if (result.inconclusive) {
      return {
        notes:
          "AI review could not be completed for this PR head. Gittensory is holding this PR for manual review instead of relying on deterministic signals alone.",
        reviewerCount: result.reviewerCount,
        inlineFindings: [],
        findings,
        metadata: metadataFor(null, []),
        cacheable: false,
      };
    }
    const unavailableFinding: AdvisoryFinding = {
      code: "ai_review_inconclusive",
      severity: "warning",
      title: "AI review did not produce public notes",
      detail:
        "The configured AI reviewer returned no usable public assessment for this PR head.",
      action:
        "Fix the configured AI provider, then re-run LoopOver review before relying on the result.",
    };
    findings.push(unavailableFinding);
    args.advisory.findings.push(unavailableFinding);
    captureReviewFailure(
      new Error("AI review did not produce public notes for the PR head"),
      {
        kind: "review",
        reason: "ai_review_public_summary_missing",
        installationId: args.installationId,
        owner: args.repoFullName.split("/")[0],
        repo: args.repoFullName,
        pr: args.pr.number,
        head_sha: args.advisory.headSha,
        ai_review_mode: args.settings.aiReviewMode,
        reviewer_count: result.reviewerCount,
        /* v8 ignore next -- current review runner always supplies diagnostics for completed AI attempts. */
        review_diagnostics: result.reviewDiagnostics ?? [],
        configured_reviewers:
          env.AI_REVIEW_PLAN?.reviewers?.map((reviewer) => reviewer.model) ??
          null,
        combine: env.AI_REVIEW_PLAN?.combine ?? null,
      },
      "ai_review_public_summary_missing",
    );
    return {
      notes:
        "AI review is unavailable for this PR head. Gittensory is holding this PR for manual review until the configured AI provider returns a usable public review summary.",
      reviewerCount: result.reviewerCount,
      inlineFindings: [],
      findings,
      metadata: metadataFor(null, []),
      cacheable: false,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "ai_review_failed",
        repository: args.repoFullName,
        pullNumber: args.pr.number,
        error: errorMessage(error),
      }),
    );
    // error is a genuinely caught exception here (unlike the two captures above, which construct their own
    // Error to report a known condition) -- named to mirror the structured log's own "event" field just above,
    // not the exception's native class, so every unexpected review crash groups under one readable title.
    captureReviewFailure(error, {
      kind: "review",
      installationId: args.installationId,
      repo: args.repoFullName,
      pr: args.pr.number,
      head_sha: args.advisory.headSha,
    }, "ai_review_failed");
    return undefined;
  } finally {
    // #regate-dup-prep: only release a lock THIS call actually claimed. A caller-supplied
    // preAcquiredAiReviewLock must keep covering the caller's own post-return work (e.g. persisting the fresh
    // review to cache) — releasing it here the instant this function returns would free the lock before that
    // write happens, reopening a narrower version of the exact race this lock exists to close.
    if (selfClaimedAiReviewLock)
      await releaseAiReviewLock(
        env,
        args.repoFullName,
        args.pr.number,
        args.advisory.headSha,
        args.settings.aiReviewMode,
        aiReviewLock.ownerToken,
      );
  }
}
