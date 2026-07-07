// Metadata-only prompt-packet builder (#2321 / analyze-phase membrane).
//
// Pure, side-effect-free composer that turns analyze-phase metadata (issue brief, feasibility notes, retrieved
// context, repo constraints) into the four text fields a coding agent may consume. Every field passes through the
// same public/private boundary vocabulary as `src/signals/redaction.ts` so economic/identity signals and absolute
// local paths cannot leak to an agent harness. The canonical alternation sources are duplicated here (not imported
// from `src/`) so `@jsonbored/gittensory-engine` stays standalone — keep them byte-identical to redaction.ts.

/** Canonical economic/identity term vocabulary (alternation source only — mirrors `PUBLIC_UNSAFE_TERMS`). */
const PUBLIC_UNSAFE_TERMS = String.raw`(?:reward|score|wallet|hotkey|coldkey|mnemonic|payout|ranking)\w*|farming|raw[-_\s]?trust|trust[-_\s]?score|private[-_\s]?reviewability|reviewability`;

/** Canonical local-filesystem-root vocabulary (alternation source only — mirrors `PUBLIC_LOCAL_PATH_INLINE`). */
const PUBLIC_LOCAL_PATH_INLINE = String.raw`/Users/|/home/|/root/|/var/|/opt/|/tmp/|/private/|[A-Za-z]:[\\/]Users[\\/]|[A-Za-z]:[\\/]Program Files[\\/]`;

const UNSAFE_TERM_SCRUB = new RegExp(String.raw`\b(${PUBLIC_UNSAFE_TERMS})\b`, "gi");
const LOCAL_PATH_SCRUB = new RegExp(String.raw`(?:${PUBLIC_LOCAL_PATH_INLINE})[^\s"',;)]*`, "gi");
const UNSAFE_GUARD = new RegExp(String.raw`\b(${PUBLIC_UNSAFE_TERMS})\b|${PUBLIC_LOCAL_PATH_INLINE}`, "i");

export const PROMPT_PACKET_REDACTED_TERM = "[redacted]";
export const PROMPT_PACKET_REDACTED_PATH = "<local-path>";

/** The four free-text fields the analyze prompt packet exposes to a coding agent. */
export type PromptPacketTextField = "taskBrief" | "feasibilityNotes" | "retrievalContext" | "constraints";

export const PROMPT_PACKET_TEXT_FIELDS: readonly PromptPacketTextField[] = Object.freeze([
  "taskBrief",
  "feasibilityNotes",
  "retrievalContext",
  "constraints",
]);

export type PromptPacketInput = Record<PromptPacketTextField, string>;
export type PromptPacket = PromptPacketInput;

export type PromptPacketBuildResult =
  | { ok: true; packet: PromptPacket }
  | { ok: false; rejectedField: PromptPacketTextField; reason: "unsafe_content" };

function emptyPromptPacketInput(): PromptPacketInput {
  return {
    taskBrief: "",
    feasibilityNotes: "",
    retrievalContext: "",
    constraints: "",
  };
}

/** Scrub unsafe economic/identity terms and absolute local paths from one packet field. */
export function sanitizePromptPacketField(value: string): string {
  return value.replace(LOCAL_PATH_SCRUB, PROMPT_PACKET_REDACTED_PATH).replace(UNSAFE_TERM_SCRUB, PROMPT_PACKET_REDACTED_TERM);
}

function fieldStillUnsafe(value: string): boolean {
  return UNSAFE_GUARD.test(value);
}

/**
 * Build a public-safe analyze prompt packet from metadata-only inputs. Clean fields pass through byte-identical;
 * unsafe terms and local paths are redacted; the build fails closed when a field still matches the guard afterward.
 */
export function buildPromptPacket(input: PromptPacketInput): PromptPacketBuildResult {
  const packet = emptyPromptPacketInput();
  for (const field of PROMPT_PACKET_TEXT_FIELDS) {
    const sanitized = sanitizePromptPacketField(input[field]);
    if (fieldStillUnsafe(sanitized)) {
      return { ok: false, rejectedField: field, reason: "unsafe_content" };
    }
    packet[field] = sanitized;
  }
  return { ok: true, packet };
}
