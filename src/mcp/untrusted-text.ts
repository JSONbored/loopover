// Shared scrub for upstream free-form text echoed back through an MCP tool result (#9163).
// `loopover_find_opportunities` copies a GitHub issue's `title` straight from the GitHub API into its
// tool result; the only existing transform on the way out, `redactSensitiveForMcp` (server.ts), filters
// KEY names against a wallet/hotkey/trust-score pattern and never touches string VALUES. A public GitHub
// issue title is attacker-authored text handed directly into the context of a model that also holds
// local write tools (open PR, close PR, delete branch, file issue) with no auth gate of its own -- this
// is the indirect-injection SOURCE half of a privately-tracked advisory (that advisory owns the sink).
//
// Every MCP tool result that echoes upstream free-form text (an issue title, a resolved-issue title
// inside a report, etc.) MUST route it through `sanitizeUntrustedMcpText` so the neutralization can never
// be silently skipped by a future tool -- this module is the one place that decision is made.
import { neutralizePromptInjection } from "../review/prompt-injection";

/** Requirement: truncate untrusted upstream text to ~120 chars before it enters a tool result -- caps
 *  how much of a single field a title-shaped payload can ever carry. */
export const MAX_UNTRUSTED_MCP_TEXT_LENGTH = 120;

const MARKDOWN_FENCE_RE = /`{3,}/g;
const HTML_COMMENT_OPEN_RE = /<!--/g;
const HTML_COMMENT_CLOSE_RE = /-->/g;

/** True for a C0-control or DEL code point -- deliberately checked by codepoint rather than a regex
 *  escape range, so this stays byte-exact regardless of how the surrounding literal is transcribed. */
function isControlCodePoint(codePoint: number): boolean {
  return codePoint < 0x20 || codePoint === 0x7f;
}

/** Collapse embedded control characters (newlines, tabs, etc.) to a single space -- a title is rendered
 *  as one line, and a raw newline could otherwise be used to visually split a redacted marker back into
 *  something that reads as two separate, less-suspicious fragments. */
function collapseControlChars(value: string): string {
  let out = "";
  let inRun = false;
  for (const ch of value) {
    // `charCodeAt`, not `codePointAt`: every control/DEL codepoint this function cares about is a single
    // BMP UTF-16 unit, so it's always at index 0 of `ch` (a for-of code point can span two units for an
    // astral character, but never for a control char) -- and unlike `codePointAt`, `charCodeAt`'s return
    // type carries no `undefined` for an in-range index, so there is no nullish fallback branch to fake-cover.
    const codePoint = ch.charCodeAt(0);
    if (isControlCodePoint(codePoint)) {
      if (!inRun) out += " ";
      inRun = true;
    } else {
      out += ch;
      inRun = false;
    }
  }
  return out;
}

/** Neutralize + truncate a single piece of upstream free-form text (a GitHub issue title, etc.) before
 *  it enters an MCP tool's `content`/`structuredContent`. Order matters: markdown fences and HTML
 *  comments are defused FIRST (either could otherwise fence off or hide a payload from a naive reader),
 *  then {@link neutralizePromptInjection} defangs recognized reviewer-manipulation phrasing, then the
 *  result is collapsed to a single line and length-capped so one field can never smuggle in an
 *  oversized payload. Returns `""` for a missing/blank input rather than throwing -- callers should
 *  never need a try/catch just to render an untrusted title. */
export function sanitizeUntrustedMcpText(value: string | null | undefined): string {
  if (!value) return "";
  const defenced = value
    .replace(MARKDOWN_FENCE_RE, "'''")
    .replace(HTML_COMMENT_OPEN_RE, "[")
    .replace(HTML_COMMENT_CLOSE_RE, "]");
  const { text } = neutralizePromptInjection(defenced);
  const collapsed = collapseControlChars(text).replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_UNTRUSTED_MCP_TEXT_LENGTH
    ? `${collapsed.slice(0, MAX_UNTRUSTED_MCP_TEXT_LENGTH - 3)}...`
    : collapsed;
}
