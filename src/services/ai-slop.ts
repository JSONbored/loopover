// Gittensory AI-assisted slop advisory (the `slopAiAdvisory` capability).
//
// An ADVISORY-ONLY second opinion that augments the deterministic slop detector (src/signals/slop.ts).
// It exists to catch the SEMANTIC slop the deterministic rules cannot quantify — generated boilerplate
// that does not match the stated intent, comments that merely restate code, cosmetic churn dressed up as
// substantive work, a description that does not correspond to the diff.
//
// Hard guarantees (so AI assistance never changes who can be blocked — only the deterministic core blocks):
//   • It NEVER feeds `slopRisk` or the gate. Its output is a single advisory `SignalFinding` with the code
//     `ai_slop_advisory`, which `isConfiguredGateBlocker` does not recognise, so it can never be a blocker.
//   • Severity is at most `warning` (never `critical`), so it cannot be mistaken for a consensus defect.
//   • Fail-safe on every path: AI off / no binding / over-budget / unparseable / unsafe text → no finding.
//   • Opt-in: only runs when the repo set `gate.slop.aiAdvisory: true` on top of `gate.slop.mode != off`.
//
// Free Cloudflare Workers AI only (one call, metered against the shared daily neuron budget). BYOK is a
// possible later enhancement; slop assessment does not need a frontier model. Every public string is
// forced through `toPublicSafe`; anything tripping the public/private boundary is dropped, not published.
import type { SignalFinding } from "../signals/engine";
import type { SlopBand } from "../signals/slop";
import { countByokAiEventsForRepoSince, recordAiUsageEvent, sumAiEstimatedNeuronsSince } from "../db/repositories";
import {
  type AiReviewProviderKey,
  BEST_REVIEW_MODELS,
  DEFAULT_BYOK_DAILY_REPO_LIMIT,
  RELIABLE_FALLBACK_MODELS,
  callAiProvider,
  clampNumber,
  coerceAiText,
  estimateNeurons,
  isEnabled,
  toPublicSafe,
  utcDayStartIso,
} from "./ai-review";

/** The finding code carried by the AI slop advisory. Deliberately NOT recognised by the gate's
 *  `isConfiguredGateBlocker`, which is what guarantees this advisory can never block. */
export const AI_SLOP_FINDING_CODE = "ai_slop_advisory";

const SLOP_SYSTEM_PROMPT = [
  "You are a senior open-source maintainer giving a SECOND OPINION on whether a pull request shows signs of",
  "low-effort, automated, or padding-style contribution ('slop'). Deterministic checks already ran; you add",
  "judgement they cannot, focusing on semantics.",
  "Judge ONLY the diff and context provided. Be conservative and fair — most pull requests are genuine.",
  "Reserve 'elevated' or 'high' for clear, evidence-backed cases: generated boilerplate that does not match",
  "the stated intent, comments that merely restate the code, no-op or cosmetic churn presented as",
  "substantive, or a description that does not correspond to the diff. When in doubt, choose 'clean' or 'low'.",
  "Never accuse; describe the observable characteristics constructively so the maintainer can decide.",
  "Never mention rewards, rankings, payouts, wallets, hotkeys, coldkeys, trust scores, scoreability,",
  "reviewability, or farming.",
  "Respond with ONLY a JSON object of this exact shape (no prose, no code fence):",
  '{"band": "clean"|"low"|"elevated"|"high", "rationale": string, "signals": string[]}',
].join(" ");

export type AiSlopInput = {
  repoFullName: string;
  prNumber: number;
  title: string;
  body?: string | null | undefined;
  /** A bounded unified-diff-ish string (filenames + patches), built by the caller. */
  diff: string;
  actor?: string | null | undefined;
  /** The deterministic band already computed for this PR — passed as context so the model can corroborate
   *  or temper it. Never used to override the model's own judgement. */
  deterministicBand?: SlopBand | undefined;
  /** Optional BYOK: when present, the maintainer's frontier model writes the advisory (billed to their
   *  account, counted against the shared per-repo/day BYOK cap) instead of free Workers AI. Advisory-only
   *  either way — BYOK never changes whether this can block (it can't). */
  providerKey?: AiReviewProviderKey | null | undefined;
};

export type AiSlopResult =
  | { status: "disabled"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "quota_exceeded"; estimatedNeurons: number; remainingBudget: number }
  | { status: "ok"; finding: SignalFinding | null; band: SlopBand | null; estimatedNeurons: number };

type SlopOpinion = { band: SlopBand; rationale: string; signals: string[] };

const SLOP_BANDS: readonly SlopBand[] = ["clean", "low", "elevated", "high"];

function isSlopBand(value: unknown): value is SlopBand {
  return typeof value === "string" && (SLOP_BANDS as readonly string[]).includes(value);
}

type AiGatewayOptions = { gateway?: { id: string } };
type AiRunner = { run?: (model: string, options: Record<string, unknown>, extra?: AiGatewayOptions) => Promise<unknown> };

/** Parse a model's JSON slop opinion into a normalized {@link SlopOpinion}, or null when unusable. */
export function parseSlopOpinion(text: string): SlopOpinion | null {
  const match = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    if (!isSlopBand(obj.band)) return null;
    const rationale = typeof obj.rationale === "string" ? obj.rationale.trim().slice(0, 400) : "";
    const signals = Array.isArray(obj.signals)
      ? obj.signals.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 4)
      : [];
    if (!rationale && signals.length === 0) return null;
    return { band: obj.band, rationale, signals };
  } catch {
    return null;
  }
}

/**
 * Convert a parsed opinion into a public-safe advisory finding, or null to add nothing. Returns null for a
 * `clean` band (no noise) and whenever the public text does not survive the public/private sanitizer.
 */
export function slopFindingFromOpinion(opinion: SlopOpinion): SignalFinding | null {
  if (opinion.band === "clean") return null;
  const safeRationale = toPublicSafe(opinion.rationale);
  const safeSignals = opinion.signals.map((s) => toPublicSafe(s)).filter((s): s is string => Boolean(s));
  // Nothing publishable survived sanitization → drop the advisory entirely (fail-safe, never publish).
  if (!safeRationale && safeSignals.length === 0) return null;
  const detailBody = safeRationale ?? "An AI maintainer-assist pass flagged possible low-effort patterns in this change.";
  const detail = safeSignals.length > 0 ? `${detailBody} Observations: ${safeSignals.join("; ")}.` : detailBody;
  const publicText = `AI maintainer-assist (advisory): ${detail}`;
  return {
    code: AI_SLOP_FINDING_CODE,
    title: `AI maintainer-assist flagged possible low-effort patterns (${opinion.band})`,
    // `elevated`/`high` read as a warning; `low` as an informational note. NEVER `critical` (never a blocker).
    severity: opinion.band === "elevated" || opinion.band === "high" ? "warning" : "info",
    detail,
    action: "Advisory only — review the noted patterns; this AI assist never blocks the gate.",
    publicText,
  };
}

/** One free Workers-AI slop opinion with a reliable per-slot fallback and a 3× retry on the primary. */
async function runWorkersSlopOpinion(env: Env, system: string, user: string, maxTokens: number): Promise<SlopOpinion | null> {
  const ai = env.AI as unknown as AiRunner | undefined;
  if (!ai || typeof ai.run !== "function") return null;
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  const extra: AiGatewayOptions | undefined = gatewayId ? { gateway: { id: gatewayId } } : undefined;
  // Primary then a reliable per-slot fallback (distinct model families), 3× retry each before giving up.
  for (const model of [BEST_REVIEW_MODELS[0], RELIABLE_FALLBACK_MODELS[0]]) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await ai.run(
          model,
          { max_tokens: maxTokens, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
          extra,
        );
        const parsed = parseSlopOpinion(coerceAiText(result));
        if (parsed) return parsed;
      } catch {
        /* retry / fall through to fallback */
      }
    }
  }
  return null;
}

function buildUserPrompt(input: AiSlopInput): string {
  return [
    `Repository: ${input.repoFullName}`,
    `Pull request #${input.prNumber}: ${input.title}`,
    input.body ? `Description:\n${input.body.slice(0, 2000)}` : "Description: (none)",
    input.deterministicBand ? `Deterministic slop band (for reference): ${input.deterministicBand}` : "",
    "",
    "Unified diff (truncated if large):",
    input.diff.slice(0, 60000),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Run the AI slop advisory. Returns a single advisory finding (or null) plus the model's band. Fail-safe on
 * every path: no finding and no thrown error ever reaches the caller.
 */
export async function runGittensoryAiSlopAdvisory(env: Env, input: AiSlopInput): Promise<AiSlopResult> {
  if (!isEnabled(env.AI_SUMMARIES_ENABLED)) return { status: "disabled", reason: "AI summaries are disabled." };
  if (!isEnabled(env.AI_PUBLIC_COMMENTS_ENABLED)) return { status: "disabled", reason: "Public AI comments are disabled." };
  if (!env.AI) return { status: "unavailable", reason: "Workers AI binding is not configured." };

  const maxTokens = clampNumber(Number(env.AI_MAX_OUTPUT_TOKENS || 256), 256, 1024);
  const user = buildUserPrompt(input);
  // BYOK bills the maintainer's own account, so it does NOT draw on the free neuron budget — it has a
  // separate per-repo/day cap shared with the AI review path. Free Workers-AI = one metered call.
  const freeCalls = input.providerKey ? 0 : 1;
  const estimatedNeurons = freeCalls === 0 ? 0 : estimateNeurons(SLOP_SYSTEM_PROMPT.length + user.length, maxTokens, 1);
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

  // BYOK frontier model if configured, else the free Workers-AI primary (with fallback). Both fail-safe to null.
  let opinion: SlopOpinion | null;
  if (input.providerKey) {
    const { text } = await callAiProvider(input.providerKey, SLOP_SYSTEM_PROMPT, user, maxTokens);
    opinion = text ? parseSlopOpinion(text) : null;
  } else {
    opinion = await runWorkersSlopOpinion(env, SLOP_SYSTEM_PROMPT, user, maxTokens);
  }
  const finding = opinion ? slopFindingFromOpinion(opinion) : null;
  await record(env, input, "ok", estimatedNeurons, finding ? `advisory finding (${opinion?.band})` : opinion ? `clean/no-op (${opinion.band})` : "no usable output", {
    band: opinion?.band ?? null,
    surfaced: Boolean(finding),
    byok: Boolean(input.providerKey),
  });
  return { status: "ok", finding, band: opinion?.band ?? null, estimatedNeurons };
}

async function record(env: Env, input: AiSlopInput, status: string, estimatedNeurons: number, detail: string, metadata?: Record<string, unknown>): Promise<void> {
  await recordAiUsageEvent(env, {
    feature: "ai_slop_pr",
    actor: input.actor ?? null,
    route: "github_app.ai_slop",
    // `byok:<provider>` so countByokAiEventsForRepoSince (model LIKE 'byok:%') counts it toward the cap.
    model: input.providerKey ? `byok:${input.providerKey.provider}` : BEST_REVIEW_MODELS.join("+"),
    status,
    estimatedNeurons,
    detail,
    metadata: { repoFullName: input.repoFullName, pullNumber: input.prNumber, ...(metadata ?? {}) },
  });
}

export const __aiSlopInternals = { parseSlopOpinion, slopFindingFromOpinion, buildUserPrompt };
