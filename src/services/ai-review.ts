// Gittensory AI maintainer review (the `aiReview` capability).
//
// Two layers, both opt-in and both fail-safe (no AI / errors / over-budget / unsafe output → no public
// text and no gate finding; gittensory NEVER blocks because the model spoke):
//
//   • Advisory notes — a concise maintainer-style write-up (assessment + suggestions + risks). When the
//     repo has BYOK configured, the maintainer's own frontier model (Anthropic/OpenAI) writes it;
//     otherwise the configured free/default reviewer does (self-host: the AI_PROVIDER chain — Codex
//     primary, Claude Code fallback, etc; unconfigured/hosted: the legacy Workers-AI pair below).
//     Advisory only — never blocks.
//   • Consensus defect — a conservative gate signal. The configured reviewer PAIR each independently
//     reviews the diff; a defect is reported ONLY when BOTH models flag a high-confidence critical defect
//     (bug / security / data-loss / build break). BYOK never changes this path, so it never changes who
//     can be blocked. The resulting finding is honored by the gate only in `block` mode AND only for
//     confirmed Gittensor contributors (the gate enforces that downstream).
//
// Every public string (notes + defect title/detail) is forced through `sanitizePublicComment`; anything
// that trips the public/private boundary is dropped, not published. Free/default-reviewer calls are metered
// against the shared daily neuron budget; maintainer-paid BYOK calls have a separate repo/day cap. All calls
// are audited via `recordAiUsageEvent` (with real provider/token/cost usage when the configured provider
// reports it, per migration 0109 — see `coerceAiUsage`/`aggregateActualUsage`).
import {
  countByokAiEventsForRepoSince,
  recordAiUsageEvent,
  sumAiEstimatedNeuronsSince,
} from "../db/repositories";
import { sanitizePublicComment } from "../queue-intelligence";
import { defangReviewInput } from "../review/safety";
import { convergedFeatureActive } from "../review/feature-activation";
import { labelSelfHostReviewerModels, labelSelfHostReviewerNames, resolveConfiguredProviderNames } from "../selfhost/ai-config";
import { incr } from "../selfhost/metrics";
import { errorMessage } from "../utils/json";
import type { ReviewProfile } from "../signals/focus-manifest";
import { isCodeFile } from "../signals/local-branch";
import { isTestPath } from "../signals/test-evidence";
import { type FindingCategory } from "../review/finding-category-classify";
import { parseInlineFindingCategory } from "../review/inline-finding-category-parse";
import type { AiContentBlock, CombineStrategy, OnMerge } from "../types";

/**
 * The legacy free Workers-AI model pair — used ONLY when neither a self-host `AI_REVIEW_PLAN` reviewer
 * pair nor any configured provider (`AI_PROVIDER`) is present (see `reviewerModelLabel`). No `ai` binding
 * exists in the deployed Worker today (Workers AI is fully retired — see CONVERGENCE_RUNBOOK.md), so this
 * pair is inert in every current deployment; it stays only as the last-resort default these model ids
 * were originally probe-verified against (both families independently clean-JSON in reviewbot).
 */
export const BEST_REVIEW_MODELS: readonly [string, string] = [
  "@cf/openai/gpt-oss-120b",
  "@cf/nvidia/nemotron-3-120b-a12b",
];

/** Reliable per-slot fallbacks for the legacy pair above (non-reasoning, clean JSON) so a slot never comes back empty. */
export const RELIABLE_FALLBACK_MODELS: readonly [string, string] = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
];

export const INCOHERENT_DIFF_ASSESSMENT =
  "Cannot review — the diff appears out of sync with the PR head.";

const REVIEW_SYSTEM_PROMPT = [
  "You are a senior open-source maintainer giving a FOCUSED, high-signal code review of a single pull request diff.",
  "Read each meaningful hunk and review like a careful human; judge ONLY the diff and the context provided.",
  "Respond with ONLY a JSON object of this exact shape (no prose, no code fence):",
  '{"assessment": string, "blockers": string[], "nits": string[], "suggestions": string[], "confidence": number}',
  "- assessment: a substantive but CONCISE summary (2-4 sentences) — what the change does, whether it is correct, and the most notable detail. Specific to THIS diff; never a generic one-liner and never hedging ('appears to', 'seems to').",
  "The assessment field is REQUIRED and must never be empty; if blockers is [] then the assessment still summarizes why the visible diff is safe enough to proceed.",
  "- blockers: each ONE sentence naming a defect that WILL break the code as written — a missing import/symbol (ReferenceError), a logic error that produces wrong output, a security hole, data loss, a build/test breakage, an API/contract break, or a genuine algorithmic-complexity/performance regression introduced by the diff (e.g. a DB query or network call moved inside a loop creating an N+1 pattern, an unbounded loop/fanout over input whose size is not capped). Reference the file (and function/line). Empty [] if there are genuinely none.",
  "- confidence: a single number in [0,1] — your CALIBRATED probability that the blockers above are REAL, must-fix defects (not false positives). Use 1.0 only when you are certain the diff itself breaks; use 0.5 for a genuine coin-flip; lower it when you cannot fully see the breaking code or the defect is speculative. When blockers is empty, set confidence to 1.0.",
  "- nits: each ONE sentence — a NON-blocking point: style, naming, a missing doc, or DEFENSIVE hardening ('should handle the empty case', 'consider catching errors', 'add validation'). File-reference where you can.",
  "- suggestions: a few concrete, file-referenced improvements (may overlap nits).",
  "BE SELECTIVE — report only the findings that genuinely matter. List at MOST ~3 blockers and ~5 nits, keeping only the most important; prefer signal over volume and do NOT pad the lists.",
  "DEDUPLICATE — if the same kind of issue recurs across several functions or lines, report it ONCE and note it applies broadly; never repeat a near-identical finding per occurrence.",
  "SEVERITY DISCIPLINE — defensive or speculative hardening ('should handle X', 'consider validating', 'add error handling') is a NIT, not a blocker, UNLESS a real input WILL actually trigger the failure. CI or check status itself (failing, pending, unverified) is NOT a code defect — never list it (the gate evaluates CI separately).",
  "PERFORMANCE SEVERITY — a performance concern is a blocker ONLY when the diff introduces a genuine, visible regression with a concrete trigger (a DB query or network call moved inside a loop, a loop/fanout over input whose size the diff removed a bound on). A stylistic or micro-optimization preference ('could use a Map instead of an array', 'this could be slightly faster') is a NIT, not a blocker, even if real.",
  "DIFF SCOPE — the diff shows only CHANGED lines, NOT whole files. A function, variable, import, type, or symbol you do not SEE may already be defined or imported elsewhere in the same file/module. NEVER report a 'missing import', 'undefined/not-imported symbol', or 'X is not defined -> ReferenceError' as a blocker unless the diff ITSELF removes the definition or introduces the symbol without defining it anywhere shown. When you cannot confirm a symbol is missing from the visible diff, it is NOT a blocker — at most a nit ('verify X is imported/defined').",
  "TRACE BEFORE ASSERTING ABSENCE — this rule extends to ANY 'X is missing' blocker (a missing schema/annotation/field, a missing null/array/type guard, a missing await/error-handler, an unregistered route/tool/handler): a backfill loop, a default, an early guard, or a registration ELSEWHERE may already supply it. Before calling absence a blocker, find the line in the visible context that WOULD break and reference it; if you cannot SEE the breaking code, downgrade to a nit phrased as a verification ('confirm X is registered/guarded'), never a blocker.",
  `FAIL CLOSED ON AN INCOHERENT DIFF — if the diff does not cohere with the PR title/description (it appears to describe a DIFFERENT change, the changed-file set looks stale or wrong, or you cannot map it to one coherent change), DO NOT emit a confident assessment or approval: set assessment to exactly '${INCOHERENT_DIFF_ASSESSMENT}' and return empty blockers, nits, and suggestions. Never rubber-stamp a change you cannot actually see.`,
  "Do NOT rubber-stamp: if the diff is genuinely clean, the assessment states specifically why and blockers is [].",
  "Never mention rewards, rankings, payouts, wallets, hotkeys, coldkeys, trust scores, scoreability, reviewability, or farming.",
].join(" ");

/** A maintainer's BYOK provider credential, decrypted at call time. Never logged, never returned. */
export type AiReviewProviderKey = {
  provider: "anthropic" | "openai";
  key: string;
  /** Optional model override; falls back to a conservative stable default per provider. */
  model?: string | null | undefined;
};

// `CombineStrategy` / `OnMerge` (#dual-ai-combiner) are defined in ../types.ts, not here, and re-exported for
// backward compat: both this file's own callers AND signals/focus-manifest.ts + types.ts's RepositorySettings
// need the type, but focus-manifest.ts/types.ts are imported by the UI workspace, which lacks the ambient
// Cloudflare Workers types (`Env`, `D1Database`, …) this file's runtime code depends on — a type-only
// `import("../services/ai-review")` reference from either would still drag this whole module graph into the UI's
// typecheck and break it (#2567 follow-up fix). See ../types.ts for the full doc comment.
export type { AiContentBlock, CombineStrategy, OnMerge } from "../types";

/**
 * Resolve the EFFECTIVE `onMerge` rule for a review call, enforcing that a per-repo `.gittensory.yml
 * gate.aiReview.onMerge` override (#2567) can only TIGHTEN the self-host operator's `AI_REVIEW_PLAN.onMerge`
 * floor, never loosen it. `either` is the STRICTER rule (any one reviewer's blocker blocks/holds); `both` is
 * more PERMISSIVE (requires every reviewer to agree before a blocker counts). So:
 *   - operator floor `either` + repo override `both`  → CLAMPED to `either` (an attempted loosening).
 *   - operator floor `either` + repo override `either` → `either` (a no-op tightening).
 *   - operator floor `both` (or unset)                → the repo override (or the operator's own value) wins
 *     unclamped — there is no stricter floor visible to this field-level helper.
 * Returns the resolved value alongside whether a clamp fired, so the caller can log/surface it (a maintainer
 * who configured a loosening override should see it was not honored, not have it silently ignored).
 */
export function resolveEffectiveAiReviewOnMerge(
  repoOverride: OnMerge | null | undefined,
  operatorFloor: OnMerge | null | undefined,
): { onMerge: OnMerge | null | undefined; clamped: boolean } {
  if (repoOverride == null) return { onMerge: operatorFloor, clamped: false };
  if (operatorFloor === "either" && repoOverride === "both") {
    return { onMerge: "either", clamped: true };
  }
  return { onMerge: repoOverride, clamped: false };
}

type AiReviewPlanShape = {
  combine?: CombineStrategy | null | undefined;
  onMerge?: OnMerge | null | undefined;
  reviewers?: ReadonlyArray<{ model: string; fallback?: string | null | undefined }> | null | undefined;
};

/**
 * Resolve the FULL effective dual-AI plan (combine + onMerge + reviewers together), extending
 * resolveEffectiveAiReviewOnMerge to close a gap it left open (gate finding on #2567): clamping `onMerge`
 * alone does not protect the operator's `either` floor if a repo can ALSO shrink the reviewer count or switch
 * to `combine: "single"` -- either change reduces the number of independent opinions that can trigger a
 * blocker, achieving the same effective loosening `onMerge` alone was meant to prevent (an operator plan of
 * two reviewers under `either` means "either ONE of two can flag it"; drop to one reviewer and there is only
 * ever one vote to begin with, silently narrowing the floor without ever touching `onMerge`).
 *
 * When the operator has NOT set an `either` floor, every field resolves unclamped (repo override, else
 * operator's own value) -- there is nothing to protect. When the operator HAS set `either`, a repo override
 * that would reduce the effective reviewer count below the operator's own count (via a shorter `reviewers`
 * list or a `combine: "single"` switch) is clamped: the repo's `combine`/`reviewers` overrides are ignored
 * entirely and the operator's own values are used instead, while `onMerge` still resolves normally through
 * resolveEffectiveAiReviewOnMerge. `clamped` is true if EITHER the onMerge clamp or this reviewer-count clamp
 * fired, so the caller can surface either kind identically.
 */
export function resolveEffectiveAiReviewPlan(
  repoOverride: AiReviewPlanShape,
  operatorPlan: AiReviewPlanShape | null | undefined,
): { combine: CombineStrategy | null | undefined; onMerge: OnMerge | null | undefined; reviewers: AiReviewPlanShape["reviewers"]; clamped: boolean } {
  // In synthesis mode, an omitted operator onMerge is not "no floor": combineReviews' historical effective
  // default is `either`. Clamp against that implicit default too, otherwise a repo could set `both` and loosen a
  // self-host dual-review plan whose operator simply relied on the default.
  const operatorOnMergeFloor = operatorPlan?.onMerge ?? (operatorPlan?.combine === "synthesis" ? "either" : undefined);
  const onMergeResolution = resolveEffectiveAiReviewOnMerge(repoOverride.onMerge, operatorOnMergeFloor);
  const hasOperatorFloor = operatorOnMergeFloor === "either";
  if (hasOperatorFloor) {
    // The operator's OWN effective reviewer count under their plan -- absent reviewers falls back to the
    // built-in default pair (2), the historical dual-reviewer behavior (see GittensoryAiReviewInput.reviewers).
    const operatorReviewerCount = operatorPlan?.reviewers?.length ?? 2;
    const repoReviewerCount = repoOverride.reviewers?.length ?? operatorReviewerCount;
    const reducesReviewerCount = repoOverride.reviewers != null && repoReviewerCount < operatorReviewerCount;
    // Must be the REPO'S OWN combine value, not `repoOverride.combine ?? operatorPlan?.combine` -- that
    // fallback made an operator plan that itself sets `combine: "single"` (no repo override at all) spuriously
    // report `clamped: true` on every call, since there is nothing for the repo to have bypassed.
    const collapsesToSingleReviewer = repoOverride.combine === "single" && operatorReviewerCount > 1;
    if (reducesReviewerCount || collapsesToSingleReviewer) {
      return { combine: operatorPlan?.combine, onMerge: onMergeResolution.onMerge, reviewers: operatorPlan?.reviewers, clamped: true };
    }
  }
  return {
    combine: repoOverride.combine ?? operatorPlan?.combine,
    onMerge: onMergeResolution.onMerge,
    reviewers: repoOverride.reviewers ?? operatorPlan?.reviewers,
    clamped: onMergeResolution.clamped,
  };
}

export type GittensoryAiReviewInput = {
  repoFullName: string;
  prNumber: number;
  title: string;
  body?: string | null | undefined;
  /** A bounded unified-diff-ish string built by the caller (filenames + patches). */
  diff: string;
  actor?: string | null | undefined;
  /** Effective `aiReviewMode`. `block` additionally runs the consensus-defect pass. */
  mode: "advisory" | "block";
  /**
   * How to combine the two reviewer opinions in `block` mode (#dual-ai-combiner). Absent ⇒ `consensus` — the
   * historical behavior, so the gate decision is byte-identical until a repo/self-host opts into another
   * strategy. `onMerge` only applies to `synthesis` (default `either`).
   */
  combine?: CombineStrategy | null | undefined;
  onMerge?: OnMerge | null | undefined;
  /**
   * The reviewer(s) to run (#dual-ai-combiner). Absent/empty ⇒ the free Workers-AI pair with per-slot fallbacks
   * (byte-identical to today). A self-host plan supplies named providers instead — `{ model: "codex",
   * fallback: "claude-code" }` — addressed by the self-host AI router. `single` (or a single entry) runs
   * reviewer[0]; consensus/synthesis run [0] and [1].
   */
  reviewers?:
    | ReadonlyArray<{ model: string; fallback?: string | null | undefined }>
    | null
    | undefined;
  /** Present only when the repo has BYOK on AND a key configured; drives the advisory write-up. */
  providerKey?: AiReviewProviderKey | null | undefined;
  /**
   * Convergence (grounding, flag-gated by GITTENSORY_REVIEW_GROUNDING). The caller builds this from the PR's
   * finished CI status + the full content of the changed files (see `review/grounding-wire`). When ABSENT
   * (the default, flag-OFF), both the system and user prompts are byte-identical to today — no section is
   * appended. `systemSuffix` carries the grounding-discipline rules; `promptSection` carries the CI STATUS
   * + FULL FILE CONTENT blocks. Empty strings behave the same as absent.
   */
  grounding?:
    | { systemSuffix?: string | undefined; promptSection?: string | undefined }
    | null
    | undefined;
  /**
   * Convergence (RAG retrieval, flag-gated by GITTENSORY_REVIEW_RAG). The caller builds this by querying the
   * codebase vector index for code/docs semantically related to the PR's changed files (see
   * `review/rag-wire`); it is the engine's pre-formatted "RELEVANT EXISTING CODE / DOCS" block, appended to
   * the USER prompt as additive reference context (callers, related modules, existing conventions) — exactly
   * like grounding. When ABSENT (the default, flag-OFF) or an empty string, the user prompt is byte-identical
   * to today — no section is appended.
   */
  ragContext?: string | null | undefined;
  /**
   * Deterministic impact map (#2186, additive grounding slice of #1971), flag-gated by BOTH the operator's
   * GITTENSORY_REVIEW_IMPACT_MAP env flag AND the per-repo `.gittensory.yml review.impact_map` opt-in (see
   * `shouldComputeImpactMap`, `src/review/impact-map-wire.ts`). The caller pre-formats
   * `computeImpactMap`'s (`src/review/impact-map.ts`) output into an "IMPACT MAP" block — which OTHER repo
   * files plausibly need re-checking given the PR's changed symbols — and appends it to the USER prompt as
   * additive reference context, exactly like `ragContext`. When ABSENT (the default, flag-OFF) or an empty
   * string, the user prompt is byte-identical to today — no section is appended, and the gate verdict is
   * never affected (reference context only, never a new blocker/nit rule by itself).
   */
  impactMapContext?: string | null | undefined;
  /**
   * Repo quality-culture profile (#2995, flag-gated by GITTENSORY_REVIEW_CULTURE_PROFILE AND `.gittensory.yml`
   * `review.culture_profile`). The caller builds this by deriving a compact profile from the repo's OWN merge
   * history — typical PR size, common accepted labels (see `review/repo-culture-profile-wire`) — and it is
   * appended to the USER prompt as additive reference context, exactly like `ragContext`. ADVISORY GROUNDING
   * ONLY: it never becomes a gate/scoring input. When ABSENT (the default, flag-OFF) or an empty string, the
   * user prompt is byte-identical to today — no section is appended.
   */
  cultureProfileContext?: string | null | undefined;
  /** Internal review observability metadata, stored with usage events. The caller must pass only public-safe,
   *  non-secret counters/paths; provider keys and raw prompt text never belong here. */
  observability?: Record<string, unknown> | null | undefined;
  /**
   * Review-enrichment service brief (#1472, flag-gated by GITTENSORY_REVIEW_ENRICHMENT). The caller POSTs the PR
   * to the external REES (see `review/enrichment-wire`), which runs heavy/external/historical analysis the
   * no-checkout reviewer can't (dependency CVEs, leaked secrets, license/EOL/supply-chain) and returns a
   * pre-rendered, public-safe brief. Same shape + splice point as grounding: `promptSection` appends to the USER
   * prompt, `systemSuffix` to the SYSTEM prompt. ABSENT (default, flag-OFF) or empty ⇒ the prompt is byte-identical.
   */
  enrichment?:
    | { systemSuffix?: string | undefined; promptSection?: string | undefined }
    | null
    | undefined;
  /**
   * `.gittensory.yml` `review.profile` (#review-profile): adjusts how nitpicky the maintainer review write-up is.
   * `chill` → surface only blocking defects; `assertive` → also raise minor improvements & nits; absent/`balanced`
   * → the reviewer prompt is byte-identical to today. PRESENTATION ONLY — it never changes the gate verdict (the
   * consensus-defect pass still runs the same), just how much advisory detail the prose carries.
   */
  profile?: ReviewProfile | null | undefined;
  /**
   * `.gittensory.yml` `review.security_focus` (#review-security-focus): when true, instructs the reviewer to
   * prioritize a security-defect category — injection, authn/authz bypass, secret handling, unsafe
   * deserialization, SSRF, and path traversal — with elevated scrutiny. ORTHOGONAL to `profile`: it composes
   * with (never replaces) the chill/balanced/assertive volume tuning above — a "what to prioritize" axis, not a
   * fourth profile level. Absent/false (the default) ⇒ the reviewer prompt is byte-identical to today.
   */
  securityFocus?: boolean | undefined;
  /**
   * `.gittensory.yml` `review.ai_model` (#selfhost-ai-model-override), resolved by the caller from the
   * (already-cached) manifest. Self-host only — overrides that repo's claude-code/codex model+effort for THIS
   * review, taking priority over the operator's global CLAUDE_AI_MODEL/CLAUDE_AI_EFFORT/CODEX_AI_MODEL/
   * CODEX_AI_EFFORT env vars. A hosted (Workers-AI) `env.AI` ignores these fields entirely. Absent/null ⇒
   * byte-identical to today (global env var, then the provider's own default).
   */
  claudeModel?: string | null | undefined;
  claudeEffort?: string | null | undefined;
  codexModel?: string | null | undefined;
  codexEffort?: string | null | undefined;
  /**
   * Same override mechanism, extended to the HTTP-API self-host providers (#3902): overrides
   * OLLAMA_AI_MODEL/OPENAI_AI_MODEL/OPENAI_COMPATIBLE_AI_MODEL/ANTHROPIC_AI_MODEL for THIS repo. A hosted
   * (Workers-AI) `env.AI` ignores these fields entirely. Absent/null ⇒ byte-identical to today.
   */
  ollamaModel?: string | null | undefined;
  openaiModel?: string | null | undefined;
  openaiCompatibleModel?: string | null | undefined;
  anthropicModel?: string | null | undefined;
  /**
   * `.gittensory.yml` `review.path_instructions` (#review-path-instructions), pre-resolved by the caller to the
   * entries whose glob matched THIS PR's changed files (via `resolveReviewPathInstructions`) — a ready-to-append
   * prompt section. Absent / empty ⇒ the reviewer prompt is byte-identical. Public-safe by construction (the
   * instructions passed the manifest's public-safe filter at parse time).
   */
  pathGuidance?: string | null | undefined;
  /**
   * `.gittensory.yml` `review.instructions` (#review-instructions) — a repo-level maintainer brief appended to EVERY
   * review (vs the per-path pathGuidance). Bounded + public-safe at parse time, so it stays cost-cheap. Absent/null ⇒
   * the reviewer prompt is byte-identical.
   */
  repoInstructions?: string | null | undefined;
  /**
   * `.gittensory.yml` `review.inline_comments` (#inline-comments) — when true (the caller has already ANDed the
   * operator flag + cutover allowlist + the per-repo manifest toggle), the reviewer is asked to ALSO emit an
   * `inlineFindings` array of line-anchored findings for quiet, non-blocking inline PR comments. Absent/false
   * (the default) ⇒ no instruction is appended, so the prompt is byte-identical and the model emits none.
   */
  inlineFindings?: boolean | undefined;
  /**
   * `.gittensory.yml` `review.finding_categories` (#1958) — when true (the caller has already ANDed this with
   * `inlineFindings` being requested, since a category has nothing to categorize otherwise), the reviewer is
   * additionally asked to tag each `inlineFindings` item with a `category`. Absent/false (the default) ⇒ no
   * instruction is appended, so the prompt is byte-identical and the model emits no category.
   */
  findingCategories?: boolean | undefined;
  /**
   * `improvementSignal` converged feature (#4743, LLM tier of epic #4737; config-as-code foundation in #4738) —
   * when true, the reviewer is ALSO asked for an ordinal "does this change plausibly move the codebase forward"
   * judgment (`valueAssessment` on `ModelReview`), a genuinely different axis from `confidence`/blockers (see
   * `ModelReview.valueAssessment`'s doc comment). The CALLER resolves the feature (expected shape:
   * `resolveConvergedFeature(env, manifest, "improvementSignal", repoFullName)`, #4738) and passes the resolved
   * boolean here — mirroring `inlineFindings`/`findingCategories`/`securityFocus` above, all of which are
   * caller-resolved rather than looked up internally, so a manifest already loaded once upstream for several
   * flags is never re-fetched per-flag inside this module. (The one exception, `safety`, resolves internally via
   * `convergedFeatureActive` because it is security-critical and has no upstream caller today; `improvementSignal`
   * is a read-only advisory signal, not a security control, so it follows the majority pattern instead.) Absent/
   * false (the default, and the only reachable value until a caller starts resolving the feature) ⇒ no instruction
   * is appended and the model is never asked — byte-identical prompt, zero extra output tokens spent.
   */
  improvementSignal?: boolean | undefined;
  /**
   * This PR's changed file paths (#2558) — reused to splice a concise "changed code files with zero
   * test-path evidence" section into the user prompt via the engine's own deterministic classifier
   * (src/signals/test-evidence.ts), so the reviewer can name specific untested files instead of guessing
   * from the raw diff. Additional CONTEXT only, never a new blocker/nit rule. Absent/empty, or when the PR
   * has ANY test-path changes ⇒ no section is appended (byte-identical to today).
   */
  changedFiles?: ReadonlyArray<{ path: string }> | null | undefined;
  /**
   * The inbound webhook delivery id that triggered this review (#codex-timeout-fields) — the closest thing this
   * queue has to a job id. Forwarded to a self-host provider's `selfhost_ai_provider_failed` log purely for
   * operator correlation; never read by any review logic. Absent (e.g. a sweep/repair fan-out with no single
   * originating delivery, or a unit test) ⇒ the log line omits it, byte-identical to before this field existed.
   */
  jobId?: string | undefined;
};

/** A consensus critical defect, already public-safe, ready to become a gate blocker finding. */
export type AiConsensusDefect = {
  title: string;
  detail: string;
  confidence: number;
};

export type GittensoryAiReviewResult =
  | { status: "disabled"; reason: string }
  | { status: "unavailable"; reason: string }
  | {
      status: "quota_exceeded";
      estimatedNeurons: number;
      remainingBudget: number;
    }
  | {
      status: "ok";
      advisoryNotes: string | null;
      consensusDefect: AiConsensusDefect | null;
      split: boolean;
      /** Calibrated confidence of the lone reviewer whose blocker caused a SPLIT (#8), so the `ai_review_split`
       *  finding carries the same confidence as a consensus defect would. Present only when `split` is true. */
      splitConfidence?: number;
      inconclusive: boolean;
      estimatedNeurons: number;
      reviewerCount: number;
      inlineFindings: InlineFinding[];
      /** Combined improvement/value judgment (#4743), public-safe and ready to render. ALWAYS present (`null`
       *  when `input.improvementSignal` is falsy, when neither reviewer emitted a usable judgment, or when the
       *  only candidate(s) failed the public-safe check) — see {@link composeImprovementSignal} for how a dual
       *  review's two opinions combine into one. ADVISORY ONLY, never a gate input. */
      valueAssessment: { magnitude: ImprovementMagnitude; rationale: string } | null;
      reviewDiagnostics?: AiReviewDiagnostic[] | undefined;
    };

/** A line-anchored review finding the model can emit for quiet inline PR comments (#inline-comments). `line` is
 *  the 1-based line number in the NEW (post-change) file; `severity` separates a must-fix from a nit. The body
 *  is made public-safe before it ever leaves the engine (see {@link composeInlineFindings}). */
export type InlineFinding = {
  path: string;
  line: number;
  severity: "blocker" | "nit";
  body: string;
  suggestion?: string | undefined;
  /** Optional end line (inclusive) for a multi-line inline comment / ```suggestion block (#2141). When absent or
   *  invalid (`endLine` ≤ `line`), the finding is treated as single-line. */
  endLine?: number | undefined;
  /** `.gittensory.yml` `review.finding_categories` (#1958): the kind of issue (security/correctness/performance/
   *  maintainability/tests/style), when the model was asked to self-categorize and emitted a value in the fixed
   *  enum. Absent when the feature is off (the model was never asked) OR the model's value didn't parse — callers
   *  that render categories fall back to `classifyFindingCategory` in that case rather than treating it as absent. */
  category?: FindingCategory | undefined;
};

/**
 * Ordinal improvement/value band (#4743) — deliberately NOT a percentage or any fake-precise number, same
 * house convention as `SlopBand` (`signals/slop.ts`: `clean/low/elevated/high`): a small named ordinal an LLM
 * (or a human) can honestly stand behind. Ascending order least → most valuable: unclear < minor < moderate <
 * significant. This is the LLM-JUDGED tier's axis only — the deterministic structural-improvement tier (sibling
 * sub-issues of #4737) is a separate system with its own scoring.
 */
export type ImprovementMagnitude = "unclear" | "minor" | "moderate" | "significant";

export type ModelReview = {
  assessment: string;
  // blockers = concrete must-fix defects in the diff (drive the consensus defect / gate); nits = non-blocking
  // points; suggestions = concrete improvements (rendered alongside nits). reviewbot-parity shape. (#extensive-reviews)
  blockers: string[];
  nits: string[];
  suggestions: string[];
  // Calibrated confidence in [0,1] (#8): the reviewer's own probability that its blocker(s) are a REAL defect. A
  // consensus/split defect blocks the gate regardless of where this falls relative to `aiReviewCloseConfidence`;
  // the floor instead selects the DISPOSITION of a sub-floor finding via `aiReviewLowConfidenceDisposition` (#4603)
  // -- hold_for_review (default) ⇒ manual-review hold instead of one-shot-close; advisory_only ⇒ non-blocking;
  // one_shot ⇒ the floor is ignored. parseModelReview sets it from the model's `confidence` field; an
  // absent/unparseable/out-of-range value degrades to 1.0 (FALLBACK), so behavior matches the historical hardcoded
  // `confidence: 1` until a calibrated value is actually present.
  confidence: number;
  // Line-anchored findings for inline PR review comments (#inline-comments). ALWAYS present (parseModelReview
  // sets []); populated only when the caller asked for them (input.inlineFindings) AND the model emitted any.
  inlineFindings: InlineFinding[];
  /**
   * Ordinal improvement/value judgment (#4743) — a DIFFERENT axis from `confidence` above, not a rename of it.
   * `confidence` is calibrated DEFECT-CERTAINTY: "how sure am I that MY OWN blockers are real." `valueAssessment`
   * instead asks "does this change plausibly move the codebase forward, given the diff and its stated intent" —
   * is it well-targeted and worth making. A defect-free change can still be low-value; a genuinely valuable change
   * can still carry a real bug — the two axes are independent by design. This is also NOT a risk/safety judgment
   * (that is the separate deterministic `signals/slop.ts` tier, which this call never touches, and which remains
   * the ONLY thing allowed to gate). ADVISORY ONLY, same as `assessment`/`nits`/`suggestions` — never a gate input.
   * Gated behind the `improvementSignal` converged feature: the prompt only asks for this field when the caller
   * has resolved the feature on (`input.improvementSignal`, see its doc comment), so this is `undefined` both when
   * the feature is off AND when it is on but the model omitted/mis-emitted the field — parseModelReview never
   * fabricates a value or a fallback band.
   */
  valueAssessment?: { magnitude: ImprovementMagnitude; rationale: string } | undefined;
};

export type AiReviewDiagnostic = {
  model: string;
  attempt: number;
  status: "parsed" | "empty_output" | "unparseable_output" | "provider_error";
  responseChars?: number | undefined;
  hasJsonObject?: boolean | undefined;
  error?: string | undefined;
  usage?: AiReviewActualUsage | undefined;
};

export type AiReviewActualUsage = {
  provider?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  costUsd?: number | undefined;
};

type ReviewerOpinionOutcome = {
  review: ModelReview | null;
  fallbackNote?: string | undefined;
};

type AiGatewayOptions = { gateway?: { id: string } };
type AiRunner = {
  run?: (
    model: string,
    options: Record<string, unknown>,
    extra?: AiGatewayOptions,
  ) => Promise<unknown>;
};

function selfHostCliSystemAppend(model: string, systemAppend: string): string | undefined {
  const trimmed = systemAppend.trim();
  if (!trimmed) return undefined;
  const [provider = ""] = model.trim().toLowerCase().split(":");
  return provider === "claude-code" || provider === "codex" ? trimmed : undefined;
}

/** Build a message's `content` — plain text (BYTE-IDENTICAL, the only shape any call site sent before #4111)
 *  when no images are attached, or a text+image content-block array when the caller supplies pixel-diff-
 *  confirmed screenshots. See `review/visual/visual-findings.ts` for the gating that decides when `images` is
 *  ever non-empty; every existing caller of the functions below passes no `images`, so this is inert today. */
function toContentBlocks(text: string, images?: readonly AiContentBlock[] | undefined): string | AiContentBlock[] {
  if (!images || images.length === 0) return text;
  return [{ type: "text", text }, ...images];
}

/** Translate the generic {@link AiContentBlock} union into Anthropic's native Messages-API content-part shape
 *  (`{type:"image", source:{type:"base64", media_type, data}}`) — the ONLY provider-specific step, since the
 *  block's `text`/`data`/`mimeType` fields already carry everything Anthropic's wire format needs. */
function toAnthropicContentBlocks(blocks: readonly AiContentBlock[]): Array<Record<string, unknown>> {
  return blocks.map((block) =>
    block.type === "image"
      ? { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }
      : { type: "text", text: block.text },
  );
}

/** Translate the generic {@link AiContentBlock} union into OpenAI chat-completions' native content-part shape
 *  (`{type:"image_url", image_url:{url:"data:<mime>;base64,<data>"}}`). */
function toOpenAiContentBlocks(blocks: readonly AiContentBlock[]): Array<Record<string, unknown>> {
  return blocks.map((block) =>
    block.type === "image"
      ? { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } }
      : { type: "text", text: block.text },
  );
}

// Exported so the sibling AI-advisory features (e.g. the slop advisory in `./ai-slop`) share ONE budget
// window + neuron estimator and never drift from the review path's accounting.
export function isEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function utcDayStartIso(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

export function estimateNeurons(
  promptChars: number,
  maxOutputTokens: number,
  calls: number,
): number {
  const inputTokens = Math.ceil(promptChars / 4);
  return Math.max(
    1,
    Math.ceil((inputTokens + maxOutputTokens) * 0.035) * Math.max(1, calls),
  );
}

function neutralizePublicMarkdown(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/@/g, "@\u200B")
    .replace(/:\/\//g, ":\u200B//")
    .replace(/([\\`*_{}\[\]()#+!|])/g, "\\$1");
}

/** Returns neutralized text if it is public-safe, otherwise null (drop — never publish). */
export function toPublicSafe(text: string | null | undefined): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  try {
    return neutralizePublicMarkdown(sanitizePublicComment(trimmed));
  } catch {
    return null;
  }
}

/** Coerce the varied Workers-AI / provider response envelopes into a scannable string. */
export function coerceAiText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    const response = obj.response;
    if (typeof response === "string" && response.trim()) return response;
    if (response && typeof response === "object")
      return JSON.stringify(response);
    const choices = obj.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as {
        message?: { content?: unknown };
        text?: unknown;
      };
      const content = first?.message?.content ?? first?.text;
      if (typeof content === "string" && content.trim()) return content;
    }
    // Anthropic Messages: { content: [{ type: "text", text }] }
    const content = obj.content;
    if (Array.isArray(content) && content.length > 0) {
      const parts = content
        .map((part) =>
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .filter(Boolean);
      if (parts.length > 0) return parts.join("\n");
    }
    if (typeof obj.output_text === "string" && obj.output_text.trim())
      return obj.output_text;
  }
  return "";
}

function finiteUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteUsageInteger(value: unknown): number | undefined {
  const n = finiteUsageNumber(value);
  return n === undefined ? undefined : Math.max(0, Math.round(n));
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Extract a provider's real usage (tokens/cost/effort) from an `env.AI.run()` result, when the configured
 *  provider reports one (self-host CLI/HTTP providers do; the legacy Workers-AI binding never did). Shared
 *  by every AI feature's `recordAiUsageEvent` call so migration 0109's columns get real data, not just the
 *  estimated-neurons proxy, whenever it's available. */
export function coerceAiUsage(result: unknown): AiReviewActualUsage | undefined {
  if (!result || typeof result !== "object") return undefined;
  const usage = (result as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  return {
    provider: stringField(record.provider),
    model: stringField(record.model),
    effort: stringField(record.effort),
    inputTokens: finiteUsageInteger(record.inputTokens),
    outputTokens: finiteUsageInteger(record.outputTokens),
    totalTokens: finiteUsageInteger(record.totalTokens),
    costUsd: finiteUsageNumber(record.costUsd),
  };
}

/**
 * Extract the LAST complete top-level JSON object from text — brace-depth-aware + string-safe.
 * The gpt-oss/nemotron reasoning models emit a `<think>` scratchpad object BEFORE the real verdict; a
 * greedy `/\{[\s\S]*\}/` spans first-`{` to last-`}` and swallows BOTH, corrupting the parse (silently
 * dropping/garbling reviews). Ported from reviewbot (the source-of-truth engine). Returns null when there
 * is no complete top-level object. (#accuracy-gap-3)
 */
export function extractLastJsonObject(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  let last: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) last = text.slice(start, i + 1);
    }
  }
  return last;
}

/** Default reviewer confidence when the model omits a usable `confidence` (#8) — 1.0, so an absent/garbage value
 *  degrades to EXACTLY the historical hardcoded `confidence: 1` (a defect always cleared the floor). Shared by the
 *  parser and the combiners so the fallback is identical everywhere. */
export const DEFAULT_REVIEW_CONFIDENCE = 1;

/** Coerce a model's `confidence` field to a calibrated value in [0,1] (#8). A finite number is clamped into range;
 *  anything else (absent, NaN/±Infinity — which JSON can't even encode — string, etc.) falls back to 1.0 so the gate
 *  degrades to today's always-block behavior rather than silently un-blocking a real defect. PURE. */
export function parseReviewConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    return DEFAULT_REVIEW_CONFIDENCE;
  return Math.min(1, Math.max(0, value));
}

/** Parse a model's JSON review into a normalized {@link ModelReview}, or null when unparseable. */
export function parseModelReview(text: string): ModelReview | null {
  const jsonText = extractLastJsonObject(text);
  if (!jsonText) return null;
  try {
    const obj = JSON.parse(jsonText) as Record<string, unknown>;
    const toList = (value: unknown): string[] =>
      Array.isArray(value)
        ? value
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.trim())
            .filter(Boolean)
            .slice(0, 6)
        : [];
    // Fail-safe: a malformed/absent inlineFindings field degrades to []; each item missing a usable path / a
    // positive line / a body is skipped, never partial. Severity defaults to "nit" unless it's exactly "blocker";
    // a bad/blank suggestion is simply dropped while keeping the finding itself. (#2138)
    // `category` (#1958 / #2147) keeps valid model enum values verbatim. Unknown or absent values stay absent so
    // downstream path/body fallback can classify security-keyword findings before lower-priority buckets.
    const toInlineFindings = (value: unknown): InlineFinding[] =>
      Array.isArray(value)
        ? value
            .flatMap((item): InlineFinding[] => {
              if (!item || typeof item !== "object") return [];
              const o = item as Record<string, unknown>;
              const path = typeof o.path === "string" ? o.path.trim() : "";
              // JSON numbers are always finite (NaN/Infinity can't appear), so a numeric `line` is real; trunc a
              // float, and the `line > 0` guard below drops 0/negative anchors.
              const line = typeof o.line === "number" ? Math.trunc(o.line) : 0;
              const endLineRaw = typeof o.endLine === "number" ? Math.trunc(o.endLine) : undefined;
              const endLine = endLineRaw != null && endLineRaw > line ? endLineRaw : undefined;
              const body = typeof o.body === "string" ? o.body.trim() : "";
              const suggestion =
                typeof o.suggestion === "string" ? o.suggestion.trim() : "";
              const severity: "blocker" | "nit" =
                o.severity === "blocker" ? "blocker" : "nit";
              const category = parseInlineFindingCategory(o.category);
              return path && line > 0 && body
                ? [
                    {
                      path,
                      line,
                      severity,
                      body,
                      ...(category != null ? { category } : {}),
                      ...(suggestion ? { suggestion } : {}),
                      ...(endLine != null ? { endLine } : {}),
                    },
                  ]
                : [];
            })
            .slice(0, 20)
        : [];
    // Fail-safe (#4743): a malformed/absent valueAssessment degrades to `undefined`, never a fabricated band —
    // an invalid `magnitude` (not one of the 4 fixed literals) or a blank `rationale` drops the WHOLE field
    // rather than keeping a half-valid judgment (mirrors toInlineFindings' item-level all-or-nothing discipline).
    const toValueAssessment = (
      value: unknown,
    ): { magnitude: ImprovementMagnitude; rationale: string } | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const o = value as Record<string, unknown>;
      const magnitude = o.magnitude;
      if (
        magnitude !== "unclear" &&
        magnitude !== "minor" &&
        magnitude !== "moderate" &&
        magnitude !== "significant"
      )
        return undefined;
      const rationale = typeof o.rationale === "string" ? o.rationale.trim() : "";
      return rationale ? { magnitude, rationale } : undefined;
    };
    const assessment =
      typeof obj.assessment === "string" ? obj.assessment.trim() : "";
    const blockers = toList(obj.blockers);
    const nits = toList(obj.nits);
    const suggestions = toList(obj.suggestions);
    const inlineFindings = toInlineFindings(obj.inlineFindings);
    const valueAssessment = toValueAssessment(obj.valueAssessment);
    // Calibrated reviewer confidence (#8): clamp the model's `confidence` to [0,1]; an absent/garbage value falls
    // back to 1.0 (parseReviewConfidence) so the gate degrades to the historical always-block behavior.
    const confidence = parseReviewConfidence(obj.confidence);
    if (assessment === INCOHERENT_DIFF_ASSESSMENT) return null;
    if (
      !assessment &&
      blockers.length === 0 &&
      nits.length === 0 &&
      suggestions.length === 0
    )
      return null;
    return {
      assessment,
      blockers,
      nits,
      suggestions,
      inlineFindings,
      confidence,
      ...(valueAssessment ? { valueAssessment } : {}),
    };
  } catch {
    return null;
  }
}

// Aggregate ceiling across ALL optional context sections combined (#3900). Each section below already
// enforces its OWN per-section cap (FILE_CONTENT_BUDGET, MAX_CONTEXT_CHARS, MAX_PROMPT_CHARS,
// MAX_ENRICHMENT_PROMPT_SECTION_CHARS...), but nothing previously bounded the COMBINED total: with every
// convergence feature enabled on one repo, the worst-case assembled prompt exceeds 200,000 characters before
// the system prompt is even added, degrading signal-to-noise on exactly the large/complex PRs that most need
// focused attention. The diff + description are NOT counted against this ceiling -- they are the primary
// review target and are always included in full (capped at 120,000 + 2,000 chars regardless). 200,000 sits
// comfortably above diff+description+grounding's own worst case (~182k) so grounding is effectively never
// trimmed, while still meaningfully bounding the "every feature enabled" case.
const AGGREGATE_CONTEXT_BUDGET_CHARS = 200_000;

/**
 * Priority-ordered cutoff (#3900): walk the optional sections highest-priority-first, including each while it
 * still fits under the remaining budget, and stop entirely (dropping this section AND every lower-priority
 * one after it) the moment one would not fit. A simple, predictable priority cutoff -- not a bin-packing
 * optimization that could skip a large section to squeeze in a smaller, lower-priority one instead.
 */
function selectContextSectionsWithinBudget(
  sections: ReadonlyArray<{ key: string; text: string | null | undefined }>,
  usedChars: number,
  budgetChars: number,
): Set<string> {
  const included = new Set<string>();
  let running = usedChars;
  for (const section of sections) {
    if (!section.text) continue;
    const addedChars = section.text.length + 2; // +2 for the blank-line separator `lines.push("", text)` adds
    if (running + addedChars > budgetChars) break;
    included.add(section.key);
    running += addedChars;
  }
  return included;
}

function buildUserPrompt(input: GittensoryAiReviewInput): string {
  const lines = [
    `Repository: ${input.repoFullName}`,
    `Pull request #${input.prNumber}: ${input.title}`,
    input.body
      ? `Description:\n${input.body.slice(0, 2000)}`
      : "Description: (none)",
    "",
    "Unified diff (truncated if large):",
    // Widened 60k→120k so a large multi-file PR is actually reviewed in full (tuned against the legacy 120B
    // Workers-AI pair's 128k context window; pairing this with the higher output ceiling gives a thorough
    // review — self-host reviewers are configured with at least as much room). (#extensive-reviews)
    input.diff.slice(0, 120000),
  ];
  // Convergence (grounding): the FINISHED CI status + FULL file content when the caller supplied them (flag
  // GITTENSORY_REVIEW_GROUNDING on). Absent/empty (the default) → the prompt is byte-identical to today.
  const groundingSection = input.grounding?.promptSection;
  // Convergence (RAG retrieval): the retrieved RELEVANT EXISTING CODE / DOCS block when the caller supplied
  // one (flag GITTENSORY_REVIEW_RAG on AND an index exists). Absent/empty (the default) → byte-identical.
  const ragSection = input.ragContext;
  // Deterministic impact map (#2186): the "IMPACT MAP" block when the caller supplied one (BOTH
  // GITTENSORY_REVIEW_IMPACT_MAP AND the per-repo review.impact_map opt-in on, AND the computation found at
  // least one affected module). Absent/empty (the default) → the prompt is byte-identical to today.
  const impactMapSection = input.impactMapContext;
  // Review-enrichment brief (#1472): the external REES analysis block when the caller supplied one (flag
  // GITTENSORY_REVIEW_ENRICHMENT on AND REES_URL set). Absent/empty (the default) → the prompt is byte-identical.
  const enrichmentSection = input.enrichment?.promptSection;
  // Repo quality-culture profile (#2995): the ADDITIVE "REPO QUALITY-CULTURE PROFILE" reference block when
  // the caller supplied one (flag GITTENSORY_REVIEW_CULTURE_PROFILE + review.culture_profile both on).
  // Absent/empty (the default) → the prompt is byte-identical. Reference-only grounding, never a gate input.
  const cultureProfileSection = input.cultureProfileContext;
  // Test-evidence classifier (#2558): grounds the reviewer's test-adequacy judgment in the engine's own
  // deterministic classification instead of eyeballing the diff. Absent/no changed code files without test
  // evidence ⇒ the prompt is byte-identical.
  const testEvidenceSection = buildTestEvidencePromptSection(input.changedFiles ?? []);

  // Priority order (highest first): grounding (CI truth + full-file content) > RAG (codebase context) >
  // impact map (deterministic blast-radius) > enrichment (external analyzer brief) > culture profile (soft
  // house-style reference) > test-evidence flag (smallest, narrowest signal).
  const included = selectContextSectionsWithinBudget(
    [
      { key: "grounding", text: groundingSection },
      { key: "rag", text: ragSection },
      { key: "impactMap", text: impactMapSection },
      { key: "enrichment", text: enrichmentSection },
      { key: "cultureProfile", text: cultureProfileSection },
      { key: "testEvidence", text: testEvidenceSection },
    ],
    lines.join("\n").length,
    AGGREGATE_CONTEXT_BUDGET_CHARS,
  );

  if (groundingSection && included.has("grounding")) lines.push("", groundingSection);
  if (ragSection && included.has("rag")) lines.push("", ragSection);
  if (impactMapSection && included.has("impactMap")) lines.push("", impactMapSection);
  if (cultureProfileSection && included.has("cultureProfile")) lines.push("", cultureProfileSection);
  if (enrichmentSection && included.has("enrichment")) lines.push("", enrichmentSection);
  if (testEvidenceSection && included.has("testEvidence")) lines.push("", testEvidenceSection);
  return lines.join("\n");
}

/**
 * A concise "changed code files with zero test-path evidence" section for the user prompt (#2558). Reuses the
 * existing deterministic classifiers (isCodeFile, isTestPath) — no new signal, this is a wiring gap only.
 * Mirrors slop.ts's buildMissingTestEvidenceFinding's whole-PR semantics: ANY changed path that already looks
 * like a test file means there IS test evidence for this PR, so nothing is called out (a partial-but-real test
 * change is not "zero evidence") — only a fully test-free PR touching real code files gets a section.
 */
export function buildTestEvidencePromptSection(files: ReadonlyArray<{ path: string }>): string | undefined {
  const codePaths = [...new Set(files.map((file) => file.path).filter(Boolean).filter(isCodeFile))];
  if (codePaths.length === 0) return undefined;
  if (files.some((file) => isTestPath(file.path))) return undefined;
  return `Test evidence (engine classifier): this PR has NO test-path changes. The following changed code file(s) have zero test-path evidence: ${codePaths.join(", ")}.`;
}

// `.gittensory.yml` review.profile → an appended tone instruction (#review-profile). `balanced`/absent appends
// nothing (byte-identical). PRESENTATION ONLY: it shapes how many nits the write-up surfaces, never the verdict.
const REVIEW_PROFILE_SUFFIX: Record<"chill" | "assertive", string> = {
  chill:
    "\n\nReview profile: CHILL. Report ONLY blocking, must-fix defects (bugs, security, data loss, breaking changes). Do NOT raise style preferences, naming, or minor nitpicks — omit them entirely.",
  assertive:
    "\n\nReview profile: ASSERTIVE. Beyond blocking defects, also surface minor improvements, style/consistency suggestions, and nitpicks — be thorough and exacting, clearly marking each non-blocking item as a nit.",
};

// `.gittensory.yml` review.security_focus → an appended security-prioritization instruction (#review-security-focus).
// ORTHOGONAL to REVIEW_PROFILE_SUFFIX above — it composes with (never replaces) the chill/balanced/assertive volume
// tuning: profile controls HOW MANY findings surface, this controls WHAT KIND the reviewer hunts for with elevated
// scrutiny. False/absent (default) appends nothing (byte-identical).
const SECURITY_FOCUS_SUFFIX =
  "\n\nSECURITY FOCUS: Beyond the usual review, prioritize hunting for security defects with elevated scrutiny — injection (SQL/command/template/log), authentication/authorization bypass, unsafe secret handling (hardcoded credentials, logged/leaked tokens), unsafe deserialization, server-side request forgery (SSRF), and path traversal. Treat a credible finding in any of these categories as a blocker even if it would otherwise read as a nit.";

// `.gittensory.yml` review.inline_comments → an appended instruction to ALSO emit line-anchored findings for
// quiet inline PR comments (#inline-comments). Absent/off appends nothing (byte-identical). The model keeps the
// existing 4-field shape and simply ADDS an `inlineFindings` array.
const INLINE_FINDINGS_SUFFIX =
  '\n\nINLINE FINDINGS: ALSO include an additional top-level field "inlineFindings" in the SAME JSON object — an array (possibly empty) of your most important findings, each anchored to a specific changed line, for inline PR comments. Each item: {"path": the changed file path EXACTLY as shown in the diff, "line": the 1-based line number in the NEW file (count forward from the "+" start in the nearest "@@ -old +new @@" hunk header) of an ADDED ("+") line you are commenting on, "severity": "blocker" or "nit", "body": the one-sentence finding, "suggestion": optional replacement text for that line}. Include ONLY findings you can place on a specific added line; OMIT any you cannot anchor precisely (a wrong line is worse than none). If a suggestion is blank or you are not confident in an exact replacement, omit the suggestion field and keep the finding. At most ~10 items.';

// `.gittensory.yml` review.finding_categories → an appended instruction that ALSO asks for a `category` on each
// inlineFindings item (#1958). Only meaningful once INLINE_FINDINGS_SUFFIX is already appended (a category has
// nothing to categorize otherwise) — the caller ANDs this with inlineFindings before setting the input flag.
// Absent/off appends nothing (byte-identical); a parser-side fallback (classifyFindingCategory) covers whatever
// the model omits or mis-emits, so this suffix only needs to ask, never enforce.
const FINDING_CATEGORY_SUFFIX =
  ' Each inlineFindings item must ALSO include "category": one of exactly "security", "correctness", "performance", "maintainability", "tests", "style" — the KIND of issue, not its severity.';

// `improvementSignal` converged feature (#4743, LLM tier of epic #4737) → an appended instruction asking for an
// ADDITIONAL, genuinely different axis: not "is this correct/safe" (blockers/nits/confidence above) and not "is
// this risky" (the separate deterministic signals/slop.ts tier, never touched by this call) but "does this change
// plausibly move the codebase forward." Absent/off (default) appends nothing (byte-identical prompt, zero extra
// output tokens). Deliberately steers the model toward "improvement"/"value"/"gain" wording and away from
// "score" and its sibling forbidden terms (#542) so the sanitizer is defended-in-depth rather than the only guard
// (see the public-safe test suite asserting representative rationale text never trips it).
const IMPROVEMENT_SIGNAL_SUFFIX =
  '\n\nVALUE ASSESSMENT: ALSO include an additional top-level field "valueAssessment" in the SAME JSON object — an object of the shape {"magnitude": one of exactly "unclear", "minor", "moderate", or "significant", "rationale": ONE specific sentence}. This is a DIFFERENT question from everything above: does this change, as shown in the diff, plausibly move the codebase forward given its stated title, description, and intent — is it well-targeted and worth making? It is NOT your confidence that the change is bug-free (that is the separate "confidence" field above — a defect-free change can still be low-value, and a genuinely valuable change can still carry a real bug) and it is NOT a risk or safety judgment (a separate deterministic system handles that; do not hedge on risk here). You see only the unified diff, never the full pre-change files, so base this on the before/after hunk shape visible in the diff plus the stated intent — never claim to have compared whole files you cannot see. Use "unclear" when the diff is too small, too mechanical, or too disconnected from its stated intent to judge either way — never guess. Never use the word "score" (or reward, ranking, payout, wallet, hotkey, coldkey, trust, farming, or reviewability) to describe this judgment; describe it only in terms of improvement, value, or gain.';

/** The effective reviewer SYSTEM prompt. Appends the grounding-discipline suffix when the caller supplied one
 *  (flag GITTENSORY_REVIEW_GROUNDING on), the `review.profile` tone suffix when set, the `review.security_focus`
 *  prioritization suffix when on, then the inline-findings instruction when the caller asked for them, then the
 *  improvement-signal instruction when the caller resolved that feature on; all absent (default) → the base
 *  prompt, byte-identical to today. */
function buildSystemPrompt(input: GittensoryAiReviewInput): string {
  const groundingSuffix = input.grounding?.systemSuffix ?? "";
  // Review-enrichment brief (#1472): the REES supplies a one-line discipline suffix ("treat a listed CVE/secret as
  // verified ground truth"). Absent (default) ⇒ "" ⇒ byte-identical.
  const enrichmentSuffix = input.enrichment?.systemSuffix ?? "";
  const profileSuffix =
    input.profile === "chill" || input.profile === "assertive"
      ? REVIEW_PROFILE_SUFFIX[input.profile]
      : "";
  const securityFocusSuffix = input.securityFocus === true ? SECURITY_FOCUS_SUFFIX : "";
  // `.gittensory.yml` review.path_instructions (#review-path-instructions): the caller pre-resolved the entries
  // matching this PR's files into a prompt section; empty ⇒ nothing appended (byte-identical).
  const pathSuffix = input.pathGuidance?.trim() ? input.pathGuidance : "";
  // `.gittensory.yml` review.instructions (#review-instructions): a repo-level maintainer brief appended to every
  // review; empty ⇒ nothing appended (byte-identical).
  const repoInstructionsAppend = buildRepoInstructionsSystemAppend(input.repoInstructions);
  const repoInstructionsSuffix = repoInstructionsAppend ? ` ${repoInstructionsAppend}` : "";
  const inlineSuffix = input.inlineFindings ? INLINE_FINDINGS_SUFFIX : "";
  // review.finding_categories (#1958) only makes sense layered on top of inlineFindings itself being requested.
  const categorySuffix = input.inlineFindings && input.findingCategories ? FINDING_CATEGORY_SUFFIX : "";
  // improvementSignal (#4743): caller-resolved, exactly like inlineFindings/findingCategories above.
  const improvementSignalSuffix = input.improvementSignal ? IMPROVEMENT_SIGNAL_SUFFIX : "";
  return `${REVIEW_SYSTEM_PROMPT}${groundingSuffix}${enrichmentSuffix}${profileSuffix}${securityFocusSuffix}${pathSuffix}${repoInstructionsSuffix}${inlineSuffix}${categorySuffix}${improvementSignalSuffix}`;
}

function buildRepoInstructionsSystemAppend(repoInstructions: string | null | undefined): string {
  const trimmed = repoInstructions?.trim();
  return trimmed
    ? `REPOSITORY REVIEW INSTRUCTIONS (maintainer conventions for this repo — honor them unless they conflict with a real defect): ${trimmed}`
    : "";
}

/** Correlation + per-repo override context forwarded to `env.AI.run`'s options. `jobId`/`repoFullName`/
 *  `pullNumber` (#codex-timeout-fields) are purely observational — a self-host provider-failure log, never read
 *  by any provider's own request logic. `claudeModel`/`claudeEffort`/`codexModel`/`codexEffort` and
 *  `ollamaModel`/`openaiModel`/`openaiCompatibleModel`/`anthropicModel` (#selfhost-ai-model-override, #3902) are
 *  the exception: the matching self-host provider DOES read its own field to pick the model (+ effort, for the
 *  CLI providers) for THIS repo, taking priority over that provider's global env var. All self-host-only; a
 *  hosted (Workers-AI) `env.AI` ignores every field here. */
type AiRunCorrelation = {
  jobId?: string | undefined;
  repoFullName?: string | undefined;
  pullNumber?: number | undefined;
  claudeModel?: string | undefined;
  claudeEffort?: string | undefined;
  codexModel?: string | undefined;
  codexEffort?: string | undefined;
  ollamaModel?: string | undefined;
  openaiModel?: string | undefined;
  openaiCompatibleModel?: string | undefined;
  anthropicModel?: string | undefined;
};

/** True for the self-host CLI adapter's own non-transient timeout signal (`src/selfhost/ai.ts`'s
 *  `throw new Error("subscription_cli_timeout")`, thrown after a `claude-code`/`codex` subprocess is SIGKILLed
 *  at its effort-based deadline). Distinguishes it from a genuinely transient failure (a dropped connection, a
 *  malformed response) that's still worth retrying up to the full budget. */
function isSubscriptionCliTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === "subscription_cli_timeout";
}

/** Cap on the diagnostic prefix logged for an unparseable model response (#observability-unparseable) -- long
 *  enough to tell a markdown-fenced/truncated-mid-JSON/plain-prose response apart, short enough to never dump
 *  a large chunk of model output into Sentry/audit context. */
const UNPARSEABLE_RESPONSE_SNIPPET_MAX_CHARS = 400;

/** One reviewer opinion (whichever provider `env.AI` resolves to — self-host Codex/Claude Code/etc, or the
 *  legacy Workers-AI pair) with a per-slot reliable fallback and a 3× retry on the primary. */
async function runWorkersOpinion(
  env: Env,
  primary: string,
  fallback: string,
  system: string,
  user: string,
  maxTokens: number,
  diagnostics: AiReviewDiagnostic[] = [],
  systemAppend = "",
  correlation?: AiRunCorrelation,
  // Pixel-diff-confirmed screenshot(s) for a visual-vision pass (#4111). Absent for every existing caller —
  // wiring a real caller (source images, invoke with them) is a deliberately deferred follow-up; see
  // review/visual/visual-findings.ts.
  images?: readonly AiContentBlock[] | undefined,
): Promise<ReviewerOpinionOutcome> {
  const ai = env.AI as unknown as AiRunner | undefined;
  if (!ai || typeof ai.run !== "function") return { review: null };
  // Route through Cloudflare AI Gateway when configured (caching, rate-limiting, logging, fallback). The
  // diff/prompt is the cache key input, scoped per model + content, so distinct PRs never share a cached
  // review. Unset → direct binding call (unchanged behavior).
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  const extra: AiGatewayOptions | undefined = gatewayId
    ? { gateway: { id: gatewayId } }
    : undefined;
  // Track the last provider error so we can fail-LOUD once ALL models × attempts are exhausted (below). Per-attempt
  // logs are warn (noisy retries, skipped by the central Sentry forwarder); the exhausted summary is error (#26).
  let lastError: unknown;
  let lastUnparseable:
    | { model: string; attempt: number; responseChars: number; hasJsonObject: boolean; responseSnippet: string }
    | undefined;
  const models = fallback && fallback !== primary ? [primary, fallback] : [primary];
  for (const [modelIndex, model] of models.entries()) {
    if (modelIndex > 0) {
      incr("gittensory_ai_review_model_fallback_total", { primary, fallback: model });
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const cliSystemAppend = selfHostCliSystemAppend(model, systemAppend);
        const result = await ai.run(
          model,
          {
            max_tokens: maxTokens,
            temperature: 0,
            messages: [
              { role: "system", content: system },
              { role: "user", content: toContentBlocks(user, images) },
            ],
            ...(cliSystemAppend ? { systemAppend: cliSystemAppend } : {}),
            ...(correlation?.jobId !== undefined ? { jobId: correlation.jobId } : {}),
            ...(correlation?.repoFullName !== undefined ? { repoFullName: correlation.repoFullName } : {}),
            ...(correlation?.pullNumber !== undefined ? { pullNumber: correlation.pullNumber } : {}),
            ...(correlation?.claudeModel !== undefined ? { claudeModel: correlation.claudeModel } : {}),
            ...(correlation?.claudeEffort !== undefined ? { claudeEffort: correlation.claudeEffort } : {}),
            ...(correlation?.codexModel !== undefined ? { codexModel: correlation.codexModel } : {}),
            ...(correlation?.codexEffort !== undefined ? { codexEffort: correlation.codexEffort } : {}),
            ...(correlation?.ollamaModel !== undefined ? { ollamaModel: correlation.ollamaModel } : {}),
            ...(correlation?.openaiModel !== undefined ? { openaiModel: correlation.openaiModel } : {}),
            ...(correlation?.openaiCompatibleModel !== undefined ? { openaiCompatibleModel: correlation.openaiCompatibleModel } : {}),
            ...(correlation?.anthropicModel !== undefined ? { anthropicModel: correlation.anthropicModel } : {}),
            attempt,
            // #5046: only the truly last attempt (last model, last retry) should escalate to Sentry via the
            // provider's own error log -- every earlier attempt in this loop is about to be retried, and this
            // loop's own per-attempt warn below is already the correct signal for those.
            finalAttempt: attempt === 2 && modelIndex === models.length - 1,
          },
          extra,
        );
        const text = coerceAiText(result);
        const usage = coerceAiUsage(result);
        const usageFields = usage ? { usage } : {};
        const parsed = parseModelReview(text);
        if (parsed) {
          diagnostics.push({ model, attempt, status: "parsed", responseChars: text.length, hasJsonObject: Boolean(extractLastJsonObject(text)), ...usageFields });
          return { review: parsed };
        }
        const hasJsonObject = Boolean(extractLastJsonObject(text));
        const trimmedText = text.trim();
        const status = trimmedText ? "unparseable_output" : "empty_output";
        diagnostics.push({ model, attempt, status, responseChars: text.length, hasJsonObject, ...usageFields });
        if (trimmedText) {
          // NOT added to the diagnostics entry above: reviewDiagnostics flows into result/Sentry context that
          // must never carry raw provider text (see the "withholds unsafe provider and reviewer fallback text"
          // test) -- logged here instead, which reaches only the structured-log Sentry forwarder, never `result`.
          const responseSnippet = trimmedText.slice(0, UNPARSEABLE_RESPONSE_SNIPPET_MAX_CHARS);
          lastUnparseable = { model, attempt, responseChars: text.length, hasJsonObject, responseSnippet };
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "ai_review_provider_unparseable_output",
              model,
              attempt,
              responseChars: text.length,
              hasJsonObject,
              responseSnippet,
            }),
          );
        }
      } catch (error) {
        // Fail-LOUD (#1566): a provider/CLI failure (e.g. the claude-code CLI absent → spawn ENOENT, or an auth/API
        // error) must be VISIBLE, not silently swallowed into a "no usable output" review. Log every failed attempt;
        // the loop still falls through to the fallback model so a transient error doesn't abort the whole review.
        diagnostics.push({ model, attempt, status: "provider_error", error: errorMessage(error) });
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "ai_review_provider_attempt_failed",
            model,
            attempt,
            error: errorMessage(error),
          }),
        );
        lastError = error;
        // A CLI timeout is not transient -- the same model retrying the same oversized/complex diff will almost
        // certainly time out again. Stop retrying THIS model (the fallback below still gets its own full retry
        // budget, since a different model/config may not share the same timeout) instead of burning up to 3x
        // the full effort-timeout in subprocess time for zero additional chance of success (#gaming-tactic-draft-cycle
        // audit finding: this inner retry count is distinct from c7073949's outer cross-sweep-tick cap).
        if (isSubscriptionCliTimeout(error)) break;
      }
    }
  }
  // All models × attempts threw (vs "ran but returned unparseable output", where lastError stays undefined): the
  // reviewer is genuinely DOWN. Emit one level:error log so the central Sentry forwarder surfaces the outage — the
  // per-attempt warns above are invisible to it. (#26 fail-loud)
  if (lastError !== undefined) {
    console.log(
      JSON.stringify({
        level: "error",
        event: "ai_review_provider_exhausted",
        primary,
        fallback,
        error: errorMessage(lastError),
      }),
    );
  }
  if (lastUnparseable) {
    console.log(
      JSON.stringify({
        level: "error",
        event: "ai_review_provider_unparseable_exhausted",
        primary,
        fallback,
        model: lastUnparseable.model,
        attempt: lastUnparseable.attempt,
        responseChars: lastUnparseable.responseChars,
        hasJsonObject: lastUnparseable.hasJsonObject,
        responseSnippet: lastUnparseable.responseSnippet,
      }),
    );
  }
  return { review: null };
}

const PROVIDER_DEFAULT_MODEL: Record<AiReviewProviderKey["provider"], string> =
  {
    anthropic: "claude-3-5-sonnet-latest",
    openai: "gpt-4o",
  };

/** Hard cap on a single BYOK provider request. Without it a slow/half-open Anthropic/OpenAI connection
 *  would stall the queue worker for as long as the platform allows; a bounded timeout turns the hang into
 *  the existing fail-safe null path. Mirrors the github/gittensor fetch-timeout convention. */
const AI_PROVIDER_TIMEOUT_MS = 20_000;

/** Default per-repository/day cap for maintainer-paid BYOK calls (shared across all BYOK AI features). */
export const DEFAULT_BYOK_DAILY_REPO_LIMIT = 25;

/** Why a BYOK call produced no usable output — surfaced in the audit event for observability (never a key). */
export type ProviderFailure = "timeout" | "http_error" | "exception";
type ProviderReviewOutcome = {
  review: ModelReview | null;
  failure?: ProviderFailure;
  fallbackNote?: string | undefined;
  diagnostic?: AiReviewDiagnostic | undefined;
};

/** Static USD-per-million-token pricing for BYOK models. Anthropic/OpenAI responses report token counts but
 *  never a dollar figure, so this table is the only source for a BYOK call's `costUsd`. A model absent here
 *  (e.g. a maintainer-configured override this table hasn't been updated for) leaves `costUsd` undefined —
 *  never fabricated — matching how every other unavailable usage field already degrades in this file.
 *  Last verified 2026-07-05 against platform.claude.com/docs/en/about-claude/models/overview (Anthropic) and
 *  platform.openai.com/docs/pricing (OpenAI) — re-verify against those pages before trusting this table for
 *  billing reconciliation, since providers reprice and rename models without notice. */
const BYOK_MODEL_PRICING_USD_PER_MTOK: Record<
  AiReviewProviderKey["provider"],
  Record<string, { input: number; output: number }>
> = {
  anthropic: {
    "claude-opus-4-8": { input: 5, output: 25 },
    "claude-opus-4-7": { input: 5, output: 25 },
    "claude-opus-4-6": { input: 5, output: 25 },
    "claude-sonnet-5": { input: 3, output: 15 },
    "claude-sonnet-4-6": { input: 3, output: 15 },
    "claude-haiku-4-5": { input: 1, output: 5 },
  },
  openai: {
    "gpt-5.5": { input: 5, output: 30 },
    "gpt-5.5-pro": { input: 30, output: 180 },
    "gpt-5.4": { input: 2.5, output: 15 },
    "gpt-5.4-mini": { input: 0.75, output: 4.5 },
    "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  },
};

function priceByokUsageUsd(
  provider: AiReviewProviderKey["provider"],
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | undefined {
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const pricing = BYOK_MODEL_PRICING_USD_PER_MTOK[provider][model];
  if (!pricing) return undefined;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/** Normalize a BYOK provider's native usage envelope into the same shape `coerceAiUsage` produces for the
 *  free/self-host path. Anthropic reports `usage: {input_tokens, output_tokens}`; OpenAI reports
 *  `usage: {prompt_tokens, completion_tokens, total_tokens}` — both snake_case and provider-specific, unlike
 *  the already-camelCase envelope `coerceAiUsage` reads from `env.AI.run()`. Anthropic's `usage` can also
 *  carry `cache_creation_input_tokens`/`cache_read_input_tokens`, priced differently than `input_tokens` —
 *  intentionally not read here, since `callAiProvider` never sends `cache_control`, so Anthropic never
 *  populates them on this path. Private to this file, but not private in effect: `ai-slop.ts`'s BYOK branch
 *  depends on this normalization too, indirectly, via `callAiProvider`'s returned `usage` field — if this
 *  ever moves, update both call sites. */
function coerceByokUsage(
  providerKey: AiReviewProviderKey,
  model: string,
  rawResult: unknown,
): AiReviewActualUsage | undefined {
  if (!rawResult || typeof rawResult !== "object") return undefined;
  const usage = (rawResult as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  const inputTokens =
    providerKey.provider === "anthropic"
      ? finiteUsageInteger(record.input_tokens)
      : finiteUsageInteger(record.prompt_tokens);
  const outputTokens =
    providerKey.provider === "anthropic"
      ? finiteUsageInteger(record.output_tokens)
      : finiteUsageInteger(record.completion_tokens);
  const totalTokens =
    providerKey.provider === "openai" ? finiteUsageInteger(record.total_tokens) : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined)
    return undefined;
  // The `?? 0` fallback below is always safe: the guard above guarantees that whenever totalTokens is
  // undefined, at least one of inputTokens/outputTokens is defined.
  return {
    provider: providerKey.provider,
    model,
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    costUsd: priceByokUsageUsd(providerKey.provider, model, inputTokens, outputTokens),
  };
}

/**
 * POST to the maintainer's BYOK provider and return the raw response text (or null + a failure reason),
 * plus real usage (tokens/cost) when the response body included a parseable `usage` field. Never throws.
 * Shared by every BYOK AI path (review, slop, …) so the endpoint/timeout/error/usage handling lives in one
 * place; callers parse the returned text into their own shape.
 */
export async function callAiProvider(
  providerKey: AiReviewProviderKey,
  system: string,
  user: string,
  maxTokens: number,
  // Pixel-diff-confirmed screenshot(s) for a visual-vision pass (#4111). Absent for every existing caller
  // (byte-identical `content: user` string body); vision rides the maintainer's OWN BYOK key since Workers AI
  // is retired — see review/visual/visual-findings.ts for the gating that decides when this is ever non-empty.
  images?: readonly AiContentBlock[] | undefined,
): Promise<{ text: string | null; usage?: AiReviewActualUsage | undefined; failure?: ProviderFailure }> {
  const model =
    providerKey.model || PROVIDER_DEFAULT_MODEL[providerKey.provider];
  const userContent: string | Array<Record<string, unknown>> =
    images && images.length > 0
      ? providerKey.provider === "anthropic"
        ? toAnthropicContentBlocks([{ type: "text", text: user }, ...images])
        : toOpenAiContentBlocks([{ type: "text", text: user }, ...images])
      : user;
  try {
    let response: Response;
    if (providerKey.provider === "anthropic") {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": providerKey.key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: userContent }],
        }),
        signal: AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS),
      });
    } else {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${providerKey.key}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS),
      });
    }
    if (!response.ok) return { text: null, failure: "http_error" };
    const body = await response.json();
    return { text: coerceAiText(body), usage: coerceByokUsage(providerKey, model, body) };
  } catch (error) {
    // AbortSignal.timeout rejects with a TimeoutError; everything else is a network/parse exception.
    const failure: ProviderFailure =
      (error as { name?: string } | null)?.name === "TimeoutError"
        ? "timeout"
        : "exception";
    return { text: null, failure };
  }
}

/** Run the maintainer's BYOK frontier model for the advisory write-up. Never throws; the review is null on
 *  any error and `failure` names the reason (timeout/http_error/exception) for the audit trail. */
async function runProviderReview(
  providerKey: AiReviewProviderKey,
  system: string,
  user: string,
  maxTokens: number,
  images?: readonly AiContentBlock[] | undefined,
): Promise<ProviderReviewOutcome> {
  const { text, usage, failure } = await callAiProvider(
    providerKey,
    system,
    user,
    maxTokens,
    images,
  );
  const model = providerKey.model || PROVIDER_DEFAULT_MODEL[providerKey.provider];
  if (failure) return { review: null, failure, diagnostic: { model, attempt: 0, status: "provider_error", error: failure } };
  /* v8 ignore next -- callAiProvider returns a string for every non-failure response; null is a type-level guard. */
  const textValue = text ?? "";
  const review = textValue ? parseModelReview(textValue) : null;
  return {
    review,
    diagnostic: {
      model,
      attempt: 0,
      status: review ? "parsed" : textValue ? "unparseable_output" : "empty_output",
      responseChars: textValue.length,
      hasJsonObject: Boolean(textValue && extractLastJsonObject(textValue)),
      usage,
    },
  };
}

function extractPublicAssessment(notes: string | null | undefined): string {
  const raw = notes?.trim();
  if (!raw) return "";
  const sectionIndex = raw.search(
    /(?:^|\n)\s*\*\*(?:Blockers|Nits \(\d+\))\*\*/u,
  );
  const assessment =
    sectionIndex === -1 ? raw : raw.slice(0, sectionIndex).trim();
  return toPublicSafe(assessment) ?? "";
}

export function hasPublicReviewAssessment(
  notes: string | null | undefined,
): boolean {
  return extractPublicAssessment(notes).length > 0;
}

function fallbackPublicAssessment(
  safeBlockers: readonly string[],
  safeNits: readonly string[],
): string | null {
  if (safeBlockers.length > 0)
    return "The AI review returned blocking findings for this change but did not include a separate narrative summary. Review the blockers below before deciding this PR.";
  if (safeNits.length > 0)
    return "The AI review returned non-blocking notes for this change but did not include a separate narrative summary. Review the nits below before deciding this PR.";
  return null;
}

function fallbackUnstructuredPublicNote(text: string): string | null {
  const safe = toPublicSafe(text.slice(0, 4000));
  if (!safe) return null;
  return [
    "The AI reviewer returned public review text but not the expected structured verdict, so Gittensory is holding this PR for manual review.",
    "",
    safe,
  ].join("\n").trim();
}

function composeFallbackAdvisoryNotes(notes: readonly string[]): string | null {
  const safeNotes = [
    ...new Set(notes.map((note) => fallbackUnstructuredPublicNote(note)).filter((note): note is string => Boolean(note))),
  ].slice(0, 2);
  if (safeNotes.length === 0) return null;
  return safeNotes.join("\n\n");
}

/** Compose a public-safe markdown advisory blurb from one or two model reviews. Null if no assessment is safe. */
export function composeAdvisoryNotes(reviews: ModelReview[]): string | null {
  const assessments = reviews.map((r) => r.assessment).filter(Boolean);
  // High-signal caps: a focused review shows only the few findings that matter (the prompt also asks the
  // model to be selective + deduplicate). Keep the core blockers and a handful of nits. (#focused-reviews)
  const blockers = [...new Set(reviews.flatMap((r) => r.blockers))].slice(0, 3);
  // nits + suggestions are both non-blocking — merge + dedupe for the write-up.
  const nits = [
    ...new Set(reviews.flatMap((r) => [...r.nits, ...r.suggestions])),
  ].slice(0, 5);
  const assessment = toPublicSafe(assessments[0] ?? "");
  const safeBlockers = blockers
    .map((s) => toPublicSafe(s))
    .filter((s): s is string => Boolean(s));
  const safeNits = nits
    .map((s) => toPublicSafe(s))
    .filter((s): s is string => Boolean(s));
  const publicAssessment =
    assessment || fallbackPublicAssessment(safeBlockers, safeNits);
  if (!publicAssessment) return null;
  const lines: string[] = [];
  lines.push(publicAssessment, "");
  if (safeBlockers.length > 0) {
    lines.push("**Blockers**");
    lines.push(...safeBlockers.map((s) => `- ${s}`));
    lines.push("");
  }
  if (safeNits.length > 0) {
    // Keep advisory notes markdown-only: downstream public comment renderers escape angle brackets
    // in this blob, so raw HTML would render as literal tags instead of GitHub UI. (#focused-reviews)
    lines.push(`**Nits (${safeNits.length})**`);
    lines.push(...safeNits.map((s) => `- ${s}`));
  }
  // Reaching here means at least one section was pushed (the all-empty case returned null above).
  return lines.join("\n").trim();
}

/** Hard cap on inline findings surfaced per review — a focused review leaves a handful of precise inline notes,
 *  not a wall of them (the prompt also asks the model to be selective). (#inline-comments) */
const INLINE_FINDINGS_LIMIT = 10;

/** Compose the public-safe, deduped, capped inline findings from one or two model reviews — the line-anchored
 *  counterpart of {@link composeAdvisoryNotes}. Dedupes by path+line (first wins), drops any body that fails the
 *  public-safe filter, and caps the total. Empty array when there is nothing safe to anchor. (#inline-comments) */
const INLINE_SEVERITY_ORDER: Record<InlineFinding["severity"], number> = { nit: 0, blocker: 1 };

/** Merge two inline findings anchored to the SAME (path, line) — dual reviewers often flag one line twice. The
 *  higher-severity finding supplies the severity + body (ties keep the first-seen one); a suggestion/category is
 *  carried from whichever finding has one, preferring the higher-severity finding's. Pure. (#2158) */
function mergeSameLineFindings(first: InlineFinding, next: InlineFinding): InlineFinding {
  const nextStronger = INLINE_SEVERITY_ORDER[next.severity] > INLINE_SEVERITY_ORDER[first.severity];
  const strong = nextStronger ? next : first;
  const weak = nextStronger ? first : next;
  const suggestion = strong.suggestion ?? weak.suggestion;
  const category = strong.category ?? weak.category;
  const endLine = strong.endLine ?? weak.endLine;
  return {
    path: first.path,
    line: first.line,
    severity: strong.severity,
    body: strong.body,
    ...(suggestion ? { suggestion } : {}),
    ...(category ? { category } : {}),
    ...(endLine != null ? { endLine } : {}),
  };
}

export function composeInlineFindings(reviews: ModelReview[]): InlineFinding[] {
  // MERGE (not drop) findings that two reviewers anchored to the same (path, line): keep the max severity and any
  // suggestion/category, so a consensus line surfaces once with the strongest note instead of silently losing the
  // second reviewer's detail (#2158). Map insertion order = first-seen order; the cap bounds DISTINCT lines.
  const byLine = new Map<string, InlineFinding>();
  for (const finding of reviews.flatMap((r) => r.inlineFindings)) {
    const safeBody = toPublicSafe(finding.body);
    if (!safeBody) continue;
    const safeSuggestion = toPublicSafe(finding.suggestion);
    const candidate: InlineFinding = {
      path: finding.path,
      line: finding.line,
      severity: finding.severity,
      body: safeBody,
      ...(safeSuggestion ? { suggestion: safeSuggestion } : {}),
      // `category` is a fixed enum literal (never free text), so it carries through as-is — no public-safe
      // scrubbing needed, unlike body/suggestion.
      ...(finding.category ? { category: finding.category } : {}),
      ...(finding.endLine != null ? { endLine: finding.endLine } : {}),
    };
    const key = `${finding.path}:${finding.line}`;
    const existing = byLine.get(key);
    if (existing) {
      byLine.set(key, mergeSameLineFindings(existing, candidate));
    } else if (byLine.size < INLINE_FINDINGS_LIMIT) {
      byLine.set(key, candidate);
    }
  }
  return [...byLine.values()];
}

/** Ascending order for {@link ImprovementMagnitude} (#4743) — used ONLY to pick the more conservative (lower)
 *  of two dual-review opinions in {@link composeImprovementSignal}. Never itself surfaced, never a gate input. */
const IMPROVEMENT_MAGNITUDE_ORDER: Record<ImprovementMagnitude, number> = {
  unclear: 0,
  minor: 1,
  moderate: 2,
  significant: 3,
};

/**
 * Compose the public-safe, combined improvement/value judgment from one or two model reviews (#4743) — the
 * ordinal-value counterpart of {@link composeAdvisoryNotes}. ADVISORY ONLY, never a gate input (see
 * `signals/slop.ts` for the one deterministic system allowed to gate).
 *
 * Dual-review combination (documented behavior, #dual-ai-combiner): when BOTH reviewers emitted a
 * `valueAssessment`, this takes the MORE CONSERVATIVE (lower) of the two magnitudes rather than averaging or
 * surfacing both — consistent with this signal's "advisory, never overstate" posture: overclaiming a change's
 * value is the riskier direction to err toward (it could nudge a maintainer to wave through something that
 * is not actually well-targeted), while understating it costs nothing since a human still makes the final call.
 * The rationale carried is always the ONE from whichever reviewer supplied the chosen (lower, or tied) band, so
 * the cited reason matches the surfaced magnitude — never a blended sentence attributed to no one. A single
 * opinion (one reviewer configured, `mode: "advisory"` which never runs a second opinion, or the other
 * reviewer's call failing/omitting the field) is used as-is. Null when no reviewer emitted a usable judgment, or
 * when the chosen one's rationale fails the public-safe check (dropped whole, never partially redacted — same
 * fail-safe discipline as `consensusDefectOf`/`synthesizeDefect`).
 */
export function composeImprovementSignal(
  reviews: ReadonlyArray<ModelReview>,
): { magnitude: ImprovementMagnitude; rationale: string } | null {
  const opinions = reviews
    .map((review) => review.valueAssessment)
    .filter((v): v is { magnitude: ImprovementMagnitude; rationale: string } => Boolean(v));
  if (opinions.length === 0) return null;
  const chosen = opinions.reduce((lowest, candidate) =>
    IMPROVEMENT_MAGNITUDE_ORDER[candidate.magnitude] < IMPROVEMENT_MAGNITUDE_ORDER[lowest.magnitude]
      ? candidate
      : lowest,
  );
  const rationale = toPublicSafe(chosen.rationale);
  if (!rationale) return null; // unsafe rationale → drop the whole judgment, fail-safe (never a partial note)
  return { magnitude: chosen.magnitude, rationale };
}

/** A CONSENSUS defect = BOTH reviews independently name at least one concrete blocker (the severity-disciplined
 *  reviewbot model: a lone blocker in a dual review is a split, not a hard block). Requiring two independent
 *  models to AGREE is itself the precision mechanism; the calibrated confidence (#8) — a consensus is only as
 *  strong as its WEAKER reviewer, so the defect carries `min(a.confidence, b.confidence)` — feeds the gate's
 *  `aiReviewLowConfidenceDisposition` (#4603): the defect always blocks under `aiReviewGateMode: block`, but a
 *  sub-`aiReviewCloseConfidence`-floor confidence changes what happens next (manual-review hold by default,
 *  non-blocking under `advisory_only`, or ignored under `one_shot`) rather than adding a second floor on top of
 *  the block decision itself. */
export function consensusDefectOf(
  a: ModelReview,
  b: ModelReview,
): AiConsensusDefect | null {
  if (a.blockers.length === 0 || b.blockers.length === 0) return null;
  const title = toPublicSafe(
    a.blockers[0] ||
      b.blockers[0] ||
      "AI reviewers agree on a likely blocking defect",
  );
  if (!title) return null; // unsafe title → drop the block entirely (fail-safe)
  // Cite ONLY the primary blocker (not every finding joined together) so the Gate's "why blocked" reason
  // stays focused on the single core defect instead of repeating the whole blockers list. (#focused-reviews)
  const detail =
    toPublicSafe(a.blockers[0] || b.blockers[0] || "") ??
    "Both AI reviewers independently flagged a concrete must-fix defect in this change.";
  // The consensus is only as strong as the WEAKER reviewer: take the minimum of the two confidences (#8).
  return { title, detail, confidence: Math.min(a.confidence, b.confidence) };
}

/** Verdict returned by the dual-AI tie-break judge (#2997). `reviewer_0`/`reviewer_1` are presentation-order
 *  slots in THAT call's prompt — compare across swapped orderings with `dualAiTieBreakVerdictsOrderStable`. */
export type DualAiTieBreakVerdict =
  | "reviewer_0"
  | "reviewer_1"
  | "consensus"
  | "inconclusive";

const TIE_BREAK_JUDGE_SYSTEM_PROMPT = [
  "You are an impartial judge resolving a disagreement between two AI code reviewers of the same pull request.",
  "Respond with ONLY a JSON object of this exact shape (no prose, no code fence):",
  '{"favored":"reviewer_0|reviewer_1|consensus|inconclusive","consensusTitle"?:string}',
  "- reviewer_0: trust the FIRST reviewer's blockers; dismiss the second reviewer's conflicting opinion.",
  "- reviewer_1: trust the SECOND reviewer's blockers.",
  "- consensus: BOTH reviewers identify the same must-fix defect — name it in consensusTitle.",
  "- inconclusive: you cannot confidently adjudicate the disagreement.",
].join(" ");

/** True when the two independent reviewer opinions disagree enough to need a tie-break judge (#2997). */
export function dualAiReviewersDisagree(a: ModelReview, b: ModelReview): boolean {
  const aBlocked = a.blockers.some((blocker) => blocker.trim().length > 0);
  const bBlocked = b.blockers.some((blocker) => blocker.trim().length > 0);
  if (aBlocked !== bBlocked) return true;
  if (!aBlocked) return false;
  const aPrimary =
    a.blockers.map((blocker) => blocker.trim()).find((blocker) => blocker.length > 0) ?? "";
  const bPrimary =
    b.blockers.map((blocker) => blocker.trim()).find((blocker) => blocker.length > 0) ?? "";
  return aPrimary !== bPrimary;
}

export function parseDualAiTieBreakJudgeResponse(text: string): {
  verdict: DualAiTieBreakVerdict;
  consensusTitle?: string;
} | null {
  const json = extractLastJsonObject(text);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { favored?: unknown; consensusTitle?: unknown };
    const favored = typeof parsed.favored === "string" ? parsed.favored.trim() : "";
    const consensusTitle =
      typeof parsed.consensusTitle === "string"
        ? (toPublicSafe(parsed.consensusTitle) ?? undefined)
        : undefined;
    if (
      favored === "reviewer_0" ||
      favored === "reviewer_1" ||
      favored === "consensus" ||
      favored === "inconclusive"
    ) {
      return {
        verdict: favored,
        ...(consensusTitle && favored === "consensus" ? { consensusTitle } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** True when two tie-break judge calls (normal vs swapped presentation order) favor the same physical outcome. */
export function dualAiTieBreakVerdictsOrderStable(
  normalOrder: { verdict: DualAiTieBreakVerdict; consensusTitle?: string | undefined },
  swappedOrder: { verdict: DualAiTieBreakVerdict; consensusTitle?: string | undefined },
): boolean {
  if (normalOrder.verdict === "inconclusive" || swappedOrder.verdict === "inconclusive") {
    return normalOrder.verdict === "inconclusive" && swappedOrder.verdict === "inconclusive";
  }
  if (normalOrder.verdict === "consensus" && swappedOrder.verdict === "consensus") {
    const a = (normalOrder.consensusTitle ?? "").trim().toLowerCase();
    const b = (swappedOrder.consensusTitle ?? "").trim().toLowerCase();
    if (!a || !b) return false;
    return a === b;
  }
  if (normalOrder.verdict === "consensus" || swappedOrder.verdict === "consensus") return false;
  // Same physical reviewer: normal slot 0 ↔ swapped slot 1 (and vice versa).
  return (
    (normalOrder.verdict === "reviewer_0" && swappedOrder.verdict === "reviewer_1") ||
    (normalOrder.verdict === "reviewer_1" && swappedOrder.verdict === "reviewer_0")
  );
}

/** Gate a tie-break resolution on order-swapped stability (#2997). Unstable → inconclusive (caller applies fallback). */
export function resolveOrderSwappedDualAiTieBreakVerdict(input: {
  normalOrder: { verdict: DualAiTieBreakVerdict; consensusTitle?: string | undefined };
  swappedOrder: { verdict: DualAiTieBreakVerdict; consensusTitle?: string | undefined };
}): {
  stable: boolean;
  verdict: DualAiTieBreakVerdict;
  consensusTitle?: string | undefined;
} {
  if (!dualAiTieBreakVerdictsOrderStable(input.normalOrder, input.swappedOrder)) {
    return { stable: false, verdict: "inconclusive" };
  }
  return {
    stable: true,
    verdict: input.normalOrder.verdict,
    ...(input.normalOrder.consensusTitle
      ? { consensusTitle: input.normalOrder.consensusTitle }
      : {}),
  };
}

/** Map a swap-stable tie-break verdict into the combineReviews result shape (#2997). */
export function mapDualAiTieBreakVerdictToCombineResult(
  reviews: ReadonlyArray<ModelReview>,
  verdict: DualAiTieBreakVerdict,
  consensusTitle?: string | undefined,
): {
  defect: AiConsensusDefect | null;
  split: boolean;
  inconclusive: boolean;
  splitConfidence?: number;
} {
  const [a, b] = reviews;
  if (!a || !b) return { defect: null, split: false, inconclusive: true };
  if (verdict === "inconclusive") {
    return combineReviews([a, b], { strategy: "consensus" });
  }
  if (verdict === "consensus") {
    const defect = consensusDefectOf(a, b);
    if (defect) return { defect, split: false, inconclusive: false };
    if (consensusTitle) {
      const safe = toPublicSafe(consensusTitle);
      if (safe) {
        return {
          defect: {
            title: safe,
            detail: safe,
            confidence: Math.min(a.confidence, b.confidence),
          },
          split: false,
          inconclusive: false,
        };
      }
    }
    return combineReviews([a, b], { strategy: "consensus" });
  }
  const favored = verdict === "reviewer_0" ? a : b;
  const favoredBlocked = favored.blockers.some((blocker) => blocker.trim().length > 0);
  if (favoredBlocked) {
    return {
      defect: synthesizeDefect([favored]),
      split: false,
      inconclusive: false,
    };
  }
  // Judge sided with a clean reviewer — trust the pass even when the other reviewer flagged.
  return { defect: null, split: false, inconclusive: false };
}

function buildDualAiTieBreakJudgeUserPrompt(
  reviewA: ModelReview,
  reviewB: ModelReview,
  swapped: boolean,
): string {
  const first = swapped ? reviewB : reviewA;
  const second = swapped ? reviewA : reviewB;
  const summarize = (review: ModelReview) =>
    JSON.stringify({
      assessment: review.assessment,
      blockers: review.blockers,
      confidence: review.confidence,
    });
  return `Reviewer 0:\n${summarize(first)}\n\nReviewer 1:\n${summarize(second)}`;
}

/** One tie-break judge call with the two reviewer opinions in the given presentation order (#2997). */
async function runDualAiTieBreakJudgeCall(
  env: Env,
  model: string,
  fallback: string,
  reviewA: ModelReview,
  reviewB: ModelReview,
  swapped: boolean,
  diagnostics: AiReviewDiagnostic[],
  correlation?: AiRunCorrelation,
  // Pixel-diff-confirmed screenshot(s) (#4111): when the two reviewers SPLIT on a visual-capture PR, the judge
  // gets the SAME images the reviewers saw so its verdict isn't text-only reasoning about a visual defect.
  // Absent for every existing caller — byte-identical `content: user` string.
  images?: readonly AiContentBlock[] | undefined,
): Promise<{ verdict: DualAiTieBreakVerdict; consensusTitle?: string | undefined } | null> {
  const ai = env.AI as unknown as AiRunner | undefined;
  if (!ai || typeof ai.run !== "function") return null;
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  const extra: AiGatewayOptions | undefined = gatewayId
    ? { gateway: { id: gatewayId } }
    : undefined;
  const user = buildDualAiTieBreakJudgeUserPrompt(reviewA, reviewB, swapped);
  const models = fallback && fallback !== model ? [model, fallback] : [model];
  for (const [modelIndex, activeModel] of models.entries()) {
    if (modelIndex > 0) {
      incr("gittensory_ai_review_model_fallback_total", { primary: model, fallback: activeModel });
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await ai.run(
          activeModel,
          {
            max_tokens: 512,
            temperature: 0,
            messages: [
              { role: "system", content: TIE_BREAK_JUDGE_SYSTEM_PROMPT },
              { role: "user", content: toContentBlocks(user, images) },
            ],
            ...(correlation?.jobId !== undefined ? { jobId: correlation.jobId } : {}),
            ...(correlation?.repoFullName !== undefined
              ? { repoFullName: correlation.repoFullName }
              : {}),
            ...(correlation?.pullNumber !== undefined ? { pullNumber: correlation.pullNumber } : {}),
            attempt,
            // #5046: same reasoning as runWorkersOpinion above -- only the truly last attempt escalates the
            // provider's own error log to Sentry.
            finalAttempt: attempt === 2 && modelIndex === models.length - 1,
          },
          extra,
        );
        const text = coerceAiText(result);
        const usage = coerceAiUsage(result);
        const usageFields = usage ? { usage } : {};
        const parsed = parseDualAiTieBreakJudgeResponse(text);
        if (parsed) {
          diagnostics.push({
            model: activeModel,
            attempt,
            status: "parsed",
            responseChars: text.length,
            hasJsonObject: Boolean(extractLastJsonObject(text)),
            ...usageFields,
          });
          return parsed;
        }
        diagnostics.push({
          model: activeModel,
          attempt,
          status: "unparseable_output",
          responseChars: text.length,
          hasJsonObject: Boolean(extractLastJsonObject(text)),
          ...usageFields,
        });
      } catch (error) {
        diagnostics.push({
          model: activeModel,
          attempt,
          status: "provider_error",
          error: errorMessage(error),
        });
        // See runWorkersOpinion's identical guard: a CLI timeout will not resolve by retrying the same model.
        if (isSubscriptionCliTimeout(error)) break;
      }
    }
  }
  return null;
}

/** Run the tie-break judge twice (normal + swapped order) and accept only swap-stable resolutions (#2997). */
async function resolveDualAiTieBreakWithOrderStability(input: {
  env: Env;
  model: string;
  fallback: string;
  reviewA: ModelReview;
  reviewB: ModelReview;
  diagnostics: AiReviewDiagnostic[];
  correlation?: AiRunCorrelation | undefined;
  // Pixel-diff-confirmed screenshot(s) (#4111), handed to BOTH the normal- and swapped-order judge calls so
  // the order-swap stability check still compares the SAME visual evidence either way. Absent for every
  // existing caller — byte-identical to today.
  images?: readonly AiContentBlock[] | undefined;
}): Promise<{
  stable: boolean;
  verdict: DualAiTieBreakVerdict;
  consensusTitle?: string | undefined;
  /** True only when both judge calls parsed but disagreed across orderings (#2997). */
  orderUnstable: boolean;
}> {
  const normalOrder = await runDualAiTieBreakJudgeCall(
    input.env,
    input.model,
    input.fallback,
    input.reviewA,
    input.reviewB,
    false,
    input.diagnostics,
    input.correlation,
    input.images,
  );
  const swappedOrder = await runDualAiTieBreakJudgeCall(
    input.env,
    input.model,
    input.fallback,
    input.reviewA,
    input.reviewB,
    true,
    input.diagnostics,
    input.correlation,
    input.images,
  );
  if (!normalOrder || !swappedOrder) {
    return { stable: false, verdict: "inconclusive", orderUnstable: false };
  }
  const resolved = resolveOrderSwappedDualAiTieBreakVerdict({ normalOrder, swappedOrder });
  return { ...resolved, orderUnstable: !resolved.stable };
}

/** Deterministic SYNTHESIS of one public-safe defect from the reviews that named a blocker — same public-safe
 *  discipline as `consensusDefectOf` (cite the primary blocker; an unsafe title drops the whole block, fail-safe).
 *  Used by the `synthesis` and `single` combine strategies. The defect carries the CONFIDENCE of the reviewer that
 *  supplied the cited primary blocker (#8) — for `single` that is that one reviewer's confidence. */
function synthesizeDefect(
  reviews: ReadonlyArray<ModelReview>,
): AiConsensusDefect | null {
  // Find the FIRST reviewer with a non-blank blocker so the cited title + the carried confidence come from the
  // SAME reviewer (a flat-map would divorce the blocker text from its reviewer's confidence).
  const source = reviews.find((r) =>
    r.blockers.some((b) => b.trim().length > 0),
  );
  const primary = source?.blockers
    .map((b) => b.trim())
    .find((b) => b.length > 0);
  if (!source || !primary) return null;
  const title = toPublicSafe(primary);
  if (!title) return null; // unsafe title → drop the block entirely (fail-safe)
  // cite the primary blocker as both title + detail; confidence = the flagging reviewer's calibrated confidence.
  return { title, detail: title, confidence: source.confidence };
}

/** Combine the independent reviewer opinions into ONE gate decision per the configured strategy (#dual-ai-combiner).
 *  `reviews` carries one slot per reviewer; a slot is `null` when that reviewer errored or returned unparseable
 *  output. Returns the gate-relevant trio: a `defect` (→ blocker), `split` (reviewers disagree → HOLD), and
 *  `inconclusive` (cannot certify → HOLD). FAIL-CLOSED: in every strategy, a missing opinion we needed to clear
 *  the change yields `inconclusive` rather than a silent pass. The `consensus` branch is byte-identical to the
 *  historical block-mode logic, so an unset strategy never changes the gate. */
export function combineReviews(
  reviews: ReadonlyArray<ModelReview | null>,
  opts: { strategy: CombineStrategy; onMerge?: OnMerge | null | undefined },
): {
  defect: AiConsensusDefect | null;
  split: boolean;
  inconclusive: boolean;
  /** The lone-flagging reviewer's calibrated confidence when `split` is true (#8); absent otherwise. */
  splitConfidence?: number;
} {
  const present = reviews.filter((r): r is ModelReview => Boolean(r));
  const missing = reviews.length - present.length;

  if (opts.strategy === "single") {
    // One reviewer: its verdict IS the decision (no second opinion to require). A named blocker blocks; a
    // missing review can't certify the change → hold.
    const r = present[0];
    if (!r) return { defect: null, split: false, inconclusive: true };
    return {
      defect: r.blockers.length > 0 ? synthesizeDefect([r]) : null,
      split: false,
      inconclusive: false,
    };
  }

  if (opts.strategy === "synthesis") {
    // Both run separately, then merge into ONE decision — never a split/hold-on-disagreement.
    const flagged = present.filter((r) => r.blockers.length > 0);
    if ((opts.onMerge ?? "either") === "both") {
      // Block only when EVERY expected reviewer is present AND each named a blocker.
      if (missing > 0)
        return { defect: null, split: false, inconclusive: true };
      const all = present.length > 0 && flagged.length === present.length;
      return {
        defect: all ? synthesizeDefect(present) : null,
        split: false,
        inconclusive: false,
      };
    }
    // `either`: any present reviewer's blocker blocks. With no present blocker but a missing opinion we cannot
    // certify the change is clean → hold (fail-closed).
    if (flagged.length > 0)
      return {
        defect: synthesizeDefect(flagged),
        split: false,
        inconclusive: false,
      };
    return { defect: null, split: false, inconclusive: missing > 0 };
  }

  // `consensus` (default) — the historical block-mode pair logic, now ALSO surfacing the split's confidence (#8).
  const [a, b] = reviews;
  if (a && b) {
    const defect = consensusDefectOf(a, b);
    const split = !defect && a.blockers.length > 0 !== b.blockers.length > 0;
    // On a split, exactly one reviewer flagged a blocker — carry THAT reviewer's confidence so the
    // `ai_review_split` finding gates on the same calibrated floor a consensus defect would.
    return split
      ? {
          defect,
          split,
          inconclusive: false,
          splitConfidence: a.blockers.length > 0 ? a.confidence : b.confidence,
        }
      : { defect, split, inconclusive: false };
  }
  return { defect: null, split: false, inconclusive: true };
}

/**
 * Run the AI maintainer review. Returns advisory notes (always, when AI is on) and — in `block` mode —
 * a consensus defect when the free Workers-AI pair agrees with high confidence. Fail-safe on every error
 * path: no notes, no defect, never a thrown error reaching the webhook.
 */
export async function runGittensoryAiReview(
  env: Env,
  input: GittensoryAiReviewInput,
): Promise<GittensoryAiReviewResult> {
  if (!isEnabled(env.AI_SUMMARIES_ENABLED))
    return { status: "disabled", reason: "AI summaries are disabled." };
  if (!isEnabled(env.AI_PUBLIC_COMMENTS_ENABLED))
    return { status: "disabled", reason: "Public AI comments are disabled." };
  if (!env.AI)
    return {
      status: "unavailable",
      reason: "AI provider is not configured.",
    };

  // Output ceiling for the review. The old 1024 cap forced a shallow "no blockers" scorecard across large diffs;
  // a thorough finding-by-finding review needs real room. Default 4096, max 8192 (the configured reviewer —
  // self-host Codex/Claude Code or the legacy free Workers-AI 120B pair — supports it); an explicit env value
  // still wins, clamped. (#extensive-reviews)
  const maxTokens = clampNumber(
    Number(env.AI_MAX_OUTPUT_TOKENS) || 4096,
    512,
    8192,
  );
  // Safety (convergence, flag-gated): defang the UNTRUSTED, author-controlled title/body/diff so a
  // prompt-injection payload never reaches the model verbatim. Flag-OFF (default) passes `input` through
  // unchanged → the prompt is byte-identical to today. Only the title/body/diff fed to buildUserPrompt are
  // affected; this NEVER changes the verdict (a redaction is data, not a finding).
  // Per-repo feature override (phase 2): the defang activates when the global GITTENSORY_REVIEW_SAFETY kill-switch
  // is ON and the repo's container-private `.gittensory.yml` `features.safety` opts in — falling back to the
  // GITTENSORY_REVIEW_REPOS allowlist when the manifest says nothing (byte-identical default).
  const promptInput = (await convergedFeatureActive(
    env,
    input.repoFullName,
    "safety",
  ))
    ? { ...input, ...defangReviewInput(input) }
    : input;
  const user = buildUserPrompt(promptInput);
  // Grounding-discipline SYSTEM suffix (convergence, flag-gated). When the caller supplied grounding, the
  // reviewers are told to verify claims against the attached CI/files; otherwise this is REVIEW_SYSTEM_PROMPT
  // unchanged (byte-identical). Computed from `promptInput` so it travels with the (possibly defanged) input.
  const system = buildSystemPrompt(promptInput);
  const repoInstructionsSystemAppend = buildRepoInstructionsSystemAppend(promptInput.repoInstructions);
  // The daily neuron budget governs FREE/default-reviewer spend only. BYOK advisory calls bill the maintainer's
  // own provider account, so they are not counted here (and a BYOK advisory still runs when the free
  // budget is exhausted). Free calls = the consensus pair in block mode (the configured self-host reviewers,
  // or the legacy Workers-AI pair when none is configured), plus the advisory leg only when it is NOT BYOK.
  // Reviewers + combine strategy (#dual-ai-combiner). DEFAULT = the legacy Workers-AI pair (per-slot fallbacks)
  // combined by `consensus` — byte-identical to today. The self-host boot plan (`env.AI_REVIEW_PLAN`) supplies
  // named providers (e.g. claude-code + codex) and a strategy; an explicit `input` field overrides it. `single`
  // (or a single configured reviewer) runs ONE opinion; consensus/synthesis run two.
  //
  // combine/onMerge/reviewers are a per-repo REFINEMENT of the operator's plan, never a bypass (#2567): a repo
  // can only TIGHTEN the operator's `either` floor, never loosen it by shrinking the reviewer count or
  // switching to `combine: "single"` either (a floor of "either ONE of two reviewers can flag it" is just as
  // bypassed by dropping to one reviewer as by flipping onMerge itself). resolveEffectiveAiReviewPlan enforces
  // the clamp across all three fields together; a fired clamp increments a metric so it is surfaced, not
  // silently ignored (mirrors the gittensory_ai_review_inconclusive_total pattern below).
  const plan = env.AI_REVIEW_PLAN;
  const planResolution = resolveEffectiveAiReviewPlan(
    { combine: input.combine, onMerge: input.onMerge, reviewers: input.reviewers },
    plan,
  );
  const configured: ReadonlyArray<{
    model: string;
    fallback?: string | null | undefined;
  }> | null = planResolution.reviewers?.length ? planResolution.reviewers : null;
  const primary = configured?.[0] ?? {
    model: BEST_REVIEW_MODELS[0],
    fallback: RELIABLE_FALLBACK_MODELS[0] as string | null,
  };
  const secondary = configured?.[1] ?? {
    model: BEST_REVIEW_MODELS[1],
    fallback: RELIABLE_FALLBACK_MODELS[1] as string | null,
  };
  // Per-slot fallback model (Workers-AI default pair has one; a self-host provider has none → reuse its own model,
  // i.e. runWorkersOpinion's single-model path).
  const primaryFallback = primary.fallback ?? primary.model;
  const secondaryFallback = secondary.fallback ?? secondary.model;
  const combine: CombineStrategy = planResolution.combine ?? "consensus";
  const onMerge = planResolution.onMerge;
  if (planResolution.clamped) {
    incr("gittensory_ai_review_onmerge_clamped_total", { mode: input.mode });
  }
  const dual = combine !== "single" && (!configured || configured.length > 1);
  const freeAiCalls =
    (input.mode === "block" ? (dual ? 2 : 1) : 0) + (input.providerKey ? 0 : 1);
  // Consensus disagreements may spend extra free calls on the order-swapped tie-break judge. Reserve the
  // worst-case retry budget up front so the daily limiter remains a hard cap even when judge output is unstable.
  const tieBreakAiCalls =
    input.mode === "block" && dual && combine === "consensus"
      ? 2 * 3 * (primaryFallback && primaryFallback !== primary.model ? 2 : 1)
      : 0;
  // Estimate against the EFFECTIVE system prompt (`system`) so grounding's extra context is billed against the
  // budget. Flag-OFF, `system === REVIEW_SYSTEM_PROMPT`, so the estimate is byte-identical to today.
  const estimatedNeurons =
    (freeAiCalls === 0
      ? 0
      : estimateNeurons(system.length + user.length, maxTokens, freeAiCalls)) +
    (tieBreakAiCalls === 0
      ? 0
      : estimateNeurons(system.length + user.length, 512, tieBreakAiCalls));
  // FAIL-SAFE default (#budget-no-starve): the daily neuron budget is a runaway-LOOP backstop, not a normal-
  // operation gate. An absent/empty/non-numeric env var must default HIGH (the clamp max), never to a tiny value
  // that silently starves every dual-AI review into quota_exceeded — that exact misconfig (the deployed worker
  // read the 10k free-tier default off `main` while this branch said 2M) blocked all reviews. An EXPLICIT value
  // (including "0" to deliberately disable) still wins; only unset/empty/NaN falls back to the safe maximum.
  const rawNeuronBudget = Number(env.AI_DAILY_NEURON_BUDGET);
  const budget = clampNumber(
    env.AI_DAILY_NEURON_BUDGET && Number.isFinite(rawNeuronBudget)
      ? rawNeuronBudget
      : 10_000_000,
    0,
    10_000_000,
  );
  const used = await sumAiEstimatedNeuronsSince(env, utcDayStartIso());
  const remainingBudget = Math.max(0, budget - used);
  if (estimatedNeurons > remainingBudget) {
    await record(
      env,
      input,
      "quota_exceeded",
      0,
      `estimated ${estimatedNeurons} neurons exceeds remaining ${remainingBudget}`,
    );
    return { status: "quota_exceeded", estimatedNeurons, remainingBudget };
  }

  if (input.providerKey) {
    const byokDailyLimit = clampNumber(
      Number(env.AI_BYOK_DAILY_REPO_LIMIT || DEFAULT_BYOK_DAILY_REPO_LIMIT),
      0,
      10_000,
    );
    const byokUsed = await countByokAiEventsForRepoSince(
      env,
      input.repoFullName,
      utcDayStartIso(),
    );
    if (byokUsed >= byokDailyLimit) {
      await record(
        env,
        input,
        "quota_exceeded",
        0,
        `BYOK daily repo limit ${byokDailyLimit} reached`,
      );
      return { status: "quota_exceeded", estimatedNeurons, remainingBudget };
    }
  }

  // Advisory write-up: BYOK frontier model if configured, else the free Workers-AI primary (with fallback).
  let byokFailure: ProviderFailure | undefined;
  let advisoryReview: ModelReview | null;
  const reviewDiagnostics: AiReviewDiagnostic[] = [];
  const fallbackNotes: string[] = [];
  // jobId/repoFullName/pullNumber: forwarded to a self-host provider's failure log (#codex-timeout-fields) —
  // never anything BYOK-billed reads. claudeModel/claudeEffort/codexModel/codexEffort (#selfhost-ai-model-
  // override): the per-repo manifest override, read by the matching self-host provider's own request logic.
  const aiRunCorrelation: AiRunCorrelation = {
    jobId: input.jobId,
    repoFullName: input.repoFullName,
    pullNumber: input.prNumber,
    claudeModel: input.claudeModel ?? undefined,
    claudeEffort: input.claudeEffort ?? undefined,
    codexModel: input.codexModel ?? undefined,
    codexEffort: input.codexEffort ?? undefined,
    ollamaModel: input.ollamaModel ?? undefined,
    openaiModel: input.openaiModel ?? undefined,
    openaiCompatibleModel: input.openaiCompatibleModel ?? undefined,
    anthropicModel: input.anthropicModel ?? undefined,
  };
  if (input.providerKey) {
    const outcome = await runProviderReview(
      input.providerKey,
      system,
      user,
      maxTokens,
    );
    advisoryReview = outcome.review;
    byokFailure = outcome.failure;
    if (outcome.fallbackNote) fallbackNotes.push(outcome.fallbackNote);
    reviewDiagnostics.push(outcome.diagnostic!);
  } else {
    const outcome = await runWorkersOpinion(
      env,
      primary.model,
      primaryFallback,
      system,
      user,
      maxTokens,
      reviewDiagnostics,
      repoInstructionsSystemAppend,
      aiRunCorrelation,
    );
    advisoryReview = outcome.review;
    if (outcome.fallbackNote) fallbackNotes.push(outcome.fallbackNote);
  }

  let consensusDefect: AiConsensusDefect | null = null;
  let secondReview: ModelReview | null = null;
  let aiReviewSplit = false;
  let splitConfidence: number | undefined;
  let inconclusive = false;
  if (input.mode === "block") {
    if (dual) {
      // Two independent reviewers (the free Workers-AI pair by default — provider-independent, never BYOK — or the
      // configured provider pair on self-host). Reuse the advisory leg's review as the first opinion when it
      // already ran it (non-BYOK), instead of paying for it twice.
      const [a, b] = await Promise.all([
        input.providerKey
          ? runWorkersOpinion(
              env,
              primary.model,
              primaryFallback,
              system,
              user,
              maxTokens,
              reviewDiagnostics,
              repoInstructionsSystemAppend,
              aiRunCorrelation,
            )
          : Promise.resolve<ReviewerOpinionOutcome>({ review: advisoryReview }),
        runWorkersOpinion(
          env,
          secondary.model,
          secondaryFallback,
          system,
          user,
          maxTokens,
          reviewDiagnostics,
          repoInstructionsSystemAppend,
          aiRunCorrelation,
        ),
      ]);
      if (a.fallbackNote) fallbackNotes.push(a.fallbackNote);
      if (b.fallbackNote) fallbackNotes.push(b.fallbackNote);
      secondReview = b.review;
      // Combine per the configured strategy (#dual-ai-combiner). Default `consensus` is byte-identical to the
      // historical logic: block only on agreement, lone blocker → split, a missing opinion → inconclusive
      // (fail-closed, HELD for a human). `synthesis` merges both into one decision (no split/hold-on-disagree).
      // On reviewer disagreement in `consensus` mode, run the tie-break judge twice (order-swapped) and accept
      // only swap-stable resolutions (#2997); unstable or inconclusive → conservative combineReviews fallback.
      let combined = combineReviews([a.review, b.review], { strategy: combine, onMerge });
      if (
        combine === "consensus" &&
        a.review &&
        b.review &&
        dualAiReviewersDisagree(a.review, b.review)
      ) {
        const tieBreak = await resolveDualAiTieBreakWithOrderStability({
          env,
          model: primary.model,
          fallback: primaryFallback,
          reviewA: a.review,
          reviewB: b.review,
          diagnostics: reviewDiagnostics,
          correlation: aiRunCorrelation,
        });
        if (tieBreak.orderUnstable) {
          incr("gittensory_ai_review_tiebreak_order_unstable_total", { mode: input.mode });
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "ai_review_tiebreak_order_unstable",
              repoFullName: input.repoFullName,
              pullNumber: input.prNumber,
            }),
          );
        } else if (tieBreak.verdict !== "inconclusive") {
          combined = mapDualAiTieBreakVerdictToCombineResult(
            [a.review, b.review],
            tieBreak.verdict,
            tieBreak.consensusTitle,
          );
        }
      }
      consensusDefect = combined.defect;
      aiReviewSplit = combined.split;
      splitConfidence = combined.splitConfidence;
      inconclusive = combined.inconclusive;
    } else {
      // Single reviewer: its verdict IS the decision. Reuse the advisory leg (non-BYOK) or run the one reviewer.
      const a = input.providerKey
        ? await runWorkersOpinion(
            env,
            primary.model,
            primaryFallback,
            system,
            user,
            maxTokens,
            reviewDiagnostics,
            repoInstructionsSystemAppend,
            aiRunCorrelation,
          )
        : ({ review: advisoryReview } as ReviewerOpinionOutcome);
      if (a.fallbackNote) fallbackNotes.push(a.fallbackNote);
      const combined = combineReviews([a.review], { strategy: "single" });
      consensusDefect = combined.defect;
      inconclusive = combined.inconclusive;
    }
  }

  const reviewsForNotes = [advisoryReview, secondReview].filter(
    (r): r is ModelReview => Boolean(r),
  );
  if (
    reviewsForNotes.length === 0 &&
    (fallbackNotes.length > 0 ||
      reviewDiagnostics.some((diagnostic) => diagnostic.status === "unparseable_output"))
  )
    inconclusive = true;
  // Observability (#2540): the single canonical point where `inconclusive` reaches its final value for this
  // review call -- increment exactly once here, never at the downstream consumers in queue/processors.ts that
  // push an `ai_review_inconclusive` advisory finding off this same already-computed result (incrementing there
  // too would double/triple-count one review).
  if (inconclusive) incr("gittensory_ai_review_inconclusive_total", { mode: input.mode });
  const advisoryNotes =
    reviewsForNotes.length > 0
      ? (composeAdvisoryNotes(reviewsForNotes) ?? composeFallbackAdvisoryNotes(fallbackNotes))
      : composeFallbackAdvisoryNotes(fallbackNotes);
  // Line-anchored inline findings (#inline-comments): only propagate model output when the resolved feature gate
  // asked for it. AI output is PR-author-influenced, so the prompt suffix is not an authorization boundary.
  const inlineFindings = input.inlineFindings
    ? composeInlineFindings(reviewsForNotes)
    : [];
  // Improvement/value judgment (#4743): only propagate model output when the resolved feature gate asked for it —
  // same authorization discipline as inlineFindings above, and null (not computed) rather than a fallback band
  // when the feature is off, so no extra work happens on the disabled path.
  const valueAssessment = input.improvementSignal
    ? composeImprovementSignal(reviewsForNotes)
    : null;

  await record(
    env,
    input,
    "ok",
    estimatedNeurons,
    consensusDefect
      ? "consensus defect"
      : aiReviewSplit
        ? "split"
        : inconclusive
          ? "inconclusive — held"
          : advisoryNotes
            ? "advisory notes"
            : "no usable output",
    {
      mode: input.mode,
      byok: Boolean(input.providerKey),
      consensus: Boolean(consensusDefect),
      split: aiReviewSplit,
      inconclusive,
      ...(byokFailure ? { byokFailure } : {}),
    },
    aggregateActualUsage(reviewDiagnostics),
  );
  return {
    status: "ok",
    advisoryNotes,
    consensusDefect,
    split: aiReviewSplit,
    // Carry the split's calibrated confidence (#8) so the caller can apply the same `aiReviewCloseConfidence`
    // floor + `aiReviewLowConfidenceDisposition` (#4603) to `ai_review_split` as to a consensus defect. Only
    // present on a split (combineReviews leaves it undefined otherwise).
    ...(splitConfidence !== undefined ? { splitConfidence } : {}),
    inconclusive,
    estimatedNeurons,
    reviewerCount: Math.max(reviewsForNotes.length, fallbackNotes.length),
    inlineFindings,
    valueAssessment,
    reviewDiagnostics,
  };
}

/** The actual configured reviewer label for usage attribution (#1566): the self-host provider plus its explicit
 *  provider-specific model when set, else the Worker dual-AI models. Without this, self-host claude-code reviews
 *  were mis-logged as the Workers-AI model ids (`@cf/openai/gpt-oss-120b+...`), which hid outages. */
function reviewerModelLabel(env: Env, input: GittensoryAiReviewInput): string {
  const e = env as unknown as Record<string, string | undefined>;
  const reviewers = (input.reviewers?.length ? input.reviewers : env.AI_REVIEW_PLAN?.reviewers) ?? null;
  if (reviewers?.length) return labelSelfHostReviewerModels(reviewers, e);
  const providers = resolveConfiguredProviderNames(e);
  if (providers.length > 0) return labelSelfHostReviewerNames(providers, e);
  return BEST_REVIEW_MODELS.join("+");
}

function joinedUnique(values: Iterable<string | undefined>): string | undefined {
  const unique = [...new Set([...values].filter((value): value is string => Boolean(value)))];
  return unique.length > 0 ? unique.join("+") : undefined;
}

function sumUsageField(
  usages: readonly AiReviewActualUsage[],
  key: "inputTokens" | "outputTokens" | "totalTokens" | "costUsd",
): number | undefined {
  let sawValue = false;
  let total = 0;
  for (const usage of usages) {
    const value = usage[key];
    if (value === undefined) continue;
    sawValue = true;
    total += value;
  }
  return sawValue ? total : undefined;
}

function aggregateActualUsage(diagnostics: readonly AiReviewDiagnostic[]): AiReviewActualUsage | undefined {
  const usages = diagnostics.map((diagnostic) => diagnostic.usage).filter((usage): usage is AiReviewActualUsage => Boolean(usage));
  if (usages.length === 0) return undefined;
  const inputTokens = sumUsageField(usages, "inputTokens");
  const outputTokens = sumUsageField(usages, "outputTokens");
  let sawTotalTokens = false;
  let totalTokensSum = 0;
  for (const usage of usages) {
    const total =
      usage.totalTokens ??
      (usage.inputTokens !== undefined || usage.outputTokens !== undefined
        ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        : undefined);
    if (total === undefined) continue;
    sawTotalTokens = true;
    totalTokensSum += total;
  }
  return {
    provider: joinedUnique(usages.map((usage) => usage.provider)),
    model: joinedUnique(usages.map((usage) => usage.model)),
    effort: joinedUnique(usages.map((usage) => usage.effort)),
    inputTokens,
    outputTokens,
    totalTokens: sawTotalTokens ? totalTokensSum : undefined,
    costUsd: sumUsageField(usages, "costUsd"),
  };
}

async function record(
  env: Env,
  input: GittensoryAiReviewInput,
  status: string,
  estimatedNeurons: number,
  detail: string,
  metadata?: Record<string, unknown>,
  actualUsage?: AiReviewActualUsage | undefined,
): Promise<void> {
  // NEVER include provider key material in usage/audit metadata.
  await recordAiUsageEvent(env, {
    feature: "ai_review_pr",
    actor: input.actor ?? null,
    route: "github_app.ai_review",
    model: input.providerKey
      ? `byok:${input.providerKey.provider}`
      : reviewerModelLabel(env, input),
    status,
    estimatedNeurons,
    provider: actualUsage?.provider,
    effort: actualUsage?.effort,
    inputTokens: actualUsage?.inputTokens,
    outputTokens: actualUsage?.outputTokens,
    totalTokens: actualUsage?.totalTokens,
    costUsd: actualUsage?.costUsd,
    detail,
    metadata: {
      repoFullName: input.repoFullName,
      pullNumber: input.prNumber,
      ...(input.observability ?? {}),
      ...(metadata ?? {}),
    },
  });
}

export const __aiReviewInternals = {
  parseModelReview,
  parseReviewConfidence,
  parseDualAiTieBreakJudgeResponse,
  coerceAiText,
  composeAdvisoryNotes,
  composeInlineFindings,
  composeImprovementSignal,
  consensusDefectOf,
  combineReviews,
  dualAiReviewersDisagree,
  dualAiTieBreakVerdictsOrderStable,
  resolveOrderSwappedDualAiTieBreakVerdict,
  mapDualAiTieBreakVerdictToCombineResult,
  buildDualAiTieBreakJudgeUserPrompt,
  runDualAiTieBreakJudgeCall,
  resolveDualAiTieBreakWithOrderStability,
  synthesizeDefect,
  toPublicSafe,
  estimateNeurons,
  runWorkersOpinion,
  coerceAiUsage,
  aggregateActualUsage,
  buildUserPrompt,
  selectContextSectionsWithinBudget,
  AGGREGATE_CONTEXT_BUDGET_CHARS,
};
