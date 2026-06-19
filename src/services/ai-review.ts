// Gittensory AI maintainer review (the `aiReview` capability).
//
// Two layers, both opt-in and both fail-safe (no AI / errors / over-budget / unsafe output → no public
// text and no gate finding; gittensory NEVER blocks because the model spoke):
//
//   • Advisory notes — a concise maintainer-style write-up (assessment + suggestions + risks). When the
//     repo has BYOK configured, the maintainer's own frontier model (Anthropic/OpenAI) writes it;
//     otherwise free Cloudflare Workers AI does. Advisory only — never blocks.
//   • Consensus defect — a conservative gate signal. The free Workers-AI model PAIR each independently
//     reviews the diff; a defect is reported ONLY when BOTH models flag a high-confidence critical defect
//     (bug / security / data-loss / build break). BYOK never changes this path, so it never changes who
//     can be blocked. The resulting finding is honored by the gate only in `block` mode AND only for
//     confirmed Gittensor contributors (the gate enforces that downstream).
//
// Every public string (notes + defect title/detail) is forced through `sanitizePublicComment`; anything
// that trips the public/private boundary is dropped, not published. Free Workers-AI calls are metered against
// the shared daily neuron budget; maintainer-paid BYOK calls have a separate repo/day cap. All calls
// are audited via `recordAiUsageEvent`.
import { countByokAiEventsForRepoSince, recordAiUsageEvent, sumAiEstimatedNeuronsSince } from "../db/repositories";
import { sanitizePublicComment } from "../queue-intelligence";

/**
 * The best free Workers-AI model pair for review accuracy — two different families for independence,
 * both probe-verified in reviewbot to emit clean JSON. The consensus blocker always uses this pair.
 */
export const BEST_REVIEW_MODELS: readonly [string, string] = ["@cf/openai/gpt-oss-120b", "@cf/nvidia/nemotron-3-120b-a12b"];

/** Reliable per-slot fallbacks (non-reasoning, clean JSON) so a slot never comes back empty. */
export const RELIABLE_FALLBACK_MODELS: readonly [string, string] = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
];

/** Default consensus confidence floor: BOTH models must be at/above this to report a defect. */
export const AI_CONSENSUS_FLOOR = 0.9;

const REVIEW_SYSTEM_PROMPT = [
  "You are a senior open-source maintainer reviewing a single pull request diff.",
  "Be concise, concrete, and fair. Judge only the diff and the context provided.",
  "Report a critical defect ONLY when you are highly confident the change introduces a real bug, a",
  "security hole, data loss, or a build break — NOT for style, nits, naming, or merely-missing tests.",
  "Never mention rewards, rankings, payouts, wallets, hotkeys, coldkeys, trust scores, scoreability,",
  "reviewability, or farming.",
  'Respond with ONLY a JSON object of this exact shape (no prose, no code fence):',
  '{"assessment": string, "suggestions": string[], "risks": string[],',
  ' "criticalDefect": {"present": boolean, "confidence": number, "title": string, "detail": string}}',
].join(" ");

/** A maintainer's BYOK provider credential, decrypted at call time. Never logged, never returned. */
export type AiReviewProviderKey = {
  provider: "anthropic" | "openai";
  key: string;
  /** Optional model override; falls back to a conservative stable default per provider. */
  model?: string | null | undefined;
};

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
  /** Present only when the repo has BYOK on AND a key configured; drives the advisory write-up. */
  providerKey?: AiReviewProviderKey | null | undefined;
};

/** A consensus critical defect, already public-safe, ready to become a gate blocker finding. */
export type AiConsensusDefect = { title: string; detail: string; confidence: number };

export type GittensoryAiReviewResult =
  | { status: "disabled"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "quota_exceeded"; estimatedNeurons: number; remainingBudget: number }
  | { status: "ok"; advisoryNotes: string | null; consensusDefect: AiConsensusDefect | null; estimatedNeurons: number };

type ModelReview = {
  assessment: string;
  suggestions: string[];
  risks: string[];
  criticalDefect: { present: boolean; confidence: number; title: string; detail: string };
};

type AiGatewayOptions = { gateway?: { id: string } };
type AiRunner = { run?: (model: string, options: Record<string, unknown>, extra?: AiGatewayOptions) => Promise<unknown> };

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
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export function estimateNeurons(promptChars: number, maxOutputTokens: number, calls: number): number {
  const inputTokens = Math.ceil(promptChars / 4);
  return Math.max(1, Math.ceil((inputTokens + maxOutputTokens) * 0.035) * Math.max(1, calls));
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
    if (response && typeof response === "object") return JSON.stringify(response);
    const choices = obj.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
      const content = first?.message?.content ?? first?.text;
      if (typeof content === "string" && content.trim()) return content;
    }
    // Anthropic Messages: { content: [{ type: "text", text }] }
    const content = obj.content;
    if (Array.isArray(content) && content.length > 0) {
      const parts = content
        .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
        .filter(Boolean);
      if (parts.length > 0) return parts.join("\n");
    }
    if (typeof obj.output_text === "string" && obj.output_text.trim()) return obj.output_text;
  }
  return "";
}

/** Parse a model's JSON review into a normalized {@link ModelReview}, or null when unparseable. */
export function parseModelReview(text: string): ModelReview | null {
  const match = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const toList = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 6) : [];
    const assessment = typeof obj.assessment === "string" ? obj.assessment.trim() : "";
    const defectRaw = obj.criticalDefect && typeof obj.criticalDefect === "object" ? (obj.criticalDefect as Record<string, unknown>) : {};
    const present = defectRaw.present === true;
    const confidence = typeof defectRaw.confidence === "number" ? Math.max(0, Math.min(1, defectRaw.confidence)) : 0;
    if (!assessment && !present && !Array.isArray(obj.suggestions)) return null;
    return {
      assessment,
      suggestions: toList(obj.suggestions),
      risks: toList(obj.risks),
      criticalDefect: {
        present,
        confidence,
        title: typeof defectRaw.title === "string" ? defectRaw.title.trim().slice(0, 140) : "",
        detail: typeof defectRaw.detail === "string" ? defectRaw.detail.trim().slice(0, 400) : "",
      },
    };
  } catch {
    return null;
  }
}

function buildUserPrompt(input: GittensoryAiReviewInput): string {
  return [
    `Repository: ${input.repoFullName}`,
    `Pull request #${input.prNumber}: ${input.title}`,
    input.body ? `Description:\n${input.body.slice(0, 2000)}` : "Description: (none)",
    "",
    "Unified diff (truncated if large):",
    input.diff.slice(0, 60000),
  ].join("\n");
}

/** One Workers-AI opinion with a per-slot reliable fallback and a 3× retry on the primary. */
async function runWorkersOpinion(env: Env, primary: string, fallback: string, system: string, user: string, maxTokens: number): Promise<ModelReview | null> {
  const ai = env.AI as unknown as AiRunner | undefined;
  if (!ai || typeof ai.run !== "function") return null;
  // Route through Cloudflare AI Gateway when configured (caching, rate-limiting, logging, fallback). The
  // diff/prompt is the cache key input, scoped per model + content, so distinct PRs never share a cached
  // review. Unset → direct binding call (unchanged behavior).
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  const extra: AiGatewayOptions | undefined = gatewayId ? { gateway: { id: gatewayId } } : undefined;
  for (const model of fallback && fallback !== primary ? [primary, fallback] : [primary]) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await ai.run(
          model,
          {
            max_tokens: maxTokens,
            temperature: 0,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          },
          extra,
        );
        const parsed = parseModelReview(coerceAiText(result));
        if (parsed) return parsed;
      } catch {
        /* retry / fall through to fallback */
      }
    }
  }
  return null;
}

const PROVIDER_DEFAULT_MODEL: Record<AiReviewProviderKey["provider"], string> = {
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
type ProviderReviewOutcome = { review: ModelReview | null; failure?: ProviderFailure };

/**
 * POST to the maintainer's BYOK provider and return the raw response text (or null + a failure reason).
 * Never throws. Shared by every BYOK AI path (review, slop, …) so the endpoint/timeout/error handling
 * lives in one place; callers parse the returned text into their own shape.
 */
export async function callAiProvider(
  providerKey: AiReviewProviderKey,
  system: string,
  user: string,
  maxTokens: number,
): Promise<{ text: string | null; failure?: ProviderFailure }> {
  const model = providerKey.model || PROVIDER_DEFAULT_MODEL[providerKey.provider];
  try {
    let response: Response;
    if (providerKey.provider === "anthropic") {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": providerKey.key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
        signal: AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS),
      });
    } else {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${providerKey.key}` },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS),
      });
    }
    if (!response.ok) return { text: null, failure: "http_error" };
    return { text: coerceAiText(await response.json()) };
  } catch (error) {
    // AbortSignal.timeout rejects with a TimeoutError; everything else is a network/parse exception.
    const failure: ProviderFailure = (error as { name?: string } | null)?.name === "TimeoutError" ? "timeout" : "exception";
    return { text: null, failure };
  }
}

/** Run the maintainer's BYOK frontier model for the advisory write-up. Never throws; the review is null on
 *  any error and `failure` names the reason (timeout/http_error/exception) for the audit trail. */
async function runProviderReview(providerKey: AiReviewProviderKey, system: string, user: string, maxTokens: number): Promise<ProviderReviewOutcome> {
  const { text, failure } = await callAiProvider(providerKey, system, user, maxTokens);
  return { review: text ? parseModelReview(text) : null, ...(failure ? { failure } : {}) };
}

/** Compose a public-safe markdown advisory blurb from one or two model reviews. Null if nothing safe. */
export function composeAdvisoryNotes(reviews: ModelReview[]): string | null {
  const assessments = reviews.map((r) => r.assessment).filter(Boolean);
  const suggestions = [...new Set(reviews.flatMap((r) => r.suggestions))].slice(0, 5);
  const risks = [...new Set(reviews.flatMap((r) => r.risks))].slice(0, 4);
  const assessment = toPublicSafe(assessments[0] ?? "");
  const safeSuggestions = suggestions.map((s) => toPublicSafe(s)).filter((s): s is string => Boolean(s));
  const safeRisks = risks.map((s) => toPublicSafe(s)).filter((s): s is string => Boolean(s));
  if (!assessment && safeSuggestions.length === 0 && safeRisks.length === 0) return null;
  const lines: string[] = [];
  if (assessment) lines.push(assessment, "");
  if (safeSuggestions.length > 0) {
    lines.push("**Suggestions**");
    lines.push(...safeSuggestions.map((s) => `- ${s}`));
    lines.push("");
  }
  if (safeRisks.length > 0) {
    lines.push("**Risks**");
    lines.push(...safeRisks.map((s) => `- ${s}`));
  }
  // Reaching here means at least one section was pushed (the all-empty case returned null above).
  return lines.join("\n").trim();
}

/** True iff BOTH reviews independently report a critical defect at/above the floor. */
export function consensusDefectOf(a: ModelReview, b: ModelReview, floor: number): AiConsensusDefect | null {
  const both = a.criticalDefect.present && b.criticalDefect.present && a.criticalDefect.confidence >= floor && b.criticalDefect.confidence >= floor;
  if (!both) return null;
  const title = toPublicSafe(a.criticalDefect.title || b.criticalDefect.title || "AI reviewers agree on a likely critical defect");
  const detail = toPublicSafe(a.criticalDefect.detail || b.criticalDefect.detail);
  if (!title) return null; // unsafe title → drop the block entirely (fail-safe)
  return { title, detail: detail ?? "Both AI reviewers independently flagged a high-confidence critical defect in this change.", confidence: Math.min(a.criticalDefect.confidence, b.criticalDefect.confidence) };
}

/**
 * Run the AI maintainer review. Returns advisory notes (always, when AI is on) and — in `block` mode —
 * a consensus defect when the free Workers-AI pair agrees with high confidence. Fail-safe on every error
 * path: no notes, no defect, never a thrown error reaching the webhook.
 */
export async function runGittensoryAiReview(env: Env, input: GittensoryAiReviewInput): Promise<GittensoryAiReviewResult> {
  if (!isEnabled(env.AI_SUMMARIES_ENABLED)) return { status: "disabled", reason: "AI summaries are disabled." };
  if (!isEnabled(env.AI_PUBLIC_COMMENTS_ENABLED)) return { status: "disabled", reason: "Public AI comments are disabled." };
  if (!env.AI) return { status: "unavailable", reason: "Workers AI binding is not configured." };

  const maxTokens = clampNumber(Number(env.AI_MAX_OUTPUT_TOKENS || 256), 256, 1024);
  const user = buildUserPrompt(input);
  // The daily neuron budget governs FREE Workers-AI spend only. BYOK advisory calls bill the maintainer's
  // own provider account, so they are not counted here (and a BYOK advisory still runs when the free
  // budget is exhausted). Free calls = the consensus pair in block mode (always Workers AI), plus the
  // advisory leg only when it is NOT BYOK.
  const freeAiCalls = (input.mode === "block" ? 2 : 0) + (input.providerKey ? 0 : 1);
  const estimatedNeurons = freeAiCalls === 0 ? 0 : estimateNeurons(REVIEW_SYSTEM_PROMPT.length + user.length, maxTokens, freeAiCalls);
  const budget = clampNumber(Number(env.AI_DAILY_NEURON_BUDGET || 10000), 0, 1_000_000);
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

  // Advisory write-up: BYOK frontier model if configured, else the free Workers-AI primary (with fallback).
  let byokFailure: ProviderFailure | undefined;
  let advisoryReview: ModelReview | null;
  if (input.providerKey) {
    const outcome = await runProviderReview(input.providerKey, REVIEW_SYSTEM_PROMPT, user, maxTokens);
    advisoryReview = outcome.review;
    byokFailure = outcome.failure;
  } else {
    advisoryReview = await runWorkersOpinion(env, BEST_REVIEW_MODELS[0], RELIABLE_FALLBACK_MODELS[0], REVIEW_SYSTEM_PROMPT, user, maxTokens);
  }

  let consensusDefect: AiConsensusDefect | null = null;
  let secondReview: ModelReview | null = null;
  if (input.mode === "block") {
    // Consensus blocker ALWAYS uses the free Workers-AI pair (provider-independent, never BYOK).
    const [a, b] = await Promise.all([
      input.providerKey ? runWorkersOpinion(env, BEST_REVIEW_MODELS[0], RELIABLE_FALLBACK_MODELS[0], REVIEW_SYSTEM_PROMPT, user, maxTokens) : Promise.resolve(advisoryReview),
      runWorkersOpinion(env, BEST_REVIEW_MODELS[1], RELIABLE_FALLBACK_MODELS[1], REVIEW_SYSTEM_PROMPT, user, maxTokens),
    ]);
    secondReview = b;
    if (a && b) consensusDefect = consensusDefectOf(a, b, AI_CONSENSUS_FLOOR);
  }

  const reviewsForNotes = [advisoryReview, secondReview].filter((r): r is ModelReview => Boolean(r));
  const advisoryNotes = reviewsForNotes.length > 0 ? composeAdvisoryNotes(reviewsForNotes) : null;

  await record(env, input, "ok", estimatedNeurons, consensusDefect ? "consensus defect" : advisoryNotes ? "advisory notes" : "no usable output", {
    mode: input.mode,
    byok: Boolean(input.providerKey),
    consensus: Boolean(consensusDefect),
    ...(byokFailure ? { byokFailure } : {}),
  });
  return { status: "ok", advisoryNotes, consensusDefect, estimatedNeurons };
}

async function record(
  env: Env,
  input: GittensoryAiReviewInput,
  status: string,
  estimatedNeurons: number,
  detail: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  // NEVER include provider key material in usage/audit metadata.
  await recordAiUsageEvent(env, {
    feature: "ai_review_pr",
    actor: input.actor ?? null,
    route: "github_app.ai_review",
    model: input.providerKey ? `byok:${input.providerKey.provider}` : BEST_REVIEW_MODELS.join("+"),
    status,
    estimatedNeurons,
    detail,
    metadata: { repoFullName: input.repoFullName, pullNumber: input.prNumber, ...(metadata ?? {}) },
  });
}

export const __aiReviewInternals = {
  parseModelReview,
  coerceAiText,
  composeAdvisoryNotes,
  consensusDefectOf,
  toPublicSafe,
  estimateNeurons,
  runWorkersOpinion,
};
