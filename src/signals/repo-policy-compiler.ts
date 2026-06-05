import {
  compileFocusManifestPolicy,
  isFocusManifestPublicSafe,
  type FocusManifest,
  type FocusManifestLanePreference,
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
  const policy = compileFocusManifestPolicy(input.manifest);
  const contributionLanes: RepoPolicyContributionLane[] = [];

  if (policy.present) {
    contributionLanes.push(buildDirectPrLane(policy.publicSafe.contributionLanes.directPrLane, policy));
    contributionLanes.push(buildIssueDiscoveryLane(policy.publicSafe.contributionLanes.issueDiscoveryLane, policy));
  }

  const publicReadinessWarnings = policy.authenticated.readinessWarnings.filter(isFocusManifestPublicSafe);
  const publicParseWarnings = policy.authenticated.parseWarnings.filter(isFocusManifestPublicSafe);

  return {
    repoFullName: input.repoFullName,
    generatedAt: input.generatedAt ?? nowIso(),
    contributionLanes,
    labelPolicy: {
      preferredLabels: policy.publicSafe.labelExpectations.preferredLabels,
      requiredLabels: [],
      discouragedLabels: [],
      note: labelPolicyNote(policy.publicSafe.labelExpectations.linkedIssuePolicy),
    },
    validationExpectations: policy.publicSafe.validationExpectations.testExpectations,
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
  preference: FocusManifestLanePreference,
  policy: ReturnType<typeof compileFocusManifestPolicy>,
): RepoPolicyContributionLane {
  return {
    id: "direct-pr",
    title: laneTitle("Direct pull request lane", preference),
    summary: directPrSummary(preference, policy.publicSafe.summary),
    preferredPaths: policy.publicSafe.contributionLanes.preferredEntryPaths,
    discouragedPaths: policy.publicSafe.discouragedWork.blockedEntryPaths,
    validationExpectations: policy.publicSafe.validationExpectations.testExpectations,
    publicNotes: policy.publicSafe.entryGuidance,
  };
}

function buildIssueDiscoveryLane(
  preference: FocusManifestLanePreference,
  policy: ReturnType<typeof compileFocusManifestPolicy>,
): RepoPolicyContributionLane {
  return {
    id: "issue-discovery",
    title: laneTitle("Issue discovery lane", preference),
    summary: issueDiscoverySummary(preference, policy.publicSafe.summary),
    preferredPaths: policy.publicSafe.contributionLanes.preferredEntryPaths,
    discouragedPaths: policy.publicSafe.discouragedWork.blockedEntryPaths,
    validationExpectations: policy.publicSafe.validationExpectations.testExpectations,
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
