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
import { defangReviewInput, isSafetyEnabled } from "../review/safety";
import { isConvergenceRepoAllowed } from "../review/cutover-gate";

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


const REVIEW_SYSTEM_PROMPT = [
  "You are a senior open-source maintainer giving a FOCUSED, high-signal code review of a single pull request diff.",
  "Read each meaningful hunk and review like a careful human; judge ONLY the diff and the context provided.",
  "Respond with ONLY a JSON object of this exact shape (no prose, no code fence):",
  '{"assessment": string, "blockers": string[], "nits": string[], "suggestions": string[]}',
  "- assessment: a substantive but CONCISE summary (2-4 sentences) — what the change does, whether it is correct, and the most notable detail. Specific to THIS diff; never a generic one-liner and never hedging ('appears to', 'seems to').",
  "- blockers: each ONE sentence naming a defect that WILL break the code as written — a missing import/symbol (ReferenceError), a logic error that produces wrong output, a security hole, data loss, a build/test breakage, or an API/contract break. Reference the file (and function/line). Empty [] if there are genuinely none.",
  "- nits: each ONE sentence — a NON-blocking point: style, naming, a missing doc, or DEFENSIVE hardening ('should handle the empty case', 'consider catching errors', 'add validation'). File-reference where you can.",
  "- suggestions: a few concrete, file-referenced improvements (may overlap nits).",
  "BE SELECTIVE — report only the findings that genuinely matter. List at MOST ~3 blockers and ~5 nits, keeping only the most important; prefer signal over volume and do NOT pad the lists.",
  "DEDUPLICATE — if the same kind of issue recurs across several functions or lines, report it ONCE and note it applies broadly; never repeat a near-identical finding per occurrence.",
  "SEVERITY DISCIPLINE — defensive or speculative hardening ('should handle X', 'consider validating', 'add error handling') is a NIT, not a blocker, UNLESS a real input WILL actually trigger the failure. CI or check status itself (failing, pending, unverified) is NOT a code defect — never list it (the gate evaluates CI separately).",
  "DIFF SCOPE — the diff shows only CHANGED lines, NOT whole files. A function, variable, import, type, or symbol you do not SEE may already be defined or imported elsewhere in the same file/module. NEVER report a 'missing import', 'undefined/not-imported symbol', or 'X is not defined -> ReferenceError' as a blocker unless the diff ITSELF removes the definition or introduces the symbol without defining it anywhere shown. When you cannot confirm a symbol is missing from the visible diff, it is NOT a blocker — at most a nit ('verify X is imported/defined').",
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
  /**
   * Convergence (grounding, flag-gated by GITTENSORY_REVIEW_GROUNDING). The caller builds this from the PR's
   * finished CI status + the full content of the changed files (see `review/grounding-wire`). When ABSENT
   * (the default, flag-OFF), both the system and user prompts are byte-identical to today — no section is
   * appended. `systemSuffix` carries the grounding-discipline rules; `promptSection` carries the CI STATUS
   * + FULL FILE CONTENT blocks. Empty strings behave the same as absent.
   */
  grounding?: { systemSuffix?: string | undefined; promptSection?: string | undefined } | null | undefined;
  /**
   * Convergence (RAG retrieval, flag-gated by GITTENSORY_REVIEW_RAG). The caller builds this by querying the
   * codebase vector index for code/docs semantically related to the PR's changed files (see
   * `review/rag-wire`); it is the engine's pre-formatted "RELEVANT EXISTING CODE / DOCS" block, appended to
   * the USER prompt as additive reference context (callers, related modules, existing conventions) — exactly
   * like grounding. When ABSENT (the default, flag-OFF) or an empty string, the user prompt is byte-identical
   * to today — no section is appended.
   */
  ragContext?: string | null | undefined;
};

/** A consensus critical defect, already public-safe, ready to become a gate blocker finding. */
export type AiConsensusDefect = { title: string; detail: string; confidence: number };

export type GittensoryAiReviewResult =
  | { status: "disabled"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "quota_exceeded"; estimatedNeurons: number; remainingBudget: number }
  | { status: "ok"; advisoryNotes: string | null; consensusDefect: AiConsensusDefect | null; split: boolean; inconclusive: boolean; estimatedNeurons: number; reviewerCount: number };

type ModelReview = {
  assessment: string;
  // blockers = concrete must-fix defects in the diff (drive the consensus defect / gate); nits = non-blocking
  // points; suggestions = concrete improvements (rendered alongside nits). reviewbot-parity shape. (#extensive-reviews)
  blockers: string[];
  nits: string[];
  suggestions: string[];
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

/** Parse a model's JSON review into a normalized {@link ModelReview}, or null when unparseable. */
export function parseModelReview(text: string): ModelReview | null {
  const jsonText = extractLastJsonObject(text);
  if (!jsonText) return null;
  try {
    const obj = JSON.parse(jsonText) as Record<string, unknown>;
    const toList = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 6) : [];
    const assessment = typeof obj.assessment === "string" ? obj.assessment.trim() : "";
    const blockers = toList(obj.blockers);
    const nits = toList(obj.nits);
    const suggestions = toList(obj.suggestions);
    if (!assessment && blockers.length === 0 && nits.length === 0 && suggestions.length === 0) return null;
    return { assessment, blockers, nits, suggestions };
  } catch {
    return null;
  }
}

function buildUserPrompt(input: GittensoryAiReviewInput): string {
  const lines = [
    `Repository: ${input.repoFullName}`,
    `Pull request #${input.prNumber}: ${input.title}`,
    input.body ? `Description:\n${input.body.slice(0, 2000)}` : "Description: (none)",
    "",
    "Unified diff (truncated if large):",
    // Widened 60k→120k so a large multi-file PR is actually reviewed in full (the 120B Workers-AI models have a
    // 128k context window; pairing this with the higher output ceiling gives a thorough review). (#extensive-reviews)
    input.diff.slice(0, 120000),
  ];
  // Convergence (grounding): append the FINISHED CI status + FULL file content when the caller supplied them
  // (flag GITTENSORY_REVIEW_GROUNDING on). Absent/empty (the default) → the prompt is byte-identical to today.
  const groundingSection = input.grounding?.promptSection;
  if (groundingSection) lines.push("", groundingSection);
  // Convergence (RAG retrieval): append the retrieved RELEVANT EXISTING CODE / DOCS block when the caller
  // supplied one (flag GITTENSORY_REVIEW_RAG on AND an index exists). Absent/empty (the default) → byte-identical.
  const ragSection = input.ragContext;
  if (ragSection) lines.push("", ragSection);
  return lines.join("\n");
}

/** The effective reviewer SYSTEM prompt. Appends the grounding-discipline suffix when the caller supplied one
 *  (flag GITTENSORY_REVIEW_GROUNDING on); absent/empty (default) → the base prompt, byte-identical to today. */
function buildSystemPrompt(input: GittensoryAiReviewInput): string {
  const suffix = input.grounding?.systemSuffix;
  return suffix ? `${REVIEW_SYSTEM_PROMPT}${suffix}` : REVIEW_SYSTEM_PROMPT;
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
  // High-signal caps: a focused review shows only the few findings that matter (the prompt also asks the
  // model to be selective + deduplicate). Keep the core blockers and a handful of nits. (#focused-reviews)
  const blockers = [...new Set(reviews.flatMap((r) => r.blockers))].slice(0, 3);
  // nits + suggestions are both non-blocking — merge + dedupe for the write-up.
  const nits = [...new Set(reviews.flatMap((r) => [...r.nits, ...r.suggestions]))].slice(0, 5);
  const assessment = toPublicSafe(assessments[0] ?? "");
  const safeBlockers = blockers.map((s) => toPublicSafe(s)).filter((s): s is string => Boolean(s));
  const safeNits = nits.map((s) => toPublicSafe(s)).filter((s): s is string => Boolean(s));
  if (!assessment && safeBlockers.length === 0 && safeNits.length === 0) return null;
  const lines: string[] = [];
  if (assessment) lines.push(assessment, "");
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

/** A CONSENSUS defect = BOTH reviews independently name at least one concrete blocker (the severity-disciplined
 *  reviewbot model: a lone blocker in a dual review is a split, not a hard block). Requiring two independent
 *  models to AGREE is itself the precision mechanism — the free Workers-AI models emit no calibrated confidence
 *  score, so there is no numeric floor to enforce; agreement is the signal. */
export function consensusDefectOf(a: ModelReview, b: ModelReview): AiConsensusDefect | null {
  if (a.blockers.length === 0 || b.blockers.length === 0) return null;
  const title = toPublicSafe(a.blockers[0] || b.blockers[0] || "AI reviewers agree on a likely blocking defect");
  if (!title) return null; // unsafe title → drop the block entirely (fail-safe)
  // Cite ONLY the primary blocker (not every finding joined together) so the Gate's "why blocked" reason
  // stays focused on the single core defect instead of repeating the whole blockers list. (#focused-reviews)
  const detail = toPublicSafe(a.blockers[0] || b.blockers[0] || "") ?? "Both AI reviewers independently flagged a concrete must-fix defect in this change.";
  return { title, detail, confidence: 1 };
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

  // Output ceiling for the review. The old 1024 cap forced a shallow "no blockers" scorecard across large diffs;
  // a thorough finding-by-finding review needs real room. Default 4096, max 8192 (the free Workers-AI 120B models
  // support it); an explicit env value still wins, clamped. (#extensive-reviews)
  const maxTokens = clampNumber(Number(env.AI_MAX_OUTPUT_TOKENS) || 4096, 512, 8192);
  // Safety (convergence, flag-gated): defang the UNTRUSTED, author-controlled title/body/diff so a
  // prompt-injection payload never reaches the model verbatim. Flag-OFF (default) passes `input` through
  // unchanged → the prompt is byte-identical to today. Only the title/body/diff fed to buildUserPrompt are
  // affected; this NEVER changes the verdict (a redaction is data, not a finding).
  // Per-repo cutover gate (GITTENSORY_REVIEW_REPOS): the defang activates for THIS PR's repo only when it
  // is allowlisted AND the global safety flag is ON. Empty/unset allowlist → `input` passes through unchanged
  // for every repo (the prompt is byte-identical to today) regardless of GITTENSORY_REVIEW_SAFETY.
  const promptInput = isSafetyEnabled(env) && isConvergenceRepoAllowed(env, input.repoFullName) ? { ...input, ...defangReviewInput(input) } : input;
  const user = buildUserPrompt(promptInput);
  // Grounding-discipline SYSTEM suffix (convergence, flag-gated). When the caller supplied grounding, the
  // reviewers are told to verify claims against the attached CI/files; otherwise this is REVIEW_SYSTEM_PROMPT
  // unchanged (byte-identical). Computed from `promptInput` so it travels with the (possibly defanged) input.
  const system = buildSystemPrompt(promptInput);
  // The daily neuron budget governs FREE Workers-AI spend only. BYOK advisory calls bill the maintainer's
  // own provider account, so they are not counted here (and a BYOK advisory still runs when the free
  // budget is exhausted). Free calls = the consensus pair in block mode (always Workers AI), plus the
  // advisory leg only when it is NOT BYOK.
  const freeAiCalls = (input.mode === "block" ? 2 : 0) + (input.providerKey ? 0 : 1);
  // Estimate against the EFFECTIVE system prompt (`system`) so grounding's extra context is billed against the
  // budget. Flag-OFF, `system === REVIEW_SYSTEM_PROMPT`, so the estimate is byte-identical to today.
  const estimatedNeurons = freeAiCalls === 0 ? 0 : estimateNeurons(system.length + user.length, maxTokens, freeAiCalls);
  // FAIL-SAFE default (#budget-no-starve): the daily neuron budget is a runaway-LOOP backstop, not a normal-
  // operation gate. An absent/empty/non-numeric env var must default HIGH (the clamp max), never to a tiny value
  // that silently starves every dual-AI review into quota_exceeded — that exact misconfig (the deployed worker
  // read the 10k free-tier default off `main` while this branch said 2M) blocked all reviews. An EXPLICIT value
  // (including "0" to deliberately disable) still wins; only unset/empty/NaN falls back to the safe maximum.
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

  // Advisory write-up: BYOK frontier model if configured, else the free Workers-AI primary (with fallback).
  let byokFailure: ProviderFailure | undefined;
  let advisoryReview: ModelReview | null;
  if (input.providerKey) {
    const outcome = await runProviderReview(input.providerKey, system, user, maxTokens);
    advisoryReview = outcome.review;
    byokFailure = outcome.failure;
  } else {
    advisoryReview = await runWorkersOpinion(env, BEST_REVIEW_MODELS[0], RELIABLE_FALLBACK_MODELS[0], system, user, maxTokens);
  }

  let consensusDefect: AiConsensusDefect | null = null;
  let secondReview: ModelReview | null = null;
  let aiReviewSplit = false;
  let inconclusive = false;
  if (input.mode === "block") {
    // Consensus blocker ALWAYS uses the free Workers-AI pair (provider-independent, never BYOK).
    const [a, b] = await Promise.all([
      input.providerKey ? runWorkersOpinion(env, BEST_REVIEW_MODELS[0], RELIABLE_FALLBACK_MODELS[0], system, user, maxTokens) : Promise.resolve(advisoryReview),
      runWorkersOpinion(env, BEST_REVIEW_MODELS[1], RELIABLE_FALLBACK_MODELS[1], system, user, maxTokens),
    ]);
    secondReview = b;
    // Fail-CLOSED: block mode requires BOTH independent reviews. If a model errored or returned unparseable
    // output (a/b null), we cannot certify the change — signal `inconclusive` so the gate HOLDS the PR for a
    // human instead of silently passing it through to auto-merge. A clean dual review (both present, no
    // blocker) is NOT inconclusive and still passes normally.
    if (a && b) {
      consensusDefect = consensusDefectOf(a, b);
      // SPLIT = the two reviewers DISAGREE (exactly one named a blocker). Lower confidence than a clean consensus,
      // so the gate HOLDS it for review instead of auto-merging (only when there is no real consensus defect —
      // a consensus is the stronger signal and blocks on its own). (#ai-review-split)
      aiReviewSplit = !consensusDefect && (a.blockers.length > 0) !== (b.blockers.length > 0);
    } else {
      inconclusive = true;
    }
  }

  const reviewsForNotes = [advisoryReview, secondReview].filter((r): r is ModelReview => Boolean(r));
  const advisoryNotes = reviewsForNotes.length > 0 ? composeAdvisoryNotes(reviewsForNotes) : null;

  await record(env, input, "ok", estimatedNeurons, consensusDefect ? "consensus defect" : aiReviewSplit ? "split" : inconclusive ? "inconclusive — held" : advisoryNotes ? "advisory notes" : "no usable output", {
    mode: input.mode,
    byok: Boolean(input.providerKey),
    consensus: Boolean(consensusDefect),
    split: aiReviewSplit,
    inconclusive,
    ...(byokFailure ? { byokFailure } : {}),
  });
  return { status: "ok", advisoryNotes, consensusDefect, split: aiReviewSplit, inconclusive, estimatedNeurons, reviewerCount: reviewsForNotes.length };
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
