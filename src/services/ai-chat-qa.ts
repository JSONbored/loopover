import { recordAiUsageEvent, recordAuditEvent, sumAiEstimatedNeuronsSince } from "../db/repositories";
import { sanitizePublicComment } from "../queue-intelligence";
import type { AdvisoryAiRoutingConfig } from "../types";
import type { AgentRunBundle } from "./agent-orchestrator";

// Grounded @gittensory chat <question> LLM Q&A (#4595), powered ENTIRELY by local Ollama (env.AI_ADVISORY).
//
// This is modeled on summarizeAgentBundleWithAi / rewriteSignalBundleWithAi (src/services/ai-summaries.ts): it
// reuses their enable-flag-check → shared-neuron-budget-gate → provider-call → guaranteed-safe-fallback shape.
// It deliberately does NOT import that module (nor github/commands, nor any action-command handler), so this
// generation surface can never reach a write/action path -- the isolation asserted by
// test/unit/ai-chat-qa-import-isolation.test.ts (#4595 requirement 10). It only narrowly rewrites the
// ALREADY-deterministic decision-pack facts in the bundle (PR verdict, which checks/findings are blocking,
// what a finding means) into natural prose; it never synthesizes new claims.
//
// Ollama-FIRST by default (#4595 requirement 5): unlike the four sibling advisoryAiRouting capabilities
// (slop/e2eTestGen/planner/summaries), which silently fall back to the shared frontier env.AI whenever their
// OWN flag is off, this surface declines instead of spending a frontier token when env.AI_ADVISORY is
// unconfigured -- UNLESS the operator explicitly opts into advisoryAiRouting.chatQaFrontierFallback (a
// self-hoster without a local GPU may prefer their own frontier subscription over declining outright). Default
// false preserves the original Ollama-only behavior for every existing deployment.

export type ChatQaResult =
  | { status: "disabled"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "declined"; reason: string; suggestion: string }
  | { status: "quota_exceeded"; model: string; estimatedNeurons: number; remainingBudget: number }
  | { status: "unsafe"; model: string; estimatedNeurons: number; reason: string }
  | { status: "error"; model: string; estimatedNeurons: number; reason: string }
  | { status: "ok"; model: string; estimatedNeurons: number; text: string };

export type ChatQaRequest = {
  bundle: AgentRunBundle | null | undefined;
  question: string | undefined;
  /** Resolved repository settings' `advisoryAiRouting` block; `chatQa === true` is the enable gate. */
  advisoryAiRouting: AdvisoryAiRoutingConfig | undefined;
  repoFullName: string;
  issueNumber: number;
  actor?: string | null | undefined;
  route?: string | null | undefined;
};

/** The existing deterministic command a declined answer points the reader at, rather than guessing (#4595 req 3). */
export const CHAT_QA_FALLBACK_COMMAND = "@gittensory preflight";

const CHAT_QA_SYSTEM_PROMPT =
  "You are answering a contributor's question about a GitHub pull request using ONLY the deterministic Gittensory " +
  "facts provided in the user message. Restate and explain those facts in clear, friendly prose (under 6 sentences). " +
  "Do not invent facts, do not claim a guaranteed outcome, and never mention rewards, rankings, payouts, wallets, " +
  "hotkeys, raw or estimated trust scores, scoreability, or reviewability. If the provided facts do not answer the " +
  "question, say so plainly and suggest running `@gittensory preflight` or `@gittensory blockers`.";

// Private decision-pack blocker codes and boundary terms are redacted (not thrown on) before the grounding
// bundle is ever put in a prompt -- publicSafeSummary is already public-safe, but raw `blockedBy`/`why` can
// carry these. Mirrors github/commands.ts's publicBlockerDetail redaction intent without importing it.
const PRIVATE_DECISION_BLOCKER_PATTERN =
  /\b(?:open_pr_pressure|closed_pr_credibility|low_credibility|maintainer_lane|inactive_or_unknown_lane|issue_discovery_only|merged_pr_history_floor|issue_discovery_validity_floor)\b/gi;
const PRIVATE_BOUNDARY_TERM_PATTERN =
  /\b(?:wallets?|hotkeys?|coldkeys?|seed phrases?|mnemonics?|raw trust scores?|trust scores?|scoreability|reviewability|payouts?|rewards?|reward estimates?|farming|rankings?)\b/gi;
const PRIVATE_LANE_SIGNAL_PATTERN =
  /\b(?:maintainer cut|direct PR lane share|direct PR share|direct PR|issue-discovery|split lane)(?:\s*[:(,;-]?\s*\d+(?:\.\d+)?%?)?/gi;

// Public-safe forbidden-term guard on the MODEL's OWN output, mirroring ai-summaries' containsPublicForbiddenText:
// near-miss phrasings the throwing word-list validator narrows (e.g. bare "estimated score") are also caught.
const PUBLIC_FORBIDDEN_TEXT_PATTERN =
  /\b(wallets?|hotkeys?|coldkeys?|seed phrases?|mnemonics?|raw trust scores?|trust scores?|estimated scores?|score estimates?|scoreability|score preview|public score estimates?|estimated rewards?|rewards?|reward estimates?|payouts?|farming|reviewability(?: internals?)?|private reviewability|private scoreability|private rankings?|rankings?|reward optimization|maintainer cut|direct PR lane share|direct PR share|issue-discovery|split lane)\b/i;

type ChatGroundingAction = {
  actionType: string;
  status: string;
  publicSafeSummary: string;
  why: string[];
  blockedBy: string[];
};

type ChatGroundingBundle = {
  objective: string;
  status: string;
  dataQualityStatus: string;
  summary: string;
  actions: ChatGroundingAction[];
  freshnessWarnings: string[];
};

export async function generateChatQaAnswer(env: Env, req: ChatQaRequest): Promise<ChatQaResult> {
  if (req.advisoryAiRouting?.chatQa !== true) {
    return { status: "disabled", reason: "Chat Q&A is not enabled on this instance (settings.advisoryAiRouting.chatQa is off)." };
  }
  // Ollama-first: env.AI_ADVISORY is always preferred. env.AI (frontier) is only ever touched when the
  // operator has explicitly opted in via advisoryAiRouting.chatQaFrontierFallback (#4595 follow-up) --
  // otherwise this stays exactly as Ollama-only as it originally shipped.
  const frontierFallbackAllowed = req.advisoryAiRouting?.chatQaFrontierFallback === true;
  const ai = env.AI_ADVISORY ?? (frontierFallbackAllowed ? env.AI : undefined);
  const usedFrontier = !env.AI_ADVISORY && ai !== undefined;
  if (!ai) {
    return {
      status: "unavailable",
      reason: frontierFallbackAllowed
        ? "Neither local advisory inference (env.AI_ADVISORY) nor the frontier model (env.AI) is configured."
        : "Local advisory inference (env.AI_ADVISORY) is not configured; chat Q&A does not fall back to the frontier model unless advisoryAiRouting.chatQaFrontierFallback is enabled.",
    };
  }

  // (#4595 req 3) Decline rather than guess when there is nothing deterministic to ground an answer in.
  const question = req.question?.trim();
  if (!question) {
    return {
      status: "declined",
      reason: "No question was supplied.",
      suggestion: "Ask a specific question, for example `@gittensory chat why is this PR blocked?`.",
    };
  }
  if (!req.bundle || req.bundle.run.status === "needs_snapshot_refresh") {
    return {
      status: "declined",
      reason: "The cached contribution-context snapshot is still refreshing.",
      suggestion: `Try again shortly, or run \`${CHAT_QA_FALLBACK_COMMAND}\` for the deterministic readiness facts.`,
    };
  }
  const grounding = compactChatSignalBundle(req.bundle);
  if (grounding.actions.length === 0) {
    return {
      status: "declined",
      reason: "No cached deterministic facts are available to ground an answer for this PR.",
      suggestion: `Run \`${CHAT_QA_FALLBACK_COMMAND}\` or \`@gittensory blockers\` for the deterministic readiness facts.`,
    };
  }

  // Empty string (not a Workers-AI `@cf/...` id): the advisory provider's own per-provider default wins when no
  // override is set. Mirrors ai-summaries.ts.
  const model = env.WORKERS_AI_SUMMARY_MODEL || "";
  const maxOutputTokens = clampNumber(Number(env.AI_MAX_OUTPUT_TOKENS || 256), 64, 512);
  const prompt = buildChatPrompt(question, grounding);
  const estimatedNeurons = estimateNeurons(prompt, maxOutputTokens);
  // Shared daily neuron budget: the SAME counter every AI feature sums into (ai-review / ai-slop / ai-summaries,
  // #1369). Default HIGH (10M) and clamp to 10M so chat Q&A never starves — or is starved by — the shared pool.
  const rawNeuronBudget = Number(env.AI_DAILY_NEURON_BUDGET);
  const budget = clampNumber(env.AI_DAILY_NEURON_BUDGET && Number.isFinite(rawNeuronBudget) ? rawNeuronBudget : 10_000_000, 0, 10_000_000);
  const used = await sumAiEstimatedNeuronsSince(env, utcDayStartIso());
  const remainingBudget = Math.max(0, budget - used);
  if (estimatedNeurons > remainingBudget) {
    await recordChatAi(env, req, {
      model,
      status: "quota_exceeded",
      estimatedNeurons: 0,
      detail: `estimated ${estimatedNeurons} neurons exceeds remaining budget ${remainingBudget}`,
      usedFrontier,
    });
    return { status: "quota_exceeded", model, estimatedNeurons, remainingBudget };
  }

  try {
    const response = await ai.run(model, {
      messages: [
        { role: "system", content: CHAT_QA_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: maxOutputTokens,
      temperature: 0.1,
    });
    const rawText = extractAiText(response);
    if (!rawText) throw new Error("empty_chat_answer");
    if (containsPublicForbiddenText(rawText)) {
      await recordChatAi(env, req, { model, status: "unsafe", estimatedNeurons, detail: "chat answer failed public sanitizer", usedFrontier });
      return { status: "unsafe", model, estimatedNeurons, reason: "chat answer failed public sanitizer" };
    }
    await recordChatAi(env, req, { model, status: "ok", estimatedNeurons, detail: "chat answer generated", usedFrontier });
    return { status: "ok", model, estimatedNeurons, text: rawText.trim() };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "chat_answer_failed";
    await recordChatAi(env, req, { model, status: "error", estimatedNeurons: 0, detail: reason, usedFrontier });
    return { status: "error", model, estimatedNeurons, reason };
  }
}

function compactChatSignalBundle(bundle: AgentRunBundle): ChatGroundingBundle {
  return {
    objective: redactGroundingText(bundle.run.objective),
    status: bundle.run.status,
    dataQualityStatus: bundle.run.dataQualityStatus,
    summary: redactGroundingText(bundle.summary),
    actions: bundle.actions.slice(0, 5).map((action) => ({
      actionType: action.actionType,
      status: action.status,
      publicSafeSummary: redactGroundingText(action.publicSafeSummary),
      why: action.why.slice(0, 4).map(redactGroundingText).filter((line) => line.length > 0),
      blockedBy: action.blockedBy.slice(0, 4).map(redactGroundingText).filter((line) => line.length > 0),
    })),
    freshnessWarnings: bundle.contextSnapshots.flatMap((snapshot) => snapshot.freshnessWarnings).slice(0, 8).map(redactGroundingText),
  };
}

function redactGroundingText(value: string): string {
  return value
    .replace(/\blikely_duplicate\b/gi, "possible overlap with existing work")
    .replace(PRIVATE_DECISION_BLOCKER_PATTERN, "private readiness context")
    .replace(PRIVATE_LANE_SIGNAL_PATTERN, "private readiness context")
    .replace(PRIVATE_BOUNDARY_TERM_PATTERN, "private context")
    .trim();
}

function buildChatPrompt(question: string, grounding: ChatGroundingBundle): string {
  return [
    `Contributor question: ${question}`,
    "Deterministic Gittensory facts for this pull request (answer using only these):",
    JSON.stringify(grounding),
  ].join("\n");
}

function containsPublicForbiddenText(value: string): boolean {
  // The queue-intelligence sanitizePublicComment THROWS on any forbidden public word; treat a throw as a fail.
  try {
    sanitizePublicComment(value);
  } catch {
    return true;
  }
  return PUBLIC_FORBIDDEN_TEXT_PATTERN.test(value);
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

function auditOutcomeForAiStatus(status: string): "success" | "denied" | "error" | "completed" {
  if (status === "ok") return "success";
  if (status === "quota_exceeded" || status === "unsafe") return "denied";
  if (status === "error") return "error";
  return "completed";
}

async function recordChatAi(
  env: Env,
  req: ChatQaRequest,
  event: { model: string; status: string; estimatedNeurons: number; detail: string; usedFrontier: boolean },
): Promise<void> {
  await recordAiUsageEvent(env, {
    feature: "chat_qa",
    actor: req.actor,
    route: req.route,
    model: event.model,
    status: event.status,
    estimatedNeurons: event.estimatedNeurons,
    detail: event.detail,
    // provider is observability-only: lets an operator who opted into chatQaFrontierFallback see, per event,
    // whether a given answer actually spent a frontier token or stayed on the (free) local GPU.
    metadata: { repoFullName: req.repoFullName, issueNumber: req.issueNumber, provider: event.usedFrontier ? "frontier" : "advisory" },
  });
  await recordAuditEvent(env, {
    eventType: "ai.chat_qa",
    actor: req.actor,
    route: req.route,
    outcome: auditOutcomeForAiStatus(event.status),
    detail: event.detail,
    metadata: {
      repoFullName: req.repoFullName,
      issueNumber: req.issueNumber,
      model: event.model,
      estimatedNeurons: event.estimatedNeurons,
      provider: event.usedFrontier ? "frontier" : "advisory",
    },
  });
}

/** @internal Exported for unit tests of the pure chat-Q&A helpers. */
export const __chatQaInternals = {
  compactChatSignalBundle,
  redactGroundingText,
  buildChatPrompt,
  containsPublicForbiddenText,
  estimateNeurons,
  extractAiText,
  auditOutcomeForAiStatus,
};
