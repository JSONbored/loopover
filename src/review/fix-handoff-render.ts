// Fix-handoff block RENDERER (#2175, render slice of #1962 — the config/gate slice lives in
// src/review/fix-handoff.ts's isFixHandoffEnabled/shouldEmitFixHandoff). Turns a single review finding into a
// structured, machine-readable "apply this fix" block a CONTRIBUTOR'S OWN local coding agent can consume —
// content only, no server-side write, no execution. Mirrors formatInlineBody's severity-label composition
// (inline-comments.ts) and reuses the exact no-cloud-write boundary text every other local-execution artifact
// carries (local-write-tools.ts's LOCAL_WRITE_BOUNDARY), so the guarantee reads identically everywhere
// loopover hands a contributor something to run themselves.
//
// The caller is responsible for gating emission via shouldEmitFixHandoff (fix-handoff.ts) BEFORE calling into
// this module — this file is pure rendering, public-safe by construction: it only renders fields the caller
// already produced through the public-safe filter (InlineFinding.body/suggestion are sanitized upstream by
// composeInlineFindings before they ever reach here — this module adds no new free text of its own beyond the
// fixed label/marker strings below).
//
// Also renders the AGGREGATE flavor (#5102): buildFixHandoffAggregateBlock combines every finding into ONE
// block for a single agent run over the whole PR, instead of one run per finding — same rendering contract,
// still unwired (see that function's doc comment for why).
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
const FIX_HANDOFF_MARKER = "<!-- loopover:fix-handoff -->";

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

/** A whole PR's findings rendered as ONE fix-handoff block, for a single local-agent run instead of one run per
 *  finding (#5102). */
export type FixHandoffAggregateBlock = {
  findingCount: number;
  /** The rendered, machine-readable markdown block (fenced items + an HTML comment marker a harness can grep for). */
  body: string;
  boundary: string;
};

/** The HTML comment marker prefixing the rendered aggregate block, distinct from FIX_HANDOFF_MARKER so a
 *  harness can tell a per-finding block from the aggregate one. */
const FIX_HANDOFF_AGGREGATE_MARKER = "<!-- loopover:fix-handoff-aggregate -->";

/** One numbered list item for the aggregate block: same location/label/suggestion composition as
 *  buildFixHandoffBlock, just indented under a shared numbered list instead of standing alone. */
function fixHandoffAggregateItem(finding: InlineFinding, index: number): string {
  const hasLine = Number.isInteger(finding.line) && finding.line > 0;
  const safePath = markdownPathCodeText(finding.path);
  const location = hasLine ? `${safePath}:${finding.line}` : `${safePath} (no specific line)`;
  const label = finding.severity === "blocker" ? "Blocker" : "Nit";
  const suggestion = finding.suggestion?.trim();
  const suggestionBlock = suggestion ? `\n   \`\`\`\n   ${suggestion.replace(/\n/g, "\n   ")}\n   \`\`\`` : "";
  return `${index + 1}. **${label} at \`${location}\`** — ${finding.body}${suggestionBlock}`;
}

/** PURE: combine every current finding into ONE fix-handoff block for a single local-agent run across the
 *  whole PR (#5102) — the aggregate sibling of buildFixHandoffBlock/buildFixHandoffBlocks, mirroring
 *  CodeRabbit's split between a per-finding "Prompt for AI Agents" collapsible and an aggregate "Fix all
 *  issues" prompt (confirmed against live CodeRabbit-reviewed PRs — see #5102). Same boundary-safe,
 *  content-only contract as the per-finding block: no server-side write, no execution, public-safe by
 *  construction (every field rendered here was already made public-safe upstream by composeInlineFindings).
 *  Empty in ⇒ null out — nothing to hand off. Render-only, like buildFixHandoffBlock was before its own
 *  wiring PR (#4053) — NOT wired into the unified comment here; #5102 leaves per-finding vs aggregate vs
 *  both as an open placement question for the wiring PR to resolve. */
export function buildFixHandoffAggregateBlock(findings: InlineFinding[]): FixHandoffAggregateBlock | null {
  if (findings.length === 0) return null;
  const body = [
    FIX_HANDOFF_AGGREGATE_MARKER,
    `**Fix handoff — ${findings.length} finding${findings.length === 1 ? "" : "s"} across this PR**`,
    ...findings.map((finding, index) => fixHandoffAggregateItem(finding, index)),
    `\n_${LOCAL_WRITE_BOUNDARY}_`,
  ].join("\n");
  return { findingCount: findings.length, body, boundary: LOCAL_WRITE_BOUNDARY };
}
