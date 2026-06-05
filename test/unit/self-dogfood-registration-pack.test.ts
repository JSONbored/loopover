import { describe, expect, it } from "vitest";
import {
  buildCollisionReport,
  buildConfigQuality,
  buildContributorIntakeHealth,
  buildLabelAudit,
  buildLaneAdvice,
  buildMaintainerCutReadiness,
  buildQueueHealth,
} from "../../src/signals/engine";
import {
  buildSelfDogfoodRegistrationPack,
  buildSelfDogfoodRegistrationPackFromSignals,
  DEFAULT_SELF_DOGFOOD_REPO,
  resolveSelfDogfoodRepoFullName,
  type SelfDogfoodRegistrationPack,
} from "../../src/services/self-dogfood-registration-pack";
import {
  buildGittensorConfigRecommendation,
  buildRegistrationReadiness,
  type InstallationHealthSummary,
} from "../../src/signals/registration-readiness";
import type { IssueRecord, PullRequestRecord, RepoLabelRecord, RegistryRepoConfig, RepositoryRecord, RepositorySettings } from "../../src/types";

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|payout|reward estimate|raw trust score|public score estimate|private reviewability|farming/i;

function repoFor(fullName: string, registryConfig: RegistryRepoConfig | null, overrides: Partial<RepositoryRecord> = {}): RepositoryRecord {
  const [owner, name] = fullName.split("/");
  return {
    fullName,
    owner: owner ?? fullName,
    name: name ?? fullName,
    installationId: 1,
    isInstalled: true,
    isRegistered: registryConfig !== null,
    isPrivate: false,
    registryConfig,
    ...overrides,
  };
}

function configFor(overrides: Partial<RegistryRepoConfig> = {}): RegistryRepoConfig {
  return { repo: "x/y", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: { bug: 1.1 }, trustedLabelPipeline: true, maintainerCut: 0, raw: {}, ...overrides };
}

function settingsFor(repoFullName: string, overrides: Partial<RepositorySettings> = {}): RepositorySettings {
  return {
    repoFullName,
    commentMode: "detected_contributors_only",
    publicAudienceMode: "oss_maintainer",
    publicSignalLevel: "standard",
    checkRunMode: "enabled",
    checkRunDetailLevel: "standard",
    gateCheckMode: "off",
    autoLabelEnabled: true,
    gittensorLabel: "gittensor",
    createMissingLabel: true,
    publicSurface: "comment_and_label",
    includeMaintainerAuthors: false,
    requireLinkedIssue: false,
    backfillEnabled: true,
    privateTrustEnabled: true,
    ...overrides,
  };
}

const healthyInstall: InstallationHealthSummary = { status: "healthy", missingPermissions: [], missingEvents: [] };

function signalsFor(repo: RepositoryRecord, issues: IssueRecord[], pullRequests: PullRequestRecord[], labels: RepoLabelRecord[]) {
  const fullName = repo.fullName;
  const collisions = buildCollisionReport(fullName, issues, pullRequests);
  return {
    lane: buildLaneAdvice(repo, fullName),
    configQuality: buildConfigQuality(repo, issues, pullRequests, fullName),
    labelAudit: buildLabelAudit(repo, labels, issues, pullRequests, fullName),
    queueHealth: buildQueueHealth(repo, issues, pullRequests, collisions),
    maintainerCutReadiness: buildMaintainerCutReadiness(repo, issues, pullRequests, fullName, {}, collisions),
    contributorIntakeHealth: buildContributorIntakeHealth(repo, issues, pullRequests, fullName, collisions),
  };
}

function label(name: string): RepoLabelRecord {
  return { repoFullName: "x/y", name, isConfigured: true, observedCount: 3, payload: {} };
}

function packFromRepo(
  repo: RepositoryRecord,
  issues: IssueRecord[] = [],
  pullRequests: PullRequestRecord[] = [],
  labels: RepoLabelRecord[] = [label("bug")],
  settingsOverrides: Partial<RepositorySettings> = {},
): SelfDogfoodRegistrationPack {
  return buildSelfDogfoodRegistrationPackFromSignals({
    repoFullName: repo.fullName,
    repo,
    settings: settingsFor(repo.fullName, settingsOverrides),
    installation: healthyInstall,
    ...signalsFor(repo, issues, pullRequests, labels),
  });
}

describe("resolveSelfDogfoodRepoFullName", () => {
  it("defaults to the Gittensory repo when drift issue repo is unset", () => {
    expect(resolveSelfDogfoodRepoFullName({})).toBe(DEFAULT_SELF_DOGFOOD_REPO);
    expect(resolveSelfDogfoodRepoFullName({ GITTENSORY_DRIFT_ISSUE_REPO: "" })).toBe(DEFAULT_SELF_DOGFOOD_REPO);
  });

  it("uses the configured drift issue repo when valid", () => {
    expect(resolveSelfDogfoodRepoFullName({ GITTENSORY_DRIFT_ISSUE_REPO: "acme/widget" })).toBe("acme/widget");
  });
});

describe("buildSelfDogfoodRegistrationPack", () => {
  it("ready fixture recommends direct-PR-first with actionable areas", () => {
    const repo = repoFor("octo/ready", configFor({ repo: "octo/ready" }));
    const issues: IssueRecord[] = [{ repoFullName: repo.fullName, number: 4, title: "Fix flaky cache test", state: "open", labels: ["bug"], linkedPrs: [] }];
    const pack = packFromRepo(repo, issues);

    expect(pack).toMatchObject({
      kind: "gittensory_self_dogfood_registration_pack",
      privateOnly: true,
      advisoryOnly: true,
      directPrFirst: true,
      registrationReadiness: { ready: true, recommendedRegistrationMode: "direct_pr" },
    });
    expect(pack.actionableAreas.some((area) => area.area === "direct_pr" && area.status === "ready")).toBe(true);
    expect(pack.maintainerEconomicsNote).toMatch(/maintainer-economics/i);
    expect(pack.minerScoreabilityNote).toMatch(/scoreability/i);
    expect(pack.rerunHint).toMatch(/Rerun this pack/i);
  });

  it("not-ready fixture surfaces registration blockers", () => {
    const repo = repoFor("octo/unregistered", null);
    const pack = packFromRepo(repo, [], [], []);

    expect(pack.registrationReadiness.ready).toBe(false);
    expect(pack.directPrFirst).toBe(true);
    expect(pack.actionableAreas[0]).toMatchObject({ area: "registration_blockers", status: "blocked" });
    expect(pack.gittensorConfigRecommendation.recommended.issueDiscoveryShare).toBe(0);
  });

  it("issue-discovery disabled fixture keeps direct PR lane primary", () => {
    const repo = repoFor("octo/direct", configFor({ repo: "octo/direct", issueDiscoveryShare: 0 }));
    const base = signalsFor(repo, [], [], [label("bug")]);
    const pack = buildSelfDogfoodRegistrationPackFromSignals({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName),
      installation: healthyInstall,
      ...base,
      contributorIntakeHealth: { ...base.contributorIntakeHealth, level: "strained" },
    });

    expect(pack.registrationReadiness.issueDiscoveryReadiness.recommendation).toBe("not_recommended");
    expect(pack.directPrFirst).toBe(true);
    expect(pack.contributorLaneStrategy).toMatch(/direct-PR-first/i);
    expect(pack.gittensorConfigRecommendation.recommended.participationMode).toBe("direct_pr");
    expect(pack.gittensorConfigRecommendation.recommended.issueDiscoveryShare).toBe(0);
  });

  it("maintainer-cut fixture separates economics from miner scoreability", () => {
    const repo = repoFor("octo/cut", configFor({ repo: "octo/cut", maintainerCut: 0.05 }));
    const base = signalsFor(repo, [], [], [label("bug")]);
    const pack = buildSelfDogfoodRegistrationPackFromSignals({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName),
      installation: healthyInstall,
      ...base,
      maintainerCutReadiness: { ...base.maintainerCutReadiness, ready: true },
    });

    expect(pack.actionableAreas.some((area) => area.area === "maintainer_cut")).toBe(true);
    expect(pack.maintainerEconomicsNote).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    expect(pack.minerScoreabilityNote).toMatch(/private API\/MCP surfaces/i);
  });

  it("public wording regression stays free of forbidden language", () => {
    const repo = repoFor("JSONbored/gittensory", configFor({ repo: "JSONbored/gittensory" }));
    const pack = packFromRepo(repo);
    expect(JSON.stringify(pack)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });

  it("composes from explicit readiness and recommendation payloads", () => {
    const repo = repoFor("octo/ready", configFor({ repo: "octo/ready" }));
    const signals = signalsFor(repo, [], [], [label("bug")]);
    const registrationReadiness = buildRegistrationReadiness({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName),
      installation: healthyInstall,
      ...signals,
    });
    const gittensorConfigRecommendation = buildGittensorConfigRecommendation({
      repoFullName: repo.fullName,
      repo,
      settings: settingsFor(repo.fullName),
      ...signals,
    });
    const pack = buildSelfDogfoodRegistrationPack({ repoFullName: repo.fullName, registrationReadiness, gittensorConfigRecommendation });
    expect(pack.repoFullName).toBe("octo/ready");
    expect(pack.registrationReadiness).toBe(registrationReadiness);
  });
});
