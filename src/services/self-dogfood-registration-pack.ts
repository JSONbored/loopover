import {
  buildGittensorConfigRecommendation,
  buildRegistrationReadiness,
  type GittensorConfigRecommendation,
  type GittensorConfigRecommendationInput,
  type RegistrationReadinessInput,
  type RegistrationReadinessReport,
} from "../signals/registration-readiness";
import { nowIso } from "../utils/json";

export const DEFAULT_SELF_DOGFOOD_REPO = "JSONbored/gittensory";

export type SelfDogfoodActionArea = {
  area: string;
  status: "ready" | "needs_attention" | "blocked";
  actions: string[];
};

export type SelfDogfoodRegistrationPack = {
  kind: "gittensory_self_dogfood_registration_pack";
  repoFullName: string;
  generatedAt: string;
  privateOnly: true;
  advisoryOnly: true;
  directPrFirst: boolean;
  contributorLaneStrategy: string;
  maintainerEconomicsNote: string;
  minerScoreabilityNote: string;
  registrationReadiness: RegistrationReadinessReport;
  gittensorConfigRecommendation: GittensorConfigRecommendation;
  actionableAreas: SelfDogfoodActionArea[];
  rerunHint: string;
};

export function resolveSelfDogfoodRepoFullName(env: { GITTENSORY_DRIFT_ISSUE_REPO?: string }): string {
  const configured = env.GITTENSORY_DRIFT_ISSUE_REPO?.trim();
  if (!configured || !configured.includes("/")) return DEFAULT_SELF_DOGFOOD_REPO;
  return configured;
}

export function buildSelfDogfoodRegistrationPack(args: {
  repoFullName: string;
  registrationReadiness: RegistrationReadinessReport;
  gittensorConfigRecommendation: GittensorConfigRecommendation;
}): SelfDogfoodRegistrationPack {
  const { registrationReadiness: readiness, gittensorConfigRecommendation: recommendation } = args;
  // Keep the lane strategy consistent with the config recommendation shown in the same pack: direct-PR-first
  // exactly when the recommendation advises direct_pr (issue-discovery share 0). Deriving this from the
  // readiness report's current-lane mode instead contradicts the recommendation when a repo is currently
  // registered for issue-discovery/split but the recommendation advises reverting to direct-PR.
  const directPrFirst = recommendation.recommended.participationMode === "direct_pr";

  return {
    kind: "gittensory_self_dogfood_registration_pack",
    repoFullName: args.repoFullName,
    generatedAt: nowIso(),
    privateOnly: true,
    advisoryOnly: true,
    directPrFirst,
    contributorLaneStrategy: directPrFirst
      ? "Keep contributor intake direct-PR-first until issue-discovery signals, label policy, and queue health are excellent."
      : "Issue-discovery intake is strong enough to keep a bounded issue-discovery lane alongside direct PRs.",
    maintainerEconomicsNote:
      "Maintainer cut and registry emission splits are maintainer-economics controls only; they do not change private miner scoreability or public compensation claims.",
    minerScoreabilityNote:
      "Miner-facing scoreability stays in private API/MCP surfaces with hashed actors; sensitive identity and ranking fields stay out of this report.",
    registrationReadiness: readiness,
    gittensorConfigRecommendation: recommendation,
    actionableAreas: buildActionableAreas(readiness, recommendation),
    rerunHint: "Rerun this pack after registry, .gittensor.yml, label policy, GitHub App, or queue changes to refresh readiness and config tradeoffs.",
  };
}

export function buildSelfDogfoodRegistrationPackFromSignals(
  input: RegistrationReadinessInput & GittensorConfigRecommendationInput,
): SelfDogfoodRegistrationPack {
  const registrationReadiness = buildRegistrationReadiness(input);
  const gittensorConfigRecommendation = buildGittensorConfigRecommendation(input);
  return buildSelfDogfoodRegistrationPack({
    repoFullName: input.repoFullName,
    registrationReadiness,
    gittensorConfigRecommendation,
  });
}

function buildActionableAreas(
  readiness: RegistrationReadinessReport,
  recommendation: GittensorConfigRecommendation,
): SelfDogfoodActionArea[] {
  const areas: SelfDogfoodActionArea[] = [
    {
      area: "direct_pr",
      status: readiness.directPrReadiness.ready ? "ready" : readiness.blockers.length > 0 ? "blocked" : "needs_attention",
      actions: readiness.directPrReadiness.ready
        ? ["Keep direct PRs as the default contributor lane."]
        : [...readiness.directPrReadiness.reasons, ...readiness.blockers],
    },
    {
      area: "issue_discovery",
      status:
        readiness.issueDiscoveryReadiness.recommendation === "not_recommended"
          ? "blocked"
          : readiness.issueDiscoveryReadiness.ready
            ? "ready"
            : "needs_attention",
      actions:
        readiness.issueDiscoveryReadiness.reasons.length > 0
          ? readiness.issueDiscoveryReadiness.reasons
          : ["Issue discovery is intentionally deprioritized until intake is staffed and config is excellent."],
    },
    {
      area: "label_policy",
      status: readiness.labelPolicy.trustedPipelineReady ? "ready" : "needs_attention",
      actions: [
        ...(readiness.labelPolicy.missingOrUnusedRegistryLabels.length > 0
          ? readiness.labelPolicy.missingOrUnusedRegistryLabels.map((label) => `Add or retire registry label "${label}".`)
          : ["Label policy matches cached repo activity."]),
        recommendation.recommended.labelMultipliers === "start_without_trusted_label_multipliers"
          ? "Start without trusted label multipliers until labels are observed in live activity."
          : "Prune unused configured labels before expanding trusted multipliers.",
      ],
    },
    {
      area: "maintainer_cut",
      status: readiness.maintainerCutReadiness.ready ? "ready" : "needs_attention",
      actions: readiness.maintainerCutReadiness.ready
        ? [`Consider maintainer cut near ${recommendation.recommended.maintainerCut}; keep it separate from miner scoreability.`]
        : readiness.maintainerCutReadiness.reasons,
    },
    {
      area: "tests_and_docs",
      status: readiness.testCoverageHealth.status === "gate_ready" ? "ready" : "needs_attention",
      actions: [
        ...readiness.testCoverageHealth.requiredGate.map((gate) => `Preserve CI gate: ${gate}.`),
        ...readiness.docsCompleteness.requiredDocs.map((doc) => `Keep ${doc} current for contributor intake.`),
      ],
    },
    {
      area: "queue_and_github_app",
      status:
        readiness.queueHealth.level === "critical" || readiness.queueHealth.level === "high"
          ? "blocked"
          : readiness.githubApp.installed
            ? "ready"
            : "needs_attention",
      actions: [
        readiness.queueHealth.summary,
        readiness.githubApp.behavior,
        ...readiness.githubApp.warnings,
      ].filter(Boolean),
    },
  ];

  if (readiness.blockers.length > 0) {
    areas.unshift({
      area: "registration_blockers",
      status: "blocked",
      actions: readiness.blockers,
    });
  }

  return areas;
}
