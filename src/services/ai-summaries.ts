import { recordAiUsageEvent, recordAuditEvent, sumAiEstimatedNeuronsSince } from "../db/repositories";
import type { JsonValue } from "../types";
import type { AgentRunBundle } from "./agent-orchestrator";

type AiSummaryVisibility = "private" | "public";

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
              ? "Summarize deterministic Gittensory signals for a public GitHub comment. Do not mention rewards, payouts, wallets, hotkeys, raw trust scores, or private reviewability."
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
  return {
    run: {
      id: bundle.run.id,
      objective: bundle.run.objective,
      actorLogin: bundle.run.actorLogin,
      surface: bundle.run.surface,
      status: bundle.run.status,
      dataQualityStatus: bundle.run.dataQualityStatus,
    },
    actions: bundle.actions.slice(0, 5).map((action) => ({
      actionType: action.actionType,
      status: action.status,
      recommendation: visibility === "public" ? action.publicSafeSummary : action.recommendation,
      publicSafeSummary: action.publicSafeSummary,
      why: action.why.slice(0, 4),
      blockedBy: action.blockedBy.slice(0, 4),
      scoreabilityImpact: visibility === "public" ? undefined : action.scoreabilityImpact,
      riskImpact: visibility === "public" ? undefined : action.riskImpact,
      maintainerImpact: action.maintainerImpact,
      rerunWhen: action.rerunWhen,
    })),
    freshnessWarnings: bundle.contextSnapshots.flatMap((snapshot) => snapshot.freshnessWarnings).slice(0, 8),
  } as Record<string, JsonValue>;
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
    .replace(/\b(wallet|hotkey|coldkey|seed phrase|mnemonic|raw trust score|trust score)\b/gi, "private context")
    .replace(/\b(payout|farming)\b/gi, "private outcome");
  if (visibility === "public") {
    return sanitized.replace(/\b(estimated score|score estimate|reward estimate|reward optimization)\b/gi, "private context");
  }
  return sanitized.trim();
}

function containsPublicForbiddenText(value: string): boolean {
  return /\b(wallet|hotkey|coldkey|seed phrase|mnemonic|raw trust score|estimated score|score estimate|reward estimate|payout|farming)\b/i.test(value);
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

export const __aiSummaryInternals = {
  compactAgentSignalBundle,
  estimateNeurons,
  extractAiText,
  sanitizeAiText,
  containsPublicForbiddenText,
  auditOutcomeForAiStatus,
};
