import { describe, expect, it } from "vitest";
import { refreshGeneratedDoc } from "../../src/review/generated-doc-refresh";
import { REPO_DOC_MARKERS, renderRepoDocContent } from "../../src/review/repo-doc-render";
import { REPO_PROFILE_SCHEMA_VERSION } from "../../src/review/repo-profile";
import type { RepoProfile } from "../../src/review/repo-profile";

const MARKERS = { start: "<!-- start -->", end: "<!-- end -->" };
const SECTION = `${MARKERS.start}\ngenerated body v1\n${MARKERS.end}\n`;
const SECTION_V2 = `${MARKERS.start}\ngenerated body v2\n${MARKERS.end}\n`;

function fixtureProfile(): RepoProfile {
  return {
    version: REPO_PROFILE_SCHEMA_VERSION,
    present: true,
    repoFullName: "owner/widgets",
    generatedAt: "2026-07-04T00:00:00.000Z",
    architecture: { indexedFileCount: 3, topLevelDirectories: [{ path: "src", fileCount: 3 }] },
    conventions: { fileNamingStyle: "kebab-case", testFileConvention: "dot-test-suffix" },
    commands: { packageManager: "npm", buildCommands: ["build"], testCommands: ["test"], lintCommands: [] },
    contributionWorkflow: { gatePublishesCheck: true, linkedIssuePolicy: "preferred", requireLinkedIssue: false, ciWorkflowFiles: [] },
  };
}

describe("refreshGeneratedDoc (#3004)", () => {
  it("generates fresh content when there is no current file at all", () => {
    expect(refreshGeneratedDoc(null, SECTION, MARKERS)).toEqual({ action: "generate", content: SECTION });
  });

  it("reports no-change when the current marker block already matches the freshly rendered section exactly", () => {
    const current = `# Preamble\n\n${SECTION}Appendix.\n`;
    expect(refreshGeneratedDoc(current, SECTION, MARKERS)).toEqual({ action: "no-change" });
  });

  it("replaces only the marked span, preserving manual content before and after it byte-for-byte", () => {
    const current = `# Preamble\n\n${SECTION}Appendix.\n`;
    const result = refreshGeneratedDoc(current, SECTION_V2, MARKERS);
    expect(result).toEqual({ action: "replace", content: `# Preamble\n\n${SECTION_V2}Appendix.\n` });
  });

  it("replaces with no leftover appendix when the marked block (plus its trailing newline) spans the entire file", () => {
    const result = refreshGeneratedDoc(SECTION, SECTION_V2, MARKERS);
    expect(result).toEqual({ action: "replace", content: SECTION_V2 });
  });

  it("replaces generated frontmatter together with a later marker block", () => {
    const withFrontmatter = `---\nname: widgets\n---\n\n${SECTION}`;
    const withUpdatedFrontmatter = `---\nname: updated-widgets\n---\n\n${SECTION_V2}`;
    expect(refreshGeneratedDoc(withFrontmatter, withFrontmatter, MARKERS)).toEqual({ action: "no-change" });
    expect(refreshGeneratedDoc(withFrontmatter, withUpdatedFrontmatter, MARKERS)).toEqual({ action: "replace", content: withUpdatedFrontmatter });
  });

  it("fails closed when the generated section is missing its start marker", () => {
    const current = `# Preamble\n\n${SECTION}Appendix.\n`;
    const result = refreshGeneratedDoc(current, `generated body v2\n${MARKERS.end}\n`, MARKERS);
    expect(result).toEqual({ action: "manual-review-required", reason: "generated section is missing the start marker" });
  });

  it("fails closed with a reason when the current file has no marker block at all", () => {
    const current = "# Hand-written CLAUDE.md\n\nNo markers here.\n";
    const result = refreshGeneratedDoc(current, SECTION, MARKERS);
    expect(result).toEqual({ action: "manual-review-required", reason: "no generated-content marker block found" });
  });

  it("fails closed when only the start marker is present", () => {
    const current = `# Doc\n\n${MARKERS.start}\norphaned start\n`;
    const result = refreshGeneratedDoc(current, SECTION, MARKERS);
    expect(result).toEqual({ action: "manual-review-required", reason: "expected exactly one end marker, found 0" });
  });

  it("fails closed when only the end marker is present", () => {
    const current = `# Doc\n\norphaned end\n${MARKERS.end}\n`;
    const result = refreshGeneratedDoc(current, SECTION, MARKERS);
    expect(result).toEqual({ action: "manual-review-required", reason: "expected exactly one start marker, found 0" });
  });

  it("fails closed when the start marker appears twice", () => {
    const current = `${MARKERS.start}\n${MARKERS.start}\nbody\n${MARKERS.end}\n`;
    const result = refreshGeneratedDoc(current, SECTION, MARKERS);
    expect(result).toEqual({ action: "manual-review-required", reason: "expected exactly one start marker, found 2" });
  });

  it("fails closed when the end marker appears twice", () => {
    const current = `${MARKERS.start}\nbody\n${MARKERS.end}\n${MARKERS.end}\n`;
    const result = refreshGeneratedDoc(current, SECTION, MARKERS);
    expect(result).toEqual({ action: "manual-review-required", reason: "expected exactly one end marker, found 2" });
  });

  it("fails closed when the end marker appears before the start marker", () => {
    const current = `${MARKERS.end}\nbody\n${MARKERS.start}\n`;
    const result = refreshGeneratedDoc(current, SECTION, MARKERS);
    expect(result).toEqual({ action: "manual-review-required", reason: "end marker appears before (or immediately at) the start marker" });
  });

  it("treats adjacent markers with an empty body between them as a valid (if degenerate) block, not an error", () => {
    const current = `${MARKERS.start}${MARKERS.end}`;
    const result = refreshGeneratedDoc(current, SECTION, MARKERS);
    expect(result).toEqual({ action: "replace", content: SECTION });
  });

  it("REGRESSION: a real renderRepoDocContent() output round-trips as no-change against itself, with or without surrounding manual content", () => {
    const rendered = renderRepoDocContent(fixtureProfile())!;
    expect(refreshGeneratedDoc(rendered, rendered, REPO_DOC_MARKERS)).toEqual({ action: "no-change" });

    const withManualContent = `<!-- Keep this intro. -->\n\n${rendered}\n<!-- Keep this appendix too. -->\n`;
    expect(refreshGeneratedDoc(withManualContent, rendered, REPO_DOC_MARKERS)).toEqual({ action: "no-change" });
  });
});
