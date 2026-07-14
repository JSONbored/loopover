// Public-comment redaction (#4882): the pure, deterministic pass that strips private scoring/credibility/
// reward context out of any text before it is echoed into a public GitHub comment. Extracted out of the
// I/O-heavy `src/github/commands.ts` command layer -- it is genuinely side-effect-free string logic (no D1, no
// Env, no network) with the highest fan-in of that file's stranded pure helpers (10+ consumers across the
// review-stack), so it belongs in the shared engine where the self-host backend and the miner can both reuse it
// without depending on the whole command layer. Behavior is byte-for-byte identical to the pre-extraction
// implementation.

/** Redact private reviewability terminology unless it is part of a literal `@loopover reviewability` command
 *  invocation (which is a public command name, safe to echo). Internal helper for {@link sanitizePublicComment}. */
function sanitizeReviewabilityTerm(value: string): string {
  return value.replace(/\breviewability\b/gi, (match, offset, fullText: string) => {
    const prefix = fullText.slice(Math.max(0, offset - "@loopover ".length), offset).toLowerCase();
    return prefix.endsWith("@loopover ") ? match : "private context";
  });
}

/**
 * Redact private, never-public scoring/credibility/reward/ranking context from a string bound for a public
 * GitHub comment, replacing each such phrase with the neutral marker `private context`. Pure and deterministic:
 * identical input always yields identical output, no IO. The catch-all passes collapse residual numeric score
 * transitions and repeated `private context` runs left behind by an earlier phrase replacement.
 */
export function sanitizePublicComment(value: string): string {
  const sanitized = value
    .replace(/\bopen pr count\s+\d+\s+exceeds threshold\s+\d+\b\.?/gi, "private context")
    .replace(/\bopen pr count is at or below\s+\d+\b/gi, "private context")
    .replace(/\bmerged pr count\s+\d+\s+is below upstream floor\s+\d+\b\.?/gi, "private context")
    .replace(/\bissue-discovery history\s*\(\s*\d+\s+valid solved,\s*credibility\s+[-+]?\d+(?:\.\d+)?\s*\)\s+is below upstream floors\s*\(\s*\d+\s+valid solved,\s*[-+]?\d+(?:\.\d+)?\s+credibility\s*\)\.?/gi, "private context")
    .replace(/\bcredibility\s+[-+]?\d+(?:\.\d+)?\s+is below floor\s+[-+]?\d+(?:\.\d+)?\b\.?/gi, "private context")
    .replace(/\b(?:effective|projected|estimated) score(?: changes?)?\b(?:\s+from)?\s+[-+]?\d+(?:\.\d+)?\s*(?:->|→|to)\s*[-+]?\d+(?:\.\d+)?/gi, "private context")
    .replace(/\b(raw trust scores?|trust scores?|wallets?|hotkeys?|coldkeys?|seed phrases?|mnemonics?)\b/gi, "private context")
    .replace(/\b(public score estimates?|estimated scores?|score estimates?|estimated rewards?|rewards?|reward estimates?|payouts?|farming|scoreability|score previews?|projected score changes?)\b/gi, "private context")
    .replace(/\b(private reviewability|reviewability internals?)\b/gi, "private context")
    .replace(/\b(private rankings?|rankings?)\b/gi, "private context")
    .replace(/\b(?:open_pr_pressure|closed_pr_credibility|low_credibility|maintainer_lane|inactive_or_unknown_lane|issue_discovery_only|merged_pr_history_floor|issue_discovery_validity_floor)\b/gi, "private context")
    .replace(/\b(?:credibility(?: updates?)?|closed pr credibility|low credibility|open pr pressure)\b/gi, "private context")
    // Catch-all: a phrase replacement above (e.g. "score estimate"/"score preview") can leave a bare
    // numeric score transition behind ("private context 32.5 -> 41.2"); redact those residual numbers too.
    .replace(/\bprivate context\b\s+[-+]?\d+(?:\.\d+)?\s*(?:->|→|to)\s*[-+]?\d+(?:\.\d+)?/gi, "private context")
    .replace(/\blikely_duplicate\b/gi, "possible overlap with existing work");
  return sanitizeReviewabilityTerm(sanitized).replace(/private context(?:,\s*private context)+/gi, "private context");
}
