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
import {
  countByokAiEventsForRepoSince,
  recordAiUsageEvent,
  sumAiEstimatedNeuronsSince,
} from "../db/repositories";
import { sanitizePublicComment } from "../queue-intelligence";
import { defangReviewInput } from "../review/safety";
import { convergedFeatureActive } from "../review/feature-activation";
import { errorMessage } from "../utils/json";
import type { ReviewProfile } from "../signals/focus-manifest";

/**
 * The best free Workers-AI model pair for review accuracy — two different families for independence,
 * both probe-verified in reviewbot to emit clean JSON. The consensus blocker always uses this pair.
 */
export const BEST_REVIEW_MODELS: readonly [string, string] = [
  "@cf/openai/gpt-oss-120b",
  "@cf/nvidia/nemotron-3-120b-a12b",
];

/** Reliable per-slot fallbacks (non-reasoning, clean JSON) so a slot never comes back empty. */
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
  '{"assessment": string, "blockers": string[], "nits": string[], "suggestions": string[]}',
  "- assessment: a substantive but CONCISE summary (2-4 sentences) — what the change does, whether it is correct, and the most notable detail. Specific to THIS diff; never a generic one-liner and never hedging ('appears to', 'seems to').",
  "- blockers: each ONE sentence naming a defect that WILL break the code as written — a missing import/symbol (ReferenceError), a logic error that produces wrong output, a security hole, data loss, a build/test breakage, or an API/contract break. Reference the file (and function/line). Empty [] if there are genuinely none.",
  "- nits: each ONE sentence — a NON-blocking point: style, naming, a missing doc, or DEFENSIVE hardening ('should handle the empty case', 'consider catching errors', 'add validation'). File-reference where you can.",
  "- suggestions: a few concrete, file-referenced improvements (may overlap nits).",
  "BE SELECTIVE — report only the findings that genuinely matter. List at MOST ~3 blockers and ~5 nits, keeping only the most important; prefer signal over volume and do NOT pad the lists.",
  "DEDUPLICATE — if the same kind of issue recurs across several functions or lines, report it ONCE and note it applies broadly; never repeat a near-identical finding per occurrence.",
  "SEVERITY DISCIPLINE — defensive or speculative hardening ('should handle X', 'consider validating', 'add error handling') is a NIT, not a blocker, UNLESS a real input WILL actually trigger the failure. CI or check status itself (failing, pending, unverified) is NOT a code defect — never list it (the gate evaluates CI separately).",
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

/**
 * How the independent reviewer opinions are combined into ONE gate decision (#dual-ai-combiner):
 *   • `single`     — one reviewer; its verdict IS the decision (a named blocker blocks).
 *   • `consensus`  — two reviewers; block ONLY when BOTH name a blocker; lone blocker → split (hold). The
 *                    historical cloud behavior — the default, so an unset `combine` is byte-identical.
 *   • `synthesis`  — two reviewers run separately, then merge into ONE decision (no split/hold-on-disagree):
 *                    `onMerge: either` blocks if EITHER flags a blocker; `both` only if all do.
 */
export type CombineStrategy = "single" | "consensus" | "synthesis";
/** Synthesis merge rule — block if `either` reviewer flags a blocker, or only when `both` agree. */
export type OnMerge = "either" | "both";

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
   * (byte-identical to today). A self-host plan supplies named providers instead — `{ model: "claude-code" }`,
   * `{ model: "codex" }` — addressed by the self-host AI router; `fallback` is Workers-AI-only (a self-host
   * provider has none). `single` (or a single entry) runs reviewer[0]; consensus/synthesis run [0] and [1].
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
      inconclusive: boolean;
      estimatedNeurons: number;
      reviewerCount: number;
      inlineFindings: InlineFinding[];
    };

/** A line-anchored review finding the model can emit for quiet inline PR comments (#inline-comments). `line` is
 *  the 1-based line number in the NEW (post-change) file; `severity` separates a must-fix from a nit. The body
 *  is made public-safe before it ever leaves the engine (see {@link composeInlineFindings}). */
export type InlineFinding = {
  path: string;
  line: number;
  severity: "blocker" | "nit";
  body: string;
};

export type ModelReview = {
  assessment: string;
  // blockers = concrete must-fix defects in the diff (drive the consensus defect / gate); nits = non-blocking
  // points; suggestions = concrete improvements (rendered alongside nits). reviewbot-parity shape. (#extensive-reviews)
  blockers: string[];
  nits: string[];
  suggestions: string[];
  // Line-anchored findings for inline PR review comments (#inline-comments). ALWAYS present (parseModelReview
  // sets []); populated only when the caller asked for them (input.inlineFindings) AND the model emitted any.
  inlineFindings: InlineFinding[];
};

type AiGatewayOptions = { gateway?: { id: string } };
type AiRunner = {
  run?: (
    model: string,
    options: Record<string, unknown>,
    extra?: AiGatewayOptions,
  ) => Promise<unknown>;
};

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
      Array.isArray(value)
        ? value
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.trim())
            .filter(Boolean)
            .slice(0, 6)
        : [];
    // Fail-safe: a malformed/absent inlineFindings field degrades to []; each item missing a usable path / a
    // positive line / a body is skipped, never partial. Severity defaults to "nit" unless it's exactly "blocker".
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
              const body = typeof o.body === "string" ? o.body.trim() : "";
              const severity: "blocker" | "nit" =
                o.severity === "blocker" ? "blocker" : "nit";
              return path && line > 0 && body
                ? [{ path, line, severity, body }]
                : [];
            })
            .slice(0, 20)
        : [];
    const assessment =
      typeof obj.assessment === "string" ? obj.assessment.trim() : "";
    const blockers = toList(obj.blockers);
    const nits = toList(obj.nits);
    const suggestions = toList(obj.suggestions);
    const inlineFindings = toInlineFindings(obj.inlineFindings);
    if (assessment === INCOHERENT_DIFF_ASSESSMENT) return null;
    if (
      !assessment &&
      blockers.length === 0 &&
      nits.length === 0 &&
      suggestions.length === 0
    )
      return null;
    return { assessment, blockers, nits, suggestions, inlineFindings };
  } catch {
    return null;
  }
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
  // Review-enrichment brief (#1472): append the external REES analysis block when the caller supplied one (flag
  // GITTENSORY_REVIEW_ENRICHMENT on AND REES_URL set). Absent/empty (the default) → the prompt is byte-identical.
  const enrichmentSection = input.enrichment?.promptSection;
  if (enrichmentSection) lines.push("", enrichmentSection);
  return lines.join("\n");
}

// `.gittensory.yml` review.profile → an appended tone instruction (#review-profile). `balanced`/absent appends
// nothing (byte-identical). PRESENTATION ONLY: it shapes how many nits the write-up surfaces, never the verdict.
const REVIEW_PROFILE_SUFFIX: Record<"chill" | "assertive", string> = {
  chill:
    "\n\nReview profile: CHILL. Report ONLY blocking, must-fix defects (bugs, security, data loss, breaking changes). Do NOT raise style preferences, naming, or minor nitpicks — omit them entirely.",
  assertive:
    "\n\nReview profile: ASSERTIVE. Beyond blocking defects, also surface minor improvements, style/consistency suggestions, and nitpicks — be thorough and exacting, clearly marking each non-blocking item as a nit.",
};

// `.gittensory.yml` review.inline_comments → an appended instruction to ALSO emit line-anchored findings for
// quiet inline PR comments (#inline-comments). Absent/off appends nothing (byte-identical). The model keeps the
// existing 4-field shape and simply ADDS an `inlineFindings` array.
const INLINE_FINDINGS_SUFFIX =
  '\n\nINLINE FINDINGS: ALSO include an additional top-level field "inlineFindings" in the SAME JSON object — an array (possibly empty) of your most important findings, each anchored to a specific changed line, for inline PR comments. Each item: {"path": the changed file path EXACTLY as shown in the diff, "line": the 1-based line number in the NEW file (count forward from the "+" start in the nearest "@@ -old +new @@" hunk header) of an ADDED ("+") line you are commenting on, "severity": "blocker" or "nit", "body": the one-sentence finding}. Include ONLY findings you can place on a specific added line; OMIT any you cannot anchor precisely (a wrong line is worse than none). At most ~10 items.';

/** The effective reviewer SYSTEM prompt. Appends the grounding-discipline suffix when the caller supplied one
 *  (flag GITTENSORY_REVIEW_GROUNDING on), the `review.profile` tone suffix when set, then the inline-findings
 *  instruction when the caller asked for them; all absent (default) → the base prompt, byte-identical to today. */
function buildSystemPrompt(input: GittensoryAiReviewInput): string {
  const groundingSuffix = input.grounding?.systemSuffix ?? "";
  // Review-enrichment brief (#1472): the REES supplies a one-line discipline suffix ("treat a listed CVE/secret as
  // verified ground truth"). Absent (default) ⇒ "" ⇒ byte-identical.
  const enrichmentSuffix = input.enrichment?.systemSuffix ?? "";
  const profileSuffix =
    input.profile === "chill" || input.profile === "assertive"
      ? REVIEW_PROFILE_SUFFIX[input.profile]
      : "";
  // `.gittensory.yml` review.path_instructions (#review-path-instructions): the caller pre-resolved the entries
  // matching this PR's files into a prompt section; empty ⇒ nothing appended (byte-identical).
  const pathSuffix = input.pathGuidance?.trim() ? input.pathGuidance : "";
  // `.gittensory.yml` review.instructions (#review-instructions): a repo-level maintainer brief appended to every
  // review; empty ⇒ nothing appended (byte-identical).
  const repoInstructionsSuffix = input.repoInstructions?.trim()
    ? ` REPOSITORY REVIEW INSTRUCTIONS (maintainer conventions for this repo — honor them unless they conflict with a real defect): ${input.repoInstructions.trim()}`
    : "";
  const inlineSuffix = input.inlineFindings ? INLINE_FINDINGS_SUFFIX : "";
  return `${REVIEW_SYSTEM_PROMPT}${groundingSuffix}${enrichmentSuffix}${profileSuffix}${pathSuffix}${repoInstructionsSuffix}${inlineSuffix}`;
}

/** One Workers-AI opinion with a per-slot reliable fallback and a 3× retry on the primary. */
async function runWorkersOpinion(
  env: Env,
  primary: string,
  fallback: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<ModelReview | null> {
  const ai = env.AI as unknown as AiRunner | undefined;
  if (!ai || typeof ai.run !== "function") return null;
  // Route through Cloudflare AI Gateway when configured (caching, rate-limiting, logging, fallback). The
  // diff/prompt is the cache key input, scoped per model + content, so distinct PRs never share a cached
  // review. Unset → direct binding call (unchanged behavior).
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  const extra: AiGatewayOptions | undefined = gatewayId
    ? { gateway: { id: gatewayId } }
    : undefined;
  for (const model of fallback && fallback !== primary
    ? [primary, fallback]
    : [primary]) {
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
      } catch (error) {
        // Fail-LOUD (#1566): a provider/CLI failure (e.g. the claude-code CLI absent → spawn ENOENT, or an auth/API
        // error) must be VISIBLE, not silently swallowed into a "no usable output" review. Log every failed attempt;
        // the loop still falls through to the fallback model so a transient error doesn't abort the whole review.
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "ai_review_provider_attempt_failed",
            model,
            attempt,
            error: errorMessage(error),
          }),
        );
      }
    }
  }
  return null;
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
};

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
  const model =
    providerKey.model || PROVIDER_DEFAULT_MODEL[providerKey.provider];
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
          messages: [{ role: "user", content: user }],
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
): Promise<ProviderReviewOutcome> {
  const { text, failure } = await callAiProvider(
    providerKey,
    system,
    user,
    maxTokens,
  );
  return {
    review: text ? parseModelReview(text) : null,
    ...(failure ? { failure } : {}),
  };
}

/** Compose a public-safe markdown advisory blurb from one or two model reviews. Null if nothing safe. */
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
  if (!assessment && safeBlockers.length === 0 && safeNits.length === 0)
    return null;
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

/** Hard cap on inline findings surfaced per review — a focused review leaves a handful of precise inline notes,
 *  not a wall of them (the prompt also asks the model to be selective). (#inline-comments) */
const INLINE_FINDINGS_LIMIT = 10;

/** Compose the public-safe, deduped, capped inline findings from one or two model reviews — the line-anchored
 *  counterpart of {@link composeAdvisoryNotes}. Dedupes by path+line (first wins), drops any body that fails the
 *  public-safe filter, and caps the total. Empty array when there is nothing safe to anchor. (#inline-comments) */
export function composeInlineFindings(reviews: ModelReview[]): InlineFinding[] {
  const seen = new Set<string>();
  const out: InlineFinding[] = [];
  for (const finding of reviews.flatMap((r) => r.inlineFindings)) {
    if (out.length >= INLINE_FINDINGS_LIMIT) break;
    const key = `${finding.path}:${finding.line}`;
    if (seen.has(key)) continue;
    const safeBody = toPublicSafe(finding.body);
    if (!safeBody) continue;
    seen.add(key);
    out.push({ ...finding, body: safeBody });
  }
  return out;
}

/** A CONSENSUS defect = BOTH reviews independently name at least one concrete blocker (the severity-disciplined
 *  reviewbot model: a lone blocker in a dual review is a split, not a hard block). Requiring two independent
 *  models to AGREE is itself the precision mechanism — the free Workers-AI models emit no calibrated confidence
 *  score, so there is no numeric floor to enforce; agreement is the signal. */
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
  return { title, detail, confidence: 1 };
}

/** Deterministic SYNTHESIS of one public-safe defect from the reviews that named a blocker — same public-safe
 *  discipline as `consensusDefectOf` (cite the primary blocker; an unsafe title drops the whole block, fail-safe).
 *  Used by the `synthesis` and `single` combine strategies. */
function synthesizeDefect(
  reviews: ReadonlyArray<ModelReview>,
): AiConsensusDefect | null {
  const primary = reviews
    .flatMap((r) => r.blockers)
    .map((b) => b.trim())
    .find((b) => b.length > 0);
  if (!primary) return null;
  const title = toPublicSafe(primary);
  if (!title) return null; // unsafe title → drop the block entirely (fail-safe)
  return { title, detail: title, confidence: 1 }; // cite the primary blocker as both title + detail
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
): { defect: AiConsensusDefect | null; split: boolean; inconclusive: boolean } {
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

  // `consensus` (default) — BYTE-IDENTICAL to the historical block-mode pair logic.
  const [a, b] = reviews;
  if (a && b) {
    const defect = consensusDefectOf(a, b);
    const split = !defect && a.blockers.length > 0 !== b.blockers.length > 0;
    return { defect, split, inconclusive: false };
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
      reason: "Workers AI binding is not configured.",
    };

  // Output ceiling for the review. The old 1024 cap forced a shallow "no blockers" scorecard across large diffs;
  // a thorough finding-by-finding review needs real room. Default 4096, max 8192 (the free Workers-AI 120B models
  // support it); an explicit env value still wins, clamped. (#extensive-reviews)
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
  // The daily neuron budget governs FREE Workers-AI spend only. BYOK advisory calls bill the maintainer's
  // own provider account, so they are not counted here (and a BYOK advisory still runs when the free
  // budget is exhausted). Free calls = the consensus pair in block mode (always Workers AI), plus the
  // advisory leg only when it is NOT BYOK.
  // Reviewers + combine strategy (#dual-ai-combiner). DEFAULT = the free Workers-AI pair (per-slot fallbacks)
  // combined by `consensus` — byte-identical to today. The self-host boot plan (`env.AI_REVIEW_PLAN`) supplies
  // named providers (e.g. claude-code + codex) and a strategy; an explicit `input` field overrides it. `single`
  // (or a single configured reviewer) runs ONE opinion; consensus/synthesis run two.
  const plan = env.AI_REVIEW_PLAN;
  const configured: ReadonlyArray<{
    model: string;
    fallback?: string | null | undefined;
  }> | null =
    (input.reviewers?.length ? input.reviewers : plan?.reviewers) ?? null;
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
  const combine: CombineStrategy =
    input.combine ?? plan?.combine ?? "consensus";
  const onMerge: OnMerge | null | undefined = input.onMerge ?? plan?.onMerge;
  const dual = combine !== "single" && (!configured || configured.length > 1);
  const freeAiCalls =
    (input.mode === "block" ? (dual ? 2 : 1) : 0) + (input.providerKey ? 0 : 1);
  // Estimate against the EFFECTIVE system prompt (`system`) so grounding's extra context is billed against the
  // budget. Flag-OFF, `system === REVIEW_SYSTEM_PROMPT`, so the estimate is byte-identical to today.
  const estimatedNeurons =
    freeAiCalls === 0
      ? 0
      : estimateNeurons(system.length + user.length, maxTokens, freeAiCalls);
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
  if (input.providerKey) {
    const outcome = await runProviderReview(
      input.providerKey,
      system,
      user,
      maxTokens,
    );
    advisoryReview = outcome.review;
    byokFailure = outcome.failure;
  } else {
    advisoryReview = await runWorkersOpinion(
      env,
      primary.model,
      primaryFallback,
      system,
      user,
      maxTokens,
    );
  }

  let consensusDefect: AiConsensusDefect | null = null;
  let secondReview: ModelReview | null = null;
  let aiReviewSplit = false;
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
            )
          : Promise.resolve(advisoryReview),
        runWorkersOpinion(
          env,
          secondary.model,
          secondaryFallback,
          system,
          user,
          maxTokens,
        ),
      ]);
      secondReview = b;
      // Combine per the configured strategy (#dual-ai-combiner). Default `consensus` is byte-identical to the
      // historical logic: block only on agreement, lone blocker → split, a missing opinion → inconclusive
      // (fail-closed, HELD for a human). `synthesis` merges both into one decision (no split/hold-on-disagree).
      const combined = combineReviews([a, b], { strategy: combine, onMerge });
      consensusDefect = combined.defect;
      aiReviewSplit = combined.split;
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
          )
        : advisoryReview;
      const combined = combineReviews([a], { strategy: "single" });
      consensusDefect = combined.defect;
      inconclusive = combined.inconclusive;
    }
  }

  const reviewsForNotes = [advisoryReview, secondReview].filter(
    (r): r is ModelReview => Boolean(r),
  );
  const advisoryNotes =
    reviewsForNotes.length > 0 ? composeAdvisoryNotes(reviewsForNotes) : null;
  // Line-anchored inline findings (#inline-comments): only propagate model output when the resolved feature gate
  // asked for it. AI output is PR-author-influenced, so the prompt suffix is not an authorization boundary.
  const inlineFindings = input.inlineFindings
    ? composeInlineFindings(reviewsForNotes)
    : [];

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
  );
  return {
    status: "ok",
    advisoryNotes,
    consensusDefect,
    split: aiReviewSplit,
    inconclusive,
    estimatedNeurons,
    reviewerCount: reviewsForNotes.length,
    inlineFindings,
  };
}

/** The actual configured reviewer label for usage attribution (#1566): the self-host `AI_PROVIDER:AI_MODEL` when set,
 *  else the Worker dual-AI models. Without this, self-host claude-code reviews were mis-logged as the Workers-AI model
 *  ids (`@cf/openai/gpt-oss-120b+…`), which hid the silent claude-CLI-missing outage. */
function reviewerModelLabel(env: Env): string {
  const e = env as unknown as { AI_PROVIDER?: string; AI_MODEL?: string };
  if (!e.AI_PROVIDER) return BEST_REVIEW_MODELS.join("+");
  return [e.AI_PROVIDER, e.AI_MODEL].filter(Boolean).join(":");
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
    model: input.providerKey
      ? `byok:${input.providerKey.provider}`
      : reviewerModelLabel(env),
    status,
    estimatedNeurons,
    detail,
    metadata: {
      repoFullName: input.repoFullName,
      pullNumber: input.prNumber,
      ...(metadata ?? {}),
    },
  });
}

export const __aiReviewInternals = {
  parseModelReview,
  coerceAiText,
  composeAdvisoryNotes,
  composeInlineFindings,
  consensusDefectOf,
  combineReviews,
  synthesizeDefect,
  toPublicSafe,
  estimateNeurons,
  runWorkersOpinion,
};
