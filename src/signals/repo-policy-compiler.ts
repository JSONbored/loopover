import {
  compileFocusManifestPolicy,
  isFocusManifestPublicSafe,
  type FocusManifest,
  type FocusManifestLanePreference,
  type FocusManifestPolicyContributionLane,
} from "./focus-manifest";
import type { RepoPolicyCompilerOutput, RepoPolicyContributionLane } from "./onboarding-pack";
import { nowIso } from "../utils/json";

export type RepoPolicyCompilerInput = {
  repoFullName: string;
  manifest: FocusManifest;
  generatedAt?: string | undefined;
};

/**
 * Compile a normalized focus manifest into policy output consumed by onboarding-pack generation (#277 → #248).
 */
export function compileRepoPolicyCompilerOutput(input: RepoPolicyCompilerInput): RepoPolicyCompilerOutput {
  const generatedAt = input.generatedAt ?? nowIso();
  const policy = compileFocusManifestPolicy(input.repoFullName, input.manifest, { generatedAt });
  const contributionLanes: RepoPolicyContributionLane[] = [];

  if (policy.present) {
    const directPrPreferredPaths = policy.publicSafe.contributionLanes.find((l) => l.id === "direct-pr")?.preferredPaths ?? [];
    for (const lane of policy.publicSafe.contributionLanes) {
      if (lane.id === "direct-pr") contributionLanes.push(buildDirectPrLane(lane, policy));
      else if (lane.id === "issue-discovery") contributionLanes.push(buildIssueDiscoveryLane(lane, policy, directPrPreferredPaths));
    }
  }

  const publicReadinessWarnings = policy.authenticated.readinessWarnings.filter(isFocusManifestPublicSafe);
  const publicParseWarnings = policy.authenticated.parseWarnings.filter(isFocusManifestPublicSafe);

  return {
    repoFullName: input.repoFullName,
    generatedAt,
    contributionLanes,
    labelPolicy: {
      preferredLabels: policy.publicSafe.labelPolicy.preferredLabels,
      requiredLabels: [],
      discouragedLabels: [],
      note: labelPolicyNote(policy.publicSafe.validation.linkedIssuePolicy),
    },
    validationExpectations: policy.publicSafe.validation.expectations,
    readinessWarnings: [
      ...publicReadinessWarnings,
      ...publicParseWarnings,
      "Confirm contribution guidance stays previewable before publication.",
      "Keep public material separated from maintainer-only context.",
    ].filter(isFocusManifestPublicSafe),
    maintainerExpectations: [
      "Keep pull requests narrow and tied to accepted repository policy.",
      "Shape PR descriptions around maintainer public notes and validation expectations.",
    ],
    publicOutputBoundaries: [
      "Keep sensitive credentials, account secrets, compensation estimates, private maintainer evidence, and local paths out of public contribution text.",
      "Keep the pack as guidance for accepted work, not as automated GitHub action.",
      ...input.manifest.publicNotes.filter(isFocusManifestPublicSafe),
    ],
    privateOwnerContext: policy.authenticated.maintainerContext,
  };
}

function buildDirectPrLane(
  lane: FocusManifestPolicyContributionLane,
  policy: ReturnType<typeof compileFocusManifestPolicy>,
): RepoPolicyContributionLane {
  return {
    id: "direct-pr",
    title: laneTitle("Direct pull request lane", lane.preference),
    summary: directPrSummary(lane.preference, policy.publicSafe.summary),
    preferredPaths: lane.preferredPaths,
    discouragedPaths: lane.discouragedPaths,
    validationExpectations: policy.publicSafe.validation.expectations,
    publicNotes: policy.publicSafe.entryGuidance,
  };
}

function buildIssueDiscoveryLane(
  lane: FocusManifestPolicyContributionLane,
  policy: ReturnType<typeof compileFocusManifestPolicy>,
  directPrPreferredPaths: string[],
): RepoPolicyContributionLane {
  return {
    id: "issue-discovery",
    title: laneTitle("Issue discovery lane", lane.preference),
    summary: issueDiscoverySummary(lane.preference, policy.publicSafe.summary),
    preferredPaths: directPrPreferredPaths,
    discouragedPaths: lane.discouragedPaths,
    validationExpectations: policy.publicSafe.validation.expectations,
    publicNotes: policy.publicSafe.entryGuidance.filter((note) => !note.toLowerCase().includes("direct")),
  };
}

function laneTitle(base: string, preference: FocusManifestLanePreference): string {
  if (preference === "preferred") return `${base} (preferred)`;
  if (preference === "discouraged") return `${base} (discouraged)`;
  return base;
}

function directPrSummary(preference: FocusManifestLanePreference, summary: string): string {
  if (preference === "discouraged") return "Direct pull requests are discouraged for this repository.";
  if (preference === "preferred") return summary;
  return "Direct pull requests are accepted when they stay inside maintainer-wanted scope.";
}

function issueDiscoverySummary(preference: FocusManifestLanePreference, summary: string): string {
  if (preference === "discouraged") return "Prefer direct fixes over new issue reports.";
  if (preference === "preferred") return summary;
  return "Issue discovery is optional; confirm maintainer scope before filing new issues.";
}

function labelPolicyNote(linkedIssuePolicy: string): string {
  if (linkedIssuePolicy === "required") return "Link a tracked issue before opening a pull request.";
  if (linkedIssuePolicy === "preferred") return "Link a tracked issue when one exists.";
  return "Use labels to explain accepted scope, not to promise outcomes.";
}
