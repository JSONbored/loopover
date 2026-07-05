// Repo-skill content rendering (#3001, part of the repo-doc generation roadmap #2993). Extends AGENTS.md/CLAUDE.md
// generation (#3000) to conditionally propose a Claude Code / Codex skill file -- this repo's own
// `.claude/skills/contributing-to-gittensory/SKILL.md` (frontmatter `name`/`description` + a procedural body) is
// the concrete convention being replicated for OTHER repos.
//
// TRIGGER, NOT UNCONDITIONAL: a skill file is only warranted when a repo's contribution workflow is complex
// enough that folding the whole procedure into AGENTS.md would be unwieldy -- exactly the reason THIS repo has
// one. `shouldGenerateRepoSkill` decides that from RepoProfile's EXISTING fields only (no new signal derivation,
// keeping #2999's extraction primitive generation-agnostic): a blocking gate check, a strict linked-issue rule,
// and multi-stage CI are each named, independently testable sub-checks (mirroring src/signals/slop.ts's
// named-sub-signal style); two or more firing is the trigger, so no single ambiguous signal alone proposes a
// file a maintainer didn't actually need.
import type { RepoProfile, RepoProfileContributionWorkflow } from "./repo-profile";
import type { GeneratedDocMarkers } from "./generated-doc-refresh";

export const REPO_SKILL_MARKER_START = "<!-- gittensory-skill-doc:start -->";
export const REPO_SKILL_MARKER_END = "<!-- gittensory-skill-doc:end -->";
export const REPO_SKILL_MARKERS: GeneratedDocMarkers = { start: REPO_SKILL_MARKER_START, end: REPO_SKILL_MARKER_END };

function hasBlockingGate(contributionWorkflow: RepoProfileContributionWorkflow): boolean {
  return contributionWorkflow.gatePublishesCheck;
}

/** A repo that both requires a linked issue AND has a policy stricter than "optional" has a real, non-obvious
 *  admission rule worth writing down -- mirrors the mismatch repo-policy-readiness.ts already treats as notable. */
function hasStrictLinkedIssueRule(contributionWorkflow: RepoProfileContributionWorkflow): boolean {
  return contributionWorkflow.requireLinkedIssue && contributionWorkflow.linkedIssuePolicy !== "optional";
}

function hasMultiStageCi(contributionWorkflow: RepoProfileContributionWorkflow): boolean {
  return contributionWorkflow.ciWorkflowFiles.length >= 2;
}

/**
 * Whether this repo's contribution workflow is complex enough to warrant a generated skill file. Two or more of
 * three named signals (a blocking gate check, a strict linked-issue rule, multi-stage CI) must fire -- a single
 * signal alone (e.g. two CI workflow files with no real gate) is common and not, by itself, evidence of a
 * non-obvious flow worth documenting.
 */
export function shouldGenerateRepoSkill(profile: Extract<RepoProfile, { present: true }>): boolean {
  const signals = [hasBlockingGate(profile.contributionWorkflow), hasStrictLinkedIssueRule(profile.contributionWorkflow), hasMultiStageCi(profile.contributionWorkflow)];
  return signals.filter(Boolean).length >= 2;
}

function sanitizeSkillNameSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "repo";
}

function repoOnlyName(repoFullName: string): string {
  const slash = repoFullName.lastIndexOf("/");
  return slash === -1 ? repoFullName : repoFullName.slice(slash + 1);
}

/** The skill's `name:` frontmatter value -- also the containing directory name, per this repo's own convention
 *  (`.claude/skills/contributing-to-gittensory/`, directory name === frontmatter `name`). */
export function repoSkillName(repoFullName: string): string {
  return `contributing-to-${sanitizeSkillNameSegment(repoOnlyName(repoFullName))}`;
}

/** Where the generated skill file is delivered -- `.claude/skills/<name>/SKILL.md`, matching the fixed-filename,
 *  one-directory-per-skill convention this repo already uses. */
export function repoSkillFilePath(repoFullName: string): string {
  return `.claude/skills/${repoSkillName(repoFullName)}/SKILL.md`;
}

function renderTriggerReasons(contributionWorkflow: RepoProfileContributionWorkflow): string {
  const reasons: string[] = [];
  if (hasBlockingGate(contributionWorkflow)) reasons.push("- CI publishes a required check before a pull request can merge.");
  if (hasStrictLinkedIssueRule(contributionWorkflow)) reasons.push(`- A linked issue is required, with a "${contributionWorkflow.linkedIssuePolicy}" policy.`);
  if (hasMultiStageCi(contributionWorkflow)) reasons.push(`- ${contributionWorkflow.ciWorkflowFiles.length} CI workflow files run on a pull request.`);
  return reasons.join("\n");
}

function renderFrontmatterDescription(repoFullName: string): string {
  const repoName = repoOnlyName(repoFullName);
  return `Use when writing, testing, or preparing any code contribution or pull request to ${repoFullName}.\n  This repo's contribution flow has enough structure that it is worth following exactly. Invoke for any\n  "contribute to / open a PR against / fix a bug in / add a feature to ${repoName}" task.`;
}

/**
 * Render the markdown body of a generated skill file from a repo profile, or `null` when either the profile has
 * no data (`present: false`) or {@link shouldGenerateRepoSkill} says this repo's workflow doesn't warrant one.
 * Callers must treat `null` as "do not generate", not as an empty-but-valid file. The ENTIRE return value is the
 * generated skill file: YAML frontmatter must be the first bytes of SKILL.md, so the generated-content
 * marker starts immediately after that frontmatter. refreshGeneratedDoc (src/review/generated-doc-refresh.ts)
 * can still recompute the marked body on a later refresh while preserving the required top-of-file metadata.
 */
export function renderRepoSkillContent(profile: RepoProfile): string | null {
  if (!profile.present) return null;
  if (!shouldGenerateRepoSkill(profile)) return null;
  const { contributionWorkflow, commands } = profile;
  const repoName = repoOnlyName(profile.repoFullName);
  const skillName = repoSkillName(profile.repoFullName);
  const runner = commands.packageManager ?? "npm";
  return `---
name: ${skillName}
description: >-
  ${renderFrontmatterDescription(profile.repoFullName)}
---

${REPO_SKILL_MARKER_START}
# Contributing to ${repoName} — the contribution playbook

This repo's contribution flow has enough structure that it is worth writing down rather than folding into
AGENTS.md:

${renderTriggerReasons(contributionWorkflow)}

## Before you push

- Build: ${commands.buildCommands.length === 0 ? "none detected" : commands.buildCommands.map((name) => `\`${runner} run ${name}\``).join(", ")}
- Test: ${commands.testCommands.length === 0 ? "none detected" : commands.testCommands.map((name) => `\`${runner} run ${name}\``).join(", ")}
- Lint: ${commands.lintCommands.length === 0 ? "none detected" : commands.lintCommands.map((name) => `\`${runner} run ${name}\``).join(", ")}

## Linked issues

- Policy: ${contributionWorkflow.linkedIssuePolicy}
- Required: ${contributionWorkflow.requireLinkedIssue ? "yes" : "no"}
${REPO_SKILL_MARKER_END}
`;
}
