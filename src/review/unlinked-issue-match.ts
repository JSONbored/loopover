// AI verification for the unlinked-issue guardrail (#unlinked-issue-guardrail). Given ONE candidate open
// issue already surfaced by the cheap deterministic pre-filter (src/signals/unlinked-issue-candidates.ts),
// ask the AI reviewer whether a PR's diff DIRECTLY and UNAMBIGUOUSLY solves that specific issue. This is
// the actual precision gate for the whole guardrail, so it fails closed at every step: a missing binding, a
// thrown provider error, an unparseable response, or a matched:true with no usable confidence all resolve to
// "not matched" rather than risk a false positive holding a legitimate PR.
//
// CRITICAL: this can HOLD a PR (suppress an otherwise-ready merge), so it uses ONLY the free/self-host AI
// path (`env.AI.run`) -- never BYOK -- mirroring ai-review.ts's own block-mode rule that BYOK must never
// affect who gets blocked. There is no `providerKey` parameter here on purpose.

import { BEST_REVIEW_MODELS, coerceAiText, extractLastJsonObject, RELIABLE_FALLBACK_MODELS } from "../services/ai-review";
import type { CandidateOpenIssue } from "../signals/unlinked-issue-candidates";

export type UnlinkedIssueMatchVerdict = {
  matched: boolean;
  confidence: number;
  evidence: string;
};

const NO_MATCH: UnlinkedIssueMatchVerdict = { matched: false, confidence: 0, evidence: "" };

const MAX_TOKENS = 400;
// This check only needs enough diff to judge scope overlap, not the full multi-file review budget.
const DIFF_CHAR_BUDGET = 6_000;

type AiRunner = { run: (model: string, options: unknown, extra?: unknown) => Promise<unknown> };

function buildSystemPrompt(): string {
  return (
    "You are verifying whether a pull request's diff DIRECTLY and UNAMBIGUOUSLY solves a SPECIFIC GitHub " +
    "issue that the PR did not link. Be conservative: default to matched=false unless the diff obviously " +
    "and substantially addresses exactly what the issue describes. A shared file, a vaguely related topic, " +
    "or a partial fix is NOT a match. Respond with ONLY a JSON object: " +
    '{"matched": boolean, "confidence": number between 0 and 1, "evidence": "one sentence citing the specific overlap, or why it does not match"}.'
  );
}

function buildUserPrompt(input: { prTitle: string; prBody: string | null | undefined; diff: string; candidate: CandidateOpenIssue }): string {
  const diff = input.diff.length > DIFF_CHAR_BUDGET ? `${input.diff.slice(0, DIFF_CHAR_BUDGET)}\n… (diff truncated)` : input.diff;
  return [
    `PULL REQUEST TITLE: ${input.prTitle}`,
    `PULL REQUEST BODY: ${input.prBody?.trim() || "(empty)"}`,
    `PULL REQUEST DIFF:\n${diff}`,
    `CANDIDATE ISSUE #${input.candidate.number}: ${input.candidate.title}`,
    `ISSUE BODY: ${input.candidate.body?.trim() || "(empty)"}`,
  ].join("\n\n");
}

function parseVerdict(text: string): UnlinkedIssueMatchVerdict {
  const jsonText = extractLastJsonObject(text);
  if (!jsonText) return NO_MATCH;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return NO_MATCH;
  }
  const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence) ? Math.min(1, Math.max(0, parsed.confidence)) : 0;
  const evidence = typeof parsed.evidence === "string" ? parsed.evidence : "";
  // A matched:true verdict with no usable (>0) confidence is untrustworthy -- fail closed rather than trust
  // an unscored "yes" (this is the one place a model's own claim of a match can still be overridden).
  const matched = parsed.matched === true && confidence > 0;
  return { matched, confidence, evidence };
}

/**
 * Ask the FREE/self-host AI provider whether a PR's diff directly solves ONE candidate open issue. Tries
 * the primary review model, then the reliable fallback, on a thrown error; returns {@link NO_MATCH} if
 * both fail, the binding is absent, or the response can't be parsed into a usable verdict. Never throws.
 */
export async function verifyUnlinkedIssueMatch(
  env: Env,
  input: { prTitle: string; prBody: string | null | undefined; diff: string; candidate: CandidateOpenIssue },
): Promise<UnlinkedIssueMatchVerdict> {
  const ai = env.AI as unknown as AiRunner | undefined;
  if (!ai || typeof ai.run !== "function") return NO_MATCH;
  const system = buildSystemPrompt();
  const user = buildUserPrompt(input);
  const models = [BEST_REVIEW_MODELS[0], RELIABLE_FALLBACK_MODELS[0]];
  for (const model of models) {
    try {
      const result = await ai.run(model, {
        max_tokens: MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      return parseVerdict(coerceAiText(result));
    } catch {
      // try the next model
    }
  }
  return NO_MATCH;
}

export const __unlinkedIssueMatchInternals = { buildSystemPrompt, buildUserPrompt, parseVerdict };
