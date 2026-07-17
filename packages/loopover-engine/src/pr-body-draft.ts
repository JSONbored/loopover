import { sanitizePublicComment } from "./github/sanitize-public-comment.js";

/**
 * Drafts a public-safe, copy/paste PR body from local branch metadata (#6741).
 *
 * Moved into `@loopover/engine` so the CLI stdio mirror can compute the draft locally from the same
 * analysis `loopover_prepare_pr_packet` already fetches — matching the local-write-tools re-export pattern.
 *
 * The draft is built ONLY from already-public-safe slices of a local branch analysis (the prepared packet,
 * base freshness, linked-issue and overlap metadata). Internal analysis context is excluded by construction
 * — those categories are listed in {@link EXCLUDED_PRIVATE_PR_BODY_FIELDS} — and every emitted line passes
 * through {@link sanitizePublicComment} and a forbidden-language filter.
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

/** Structural subset of a local-branch analysis the drafter consumes (all public-safe).
 *  Extra fields from the full LocalBranchAnalysis are allowed so callers can pass the analysis
 *  object through without stripping (and so existing unit fixtures keep typechecking). */
export type PrBodyDraftSource = {
  repoFullName: string;
  prPacket: {
    titleSuggestion: string;
    markdown?: string;
    bodySections: Array<{ heading: string; lines: string[] }>;
    validationSummary: {
      passed: number;
      failed: number;
      notRun: number;
      commands: Array<{
        command: string;
        status: string;
        summary?: string | undefined;
      }>;
    };
    publicSafeWarnings: string[];
    reviewerNotes?: string[];
  };
  baseFreshness: {
    status: string;
    changedFileCount: number;
    testFileCount: number;
    passedValidationCount?: number;
    warnings: string[];
    recommendation?: string | undefined;
  };
  manifestGuidance: {
    present: boolean;
    publicNextSteps: string[];
    source?: string;
    linkedIssuePolicy?: string;
    issueDiscoveryPolicy?: string;
    matchedWantedPaths?: string[];
    preferredLabelHits?: string[];
    findings?: unknown[];
    warnings?: string[];
    summary?: string;
  };
  preflight: {
    linkedIssues: number[];
    collisions: Array<{
      id?: string;
      risk?: string;
      reason?: string;
      items: Array<{ type: string; number: number; title?: string }>;
    }>;
    reviewBurden?: string | undefined;
  };
};

/**
 * Categories of internal analysis context that must never appear in a public PR body draft.
 * Labels intentionally avoid private/financial taxonomy because MCP clients may display
 * the structured draft alongside the markdown.
 */
export const EXCLUDED_PRIVATE_PR_BODY_FIELDS = [
  "omitted analysis details",
  "omitted forecast details",
  "omitted signal details",
  "omitted blocker details",
  "omitted readiness details",
  "omitted follow-up details",
] as const;

// Mirrors src/signals/redaction.ts PUBLIC_UNSAFE_TERMS (duplicated so loopover-engine stays standalone).
const PUBLIC_UNSAFE_TERMS = String.raw`(?:reward|score|wallet|hotkey|coldkey|mnemonic|payout|ranking|cohort)\w*|miner[-_\s]?originated|human[-_\s]?originated|farming|raw[-_\s]?trust|trust[-_\s]?score|private[-_\s]?reviewability|reviewability`;
const RESIDUAL_PRIVATE_TERMS = new RegExp(
  String.raw`\b(${PUBLIC_UNSAFE_TERMS})\b`,
  "gi",
);
const LOCAL_PATH_SOURCE = String.raw`(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"';)]+|\\\\[^\s"';\\]+\\[^\s"';]+|(?<![/\\A-Za-z0-9._-])/[A-Za-z0-9._-]+(?:/[^\s"';)]+)*)`;
const LOCAL_PATH_PATTERN = new RegExp(LOCAL_PATH_SOURCE, "g");
const FORBIDDEN_PR_BODY_LANGUAGE = new RegExp(
  String.raw`\b(${PUBLIC_UNSAFE_TERMS})\b|${LOCAL_PATH_SOURCE}`,
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
    if (clean.length > 0 && !FORBIDDEN_PR_BODY_LANGUAGE.test(clean))
      out.push(clean);
  }
  return out;
}

function changedFilesSection(source: PrBodyDraftSource): PrBodyDraftSection {
  const { changedFileCount, testFileCount } = source.baseFreshness;
  const countLine = `${changedFileCount} file(s) changed${testFileCount > 0 ? `, including ${testFileCount} test file(s)` : ""}.`;
  const pathLines = sectionLines(
    source.prPacket.bodySections,
    "Changed Paths",
  ).filter((line) => !/no changed paths/i.test(line));
  return {
    heading: "Changed files",
    lines: safeLines([countLine, ...pathLines]),
  };
}

function validationSection(source: PrBodyDraftSource): {
  section: PrBodyDraftSection;
  missingTests: boolean;
} {
  const { passed, failed, notRun, commands } =
    source.prPacket.validationSummary;
  const ran = commands.filter(
    (entry) =>
      entry.status === "passed" ||
      entry.status === "focused" ||
      entry.status === "failed",
  );
  const missingTests = ran.length === 0;
  const lines = missingTests
    ? [
        "No automated tests were recorded for this branch. Add validation evidence (commands + results) before requesting review.",
      ]
    : [
        `Validation summary: ${passed} passed, ${failed} failed, ${notRun} not run.`,
        ...commands.map(
          (entry) =>
            `- ${entry.status}: ${entry.command}${entry.summary ? ` (${entry.summary})` : ""}`,
        ),
      ];
  return {
    section: { heading: "Tests run", lines: safeLines(lines) },
    missingTests,
  };
}

function linkedIssueSection(source: PrBodyDraftSource): PrBodyDraftSection {
  const issues = source.preflight.linkedIssues;
  const lines =
    issues.length > 0
      ? issues.map((issue) => `Closes #${issue}`)
      : [
          "No linked issue detected. If this is intentional, explain why a tracked issue is not needed.",
        ];
  return { heading: "Linked issue", lines: safeLines(lines) };
}

function duplicateSection(source: PrBodyDraftSource): {
  section: PrBodyDraftSection;
  hasOverlap: boolean;
} {
  const collisions = source.preflight.collisions;
  if (collisions.length === 0) {
    return {
      section: {
        heading: "Duplicate / WIP check",
        lines: safeLines([
          "No overlapping open work was detected from cached issue/PR metadata.",
        ]),
      },
      hasOverlap: false,
    };
  }
  const lines = collisions.slice(0, 3).map((cluster) => {
    const refs = cluster.items
      .slice(0, 3)
      .map(
        (item) =>
          `${item.type === "pull_request" ? "PR" : item.type === "issue" ? "issue" : "recent merge"} #${item.number}`,
      )
      .join(", ");
    return `Possible overlap with existing work: double-check ${refs} before review to avoid duplicate effort.`;
  });
  return {
    section: { heading: "Duplicate / WIP check", lines: safeLines(lines) },
    hasOverlap: true,
  };
}

function branchFreshnessSection(source: PrBodyDraftSource): {
  section: PrBodyDraftSection;
  stale: boolean;
} {
  const freshness = source.baseFreshness;
  const stale =
    freshness.status === "stale" || freshness.status === "possibly_stale";
  const lines = [
    `Base freshness: ${freshness.status.replace(/_/g, " ")}.`,
    ...freshness.warnings,
    ...(freshness.recommendation ? [freshness.recommendation] : []),
  ];
  return {
    section: { heading: "Branch freshness", lines: safeLines(lines) },
    stale,
  };
}

function nextStepsSection(
  source: PrBodyDraftSource,
  caveats: string[],
): PrBodyDraftSection {
  const manifestSteps = source.manifestGuidance.present
    ? source.manifestGuidance.publicNextSteps
    : [];
  const lines = [
    ...source.prPacket.publicSafeWarnings,
    ...manifestSteps,
    ...caveats,
    "Keep source upload disabled; this draft is built from local git metadata only.",
  ];
  return { heading: "Next steps", lines: dedupe(safeLines(lines)).slice(0, 8) };
}

/** Build a public-safe PR body draft from the public-safe slices of a local branch analysis. */
export function buildPublicPrBodyDraft(
  source: PrBodyDraftSource,
): PublicPrBodyDraft {
  const title =
    sanitizeLine(source.prPacket.titleSuggestion) || "Describe this change";

  const summary: PrBodyDraftSection = {
    heading: "Summary",
    lines: safeLines([
      "Briefly describe the user-visible change or maintainer-facing improvement in this PR.",
    ]),
  };
  const changedFiles = changedFilesSection(source);
  const { section: tests, missingTests } = validationSection(source);
  const linkedIssue = linkedIssueSection(source);
  const { section: duplicate, hasOverlap } = duplicateSection(source);
  const { section: freshness, stale } = branchFreshnessSection(source);

  const caveats = safeLines([
    missingTests
      ? "No test evidence was supplied; reviewers may ask for validation before merge."
      : undefined,
    stale
      ? "Base branch may be stale; rebase or refresh before requesting review."
      : undefined,
    hasOverlap
      ? "Possible overlap with existing work; confirm this is not a duplicate before review."
      : undefined,
  ]);

  const nextSteps = nextStepsSection(source, caveats);

  const sections = [
    summary,
    changedFiles,
    tests,
    linkedIssue,
    duplicate,
    freshness,
    nextSteps,
  ].filter((section) => section.lines.length > 0);

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

function sectionLines(
  bodySections: PrBodyDraftSource["prPacket"]["bodySections"],
  heading: string,
): string[] {
  const match = bodySections.find((section) => section.heading === heading);
  return match ? match.lines.map((line) => line.replace(/^-\s*/, "")) : [];
}

function dedupe(lines: string[]): string[] {
  return [...new Set(lines)];
}

function renderMarkdown(title: string, sections: PrBodyDraftSection[]): string {
  const blocks = [`# ${title}`];
  for (const section of sections) {
    blocks.push(
      "",
      `## ${section.heading}`,
      ...section.lines.map((line) =>
        section.heading === "Summary" ? line : `- ${line}`,
      ),
    );
  }
  return `${blocks.join("\n").trim()}\n`;
}
