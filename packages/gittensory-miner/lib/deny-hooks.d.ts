export type DenyRule = {
  /** Tool-name glob (`*` = any within a segment, `**` across segments) or an exact tool name. */
  matcher: string;
  /** Optional glob tested against every path-shaped string in the tool-call input. */
  pathPattern?: string;
  /** Optional substrings that must ALL appear in one string-shaped input field (e.g. a shell command). */
  inputIncludesAll?: string[];
  /** Optional pattern that must match a whole whitespace-separated token (quotes stripped) of one
   *  string-shaped input field — for flag-shaped needles where a substring test would false-positive
   *  on an unrelated longer flag (e.g. `-f` vs. `--follow-tags`). */
  inputTokenPattern?: RegExp;
  /** Human-readable reason surfaced when this rule blocks a call. */
  reason: string;
};

export type DenyVerdict = {
  allowed: boolean;
  blockedBy?: DenyRule;
};

export type ProposedToolCall = {
  name: string;
  input: Record<string, unknown>;
};

export const DEFAULT_DENY_RULES: DenyRule[];

export function evaluateDenyHooks(toolCall: ProposedToolCall, rules?: DenyRule[]): DenyVerdict;
