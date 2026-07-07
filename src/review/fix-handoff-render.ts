// Fix-handoff block RENDERER (#2175, render slice of #1962 — the config/gate slice lives in
// src/review/fix-handoff.ts's isFixHandoffEnabled/shouldEmitFixHandoff). Turns a single review finding into a
// structured, machine-readable "apply this fix" block a CONTRIBUTOR'S OWN local coding agent can consume —
// content only, no server-side write, no execution. Mirrors formatInlineBody's severity-label composition
// (inline-comments.ts) and reuses the exact no-cloud-write boundary text every other local-execution artifact
// carries (local-write-tools.ts's LOCAL_WRITE_BOUNDARY), so the guarantee reads identically everywhere
// gittensory hands a contributor something to run themselves.
//
// The caller is responsible for gating emission via shouldEmitFixHandoff (fix-handoff.ts) BEFORE calling into
// this module — this file is pure rendering, public-safe by construction: it only renders fields the caller
// already produced through the public-safe filter (InlineFinding.body/suggestion are sanitized upstream by
// composeInlineFindings before they ever reach here — this module adds no new free text of its own beyond the
// fixed label/marker strings below).
import { LOCAL_WRITE_BOUNDARY } from "../mcp/local-write-tools";
import type { InlineFinding } from "../services/ai-review";

/** A single finding rendered as a structured, LOCAL-execution fix-handoff block. `line` is `0` when the
 *  finding has no commentable diff line (mirrors the codebase's existing path-only sentinel — see
 *  `secretLeakFinding`/`scanDiffForSecretsWithLocations` in review/safety.ts, review/secrets-scan.ts) so the
 *  block still identifies WHERE to look, even path-only. */
export type FixHandoffBlock = {
  path: string;
  line: number;
  severity: "blocker" | "nit";
  instruction: string;
  suggestedChange?: string | undefined;
  /** The rendered, machine-readable markdown block (fenced + an HTML comment marker a harness can grep for). */
  body: string;
  boundary: string;
};

/** The HTML comment marker prefixing every rendered block, so a contributor's own agent can reliably locate and
 *  parse fix-handoff blocks in a comment body without depending on markdown structure alone. */
const FIX_HANDOFF_MARKER = "<!-- gittensory:fix-handoff -->";

/** Public-safe inline-code escaping for a finding path/location. GitHub comments still render markdown inside
 *  collapsibles, so neutralize delimiters that can break out of the `...` span or table-like contexts before
 *  composing the location label. */
function markdownPathCodeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|")
    .replace(/[<>]/g, (char) => (char === "<" ? "&lt;" : "&gt;"));
}

/** PURE: build a single finding's fix-handoff block. Never throws; a finding whose `line` is not a positive
 *  integer (0, negative, non-finite — i.e. "no commentable line") still yields a valid PATH-ONLY block rather
 *  than being dropped, since the finding itself is still actionable context even without a line anchor. */
export function buildFixHandoffBlock(finding: InlineFinding): FixHandoffBlock {
  const hasLine = Number.isInteger(finding.line) && finding.line > 0;
  const line = hasLine ? finding.line : 0;
  const safePath = markdownPathCodeText(finding.path);
  const location = hasLine ? `${safePath}:${line}` : `${safePath} (no specific line)`;
  const label = finding.severity === "blocker" ? "Blocker" : "Nit";
  const suggestedChange = finding.suggestion?.trim() || undefined;
  const suggestionBlock = suggestedChange ? `\n\nSuggested change:\n\`\`\`\n${suggestedChange}\n\`\`\`` : "";
  const body = [
    FIX_HANDOFF_MARKER,
    `**Fix handoff — ${label} at \`${location}\`**`,
    finding.body,
    suggestionBlock,
    `\n_${LOCAL_WRITE_BOUNDARY}_`,
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return {
    path: finding.path,
    line,
    severity: finding.severity,
    instruction: finding.body,
    ...(suggestedChange !== undefined ? { suggestedChange } : {}),
    body,
    boundary: LOCAL_WRITE_BOUNDARY,
  };
}

/** PURE: build a fix-handoff block for every finding in order. Empty in ⇒ empty out — no-op when there is
 *  nothing to hand off. */
export function buildFixHandoffBlocks(findings: InlineFinding[]): FixHandoffBlock[] {
  return findings.map((finding) => buildFixHandoffBlock(finding));
}
