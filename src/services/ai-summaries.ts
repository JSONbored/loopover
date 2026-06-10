import { recordAiUsageEvent, recordAuditEvent, sumAiEstimatedNeuronsSince } from "../db/repositories";
import { sanitizePublicComment } from "../queue-intelligence";
import type { JsonValue } from "../types";
import type { AgentRunBundle } from "./agent-orchestrator";

const PR_INTELLIGENCE_MARKER = "<!-- gittensory-pr-intelligence -->";

type AiSummaryVisibility = "private" | "public";

const PRIVATE_CONTEXT_PATTERN =
  /\b(wallets?|hotkeys?|coldkeys?|seed phrases?|mnemonics?|raw trust scores?|trust scores?|scoreability|reviewability(?: internals?)?|private reviewability|private scoreability|public score estimates?)\b/gi;
const PRIVATE_OUTCOME_PATTERN = /\b(payouts?|farming|rewards?|reward estimates?|reward optimization)\b/gi;
const PUBLIC_FORBIDDEN_TEXT_PATTERN =
  /\b(wallets?|hotkeys?|coldkeys?|seed phrases?|mnemonics?|raw trust scores?|trust scores?|estimated scores?|score estimates?|scoreability|score preview|public score estimates?|estimated rewards?|rewards?|reward estimates?|payouts?|farming|reviewability(?: internals?)?|private reviewability|private scoreability|private rankings?|rankings?|reward optimization)\b/i;

export type AiSummaryResult =
  | { status: "disabled"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "quota_exceeded"; model: string; estimatedNeurons: number; remainingBudget: number }
  | { status: "unsafe"; model: string; estimatedNeurons: number; reason: string }
  | { status: "error"; model: string; estimatedNeurons: number; reason: string }
  | { status: "ok"; model: string; estimatedNeurons: number; text: string };

export async function summarizeAgentBundleWithAi(env: Env, bundle: AgentRunBundle, visibility: AiSummaryVisibility): Promise<AiSummaryResult> {
  const privateEnabled = isEnabled(env.AI_SUMMARIES_ENABLED);
  const publicEnabled = isEnabled(env.AI_PUBLIC_COMMENTS_ENABLED);
  if (!privateEnabled) return { status: "disabled", reason: "AI summaries are disabled." };
  if (visibility === "public" && !publicEnabled) return { status: "disabled", reason: "Public AI summaries are disabled." };
  if (!env.AI) return { status: "unavailable", reason: "Workers AI binding is not configured." };

  const model = env.WORKERS_AI_SUMMARY_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
  const maxOutputTokens = clampNumber(Number(env.AI_MAX_OUTPUT_TOKENS || 256), 64, 512);
  const signalBundle = compactAgentSignalBundle(bundle, visibility);
  const prompt = buildPrompt(signalBundle, visibility);
  const estimatedNeurons = estimateNeurons(prompt, maxOutputTokens);
  const budget = clampNumber(Number(env.AI_DAILY_NEURON_BUDGET || 10000), 0, 1_000_000);
  const used = await sumAiEstimatedNeuronsSince(env, utcDayStartIso());
  const remainingBudget = Math.max(0, budget - used);

  if (estimatedNeurons > remainingBudget) {
    await recordAi(env, bundle, {
      feature: `agent_${visibility}_summary`,
      model,
      status: "quota_exceeded",
      estimatedNeurons: 0,
      detail: `estimated ${estimatedNeurons} neurons exceeds remaining budget ${remainingBudget}`,
    });
    return { status: "quota_exceeded", model, estimatedNeurons, remainingBudget };
  }

  try {
    const response = await env.AI.run(model, {
      messages: [
        {
          role: "system",
          content:
            visibility === "public"
              ? "Summarize deterministic Gittensory signals for a public GitHub comment. Do not mention rewards, rankings, payouts, wallets, hotkeys, raw trust scores, scoreability, or reviewability."
              : "Summarize deterministic Gittensory signals for an authenticated MCP/API user. Be concise and preserve scoreability blockers and next actions.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: maxOutputTokens,
      temperature: 0.1,
    });
    const rawText = extractAiText(response);
    if (!rawText) throw new Error("empty_ai_summary");
    if (visibility === "public" && containsPublicForbiddenText(rawText)) {
      await recordAi(env, bundle, {
        feature: `agent_${visibility}_summary`,
        model,
        status: "unsafe",
        estimatedNeurons,
        detail: "public summary failed sanitizer",
      });
      return { status: "unsafe", model, estimatedNeurons, reason: "public summary failed sanitizer" };
    }
    const text = sanitizeAiText(rawText, visibility);
    await recordAi(env, bundle, {
      feature: `agent_${visibility}_summary`,
      model,
      status: "ok",
      estimatedNeurons,
      detail: "summary generated",
      metadata: { visibility },
    });
    return { status: "ok", model, estimatedNeurons, text };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "workers_ai_failed";
    await recordAi(env, bundle, {
      feature: `agent_${visibility}_summary`,
      model,
      status: "error",
      estimatedNeurons: 0,
      detail: reason,
    });
    return { status: "error", model, estimatedNeurons, reason };
  }
}

function compactAgentSignalBundle(bundle: AgentRunBundle, visibility: AiSummaryVisibility): Record<string, JsonValue> {
  const publicMode = visibility === "public";
  return {
    run: {
      id: bundle.run.id,
      objective: bundle.run.objective,
      actorLogin: bundle.run.actorLogin,
      surface: bundle.run.surface,
      status: bundle.run.status,
      dataQualityStatus: bundle.run.dataQualityStatus,
    },
    actions: bundle.actions.slice(0, 5).map((action) => {
      const publicSafeSummary = publicMode ? sanitizePublicPromptText(action.publicSafeSummary) : action.publicSafeSummary;
      return {
        actionType: action.actionType,
        status: action.status,
        recommendation: publicMode ? publicSafeSummary : action.recommendation,
        publicSafeSummary,
        why: sanitizePromptList(action.why, visibility),
        blockedBy: sanitizePromptList(action.blockedBy, visibility),
        scoreabilityImpact: publicMode ? undefined : action.scoreabilityImpact,
        riskImpact: publicMode ? undefined : action.riskImpact,
        maintainerImpact: publicMode && action.maintainerImpact ? sanitizePublicPromptText(action.maintainerImpact) : action.maintainerImpact,
        rerunWhen: action.rerunWhen,
      };
    }),
    freshnessWarnings: bundle.contextSnapshots.flatMap((snapshot) => snapshot.freshnessWarnings).slice(0, 8),
  } as Record<string, JsonValue>;
}

function sanitizePromptList(values: string[], visibility: AiSummaryVisibility): string[] {
  const selected = values.slice(0, 4);
  if (visibility !== "public") return selected;
  return selected.map((value) => sanitizePublicPromptText(value)).filter(Boolean);
}

function sanitizePublicPromptText(value: string): string {
  return sanitizeAiText(value, "public");
}

function buildPrompt(signalBundle: Record<string, JsonValue>, visibility: AiSummaryVisibility): string {
  return [
    `Visibility: ${visibility}`,
    "Summarize this deterministic Gittensory signal bundle in 4 short bullets.",
    "Do not invent facts or claim guaranteed outcomes.",
    JSON.stringify(signalBundle),
  ].join("\n");
}

function estimateNeurons(prompt: string, maxOutputTokens: number): number {
  const inputTokens = Math.ceil(prompt.length / 4);
  return Math.max(1, Math.ceil((inputTokens + maxOutputTokens) * 0.035));
}

function extractAiText(response: unknown): string {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return "";
  const record = response as Record<string, unknown>;
  if (typeof record.response === "string") return record.response;
  if (typeof record.text === "string") return record.text;
  if (typeof record.result === "string") return record.result;
  return "";
}

function sanitizeAiText(value: string, visibility: AiSummaryVisibility): string {
  const sanitized = value
    .replace(PRIVATE_CONTEXT_PATTERN, "private context")
    .replace(PRIVATE_OUTCOME_PATTERN, "private outcome");
  if (visibility === "public") {
    return sanitized.replace(/\b(estimated scores?|score estimates?)\b/gi, "private context").trim();
  }
  return sanitized.trim();
}

function containsPublicForbiddenText(value: string): boolean {
  // Route every public AI output through the canonical public/private sanitizer (issue #151).
  // `sanitizePublicComment` throws on any forbidden public term (wallet, hotkey, raw trust score,
  // scoreability/reviewability terms, payout, reward language, farming, public score estimate,
  // or ranking language).
  try {
    sanitizePublicComment(value);
  } catch {
    return true;
  }
  // Defense in depth: keep the centralized local pattern, which intentionally also catches near-miss
  // phrasings the canonical word list narrows (e.g. bare "estimated score" or seed-phrase wording).
  return PUBLIC_FORBIDDEN_TEXT_PATTERN.test(value);
}

function isEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function utcDayStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

async function recordAi(
  env: Env,
  bundle: AgentRunBundle,
  event: {
    feature: string;
    model: string;
    status: string;
    estimatedNeurons: number;
    detail?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await recordAiUsageEvent(env, {
    ...event,
    actor: bundle.run.actorLogin,
    route: bundle.run.surface,
    metadata: { runId: bundle.run.id, ...(event.metadata ?? {}) },
  });
  await recordAuditEvent(env, {
    eventType: "ai.summary",
    actor: bundle.run.actorLogin,
    route: bundle.run.surface,
    outcome: auditOutcomeForAiStatus(event.status),
    detail: event.detail,
    metadata: { runId: bundle.run.id, feature: event.feature, model: event.model, estimatedNeurons: event.estimatedNeurons },
  });
}

function auditOutcomeForAiStatus(status: string): "success" | "denied" | "error" | "queued" | "completed" {
  if (status === "ok") return "success";
  if (status === "quota_exceeded" || status === "unsafe") return "denied";
  if (status === "error") return "error";
  return "completed";
}

export type AiRewriteRequest = {
  feature: string;
  visibility: AiSummaryVisibility;
  bundle: Record<string, JsonValue>;
  fallbackText: string;
  instructions: string;
  actor?: string | null | undefined;
  route?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type AiRewriteOutcome = {
  status: AiSummaryResult["status"];
  /** Always safe to publish/use: equals `fallbackText` on every non-`ok` path. */
  text: string;
  model?: string;
  estimatedNeurons?: number;
  reason?: string;
};

/**
 * Generic, reusable rewrite layer for issue #151. Turns a compact deterministic signal bundle into
 * clearer prose when AI is enabled, and otherwise returns the caller's deterministic `fallbackText`.
 * The returned `text` is ALWAYS safe to use: disabled, unavailable, quota-exceeded, unsafe, and error
 * paths all fall back to the deterministic template, and every public `ok` result is gated by the
 * canonical public/private sanitizer before it is returned.
 */
export async function rewriteSignalBundleWithAi(env: Env, req: AiRewriteRequest): Promise<AiRewriteOutcome> {
  const privateEnabled = isEnabled(env.AI_SUMMARIES_ENABLED);
  const publicEnabled = isEnabled(env.AI_PUBLIC_COMMENTS_ENABLED);
  if (!privateEnabled) return { status: "disabled", text: req.fallbackText, reason: "AI summaries are disabled." };
  if (req.visibility === "public" && !publicEnabled) return { status: "disabled", text: req.fallbackText, reason: "Public AI summaries are disabled." };
  if (!env.AI) return { status: "unavailable", text: req.fallbackText, reason: "Workers AI binding is not configured." };

  const model = env.WORKERS_AI_SUMMARY_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
  const maxOutputTokens = clampNumber(Number(env.AI_MAX_OUTPUT_TOKENS || 256), 64, 512);
  const prompt = buildBundlePrompt(req.bundle, req.visibility);
  const estimatedNeurons = estimateNeurons(prompt, maxOutputTokens);
  const budget = clampNumber(Number(env.AI_DAILY_NEURON_BUDGET || 10000), 0, 1_000_000);
  const used = await sumAiEstimatedNeuronsSince(env, utcDayStartIso());
  const remainingBudget = Math.max(0, budget - used);

  if (estimatedNeurons > remainingBudget) {
    await recordGenericAi(env, req, {
      model,
      status: "quota_exceeded",
      estimatedNeurons: 0,
      detail: `estimated ${estimatedNeurons} neurons exceeds remaining budget ${remainingBudget}`,
    });
    return { status: "quota_exceeded", text: req.fallbackText, model, estimatedNeurons };
  }

  try {
    const response = await env.AI.run(model, {
      messages: [
        { role: "system", content: req.instructions },
        { role: "user", content: prompt },
      ],
      max_tokens: maxOutputTokens,
      temperature: 0.1,
    });
    const rawText = extractAiText(response);
    if (!rawText) throw new Error("empty_ai_summary");
    if (req.visibility === "public" && containsPublicForbiddenText(rawText)) {
      await recordGenericAi(env, req, { model, status: "unsafe", estimatedNeurons, detail: "public summary failed sanitizer" });
      return { status: "unsafe", text: req.fallbackText, model, estimatedNeurons, reason: "public summary failed sanitizer" };
    }
    const text = sanitizeAiText(rawText, req.visibility);
    await recordGenericAi(env, req, { model, status: "ok", estimatedNeurons, detail: "summary generated", metadata: { visibility: req.visibility } });
    return { status: "ok", text, model, estimatedNeurons };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "workers_ai_failed";
    await recordGenericAi(env, req, { model, status: "error", estimatedNeurons: 0, detail: reason });
    return { status: "error", text: req.fallbackText, model, estimatedNeurons, reason };
  }
}

/**
 * Public-surface wrapper used by the GitHub App PR intelligence comment. Builds the rewrite request,
 * preserves the sticky-comment marker, and guarantees the deterministic body is posted whenever AI is
 * disabled, over quota, unavailable, or produces unsafe output.
 */
export async function rewritePublicPrIntelligenceComment(
  env: Env,
  args: { bundle: Record<string, JsonValue>; deterministicBody: string; actor?: string | null | undefined; route?: string | null | undefined },
): Promise<{ body: string; outcome: AiRewriteOutcome }> {
  const outcome = await rewriteSignalBundleWithAi(env, {
    feature: "pr_intelligence_comment",
    visibility: "public",
    bundle: args.bundle,
    fallbackText: args.deterministicBody,
    instructions:
      "Rewrite this deterministic Gittensory PR signal bundle as a short, friendly public GitHub comment with 3-5 bullet points. Only restate the facts provided. Never mention rewards, rankings, payouts, wallets, hotkeys, raw or estimated trust scores, score estimates, scoreability, reviewability, or farming, and never claim a guaranteed outcome.",
    actor: args.actor,
    route: args.route,
  });
  if (outcome.status !== "ok") return { body: args.deterministicBody, outcome };
  const body = [
    PR_INTELLIGENCE_MARKER,
    "## Gittensory contribution context",
    "",
    "_AI-clarified from deterministic public GitHub metadata. Deterministic signals remain authoritative; this is not an endorsement._",
    "",
    outcome.text.trim(),
  ].join("\n");
  return { body, outcome };
}

function buildBundlePrompt(signalBundle: Record<string, JsonValue>, visibility: AiSummaryVisibility): string {
  return [
    `Visibility: ${visibility}`,
    "Summarize this deterministic Gittensory signal bundle clearly and concisely.",
    "Do not invent facts or claim guaranteed outcomes.",
    JSON.stringify(signalBundle),
  ].join("\n");
}

async function recordGenericAi(
  env: Env,
  req: AiRewriteRequest,
  event: { model: string; status: string; estimatedNeurons: number; detail?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await recordAiUsageEvent(env, {
    feature: req.feature,
    actor: req.actor,
    route: req.route,
    model: event.model,
    status: event.status,
    estimatedNeurons: event.estimatedNeurons,
    detail: event.detail,
    metadata: { ...(req.metadata ?? {}), ...(event.metadata ?? {}) },
  });
  await recordAuditEvent(env, {
    eventType: "ai.summary",
    actor: req.actor,
    route: req.route,
    outcome: auditOutcomeForAiStatus(event.status),
    detail: event.detail,
    metadata: { feature: req.feature, model: event.model, estimatedNeurons: event.estimatedNeurons },
  });
}

export const __aiSummaryInternals = {
  compactAgentSignalBundle,
  estimateNeurons,
  extractAiText,
  sanitizeAiText,
  containsPublicForbiddenText,
  auditOutcomeForAiStatus,
};
