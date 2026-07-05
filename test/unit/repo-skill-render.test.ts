import { describe, expect, it } from "vitest";
import { REPO_SKILL_MARKER_END, REPO_SKILL_MARKER_START, renderRepoSkillContent, repoSkillFilePath, repoSkillName, shouldGenerateRepoSkill } from "../../src/review/repo-skill-render";
import type { RepoProfile, RepoProfileContributionWorkflow } from "../../src/review/repo-profile";
import { REPO_PROFILE_SCHEMA_VERSION } from "../../src/review/repo-profile";

function contributionWorkflow(overrides: Partial<RepoProfileContributionWorkflow> = {}): RepoProfileContributionWorkflow {
  return { gatePublishesCheck: false, linkedIssuePolicy: "optional", requireLinkedIssue: false, ciWorkflowFiles: [], ...overrides };
}

function presentProfile(overrides: Partial<Extract<RepoProfile, { present: true }>> = {}): RepoProfile {
  return {
    version: REPO_PROFILE_SCHEMA_VERSION,
    present: true,
    repoFullName: "owner/widgets",
    generatedAt: "2026-07-04T00:00:00.000Z",
    architecture: { indexedFileCount: 10, topLevelDirectories: [{ path: "src", fileCount: 10 }] },
    conventions: { fileNamingStyle: "kebab-case", testFileConvention: "dot-test-suffix" },
    commands: { packageManager: "npm", buildCommands: ["build"], testCommands: ["test"], lintCommands: ["lint"] },
    contributionWorkflow: contributionWorkflow(),
    ...overrides,
  };
}

describe("shouldGenerateRepoSkill (#3001)", () => {
  it.each([
    ["no signals", contributionWorkflow(), false],
    ["gate only", contributionWorkflow({ gatePublishesCheck: true }), false],
    ["strict linked issue only", contributionWorkflow({ requireLinkedIssue: true, linkedIssuePolicy: "required" }), false],
    ["multi-stage CI only", contributionWorkflow({ ciWorkflowFiles: [".github/workflows/a.yml", ".github/workflows/b.yml"] }), false],
    ["gate + strict linked issue (2 of 3)", contributionWorkflow({ gatePublishesCheck: true, requireLinkedIssue: true, linkedIssuePolicy: "required" }), true],
    ["gate + multi-stage CI (2 of 3)", contributionWorkflow({ gatePublishesCheck: true, ciWorkflowFiles: [".github/workflows/a.yml", ".github/workflows/b.yml"] }), true],
    ["strict linked issue + multi-stage CI (2 of 3)", contributionWorkflow({ requireLinkedIssue: true, linkedIssuePolicy: "preferred", ciWorkflowFiles: [".github/workflows/a.yml", ".github/workflows/b.yml"] }), true],
    ["all three signals (3 of 3)", contributionWorkflow({ gatePublishesCheck: true, requireLinkedIssue: true, linkedIssuePolicy: "required", ciWorkflowFiles: [".github/workflows/a.yml", ".github/workflows/b.yml"] }), true],
  ])("%s -> %s", (_label, workflow, expected) => {
    expect(shouldGenerateRepoSkill(presentProfile({ contributionWorkflow: workflow }) as Extract<RepoProfile, { present: true }>)).toBe(expected);
  });

  it("requireLinkedIssue alone with an \"optional\" policy does not count as a strict linked-issue rule", () => {
    const workflow = contributionWorkflow({ requireLinkedIssue: true, linkedIssuePolicy: "optional", ciWorkflowFiles: [".github/workflows/a.yml", ".github/workflows/b.yml"] });
    // requireLinkedIssue+optional is a settings/policy mismatch, not a "strict rule" -- only 1 real signal
    // (multi-stage CI) fires, below the 2-of-3 threshold.
    expect(shouldGenerateRepoSkill(presentProfile({ contributionWorkflow: workflow }) as Extract<RepoProfile, { present: true }>)).toBe(false);
  });

  it("exactly one CI workflow file does not count as multi-stage", () => {
    const workflow = contributionWorkflow({ gatePublishesCheck: true, ciWorkflowFiles: [".github/workflows/ci.yml"] });
    expect(shouldGenerateRepoSkill(presentProfile({ contributionWorkflow: workflow }) as Extract<RepoProfile, { present: true }>)).toBe(false);
  });
});

describe("repoSkillName / repoSkillFilePath (#3001)", () => {
  it("derives a lowercase, dash-joined name from the repo segment", () => {
    expect(repoSkillName("owner/widgets")).toBe("contributing-to-widgets");
  });

  it("sanitizes dots, underscores, and mixed case into dashes", () => {
    expect(repoSkillName("owner/My_Cool.Repo")).toBe("contributing-to-my-cool-repo");
  });

  it("falls back to a bare 'repo' segment name when sanitization removes everything", () => {
    expect(repoSkillName("owner/___")).toBe("contributing-to-repo");
  });

  it("handles a repo full name with no slash", () => {
    expect(repoSkillName("widgets")).toBe("contributing-to-widgets");
  });

  it("builds the fixed .claude/skills/<name>/SKILL.md path", () => {
    expect(repoSkillFilePath("owner/widgets")).toBe(".claude/skills/contributing-to-widgets/SKILL.md");
  });
});

describe("renderRepoSkillContent (#3001)", () => {
  it("renders null for an absent profile", () => {
    const profile: RepoProfile = { version: REPO_PROFILE_SCHEMA_VERSION, present: false, repoFullName: "owner/widgets", generatedAt: "now", reason: "no RAG index configured or populated for this repo yet" };
    expect(renderRepoSkillContent(profile)).toBeNull();
  });

  it("renders null when the trigger condition is not met", () => {
    expect(renderRepoSkillContent(presentProfile())).toBeNull();
  });

  it("renders the marker, frontmatter, trigger reasons, and command/linked-issue sections when the trigger fires", () => {
    const profile = presentProfile({
      repoFullName: "owner/widgets",
      contributionWorkflow: contributionWorkflow({ gatePublishesCheck: true, requireLinkedIssue: true, linkedIssuePolicy: "required", ciWorkflowFiles: [".github/workflows/a.yml", ".github/workflows/b.yml"] }),
    });
    const content = renderRepoSkillContent(profile);
    expect(content).not.toBeNull();
    expect(content!.startsWith("---\nname: contributing-to-widgets")).toBe(true);
    expect(content!.indexOf(REPO_SKILL_MARKER_START)).toBeGreaterThan(content!.indexOf("---\n\n") + "---\n\n".length - 1);
    expect(content!.trimEnd().endsWith(REPO_SKILL_MARKER_END)).toBe(true);
    expect(content).toContain("name: contributing-to-widgets");
    expect(content).toContain("# Contributing to widgets");
    expect(content).toContain("CI publishes a required check before a pull request can merge.");
    expect(content).toContain('A linked issue is required, with a "required" policy.');
    expect(content).toContain("2 CI workflow files run on a pull request.");
    expect(content).toContain("Build: `npm run build`");
    expect(content).toContain("Test: `npm run test`");
    expect(content).toContain("Lint: `npm run lint`");
    expect(content).toContain("Policy: required");
    expect(content).toContain("Required: yes");
  });

  it("omits the gate-check reason line when the trigger fires via linked-issue + multi-stage CI alone (no blocking gate)", () => {
    const profile = presentProfile({
      contributionWorkflow: contributionWorkflow({ gatePublishesCheck: false, requireLinkedIssue: true, linkedIssuePolicy: "preferred", ciWorkflowFiles: [".github/workflows/a.yml", ".github/workflows/b.yml"] }),
    });
    const content = renderRepoSkillContent(profile);
    expect(content).not.toBeNull();
    expect(content).not.toContain("CI publishes a required check");
    expect(content).toContain('A linked issue is required, with a "preferred" policy.');
    expect(content).toContain("2 CI workflow files run on a pull request.");
  });

  it("omits the multi-stage-CI reason line when the trigger fires via gate + strict linked issue alone (single CI file)", () => {
    const profile = presentProfile({
      contributionWorkflow: contributionWorkflow({ gatePublishesCheck: true, requireLinkedIssue: true, linkedIssuePolicy: "required", ciWorkflowFiles: [".github/workflows/ci.yml"] }),
    });
    const content = renderRepoSkillContent(profile);
    expect(content).not.toBeNull();
    expect(content).toContain("CI publishes a required check before a pull request can merge.");
    expect(content).toContain('A linked issue is required, with a "required" policy.');
    expect(content).not.toContain("CI workflow files run on a pull request.");
  });

  it("degrades commands to 'none detected' and uses npm as the default runner when no package manager is known", () => {
    const profile = presentProfile({
      contributionWorkflow: contributionWorkflow({ gatePublishesCheck: true, ciWorkflowFiles: [".github/workflows/a.yml", ".github/workflows/b.yml"] }),
      commands: { packageManager: null, buildCommands: [], testCommands: [], lintCommands: [] },
    });
    const content = renderRepoSkillContent(profile);
    expect(content).toContain("Build: none detected");
    expect(content).toContain("Test: none detected");
    expect(content).toContain("Lint: none detected");
  });

  it("renders byte-identical output for the same profile facts regardless of generatedAt", () => {
    const workflow = contributionWorkflow({ gatePublishesCheck: true, ciWorkflowFiles: [".github/workflows/a.yml", ".github/workflows/b.yml"] });
    const a = renderRepoSkillContent(presentProfile({ contributionWorkflow: workflow, generatedAt: "2026-01-01T00:00:00.000Z" }));
    const b = renderRepoSkillContent(presentProfile({ contributionWorkflow: workflow, generatedAt: "2026-12-31T23:59:59.000Z" }));
    expect(a).toEqual(b);
  });
});
