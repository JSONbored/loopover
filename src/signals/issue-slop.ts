// Issue-side slop triage (#533). Split out of src/signals/slop.ts (#5133 follow-up) so that file can be a
// pure re-export shim over packages/gittensory-engine/src/signals/slop.ts — the engine-parity checker
// (scripts/check-engine-parity.ts) only recognizes a host file as a shim when it contains NOTHING but the
// re-export statement, so this issue-side code (never extracted to the engine; not needed by the miner's
// self-review path) needed its own file. Reuses slop.ts's re-exported clamp/slopBandFor so the two sides
// continue to share identical band math.
import { clamp, slopBandFor, type SlopAssessment } from "./slop";
import type { SignalFinding } from "./engine";

// ─── Issue-side slop triage (#533) ──────────────────────────────────────────────────────────────────
// Advisory-only maintainer triage signal for low-effort issues — there is no issue gate, so these never
// block. High-precision signals only (an empty issue body is sometimes legitimate, so the bar is set at
// "clearly low-effort": empty body, or a template opened and submitted without being filled in).

export type IssueSlopAssessmentInput = {
  title?: string | null | undefined;
  body?: string | null | undefined;
};

export const ISSUE_SLOP_WEIGHTS = {
  unfilledTemplate: 50,
  emptyBody: 40,
  titleRestatement: 35,
} as const;

export const ISSUE_SLOP_RUBRIC_MARKDOWN = [
  "# LoopOver issue slop triage rubric",
  "",
  "- `clean`: 0",
  "- `low`: 1-30",
  "- `elevated`: 31-59",
  "- `high`: 60-100",
  "",
  "Advisory-only (issues never block). Current deterministic signals:",
  "- empty issue body",
  "- issue template opened but left unfilled",
  "- issue body only restates the title (no added detail)",
].join("\n");

export function buildIssueSlopAssessment(input: IssueSlopAssessmentInput): SlopAssessment {
  const findings: SignalFinding[] = [];
  const emptyBodyFinding = buildEmptyIssueBodyFinding(input);
  // An empty body and an unfilled template are mutually exclusive (the latter needs a non-empty body), so
  // only probe for the template when there IS a body to inspect.
  const unfilledTemplateFinding = emptyBodyFinding ? null : buildUnfilledIssueTemplateFinding(input);
  // The title-restatement signal needs a body with REAL prose (so it survives the unfilled-template strip),
  // so it can only fire once the two emptier signals are ruled out — the three are mutually exclusive.
  const titleRestatementFinding = emptyBodyFinding || unfilledTemplateFinding ? null : buildTitleRestatementIssueFinding(input);
  if (unfilledTemplateFinding) findings.push(unfilledTemplateFinding);
  if (emptyBodyFinding) findings.push(emptyBodyFinding);
  if (titleRestatementFinding) findings.push(titleRestatementFinding);

  const slopRisk = clamp(
    (emptyBodyFinding ? ISSUE_SLOP_WEIGHTS.emptyBody : 0) +
      (unfilledTemplateFinding ? ISSUE_SLOP_WEIGHTS.unfilledTemplate : 0) +
      (titleRestatementFinding ? ISSUE_SLOP_WEIGHTS.titleRestatement : 0),
    0,
    100,
  );
  return { slopRisk, band: slopBandFor(slopRisk), findings };
}

export function buildEmptyIssueBodyFinding(input: IssueSlopAssessmentInput): SignalFinding | null {
  if ((input.body ?? "").trim().length > 0) return null;
  // Static, public-safe text (no interpolation) — no sanitizer guard needed, unlike the PR findings.
  const detail = "This issue was opened with an empty body.";
  return {
    code: "empty_issue_body",
    title: "Issue has no description",
    severity: "warning",
    detail,
    action: "Add a clear description: what is wrong, where, and why it matters.",
    publicText: detail,
  };
}

// Fires when a non-empty body reduces to NOTHING substantive after stripping template scaffolding (HTML
// comments, markdown headings, empty bullets/checkboxes, residual punctuation) — i.e. the submitter opened
// the issue template and submitted it without filling anything in. Any real prose survives the strip → no fire.
export function buildUnfilledIssueTemplateFinding(input: IssueSlopAssessmentInput): SignalFinding | null {
  const body = (input.body ?? "").trim();
  if (body.length === 0) return null;
  const substantive = stripHtmlComments(body) // HTML comment placeholders
    .replace(/^#{1,6}\s.*$/gm, "") // markdown heading lines
    .replace(/^\s*[-*]\s*(\[[ xX]\])?\s*$/gm, "") // empty bullets / checkboxes
    .replace(/[\s>#*_`+-]/g, "") // residual markdown punctuation + whitespace
    .trim();
  // Require a real WORD (a run of 3+ letters/digits, any script) to survive — not merely "any surviving char",
  // which a single padding character would satisfy to dodge the finding. (#audit-§4)
  if (/[\p{L}\p{N}]{3,}/u.test(substantive)) return null;
  // Static, public-safe text (no interpolation) — no sanitizer guard needed.
  const detail = "The issue body contains only an unfilled template (headings or comment placeholders, no details).";
  return {
    code: "unfilled_issue_template",
    title: "Issue template left unfilled",
    severity: "warning",
    detail,
    action: "Fill in the template sections with the actual problem details.",
    publicText: detail,
  };
}

// Normalize for restatement comparison: lowercase, then collapse every run of non-alphanumeric characters
// (punctuation, markdown, whitespace, emoji) to a single space. This makes "Login is BROKEN!" and
// "login is broken" compare equal, so reformatting/punctuation alone cannot dodge the signal.
function normalizeIssueText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Fires when a non-empty body adds NOTHING beyond the title — it normalizes to exactly the title (a verbatim
// restatement or the title pasted back as the "description"). High-precision and conservative: the body must
// reduce to the title with zero extra words, so any genuine added detail (steps, location, expected vs actual)
// clears it. Distinct from the unfilled-template signal, whose body has no real word at all. (#533)
export function buildTitleRestatementIssueFinding(input: IssueSlopAssessmentInput): SignalFinding | null {
  const title = normalizeIssueText(input.title ?? "");
  const body = normalizeIssueText(input.body ?? "");
  // Need both a real title and a real body to compare; an empty side is another signal's concern.
  if (title.length === 0 || body.length === 0) return null;
  if (body !== title) return null;
  // Static, public-safe text (no interpolation) — no sanitizer guard needed.
  const detail = "The issue body only restates the title and adds no further detail.";
  return {
    code: "title_only_restatement",
    title: "Issue body only restates the title",
    severity: "warning",
    detail,
    action: "Add detail beyond the title: what is wrong, where it happens, and why it matters.",
    publicText: detail,
  };
}

function stripHtmlComments(input: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < input.length) {
    const commentStart = input.indexOf("<!--", cursor);
    if (commentStart === -1) {
      output += input.slice(cursor);
      break;
    }

    output += input.slice(cursor, commentStart);
    const commentEnd = input.indexOf("-->", commentStart + 4);
    if (commentEnd === -1) {
      // An unterminated "<!--" is rendered by GitHub/CommonMark as a comment running to end-of-body — the
      // text is hidden — so it must NOT survive as substantive content. Dropping it (rather than appending
      // it) closes an evasion where a placeholder-only body dodges the unfilled-template signal just by
      // omitting the closing "-->". Real prose BEFORE the comment was already appended above and is kept.
      break;
    }

    cursor = commentEnd + 3;
  }

  return output;
}
