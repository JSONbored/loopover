// Metadata-only prompt-packet builder (#2321): four analyze-phase text fields scrubbed with the same PUBLIC_UNSAFE_TERMS / PUBLIC_LOCAL_PATH_INLINE vocabulary as src/signals/redaction.ts (duplicated here so gittensory-engine stays standalone).

/** Canonical economic/identity term vocabulary (alternation source only — mirrors `PUBLIC_UNSAFE_TERMS`). */
const PUBLIC_UNSAFE_TERMS = String.raw`(?:reward|score|wallet|hotkey|coldkey|mnemonic|payout|ranking)\w*|farming|raw[-_\s]?trust|trust[-_\s]?score|private[-_\s]?reviewability|reviewability`;

/** Canonical local-filesystem-root vocabulary (alternation source only — mirrors `PUBLIC_LOCAL_PATH_INLINE`). */
const PUBLIC_LOCAL_PATH_INLINE = String.raw`/Users/|/home/|/root/|/var/|/opt/|/tmp/|/private/|[A-Za-z]:[\\/]Users[\\/]|[A-Za-z]:[\\/]Program Files[\\/]`;

const UNSAFE_TERM_SCRUB = new RegExp(String.raw`\b(${PUBLIC_UNSAFE_TERMS})\b`, "gi");
const LOCAL_PATH_SCRUB = new RegExp(String.raw`(?:${PUBLIC_LOCAL_PATH_INLINE})[^\s"',;)]*`, "gi");

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

/** Build a public-safe analyze prompt packet from metadata-only inputs. Clean fields pass through byte-identical; unsafe terms and local paths are redacted. */
export function buildPromptPacket(input: PromptPacketInput): PromptPacket {
  const packet = emptyPromptPacketInput();
  for (const field of PROMPT_PACKET_TEXT_FIELDS) packet[field] = sanitizePromptPacketField(input[field]);
  return packet;
}
