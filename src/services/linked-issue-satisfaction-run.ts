// Linked-issue satisfaction assessment -- model-calling orchestration (#1961/#3906). This is the "separate,
// maintainer-only slice" the pure analysis core (./linked-issue-satisfaction.ts, #2172) explicitly forward-
// references in its own module doc: "That orchestration (budget, provider selection, usage accounting, and --
// eventually -- a `gate.linkedIssueSatisfaction` mode wiring) is a separate, maintainer-only slice." Mirrors
// ai-slop.ts's runGittensoryAiSlopAdvisory shape exactly (same budget/provider/retry discipline), but calls
// the pure module's own buildLinkedIssueSatisfactionResult as the single source of truth for "is this attempt's
// raw model text a valid, publishable result" -- never re-implements its parsing/confidence-floor/public-safe
// logic here.
//
// Hard guarantees (mirrors ai-slop.ts's fail-safe discipline):
//   • AI off / no binding / over-budget / every attempt unparseable -> no result, never throws.
//   • This module NEVER decides whether a result blocks the gate or how it renders -- it only returns the
//     bounded, public-safe {status, rationale} (or null). The caller (src/queue/processors.ts) decides.
import type { LinkedIssueSatisfactionResult } from "./linked-issue-satisfaction";
import { SATISFACTION_SYSTEM_PROMPT, buildLinkedIssueSatisfactionPrompt, buildLinkedIssueSatisfactionResult } from "./linked-issue-satisfaction";
import { countByokAiEventsForRepoSince, recordAiUsageEvent, sumAiEstimatedNeuronsSince } from "../db/repositories";
import {
  type AiReviewActualUsage,
  type AiReviewProviderKey,
  BEST_REVIEW_MODELS,
  DEFAULT_BYOK_DAILY_REPO_LIMIT,
  RELIABLE_FALLBACK_MODELS,
  callAiProvider,
  clampNumber,
  coerceAiText,
  coerceAiUsage,
  estimateNeurons,
  isEnabled,
  utcDayStartIso,
} from "./ai-review";

export type LinkedIssueSatisfactionRunInput = {
  repoFullName: string;
  prNumber: number;
  /** The already-fetched linked (primary) issue's title + body, joined into one text blob by the caller. */
  issueText: string | null | undefined;
  prTitle: string;
  prBody?: string | null | undefined;
  /** A bounded unified-diff-ish string (filenames + patches), built by the caller (buildAiReviewDiff). */
  diff: string;
  actor?: string | null | undefined;
  /** Optional BYOK: when present, the maintainer's frontier model writes the assessment (billed to their
   *  account, counted against the shared per-repo/day BYOK cap) instead of the free/default reviewer. */
  providerKey?: AiReviewProviderKey | null | undefined;
};

export type LinkedIssueSatisfactionRunResult =
  | { status: "disabled"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "quota_exceeded"; estimatedNeurons: number; remainingBudget: number }
  | { status: "ok"; result: LinkedIssueSatisfactionResult | null; estimatedNeurons: number };

const LINKED_ISSUE_SATISFACTION_MODELS = [BEST_REVIEW_MODELS[0], RELIABLE_FALLBACK_MODELS[0]] as const;
const LINKED_ISSUE_SATISFACTION_ATTEMPTS_PER_MODEL = 3;
const LINKED_ISSUE_SATISFACTION_MAX_CALLS = LINKED_ISSUE_SATISFACTION_MODELS.length * LINKED_ISSUE_SATISFACTION_ATTEMPTS_PER_MODEL;

type AiGatewayOptions = { gateway?: { id: string } };
type AiRunner = { run?: (model: string, options: Record<string, unknown>, extra?: AiGatewayOptions) => Promise<unknown> };

type WorkersSatisfactionOpinionResult = { result: LinkedIssueSatisfactionResult | null; usage?: AiReviewActualUsage | undefined };

/** One free/default-reviewer satisfaction opinion (whichever provider `env.AI` resolves to) with bounded
 *  retry/fallback attempts, all pre-budgeted. Each attempt's raw text is validated via the pure module's own
 *  buildLinkedIssueSatisfactionResult -- a structurally-invalid response AND a below-confidence-floor
 *  "unaddressed" call both fall through to the next attempt (the floor is re-checked fresh on every independent
 *  attempt; retrying never lowers it), so the loop only ever stops on a genuinely valid, publishable result or
 *  on exhausting every attempt. */
async function runWorkersSatisfactionOpinion(
  env: Env,
  issueText: string | null | undefined,
  system: string,
  user: string,
  maxTokens: number,
): Promise<WorkersSatisfactionOpinionResult> {
  const ai = env.AI as unknown as AiRunner | undefined;
  if (!ai || typeof ai.run !== "function") return { result: null };
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  const extra: AiGatewayOptions | undefined = gatewayId ? { gateway: { id: gatewayId } } : undefined;
  for (const model of LINKED_ISSUE_SATISFACTION_MODELS) {
    for (let attempt = 0; attempt < LINKED_ISSUE_SATISFACTION_ATTEMPTS_PER_MODEL; attempt += 1) {
      try {
        const raw = await ai.run(
          model,
          { max_tokens: maxTokens, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
          extra,
        );
        const result = buildLinkedIssueSatisfactionResult(issueText, coerceAiText(raw));
        if (result) return { result, usage: coerceAiUsage(raw) };
      } catch {
        /* retry / fall through to fallback */
      }
    }
  }
  return { result: null };
}

/**
 * Run the linked-issue satisfaction assessment. Returns the bounded, public-safe result (or null) plus the
 * estimated neuron spend. Fail-safe on every path: no result and no thrown error ever reaches the caller.
 */
export async function runGittensoryLinkedIssueSatisfaction(env: Env, input: LinkedIssueSatisfactionRunInput): Promise<LinkedIssueSatisfactionRunResult> {
  if (!isEnabled(env.AI_SUMMARIES_ENABLED)) return { status: "disabled", reason: "AI summaries are disabled." };
  if (!isEnabled(env.AI_PUBLIC_COMMENTS_ENABLED)) return { status: "disabled", reason: "Public AI comments are disabled." };
  if (!env.AI) return { status: "unavailable", reason: "AI provider is not configured." };
  // Fail-safe (mirrors buildLinkedIssueSatisfactionResult's own contract): no issue text means there is
  // nothing to assess, so short-circuit before spending any budget or making a model call.
  if (!(input.issueText ?? "").trim()) return { status: "ok", result: null, estimatedNeurons: 0 };

  const maxTokens = clampNumber(Number(env.AI_MAX_OUTPUT_TOKENS || 256), 256, 1024);
  const user = buildLinkedIssueSatisfactionPrompt({
    issueText: input.issueText,
    prTitle: input.prTitle,
    prBody: input.prBody,
    diff: input.diff,
  });
  // BYOK bills the maintainer's own account (separate per-repo/day cap shared with AI review + slop). Free/
  // default-reviewer retry/fallback attempts are pre-budgeted at their worst case so malformed output or
  // transient failures cannot amplify spend beyond the daily neuron budget. This draws from the SAME shared
  // daily neuron counter as AI review + AI slop (sumAiEstimatedNeuronsSince has no per-feature scope).
  const freeCalls = input.providerKey ? 0 : LINKED_ISSUE_SATISFACTION_MAX_CALLS;
  const estimatedNeurons = freeCalls === 0 ? 0 : estimateNeurons(SATISFACTION_SYSTEM_PROMPT.length + user.length, maxTokens, freeCalls);
  const rawNeuronBudget = Number(env.AI_DAILY_NEURON_BUDGET);
  const budget = clampNumber(env.AI_DAILY_NEURON_BUDGET && Number.isFinite(rawNeuronBudget) ? rawNeuronBudget : 10_000_000, 0, 10_000_000);
  const used = await sumAiEstimatedNeuronsSince(env, utcDayStartIso());
  const remainingBudget = Math.max(0, budget - used);
  if (estimatedNeurons > remainingBudget) {
    await record(env, input, "quota_exceeded", 0, `estimated ${estimatedNeurons} neurons exceeds remaining ${remainingBudget}`);
    return { status: "quota_exceeded", estimatedNeurons, remainingBudget };
  }
  if (input.providerKey) {
    const byokDailyLimit = clampNumber(Number(env.AI_BYOK_DAILY_REPO_LIMIT || DEFAULT_BYOK_DAILY_REPO_LIMIT), 0, 10_000);
    const byokUsed = await countByokAiEventsForRepoSince(env, input.repoFullName, utcDayStartIso());
    if (byokUsed >= byokDailyLimit) {
      await record(env, input, "quota_exceeded", 0, `BYOK daily repo limit ${byokDailyLimit} reached`);
      return { status: "quota_exceeded", estimatedNeurons, remainingBudget };
    }
  }

  // BYOK frontier model if configured, else the free/default-reviewer primary (with fallback). Both fail-safe
  // to null via buildLinkedIssueSatisfactionResult.
  let result: LinkedIssueSatisfactionResult | null;
  let usage: AiReviewActualUsage | undefined;
  if (input.providerKey) {
    const { text, usage: byokUsage } = await callAiProvider(input.providerKey, SATISFACTION_SYSTEM_PROMPT, user, maxTokens);
    result = text ? buildLinkedIssueSatisfactionResult(input.issueText, text) : null;
    usage = byokUsage;
  } else {
    ({ result, usage } = await runWorkersSatisfactionOpinion(env, input.issueText, SATISFACTION_SYSTEM_PROMPT, user, maxTokens));
  }
  await record(env, input, "ok", estimatedNeurons, result ? `advisory finding (${result.status})` : "no usable output", { status: result?.status ?? null, surfaced: Boolean(result), byok: Boolean(input.providerKey) }, usage);
  return { status: "ok", result, estimatedNeurons };
}

async function record(
  env: Env,
  input: LinkedIssueSatisfactionRunInput,
  status: string,
  estimatedNeurons: number,
  detail: string,
  metadata?: Record<string, unknown>,
  usage?: AiReviewActualUsage | undefined,
): Promise<void> {
  await recordAiUsageEvent(env, {
    feature: "linked_issue_satisfaction",
    actor: input.actor ?? null,
    route: "github_app.linked_issue_satisfaction",
    model: input.providerKey ? `byok:${input.providerKey.provider}` : (usage?.model ?? LINKED_ISSUE_SATISFACTION_MODELS.join("+")),
    status,
    estimatedNeurons,
    provider: usage?.provider,
    effort: usage?.effort,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    costUsd: usage?.costUsd,
    detail,
    metadata: { repoFullName: input.repoFullName, pullNumber: input.prNumber, ...(metadata ?? {}) },
  });
}
