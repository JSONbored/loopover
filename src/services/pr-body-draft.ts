import { sanitizePublicComment } from "../github/commands";
import type { LocalDiffPreflightResult } from "../signals/engine";
import type { LocalBranchAnalysis } from "../signals/local-branch";

/**
 * Drafts a public-safe, copy/paste PR body from local branch metadata.
 *
 * The draft is built ONLY from already-public-safe slices of {@link LocalBranchAnalysis}
 * (the prepared packet, base freshness, linked-issue and overlap metadata). Private
 * scoreability, reward/risk, raw trust, and reviewability context are excluded by
 * construction — their field names are listed in {@link EXCLUDED_PRIVATE_PR_BODY_FIELDS}
 * — and every emitted line additionally passes through {@link sanitizePublicComment} and a
 * forbidden-language filter, so no private/financial language reaches GitHub.
 *
 * Input is metadata only; source contents are never read or uploaded.
 */
export type PrBodyDraftSection = {
  heading: string;
  lines: string[];
};

export type PublicPrBodyDraft = {
  repoFullName: string;
  title: string;
  sections: PrBodyDraftSection[];
  markdown: string;
  caveats: string[];
  excludedPrivateFields: string[];
  sourceUploadDisabled: true;
};

/** Structural subset of {@link LocalBranchAnalysis} the drafter consumes (all public-safe). */
export type PrBodyDraftSource = Pick<LocalBranchAnalysis, "repoFullName" | "prPacket" | "baseFreshness" | "manifestGuidance"> & {
  preflight: Pick<LocalDiffPreflightResult, "linkedIssues" | "collisions" | "reviewBurden">;
};

/**
 * Categories of private analysis context that must never appear in a public PR body draft.
 * Phrased as public-safe labels (no private/financial terms) so the list itself stays
 * safe to surface; it documents that private scoreability/risk context is excluded.
 */
export const EXCLUDED_PRIVATE_PR_BODY_FIELDS = [
  "private score preview",
  "private scenario projections",
  "private risk signals",
  "private score-gate blockers",
  "branch eligibility gate",
  "private ranked next actions",
] as const;

// Residual private/financial terms that sanitizePublicComment does not rewrite on its own
// (e.g. a bare "reward"/"score"/"ranking"); scrubbed to a neutral phrase as defense-in-depth.
const RESIDUAL_PRIVATE_TERMS = /\b(reward\w*|score\w*|farming|payout|ranking|raw[-_\s]?trust|trust[-_\s]?score|private[-_\s]?reviewability|reviewability|wallet|hotkey|coldkey|mnemonic)\b/gi;
const LOCAL_PATH_SOURCE = String.raw`(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"';)]+|\\\\[^\s"';\\]+\\[^\s"';]+|(?<![:/\\A-Za-z0-9._-])/[A-Za-z0-9._-]+(?:/[^\s"';)]+)*)`;
const LOCAL_PATH_PATTERN = new RegExp(LOCAL_PATH_SOURCE, "g");
// Final guard used to drop anything that still looks unsafe after scrubbing.
const FORBIDDEN_PR_BODY_LANGUAGE = new RegExp(
  String.raw`\b(reward\w*|score\w*|wallet|hotkey|coldkey|mnemonic|farming|payout|ranking|raw[-_\s]?trust|trust[-_\s]?score|private[-_\s]?reviewability|reviewability)\b|${LOCAL_PATH_SOURCE}`,
  "i",
);

function sanitizeLine(line: string): string {
  return sanitizePublicComment(line)
    .replace(RESIDUAL_PRIVATE_TERMS, "private context")
    .replace(LOCAL_PATH_PATTERN, "[local path]")
    .replace(/\s+/g, " ")
    .trim();
}

/** Scrub, trim, drop empties, and drop any residual unsafe line. */
function safeLines(lines: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    if (!raw) continue;
    const clean = sanitizeLine(raw);
    if (clean.length > 0 && !FORBIDDEN_PR_BODY_LANGUAGE.test(clean)) out.push(clean);
  }
  return out;
}

function changedFilesSection(source: PrBodyDraftSource): PrBodyDraftSection {
  const { changedFileCount, testFileCount } = source.baseFreshness;
  const countLine = `${changedFileCount} file(s) changed${testFileCount > 0 ? `, including ${testFileCount} test file(s)` : ""}.`;
  const pathLines = sectionLines(source.prPacket.bodySections, "Changed Paths").filter((line) => !/no changed paths/i.test(line));
  return { heading: "Changed files", lines: safeLines([countLine, ...pathLines]) };
}

function validationSection(source: PrBodyDraftSource): { section: PrBodyDraftSection; missingTests: boolean } {
  const { passed, failed, notRun, commands } = source.prPacket.validationSummary;
  const ran = commands.filter((entry) => entry.status === "passed" || entry.status === "focused" || entry.status === "failed");
  const missingTests = ran.length === 0;
  const lines = missingTests
    ? ["No automated tests were recorded for this branch. Add validation evidence (commands + results) before requesting review."]
    : [
        `Validation summary: ${passed} passed, ${failed} failed, ${notRun} not run.`,
        ...commands.map((entry) => `- ${entry.status}: ${entry.command}${entry.summary ? ` (${entry.summary})` : ""}`),
      ];
  return { section: { heading: "Tests run", lines: safeLines(lines) }, missingTests };
}

function linkedIssueSection(source: PrBodyDraftSource): PrBodyDraftSection {
  const issues = source.preflight.linkedIssues;
  const lines = issues.length > 0 ? issues.map((issue) => `Closes #${issue}`) : ["No linked issue detected. If this is intentional, explain why a tracked issue is not needed."];
  return { heading: "Linked issue", lines: safeLines(lines) };
}

function duplicateSection(source: PrBodyDraftSource): { section: PrBodyDraftSection; hasOverlap: boolean } {
  const collisions = source.preflight.collisions;
  if (collisions.length === 0) {
    return { section: { heading: "Duplicate / WIP check", lines: safeLines(["No overlapping open work was detected from cached issue/PR metadata."]) }, hasOverlap: false };
  }
  // Phrased as hygiene, never as an accusation.
  const lines = collisions.slice(0, 3).map((cluster) => {
    const refs = cluster.items
      .slice(0, 3)
      .map((item) => `${item.type === "pull_request" ? "PR" : item.type === "issue" ? "issue" : "recent merge"} #${item.number}`)
      .join(", ");
    return `Possible overlap with existing work: double-check ${refs} before review to avoid duplicate effort.`;
  });
  return { section: { heading: "Duplicate / WIP check", lines: safeLines(lines) }, hasOverlap: true };
}

function branchFreshnessSection(source: PrBodyDraftSource): { section: PrBodyDraftSection; stale: boolean } {
  const freshness = source.baseFreshness;
  const stale = freshness.status === "stale" || freshness.status === "possibly_stale";
  const lines = [
    `Base freshness: ${freshness.status.replace(/_/g, " ")}.`,
    ...freshness.warnings,
    ...(freshness.recommendation ? [freshness.recommendation] : []),
  ];
  return { section: { heading: "Branch freshness", lines: safeLines(lines) }, stale };
}

function nextStepsSection(source: PrBodyDraftSource, caveats: string[]): PrBodyDraftSection {
  const manifestSteps = source.manifestGuidance.present ? source.manifestGuidance.publicNextSteps : [];
  const lines = [
    ...source.prPacket.publicSafeWarnings,
    ...manifestSteps,
    ...caveats,
    "Keep source upload disabled; this draft is built from local git metadata only.",
  ];
  return { heading: "Next steps", lines: dedupe(safeLines(lines)).slice(0, 8) };
}

/** Build a public-safe PR body draft from the public-safe slices of a local branch analysis. */
export function buildPublicPrBodyDraft(source: PrBodyDraftSource): PublicPrBodyDraft {
  const title = sanitizeLine(source.prPacket.titleSuggestion) || "Describe this change";

  const summary: PrBodyDraftSection = {
    heading: "Summary",
    lines: safeLines(["Briefly describe the user-visible change or maintainer-facing improvement in this PR."]),
  };
  const changedFiles = changedFilesSection(source);
  const { section: tests, missingTests } = validationSection(source);
  const linkedIssue = linkedIssueSection(source);
  const { section: duplicate, hasOverlap } = duplicateSection(source);
  const { section: freshness, stale } = branchFreshnessSection(source);

  const caveats = safeLines([
    missingTests ? "No test evidence was supplied; reviewers may ask for validation before merge." : undefined,
    stale ? "Base branch may be stale; rebase or refresh before requesting review." : undefined,
    hasOverlap ? "Possible overlap with existing work; confirm this is not a duplicate before review." : undefined,
  ]);

  const nextSteps = nextStepsSection(source, caveats);

  const sections = [summary, changedFiles, tests, linkedIssue, duplicate, freshness, nextSteps].filter((section) => section.lines.length > 0);

  return {
    repoFullName: source.repoFullName,
    title,
    sections,
    markdown: renderMarkdown(title, sections),
    caveats,
    excludedPrivateFields: [...EXCLUDED_PRIVATE_PR_BODY_FIELDS],
    sourceUploadDisabled: true,
  };
}

function sectionLines(bodySections: PrBodyDraftSource["prPacket"]["bodySections"], heading: string): string[] {
  const match = bodySections.find((section) => section.heading === heading);
  return match ? match.lines.map((line) => line.replace(/^-\s*/, "")) : [];
}

function dedupe(lines: string[]): string[] {
  return [...new Set(lines)];
}

function renderMarkdown(title: string, sections: PrBodyDraftSection[]): string {
  const blocks = [`# ${title}`];
  for (const section of sections) {
    blocks.push("", `## ${section.heading}`, ...section.lines.map((line) => (section.heading === "Summary" ? line : `- ${line}`)));
  }
  return `${blocks.join("\n").trim()}\n`;
}
