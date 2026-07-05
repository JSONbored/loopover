export type AiPolicySource = "AI-USAGE.md" | "CONTRIBUTING.md" | "none";

export type AiPolicyVerdict = {
  allowed: boolean;
  matchedPhrase: string | null;
  source: AiPolicySource;
};

type BanPhrase = {
  phrase: string;
  pattern: RegExp;
};

const AI_POLICY_ALLOWED: AiPolicyVerdict = {
  allowed: true,
  matchedPhrase: null,
  source: "none",
};

const BAN_PHRASES: BanPhrase[] = [
  {
    phrase: "no ai-generated pull requests",
    pattern: /\bno\s+ai[-\s]+generated\s+(?:pull\s+requests|prs|contributions)\b/i,
  },
  {
    phrase: "ai-generated prs are rejected",
    pattern:
      /\bai[-\s]+generated\s+(?:prs?|pull\s+requests|contributions?)\s+(?:are|will\s+be)\s+(?:banned|rejected|not\s+accepted)\b/i,
  },
  {
    phrase: "do not submit ai-generated code",
    pattern: /\bdo\s+not\s+(?:use|submit)\s+ai[-\s]+(?:written|generated)\s+code\b/i,
  },
  {
    phrase: "llm-generated code is not accepted",
    pattern: /\b(?:ai|llm)[-\s]+generated\s+code\s+(?:is|will\s+be)\s+(?:rejected|not\s+accepted)\b/i,
  },
];

/**
 * Conservative by design (#2305): explicit ban phrases deny a repo, but ambiguous or absent policy text stays
 * allowed. False negatives can be tightened with new literal phrases; false positives would hide valid work.
 */
export function scanAiPolicyText(content: string | null | undefined, source: AiPolicySource): AiPolicyVerdict {
  const text = content ?? "";
  if (source === "none" || text.trim().length === 0) {
    return { allowed: true, matchedPhrase: null, source };
  }
  for (const ban of BAN_PHRASES) {
    if (ban.pattern.test(text)) {
      return { allowed: false, matchedPhrase: ban.phrase, source };
    }
  }
  return { allowed: true, matchedPhrase: null, source };
}

export function resolveAiPolicyVerdict(docs: {
  aiUsage: string | null | undefined;
  contributing: string | null | undefined;
}): AiPolicyVerdict {
  // An empty or whitespace-only AI-USAGE.md carries no policy and must fall through to CONTRIBUTING.md,
  // exactly as an absent (null/undefined) file does — otherwise a stub AI-USAGE.md silently fails open and
  // swallows a real ban declared in CONTRIBUTING.md (#2305).
  if (docs.aiUsage !== null && docs.aiUsage !== undefined && docs.aiUsage.trim().length > 0) {
    return scanAiPolicyText(docs.aiUsage, "AI-USAGE.md");
  }
  if (docs.contributing !== null && docs.contributing !== undefined) {
    return scanAiPolicyText(docs.contributing, "CONTRIBUTING.md");
  }
  return { ...AI_POLICY_ALLOWED };
}
