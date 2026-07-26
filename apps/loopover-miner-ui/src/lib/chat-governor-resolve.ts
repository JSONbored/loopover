// Chat-text → governor pause/resume action resolution (#8670). Pure: no fetch, no dispatch. Mirrors
// chat-portfolio-queue-resolve.ts's pattern: parse an operator's chat message into one of the two known
// governor actions (`governor_pause` / `governor_resume`) plus the optional pause reason. Ambiguous /
// malformed text returns an explicit unresolvable result so the caller never turns a best-guess into a
// `dispatchChatAction` call — an ordinary governor *question* ("what is the governor status?") must keep
// falling through to the read-only streaming assistant.

import {
  GOVERNOR_PAUSE_CHAT_ACTION,
  GOVERNOR_RESUME_CHAT_ACTION,
} from "../../../../packages/loopover-miner/lib/chat-governor-actions.js";

export { GOVERNOR_PAUSE_CHAT_ACTION, GOVERNOR_RESUME_CHAT_ACTION };

export type GovernorChatResolvedActionName = typeof GOVERNOR_PAUSE_CHAT_ACTION | typeof GOVERNOR_RESUME_CHAT_ACTION;

export type GovernorChatResolveResult =
  | { ok: true; action: GovernorChatResolvedActionName; params?: { reason: string } }
  | { ok: false; reason: "unresolvable"; message: string };

/** Verbs that read as a pause intent. Word-bounded so "unpaused" / "pauses" prose doesn't half-match. */
const PAUSE_WORDS = ["pause", "halt", "suspend"] as const;
/** Verbs that read as a resume intent. `\bpause\b` never matches inside "unpause", so the sets stay disjoint. */
const RESUME_WORDS = ["resume", "unpause"] as const;

/** The message must actually be about the governor — a bare "pause" (a stream? a queue?) stays unresolved. */
const GOVERNOR_RE = /\bgovernor\b/i;

/** Optional pause reason: everything after a trailing "because …" / "reason: …" clause. */
const REASON_RE = /\b(?:because|reason:?)\s+(\S.*)$/i;

const UNRESOLVABLE =
  'Couldn\'t determine a governor action. Say something like "pause the governor", "pause the governor because <reason>", or "resume the governor".';

function hasWord(text: string, words: readonly string[]): boolean {
  return words.some((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
}

/**
 * Resolve chat text to a governor pause/resume request the runner (`runGovernorChatAction`) accepts.
 * Does NOT call the dispatch layer — an unresolvable result must never be turned into a best-guess
 * dispatch, exactly like the portfolio-queue resolver.
 */
export function resolveGovernorChatAction(text: string): GovernorChatResolveResult {
  const trimmed = text.trim();
  if (!trimmed || !GOVERNOR_RE.test(trimmed)) {
    return { ok: false, reason: "unresolvable", message: UNRESOLVABLE };
  }

  const wantsPause = hasWord(trimmed, PAUSE_WORDS);
  const wantsResume = hasWord(trimmed, RESUME_WORDS);
  // Neither intent (a status question) or both at once (ambiguous) — never guess.
  if (wantsPause === wantsResume) {
    return { ok: false, reason: "unresolvable", message: UNRESOLVABLE };
  }

  if (wantsResume) {
    return { ok: true, action: GOVERNOR_RESUME_CHAT_ACTION };
  }

  const reason = trimmed.match(REASON_RE)?.[1]?.replace(/[.?!\s]+$/, "");
  // Mirror LedgersPage / readOptionalPauseReason: an empty reason is omitted, not sent as "".
  return reason
    ? { ok: true, action: GOVERNOR_PAUSE_CHAT_ACTION, params: { reason } }
    : { ok: true, action: GOVERNOR_PAUSE_CHAT_ACTION };
}
