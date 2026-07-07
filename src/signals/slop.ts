import { GENERIC_COMMIT_PATTERN, hasClearNoIssueRationale, type SignalFinding } from "./engine";
import { isCodeFile, isTestFile } from "./local-branch";
import { hasLocalTestEvidence, isTestPath } from "./test-evidence";
import { isFocusManifestPublicSafe } from "./focus-manifest";
import { classifyChangedFile } from "./path-matchers";

export type SlopBand = "clean" | "low" | "elevated" | "high";

export type SlopChangedFile = {
  path: string;
  additions?: number | undefined;
  deletions?: number | undefined;
};

export type SlopAssessmentInput = {
  changedFiles?: SlopChangedFile[] | undefined;
  tests?: string[] | undefined;
  testFiles?: string[] | undefined;
  /** PR/branch description. An empty/whitespace description on a code change is a weak-effort signal. */
  description?: string | null | undefined;
  /** The PR's commit subject line(s). A generic/empty primary subject (wip / fix / update / ".") is a weak-effort signal. */
  commitMessages?: string[] | undefined;
  /** True when this PR sits in a high-risk duplicate cluster (2+ open PRs) — the caller computes it from the
   *  collision report via {@link isPullRequestInDuplicateCluster}. Undefined on surfaces without repo context. */
  inDuplicateCluster?: boolean | undefined;
  /** Whether this PR links at least one issue (caller computes from `linkedIssues.length > 0`). Only an explicit
   *  `false` can trip the no-linked-issue-without-rationale signal; undefined means the surface has no issue data. */
  hasLinkedIssue?: boolean | undefined;
  /** True when the contributor/repo is in the issue-discovery lane, where PRs without a linked issue are expected
   *  and so the no-linked-issue-without-rationale signal does not apply. */
  issueDiscoveryLane?: boolean | undefined;
};

export type SlopAssessment = {
  slopRisk: number;
  band: SlopBand;
  findings: SignalFinding[];
};

// Deterministic, high-precision signals only — this score is the ONLY thing allowed to gate (block), so it
// must be false-positive-averse. Heuristic/AI "this reads low-effort" judgments stay ADVISORY elsewhere and
// never feed this score. The "strong" signals (trivialWhitespaceChurn, nonSubstantivePadding) are weighted 30
// so the `high` band (>=60) is reachable from any two of them. missingTestEvidence is a weak/corroborating 15:
// missing-test alone never blocks, and even paired with one strong-30 signal it only reaches 45 (elevated, not
// blockable at the default block threshold) — it takes two strong signals (or one strong + two weak) to block,
// so "no tests" corroborates a high but is no longer decisive. `clamp(.,0,100)` keeps the stacked score bounded.
export const SLOP_WEIGHTS = {
  trivialWhitespaceChurn: 30,
  missingTestEvidence: 15,
  nonSubstantivePadding: 30,
  emptyDescription: 15,
  lowQualityCommitMessage: 15,
  duplicateClusterMembership: 15,
  noLinkedIssueWithoutRationale: 15,
} as const;

export const SLOP_RUBRIC_MARKDOWN = [
  "# Gittensory slop assessment rubric",
  "",
  "- `clean`: 0",
  "- `low`: 1-30",
  "- `elevated`: 31-59",
  "- `high`: 60-100",
  "",
  "Current deterministic signals:",
  "- trivial / whitespace-only churn",
  "- missing test evidence",
  "- non-substantive padding (generated / vendored / minified output as source)",
  "- empty pull request description on a code change",
  "- generic or empty commit message",
  "- duplicate / overlapping pull request (high-risk collision cluster)",
  "- no linked issue and no rationale (outside the issue-discovery lane)",
].join("\n");

const MIN_CHURN_LINES = 40;
const MAX_SOURCE_LINE_SHARE = 0.15;
// Minimum added lines for a changed test file to count as real test evidence. A genuine test needs at least a
// describe/it/assert; an empty or stub file (0–2 added lines) does not — this stops an empty `*.test.ts` from
// faking coverage to clear the missing-test finding. (#audit-3.1)
const MIN_SUBSTANTIVE_TEST_ADDITIONS = 3;
// A padded diff is one whose churn is dominated by non-substantive output. Set at half the diff so a PR
// with any meaningful share of real, hand-authored files cannot trip it.
const PADDING_DOMINANCE_SHARE = 0.5;

export function buildSlopAssessment(input: SlopAssessmentInput): SlopAssessment {
  const findings: SignalFinding[] = [];
  const trivialChurnFinding = buildTrivialWhitespaceChurnFinding(input);
  const missingTestEvidenceFinding = buildMissingTestEvidenceFinding(input);
  const nonSubstantivePaddingFinding = buildNonSubstantivePaddingFinding(input);
  const emptyDescriptionFinding = buildEmptyDescriptionFinding(input);
  const lowQualityCommitMessageFinding = buildLowQualityCommitMessageFinding(input);
  const duplicateClusterFinding = buildDuplicateClusterFinding(input);
  const noLinkedIssueRationaleFinding = buildNoLinkedIssueRationaleFinding(input);
  if (trivialChurnFinding) findings.push(trivialChurnFinding);
  if (missingTestEvidenceFinding) findings.push(missingTestEvidenceFinding);
  if (nonSubstantivePaddingFinding) findings.push(nonSubstantivePaddingFinding);
  if (emptyDescriptionFinding) findings.push(emptyDescriptionFinding);
  if (lowQualityCommitMessageFinding) findings.push(lowQualityCommitMessageFinding);
  if (duplicateClusterFinding) findings.push(duplicateClusterFinding);
  if (noLinkedIssueRationaleFinding) findings.push(noLinkedIssueRationaleFinding);

  const slopRisk = clamp(
    (trivialChurnFinding ? SLOP_WEIGHTS.trivialWhitespaceChurn : 0) +
      (missingTestEvidenceFinding ? SLOP_WEIGHTS.missingTestEvidence : 0) +
      (nonSubstantivePaddingFinding ? SLOP_WEIGHTS.nonSubstantivePadding : 0) +
      (emptyDescriptionFinding ? SLOP_WEIGHTS.emptyDescription : 0) +
      (lowQualityCommitMessageFinding ? SLOP_WEIGHTS.lowQualityCommitMessage : 0) +
      (duplicateClusterFinding ? SLOP_WEIGHTS.duplicateClusterMembership : 0) +
      (noLinkedIssueRationaleFinding ? SLOP_WEIGHTS.noLinkedIssueWithoutRationale : 0),
    0,
    100,
  );

  return {
    slopRisk,
    band: slopBandFor(slopRisk),
    findings,
  };
}

// Fires when a high-churn diff is dominated by generated/vendored/minified output (files that carry code
// extensions and so slip past the source-share check in `trivialWhitespaceChurn`) while genuine source and
// test effort is negligible — i.e. the diff is padded to look substantive. Lockfiles, dependency manifests,
// and docs are legitimate change categories and never count toward the padding share, so dependency bumps
// and docs PRs cannot trip this.
export function buildNonSubstantivePaddingFinding(input: SlopAssessmentInput): SignalFinding | null {
  const totals = summarizePaddingLines(input.changedFiles ?? []);
  if (totals.changedLineCount < MIN_CHURN_LINES) return null;
  if (totals.paddingLineCount === 0) return null;
  if (totals.paddingLineCount / totals.changedLineCount < PADDING_DOMINANCE_SHARE) return null;
  if (totals.substantiveLineCount / totals.changedLineCount > MAX_SOURCE_LINE_SHARE) return null;
  return buildPaddingFinding(totals.changedLineCount, totals.paddingLineCount);
}

function summarizePaddingLines(changedFiles: SlopChangedFile[]): {
  changedLineCount: number;
  paddingLineCount: number;
  substantiveLineCount: number;
} {
  let changedLineCount = 0;
  let paddingLineCount = 0;
  let substantiveLineCount = 0;
  for (const file of changedFiles) {
    const lines = nonNegative(file.additions) + nonNegative(file.deletions);
    if (lines === 0) continue;
    changedLineCount += lines;
    const category = classifyChangedFile(file.path);
    if (category === "minified" || category === "generated" || category === "vendored") {
      paddingLineCount += lines;
    } else if (category === "source" || category === "test") {
      substantiveLineCount += lines;
    }
  }
  return { changedLineCount, paddingLineCount, substantiveLineCount };
}

function buildPaddingFinding(changedLineCount: number, paddingLineCount: number): SignalFinding {
  // Only integer counts are interpolated, so the text is public-safe by construction.
  const detail = `${paddingLineCount} of ${changedLineCount} changed line(s) are in generated, vendored, or minified files with little substantive source.`;
  return {
    code: "non_substantive_padding",
    title: "Diff is mostly generated, vendored, or minified output",
    severity: "warning",
    detail,
    action: "Exclude generated, vendored, and minified output and keep the diff focused on substantive changes.",
    publicText: detail,
  };
}

// Fires only when a real code change ships with an empty / whitespace-only description — a high-precision
// weak-effort signal. A non-empty description (even a terse one) never trips it, to avoid false positives.
export function buildEmptyDescriptionFinding(input: SlopAssessmentInput): SignalFinding | null {
  // Single pass over changedFiles instead of map().filter(Boolean).filter(isCodeFile) building three
  // intermediate arrays: count changed code-file paths directly.
  let codeFileCount = 0;
  for (const file of input.changedFiles ?? []) {
    if (file.path && isCodeFile(file.path)) codeFileCount += 1;
  }
  if (codeFileCount === 0) return null;
  if ((input.description ?? "").trim().length > 0) return null;

  const detail = ensurePublicSafeText(
    `${codeFileCount} code file(s) changed with an empty pull request description.`,
    "Code changed with an empty pull request description.",
  );
  return {
    code: "empty_pr_description",
    title: "Code change has no description",
    severity: "warning",
    detail,
    action: "Describe what changed and why so reviewers can evaluate it.",
    publicText: detail,
  };
}

// Fires when commit-message data is supplied and the primary subject is empty/whitespace, or is entirely a
// generic low-effort word (wip / fix / update / "." …) per the #549 lint tool's shared GENERIC_COMMIT_PATTERN.
// High-precision: a specific subject — even one that isn't a Conventional Commit — never trips this blocking
// signal; only a bare generic word that IS the whole subject does. Nothing to assess (undefined / no commit
// data) returns null. Static, public-safe detail text — no interpolation, like the issue-side findings.
export function buildLowQualityCommitMessageFinding(input: SlopAssessmentInput): SignalFinding | null {
  if (input.commitMessages === undefined || input.commitMessages.length === 0) return null;
  const messages = input.commitMessages.map((message) => message.trim()).filter((message) => message.length > 0);
  const primary = messages[0];
  if (primary !== undefined && !GENERIC_COMMIT_PATTERN.test(primary)) return null;
  const detail = primary === undefined ? "The commit message is empty." : "The commit message is generic (e.g. wip / fix / update) with no specific detail.";
  return {
    code: "low_quality_commit_message",
    title: "Commit message is generic or empty",
    severity: "warning",
    detail,
    action: "Write a specific commit subject that names what changed and why (a Conventional Commit like 'feat(api): add cursor pagination' works well).",
    publicText: detail,
  };
}

// Fires when the PR sits in a HIGH-risk collision cluster that holds 2+ open pull requests — genuine
// overlapping/duplicate work. The caller determines this via isPullRequestInDuplicateCluster (#563), whose
// 2+-pull-request bar keeps the blocking signal false-positive-averse (a healthy issue↔its-own-PR pair, also
// marked high-risk by buildCollisionReport, is excluded). Static, public-safe text.
export function buildDuplicateClusterFinding(input: SlopAssessmentInput): SignalFinding | null {
  if (input.inDuplicateCluster !== true) return null;
  const detail = "This pull request overlaps a high-risk cluster of other open pull requests doing similar work.";
  return {
    code: "duplicate_cluster_membership",
    title: "Pull request duplicates other open work",
    severity: "warning",
    detail,
    action: "Check for an existing pull request or issue covering this change and coordinate or consolidate before continuing.",
    publicText: detail,
  };
}

// Fires when the caller reports NO linked issue (#562), the PR body carries no clear no-issue rationale, and the
// repo is not in the issue-discovery lane (where unlinked PRs are expected). High-precision: only an explicit
// `hasLinkedIssue: false` trips it — absent data (undefined) is not a signal — and any clear rationale
// (maintenance / docs-only / "no issue: …") clears it. Reuses engine.ts `hasClearNoIssueRationale` so this signal
// and the public PR-panel traceability check agree on what counts as a rationale. Static, public-safe text.
export function buildNoLinkedIssueRationaleFinding(input: SlopAssessmentInput): SignalFinding | null {
  if (input.hasLinkedIssue !== false) return null;
  if (input.issueDiscoveryLane === true) return null;
  if (hasClearNoIssueRationale({ title: "", body: input.description ?? "" })) return null;
  const detail = "This pull request links no issue and gives no rationale for working without one.";
  return {
    code: "no_linked_issue_without_rationale",
    title: "No linked issue and no rationale",
    severity: "warning",
    detail,
    action: "Link the issue this addresses, or explain in the description why no issue applies (e.g. a typo, docs-only, or maintenance change).",
    publicText: detail,
  };
}

export function buildMissingTestEvidenceFinding(input: SlopAssessmentInput): SignalFinding | null {
  const changedFiles = input.changedFiles ?? [];
  const changedPaths = changedFiles.map((file) => file.path).filter(Boolean);
  const codePaths = changedPaths.filter(isCodeFile);
  if (codePaths.length === 0) return null;

  // A changed test FILE only counts as real test evidence when it carries substantive content. An empty or
  // no-op test (e.g. a committed `tests/noop.test.ts`) would otherwise clear this finding by path alone. When
  // per-file line counts are unavailable we trust the path (can't prove emptiness); when known, require a few
  // added lines so a stub can't fake coverage. (#audit-3.1)
  const hasSubstantiveTestFile = changedFiles.some((file) => {
    if (!(isTestFile(file.path) || isTestPath(file.path))) return false;
    return file.additions === undefined || nonNegative(file.additions) >= MIN_SUBSTANTIVE_TEST_ADDITIONS;
  });
  const hasChangedTestPaths = hasSubstantiveTestFile || hasLocalTestEvidence({ tests: input.tests, testFiles: input.testFiles });
  if (hasChangedTestPaths) return null;

  const detail = ensurePublicSafeText(
    `Changed paths include ${codePaths.length} code file(s) without accompanying test evidence.`,
    "Code changes were detected without accompanying test evidence.",
  );
  const action = ensurePublicSafeText(
    "Add focused regression tests or explain why existing coverage is sufficient.",
    "Add focused tests or explain why existing coverage is sufficient.",
  );

  return {
    code: "missing_test_evidence",
    title: "Code changes lack test evidence",
    severity: "warning",
    detail,
    action,
    publicText: detail,
  };
}

export function buildTrivialWhitespaceChurnFinding(input: SlopAssessmentInput): SignalFinding | null {
  const changedFiles = input.changedFiles ?? [];
  const lineTotals = summarizeChangedLines(changedFiles);
  if (lineTotals.changedLineCount < MIN_CHURN_LINES) return null;
  const substantiveLineCount = lineTotals.sourceLineCount + lineTotals.testLineCount;
  if (substantiveLineCount === 0) {
    return buildTrivialChurnFinding(lineTotals.changedLineCount, lineTotals.nonCodeLineCount);
  }
  const substantiveShare = substantiveLineCount / lineTotals.changedLineCount;
  if (substantiveShare > MAX_SOURCE_LINE_SHARE) return null;
  return buildTrivialChurnFinding(lineTotals.changedLineCount, lineTotals.nonCodeLineCount);
}

function summarizeChangedLines(changedFiles: SlopChangedFile[]): {
  changedLineCount: number;
  sourceLineCount: number;
  testLineCount: number;
  nonCodeLineCount: number;
} {
  const changedLineCount = changedFiles.reduce(
    (sum, file) => sum + nonNegative(file.additions) + nonNegative(file.deletions),
    0,
  );
  const sourceLineCount = changedFiles
    .filter((file) => isCodeFile(file.path))
    .reduce((sum, file) => sum + nonNegative(file.additions) + nonNegative(file.deletions), 0);
  const testLineCount = changedFiles
    .filter((file) => isTestFile(file.path))
    .reduce((sum, file) => sum + nonNegative(file.additions) + nonNegative(file.deletions), 0);
  const nonCodeLineCount = Math.max(0, changedLineCount - sourceLineCount - testLineCount);
  return { changedLineCount, sourceLineCount, testLineCount, nonCodeLineCount };
}

function buildTrivialChurnFinding(changedLineCount: number, nonCodeLineCount: number): SignalFinding {
  const detail = ensurePublicSafeText(
    `The diff churns ${changedLineCount} line(s) with only ${Math.max(0, changedLineCount - nonCodeLineCount)} substantive source line(s) touched.`,
    "The diff shows high churn with minimal substantive source changes.",
  );
  const action = ensurePublicSafeText(
    "Reduce whitespace-only or formatting-only churn and keep the diff focused on substantive changes.",
    "Reduce formatting-only churn and keep the diff focused on substantive changes.",
  );

  return {
    code: "trivial_whitespace_churn",
    title: "Diff looks like trivial or whitespace-only churn",
    severity: "warning",
    detail,
    action,
    publicText: detail,
  };
}

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
  "# Gittensory issue slop triage rubric",
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

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.trunc(value as number) : 0;
}

function ensurePublicSafeText(text: string, fallback: string): string {
  return isFocusManifestPublicSafe(text) ? text : fallback;
}

// Documented thresholds (#565, recalibrated by #3939): the deterministic slopRisk (0-100) maps to fixed
// bands — clean = 0, low = 1-30, elevated = 31-59, high = 60-100. Strong signals (trivial churn,
// non-substantive padding) weigh 30 (any two reach `high`); weak/corroborating/traceability signals —
// including missing-test-evidence — weigh 15, so a single strong or a pair of weak signals alone now lands
// in `low`, not `elevated` — `elevated` needs genuine multi-signal evidence (strong+weak ≥ 45, or 3×weak =
// 45). Identical metadata always yields an identical band (see golden fixtures).
function slopBandFor(slopRisk: number): SlopBand {
  if (slopRisk <= 0) return "clean";
  if (slopRisk < 31) return "low";
  if (slopRisk < 60) return "elevated";
  return "high";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
