// Linked-issue satisfaction assessment (#2172, pure analysis core of #1961).
//
// We already enforce deterministic linked-issue HARD rules (src/review/linked-issue-hard-rules.ts) and fetch
// linked-issue text in grounding, but never judge whether the PR's diff actually satisfies what the issue
// asked for. This module is the bounded, AI-BACKED analysis core: prompt composition + response parsing only —
// NO gate wiring, NO disposition change, NO I/O (no env, no model call). The caller supplies the model's raw
// text output (from whichever provider it already resolved — self-host router or BYOK, exactly like
// ai-review.ts/ai-slop.ts do); this module never talks to a model itself. That orchestration (budget, provider
// selection, usage accounting, and — eventually — a `gate.linkedIssueSatisfaction` mode wiring) is a separate,
// maintainer-only slice.
//
// Hard guarantees (mirrors ai-slop.ts's fail-safe discipline):
//   • No issue text (empty/absent) ⇒ no finding. Never guesses "unaddressed" from silence.
//   • Malformed/unparseable model output, or a thrown error while composing ⇒ no finding, never throws.
//   • A LOW-CONFIDENCE "unaddressed" verdict is never published as unaddressed — it degrades to no finding,
//     so an uncertain model never manufactures a false "you didn't fix this" call that could spook a
//     contributor. "addressed"/"partial" are not similarly gated: a false-positive "looks addressed" is a much
//     lower-stakes error than a false "unaddressed" (advisory-only either way; no gate can read this yet).
//   • Every public string is forced through the public-safe filter; anything tripping the boundary is dropped.
import { toPublicSafe } from "./ai-review";

/** The three verdicts this advisory can reach about a single linked issue. */
export const LINKED_ISSUE_SATISFACTION_STATUSES = ["addressed", "partial", "unaddressed"] as const;
export type LinkedIssueSatisfactionStatus = (typeof LINKED_ISSUE_SATISFACTION_STATUSES)[number];

/** Below this calibrated confidence, an "unaddressed" verdict is too uncertain to publish (see module doc) —
 *  mirrors the AI review path's confidence-floor philosophy (`aiReviewCloseConfidence`, ai-review.ts) applied
 *  here as a fixed, non-configurable floor since this slice has no gate wiring to carry an operator override. */
export const LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR = 0.5;

const MAX_RATIONALE_LENGTH = 400;
const MAX_ISSUE_TEXT_CHARS = 6000;
const MAX_DIFF_CHARS = 60000;
const MAX_BODY_CHARS = 2000;

export type LinkedIssueSatisfactionInput = {
  /** The already-fetched linked-issue title + body text (grounding already resolved this — see
   *  review/grounding-wire.ts). Empty/absent ⇒ no finding (fail-safe: never assessed without real issue text). */
  issueText: string | null | undefined;
  prTitle: string;
  prBody?: string | null | undefined;
  /** A bounded unified-diff-ish string (filenames + patches), same shape ai-review.ts/ai-slop.ts already build. */
  diff: string;
};

/** A public-safe, bounded assessment of whether a PR satisfies its linked issue. Never a gate signal by
 *  itself — purely advisory data for a renderer (#2174) or a future gate slice to consume. */
export type LinkedIssueSatisfactionResult = {
  status: LinkedIssueSatisfactionStatus;
  rationale: string;
  /** The model's own calibrated confidence in [0,1] that `status` is correct. */
  confidence: number;
};

function isSatisfactionStatus(value: unknown): value is LinkedIssueSatisfactionStatus {
  return typeof value === "string" && (LINKED_ISSUE_SATISFACTION_STATUSES as readonly string[]).includes(value);
}

/** Calibrated confidence in [0,1]; an absent/unparseable/out-of-range value degrades to 0 — the LOWEST
 *  confidence, not the highest (opposite of ai-review.ts's ModelReview default). An "unaddressed" verdict with
 *  no legible confidence must fail the floor below rather than be trusted by default, since a hallucinated
 *  "unaddressed" is the one failure mode this module exists to suppress. */
function parseConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) return 0;
  return n;
}

const SATISFACTION_SYSTEM_PROMPT = [
  "You are a senior open-source maintainer judging whether a pull request satisfies the intent and acceptance",
  "criteria of a SINGLE linked issue. Judge ONLY the issue text and the PR's title/description/diff provided.",
  "Be conservative: 'addressed' requires the diff to visibly fulfill the issue's own ask; 'partial' means it",
  "makes real progress but plainly leaves part of the issue's stated scope undone; 'unaddressed' means the",
  "diff does not appear to touch the issue's ask at all, or contradicts it.",
  "Reserve 'unaddressed' for clear, evidence-backed cases — when genuinely uncertain, prefer 'partial'.",
  "Never accuse; describe the gap constructively so a maintainer can decide what (if anything) to do.",
  "Never mention rewards, rankings, payouts, wallets, hotkeys, coldkeys, trust scores, scoreability,",
  "reviewability, or farming.",
  "Respond with ONLY a JSON object of this exact shape (no prose, no code fence):",
  '{"status": "addressed"|"partial"|"unaddressed", "rationale": string, "confidence": number}',
  "- rationale: ONE to TWO sentences, specific to this issue and this diff.",
  "- confidence: your CALIBRATED probability in [0,1] that `status` is correct. Use a lower value when the",
  "issue text is vague, the diff is hard to map to the issue's ask, or you are speculating.",
].join(" ");

/** Compose the user prompt for the linked-issue satisfaction model call. Pure — no I/O. Omits the description
 *  line when the PR body is empty, mirroring ai-slop.ts's buildUserPrompt shape. */
export function buildLinkedIssueSatisfactionPrompt(input: LinkedIssueSatisfactionInput): string {
  const issueText = (input.issueText ?? "").trim().slice(0, MAX_ISSUE_TEXT_CHARS);
  return [
    `Linked issue text:\n${issueText}`,
    "",
    `Pull request: ${input.prTitle}`,
    input.prBody?.trim() ? `Description:\n${input.prBody.trim().slice(0, MAX_BODY_CHARS)}` : "Description: (none)",
    "",
    "Unified diff (truncated if large):",
    input.diff.slice(0, MAX_DIFF_CHARS),
  ].join("\n");
}

/** Parse the model's raw JSON text response into a {@link LinkedIssueSatisfactionResult}, or null when the
 *  output is unusable (no JSON object, invalid status, or the confidence floor rejects an "unaddressed" call).
 *  PURE — never throws (a malformed blob that matches the brace regex but fails JSON.parse is caught). */
export function parseLinkedIssueSatisfactionOpinion(text: string): LinkedIssueSatisfactionResult | null {
  const match = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!isSatisfactionStatus(obj.status)) return null;
  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim().slice(0, MAX_RATIONALE_LENGTH) : "";
  const confidence = parseConfidence(obj.confidence);
  // Fail-safe floor (#2172): a low-confidence "unaddressed" is never published as unaddressed — the caller
  // gets no finding at all rather than a shaky "you didn't fix this" call. addressed/partial are unaffected.
  if (obj.status === "unaddressed" && confidence < LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR) return null;
  if (!rationale) return null;
  return { status: obj.status, rationale, confidence };
}

/**
 * Build the bounded, public-safe linked-issue satisfaction result from raw model text, given the already-
 * fetched issue text. PURE + fail-safe: no issue text, unparseable output, a below-floor "unaddressed" call, or
 * a rationale that does not survive public-safe sanitization all yield `null` — the caller only surfaces a
 * finding when this returns non-null. Never throws.
 */
export function buildLinkedIssueSatisfactionResult(
  issueText: string | null | undefined,
  modelResponseText: string,
): LinkedIssueSatisfactionResult | null {
  if (!(issueText ?? "").trim()) return null;
  try {
    const opinion = parseLinkedIssueSatisfactionOpinion(modelResponseText);
    if (!opinion) return null;
    const safeRationale = toPublicSafe(opinion.rationale);
    if (!safeRationale) return null;
    return { status: opinion.status, rationale: safeRationale, confidence: opinion.confidence };
  } catch {
    return null;
  }
}

export const __linkedIssueSatisfactionInternals = {
  parseLinkedIssueSatisfactionOpinion,
  buildLinkedIssueSatisfactionPrompt,
};
