import { recordAiUsageEvent, recordAuditEvent, sumAiEstimatedNeuronsSince } from "../db/repositories";
import { INTENT_ROUTABLE_COMMANDS, isIntentRoutableCommand, type IntentRoutableCommandName } from "../github/commands";
import type { AdvisoryAiRoutingConfig } from "../types";

// Closed-set intent-classification router for unrecognized @gittensory mentions (#4596), powered ENTIRELY by
// local Ollama (env.AI_ADVISORY) -- same Ollama-only shape as ai-chat-qa.ts (#4595), no frontier fallback.
//
// This NEVER generates new content: the classifier's only job is to pick the single closest match among the
// existing Q&A commands (INTENT_ROUTABLE_COMMANDS, github/commands.ts) or report no match. Whatever it picks
// is re-dispatched through the exact same, already-tested rendering path that command already has -- there is
// no new answer surface here, only a new way to reach one without knowing the exact verb.
//
// The hard allowlist check (isIntentRoutableCommand) is the actual safety boundary, not the prompt: any raw
// model output that is not EXACTLY one of the 9 literal command names -- including a prompt-injection attempt
// to name an action command like "review" or "gate-override" -- is treated as "no match", never dispatched.

export type IntentRoutingResult =
  | { status: "disabled"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "quota_exceeded"; model: string; estimatedNeurons: number; remainingBudget: number }
  | { status: "error"; model: string; estimatedNeurons: number; reason: string }
  | { status: "no_match"; model: string; estimatedNeurons: number }
  | { status: "matched"; model: string; estimatedNeurons: number; command: IntentRoutableCommandName };

export type IntentRoutingRequest = {
  /** The free-form text after `@gittensory` (GittensoryMentionCommand.unrecognizedText). */
  text: string;
  /** Resolved repository settings' `advisoryAiRouting` block; `intentRouting === true` is the enable gate. */
  advisoryAiRouting: AdvisoryAiRoutingConfig | undefined;
  repoFullName: string;
  issueNumber: number;
  actor?: string | null | undefined;
  route?: string | null | undefined;
};

const INTENT_ROUTER_SYSTEM_PROMPT =
  "You classify a GitHub contributor's free-form message addressed to a bot as one of a fixed set of commands, " +
  `or no match. Valid commands: ${INTENT_ROUTABLE_COMMANDS.join(", ")}. ` +
  'Respond with ONLY a JSON object: {"command": "<one of the valid commands>"} if the message clearly asks for ' +
  'one of them, or {"command": null} if it does not confidently match any of them or asks for something else ' +
  "entirely (e.g. requesting a new review, changing settings, or anything not in the list). When uncertain, prefer " +
  'null over a guess. Never output anything other than this one JSON object.';

export async function classifyGittensoryIntent(env: Env, req: IntentRoutingRequest): Promise<IntentRoutingResult> {
  if (req.advisoryAiRouting?.intentRouting !== true) {
    return { status: "disabled", reason: "Intent routing is not enabled on this instance (settings.advisoryAiRouting.intentRouting is off)." };
  }
  // Ollama-only, same hard requirement as chatQa (#4595): never falls back to the frontier chain.
  if (!env.AI_ADVISORY) {
    return {
      status: "unavailable",
      reason: "Local advisory inference (env.AI_ADVISORY) is not configured; intent routing does not fall back to the frontier model.",
    };
  }

  const text = req.text.trim();
  if (!text) return { status: "no_match", model: "", estimatedNeurons: 0 };

  // Empty string (not a Workers-AI `@cf/...` id): the advisory provider's own per-provider default wins when no
  // override is set. Mirrors ai-chat-qa.ts.
  const model = env.WORKERS_AI_SUMMARY_MODEL || "";
  const maxOutputTokens = 32; // the entire valid output is a ~20-char JSON object; no legitimate reason to allow more
  const prompt = `Contributor message: ${text}`;
  const estimatedNeurons = estimateNeurons(prompt, maxOutputTokens);
  // Shared daily neuron budget: the SAME counter every AI feature sums into (ai-review / ai-slop / ai-summaries /
  // ai-chat-qa, #1369). Default HIGH (10M) and clamp to 10M so intent routing never starves -- or is starved by --
  // the shared pool.
  const rawNeuronBudget = Number(env.AI_DAILY_NEURON_BUDGET);
  const budget = clampNumber(env.AI_DAILY_NEURON_BUDGET && Number.isFinite(rawNeuronBudget) ? rawNeuronBudget : 10_000_000, 0, 10_000_000);
  const used = await sumAiEstimatedNeuronsSince(env, utcDayStartIso());
  const remainingBudget = Math.max(0, budget - used);
  if (estimatedNeurons > remainingBudget) {
    await recordIntentRoutingAi(env, req, {
      model,
      status: "quota_exceeded",
      estimatedNeurons: 0,
      detail: `estimated ${estimatedNeurons} neurons exceeds remaining budget ${remainingBudget}`,
    });
    return { status: "quota_exceeded", model, estimatedNeurons, remainingBudget };
  }

  try {
    const response = await env.AI_ADVISORY.run(model, {
      messages: [
        { role: "system", content: INTENT_ROUTER_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: maxOutputTokens,
      temperature: 0, // deterministic classification, not creative generation
    });
    const rawText = extractAiText(response);
    const candidate = extractCommandCandidate(rawText);
    // THE hard allowlist check (req 3): candidate is only ever trusted if it is EXACTLY one of the 9 literal
    // command names, regardless of what the raw model text said. Everything else -- including a prompt-
    // injection attempt naming an action command -- resolves to "no match".
    if (isIntentRoutableCommand(candidate)) {
      await recordIntentRoutingAi(env, req, { model, status: "matched", estimatedNeurons, detail: `matched ${candidate}` });
      return { status: "matched", model, estimatedNeurons, command: candidate };
    }
    await recordIntentRoutingAi(env, req, { model, status: "no_match", estimatedNeurons, detail: "no confident match" });
    return { status: "no_match", model, estimatedNeurons };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "intent_routing_failed";
    await recordIntentRoutingAi(env, req, { model, status: "error", estimatedNeurons: 0, detail: reason });
    return { status: "error", model, estimatedNeurons, reason };
  }
}

/** Pulls a `command` candidate out of the model's raw text, tolerant of surrounding prose/code fences a small
 *  local model might still emit despite the system prompt -- but this extraction is NOT the safety boundary;
 *  whatever it returns still has to pass {@link isIntentRoutableCommand} before ever being trusted. */
function extractCommandCandidate(rawText: string): unknown {
  if (!rawText) return null;
  try {
    return (JSON.parse(rawText) as { command?: unknown }).command ?? null;
  } catch {
    // Not bare JSON (e.g. wrapped in a code fence or trailing prose) -- fall back to a narrow regex pull of
    // `"command": "..."` or `"command": null` rather than trusting free text directly.
    const match = rawText.match(/"command"\s*:\s*(?:"([a-z-]+)"|null)/i);
    return match?.[1] ?? null;
  }
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

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function utcDayStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function auditOutcomeForStatus(status: string): "success" | "denied" | "error" | "completed" {
  if (status === "matched" || status === "no_match") return "success";
  if (status === "quota_exceeded") return "denied";
  if (status === "error") return "error";
  return "completed";
}

async function recordIntentRoutingAi(
  env: Env,
  req: IntentRoutingRequest,
  event: { model: string; status: string; estimatedNeurons: number; detail: string },
): Promise<void> {
  await recordAiUsageEvent(env, {
    feature: "intent_routing",
    actor: req.actor,
    route: req.route,
    model: event.model,
    status: event.status,
    estimatedNeurons: event.estimatedNeurons,
    detail: event.detail,
    metadata: { repoFullName: req.repoFullName, issueNumber: req.issueNumber },
  });
  await recordAuditEvent(env, {
    eventType: "ai.intent_routing",
    actor: req.actor,
    route: req.route,
    outcome: auditOutcomeForStatus(event.status),
    detail: event.detail,
    metadata: { repoFullName: req.repoFullName, issueNumber: req.issueNumber, model: event.model, estimatedNeurons: event.estimatedNeurons },
  });
}

/** @internal Exported for unit tests of the pure intent-routing helpers. */
export const __intentRouterInternals = {
  extractCommandCandidate,
  estimateNeurons,
  extractAiText,
  auditOutcomeForStatus,
  clampNumber,
};
