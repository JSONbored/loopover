import { afterEach, describe, expect, it, vi } from "vitest";
import * as repositories from "../../src/db/repositories";
import {
  persistUpstreamRulesetSnapshot,
  listLatestUpstreamSourceSnapshotsByKey,
  listUpstreamDriftReports,
  upsertUpstreamDriftReport,
} from "../../src/db/repositories";
import {
  buildUpstreamRulesetSnapshot,
  detectAndPersistUpstreamDrift,
  buildUpstreamDriftReport,
  fileUpstreamDriftIssues,
  loadUpstreamStatus,
  registryHyperparameterDriftWarningsForRepo,
  refreshUpstreamDrift,
  refreshUpstreamSourceSnapshots,
} from "../../src/upstream/ruleset";
import type { UpstreamDriftReportRecord, UpstreamRulesetSnapshotRecord, UpstreamSourceSnapshotRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

describe("upstream ruleset drift tracking", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("builds a versioned ruleset from GitHub contents snapshots", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-30T00:00:00.000Z"));
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "token" });
    vi.stubGlobal("fetch", upstreamFetch(fixtures("58", 0.01)));

    const result = await refreshUpstreamDrift(env);
    const status = await loadUpstreamStatus(env);

    expect(result.sources).toHaveLength(6);
    expect(result.drift).toBeNull();
    expect(result.ruleset).toMatchObject({
      sourceRepo: "entrius/gittensor",
      sourceRef: "test",
      commitSha: "commit-58",
      activeModel: "pending_saturation_model",
      registryRepoCount: 1,
      totalEmissionShare: 0.01,
    });
    expect(status).toMatchObject({
      status: "current",
      latestCommitSha: "commit-58",
      activeModel: "pending_saturation_model",
      openReportCount: 0,
    });
  });

  it("opens an upstream drift report when upstream defines scoring constants gittensory does not model", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-30T00:00:00.000Z"));
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "token" });
    const files = fixtures("58", 0.01);
    files["gittensor/constants.py"] += "\nNOVELTY_BONUS_SCALAR = 3\n";
    vi.stubGlobal("fetch", upstreamFetch(files));

    await refreshUpstreamDrift(env);
    const reports = await listUpstreamDriftReports(env, 10);
    const status = await loadUpstreamStatus(env);

    expect(reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "open",
          severity: "medium",
          affectedAreas: ["scoring_model"],
          summary: expect.stringContaining("NOVELTY_BONUS_SCALAR"),
          payload: expect.objectContaining({
            kind: "unmodeled_scoring_constants",
            unmodeledUpstreamConstants: ["NOVELTY_BONUS_SCALAR"],
          }),
        }),
      ]),
    );
    expect(status).toMatchObject({
      status: "drift_detected",
      openReportCount: 1,
      affectedAreas: ["scoring_model"],
    });
  });

  it("detects high-severity scoring and registry drift between semantic rulesets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "token" });

    vi.setSystemTime(new Date("2026-05-30T00:00:00.000Z"));
    vi.stubGlobal("fetch", upstreamFetch(fixtures("58", 0.01)));
    await refreshUpstreamDrift(env);

    vi.setSystemTime(new Date("2026-05-30T00:10:00.000Z"));
    vi.stubGlobal("fetch", upstreamFetch(fixtures("99", 0.02)));
    const result = await refreshUpstreamDrift(env);
    const reports = await listUpstreamDriftReports(env);
    const status = await loadUpstreamStatus(env);

    expect(result.drift).toMatchObject({
      severity: "high",
      affectedAreas: expect.arrayContaining(["registry", "scoring_model"]),
      summary: expect.stringContaining("scoring constants changed"),
    });
    expect(reports).toHaveLength(1);
    expect(status).toMatchObject({
      status: "drift_detected",
      highestSeverity: "high",
      affectedAreas: expect.arrayContaining(["registry", "scoring_model"]),
    });
  });

  it("uses raw GitHub fallback when the contents API is unavailable", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", upstreamRawFallbackFetch(fixtures("58", 0.01)));

    const sources = await refreshUpstreamSourceSnapshots(env);
    const stored = await listLatestUpstreamSourceSnapshotsByKey(env);

    expect(sources.map((source) => source.status)).toEqual(Array(6).fill("fallback"));
    expect(sources.flatMap((source) => source.warnings)).toEqual(expect.arrayContaining([expect.stringContaining("raw fallback used")]));
    expect(stored).toHaveLength(6);
  });

  it("reuses previous snapshots on not-modified responses", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "token" });
    vi.stubGlobal("fetch", upstreamFetch(fixtures("58", 0.01), { etag: "\"etag-58\"" }));
    await refreshUpstreamSourceSnapshots(env);

    vi.stubGlobal("fetch", upstreamNotModifiedFetch("commit-58"));
    const sources = await refreshUpstreamSourceSnapshots(env);

    expect(sources.map((source) => source.status)).toEqual(Array(6).fill("not_modified"));
    expect(sources.every((source) => typeof source.payload.previousSnapshotId === "string")).toBe(true);
  });

  it("preserves previous parsed payloads when both GitHub contents and raw fallback fail", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", upstreamFetch(fixtures("58", 0.01)));
    await refreshUpstreamSourceSnapshots(env);

    vi.stubGlobal("fetch", upstreamFailedFetch());
    const sources = await refreshUpstreamSourceSnapshots(env);

    expect(sources.map((source) => source.status)).toEqual(Array(6).fill("error"));
    expect(sources.flatMap((source) => source.warnings)).toEqual(expect.arrayContaining([expect.stringContaining("Raw fallback failed")]));
    expect(sources.find((source) => source.sourceKey === "constants")?.parsed).toEqual(expect.objectContaining({ activeModel: "pending_saturation_model" }));
  });

  it("returns empty parsed payloads when no previous source snapshot exists", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", upstreamFailedFetch());

    const sources = await refreshUpstreamSourceSnapshots(env);

    expect(sources.map((source) => source.status)).toEqual(Array(6).fill("error"));
    expect(sources.every((source) => Object.keys(source.parsed).length === 0)).toBe(true);
    expect(sources.every((source) => source.payload.previousSnapshotId === null)).toBe(true);
  });

  it("keeps previous commit SHA when not-modified refresh cannot resolve a new commit", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", upstreamFetch(fixtures("58", 0.01)));
    await refreshUpstreamSourceSnapshots(env);

    vi.stubGlobal("fetch", upstreamNotModifiedNoCommitFetch());
    const sources = await refreshUpstreamSourceSnapshots(env);

    expect(sources.map((source) => source.status)).toEqual(Array(6).fill("not_modified"));
    expect(sources.every((source) => source.commitSha === "commit-58")).toBe(true);
  });

  it("parses invalid upstream JSON as an empty semantic payload", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", upstreamFetch(invalidJsonFixtures("58")));

    const sources = await refreshUpstreamSourceSnapshots(env);
    const registry = sources.find((source) => source.sourceKey === "registry");
    const languages = sources.find((source) => source.sourceKey === "programming_languages");

    expect(registry?.parsed).toMatchObject({ registry: { repoCount: 0, totalEmissionShare: 0, repositories: [] } });
    expect(languages?.parsed).toMatchObject({ weights: {}, count: 0 });
  });

  it("builds a ruleset from supplied source snapshots and surfaces source warnings", async () => {
    const env = createTestEnv({ GITTENSOR_UPSTREAM_REPO: "", GITTENSOR_UPSTREAM_REF: "" });
    const snapshot = await buildUpstreamRulesetSnapshot(env, [
      sourceSnapshot("constants", { constants: { SRC_TOK_SATURATION_SCALE: 33, EXTRA_CONSTANT: 4 } }, ["manual warning"]),
      sourceSnapshot("registry", { registry: "not-a-registry" }),
      sourceSnapshot("programming_languages", { weights: ["bad"] }),
      sourceSnapshot("mirror_scoring", { usesDensityModel: false, usesSaturationModel: false, usesExponentialSaturation: false, solvedByPrRequired: false }),
      sourceSnapshot("issue_discovery_scan", { branchEligibilityRequired: true }),
      sourceSnapshot("mirror_models", { solvedByPrRequired: true }),
    ]);

    expect(snapshot).toMatchObject({
      sourceRepo: "entrius/gittensor",
      sourceRef: "test",
      activeModel: "pending_saturation_model",
      registryRepoCount: 0,
      totalEmissionShare: 0,
      warnings: ["constants: manual warning"],
    });
    expect(snapshot.payload).toMatchObject({
      issueDiscovery: { branchEligibilityRequired: true },
      mirrorLinkage: { solvedByPrRequired: true },
      languageWeights: { count: 0 },
    });
  });

  it("falls back safely when source snapshots are incomplete or malformed", async () => {
    const env = createTestEnv();

    const snapshot = await buildUpstreamRulesetSnapshot(env, [
      sourceSnapshot("registry", { registry: { repoCount: "bad", totalEmissionShare: "bad", repositories: "bad" } }),
      sourceSnapshot("programming_languages", { weights: null }),
    ]);

    expect(snapshot).toMatchObject({
      commitSha: "commit-manual",
      activeModel: "unknown",
      registryRepoCount: 0,
      totalEmissionShare: 0,
    });
    expect(snapshot.payload).toMatchObject({
      scoring: { activeModel: "unknown", constants: {}, semanticFlags: { usesDensityModel: false, usesSaturationModel: false, usesExponentialSaturation: false } },
      issueDiscovery: { branchEligibilityRequired: false },
      mirrorLinkage: { solvedByPrRequired: false },
      languageWeights: { count: 0, weights: {} },
    });

    const emptySnapshot = await buildUpstreamRulesetSnapshot(createTestEnv(), []);
    expect(emptySnapshot).toMatchObject({
      commitSha: null,
      activeModel: "unknown",
      registryRepoCount: 0,
      totalEmissionShare: 0,
    });
    expect(emptySnapshot.payload).toMatchObject({ languageWeights: { count: 0 } });
  });

  it("normalizes stored ruleset registry repositories defensively", async () => {
    const snapshot = await buildUpstreamRulesetSnapshot(createTestEnv(), [
      sourceSnapshot("registry", {
        registry: {
          repoCount: 4,
          totalEmissionShare: 0.2,
          repositories: [
            null,
            {},
            {
              repo: "owner/defaults",
              emissionShare: "bad",
              issueDiscoveryShare: "bad",
              maintainerCut: "bad",
              labelMultipliers: { feature: "bad" },
              trustedLabelPipeline: "bad",
              defaultLabelMultiplier: "bad",
              fixedBaseScore: "bad",
              eligibilityMode: 7,
            },
            {
              repo: "owner/policy",
              emissionShare: 0.2,
              issueDiscoveryShare: 0.4,
              maintainerCut: 0.1,
              labelMultipliers: { feature: 1.1 },
              trustedLabelPipeline: false,
              defaultLabelMultiplier: 1.2,
              fixedBaseScore: 12,
              eligibilityMode: "linked_issue_required",
              timeDecay: { gracePeriodHours: 24, sigmoidMidpointDays: 5, sigmoidSteepness: 0.4, minMultiplier: 0.05 },
            },
          ],
        },
      }),
    ]);

    expect(rulesetRegistry(snapshot).repositories).toEqual([
      {
        repo: "owner/defaults",
        emissionShare: 0,
        issueDiscoveryShare: 0,
        maintainerCut: 0,
        labelMultipliers: {},
        trustedLabelPipeline: null,
        defaultLabelMultiplier: null,
        fixedBaseScore: null,
        eligibilityMode: null,
        timeDecay: null,
      },
      {
        repo: "owner/policy",
        emissionShare: 0.2,
        issueDiscoveryShare: 0.4,
        maintainerCut: 0.1,
        labelMultipliers: { feature: 1.1 },
        trustedLabelPipeline: false,
        defaultLabelMultiplier: 1.2,
        fixedBaseScore: 12,
        eligibilityMode: "linked_issue_required",
        timeDecay: { gracePeriodHours: 24, sigmoidMidpointDays: 5, sigmoidSteepness: 0.4, minMultiplier: 0.05 },
      },
    ]);
  });

  it("can build a ruleset from stored latest snapshots", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", upstreamNoCommitShaFetch(fixturesWithoutOptionalRegistryFields("58", 0.01)));

    const sources = await refreshUpstreamSourceSnapshots(env);
    const snapshot = await buildUpstreamRulesetSnapshot(env);

    expect(sources.every((source) => source.commitSha === null)).toBe(true);
    expect(snapshot).toMatchObject({ commitSha: null, activeModel: "pending_saturation_model", registryRepoCount: 1 });
    expect(rulesetRegistry(snapshot).repositories[0]).toMatchObject({
      trustedLabelPipeline: null,
      defaultLabelMultiplier: null,
      fixedBaseScore: null,
      eligibilityMode: null,
    });
  });

  it("compacts per-repo time-decay overrides through the raw registry source (partial fields kept, absent fields null)", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", upstreamNoCommitShaFetch(fixturesWithPartialTimeDecay("58", 0.01)));

    await refreshUpstreamSourceSnapshots(env);
    const snapshot = await buildUpstreamRulesetSnapshot(env);

    const byRepo = Object.fromEntries(rulesetRegistry(snapshot).repositories.map((repo) => [repo.repo, repo.timeDecay]));
    expect(byRepo["owner/decay-a"]).toEqual({ gracePeriodHours: 24, sigmoidMidpointDays: null, sigmoidSteepness: 0.4, minMultiplier: null });
    expect(byRepo["owner/decay-b"]).toEqual({ gracePeriodHours: null, sigmoidMidpointDays: 5, sigmoidSteepness: null, minMultiplier: 0.05 });
  });

  it("records no drift when no ruleset exists and detects drift after two snapshots exist", async () => {
    const env = createTestEnv();

    await expect(detectAndPersistUpstreamDrift(env)).resolves.toMatchObject({ current: null, previous: null, report: null });

    await persistUpstreamRulesetSnapshot(env, ruleset("ruleset-old", "old-hash", "current_density_model", 1, 0.01, "2026-05-30T00:00:00.000Z"));
    await persistUpstreamRulesetSnapshot(env, ruleset("ruleset-new", "new-hash", "pending_saturation_model", 1, 0.01, "2026-05-30T00:10:00.000Z"));

    const result = await detectAndPersistUpstreamDrift(env);
    expect(result.report).toMatchObject({ severity: "high", affectedAreas: ["scoring_model"] });
    await expect(listUpstreamDriftReports(env)).resolves.toHaveLength(1);
  });

  it("classifies upstream drift by affected semantic area", async () => {
    const base = ruleset("base", "base-hash", "pending_saturation_model", 1, 0.01, "2026-05-30T00:00:00.000Z");
    const baseRegistry = rulesetRegistry(base);

    await expect(buildUpstreamDriftReport(base, null)).resolves.toBeNull();
    await expect(buildUpstreamDriftReport({ ...base, id: "same" }, base)).resolves.toBeNull();

    await expect(buildUpstreamDriftReport(ruleset("unknown", "unknown-hash", "unknown", 1, 0.01, "2026-05-30T00:05:00.000Z"), base)).resolves.toMatchObject({
      severity: "blocking",
      affectedAreas: ["scoring_model"],
    });

    await expect(buildUpstreamDriftReport(withPayload(base, "branch", { issueDiscovery: { branchEligibilityRequired: true } }), base)).resolves.toMatchObject({
      severity: "high",
      affectedAreas: ["issue_discovery"],
      summary: expect.stringContaining("branch eligibility"),
    });

    await expect(buildUpstreamDriftReport(withPayload(base, "solved", { mirrorLinkage: { solvedByPrRequired: true } }), base)).resolves.toMatchObject({
      severity: "high",
      affectedAreas: ["mirror_linkage"],
      summary: expect.stringContaining("solved_by_pr"),
    });

    await expect(buildUpstreamDriftReport(withPayload(base, "language", { languageWeights: { count: 2, weights: { TypeScript: 1, Go: 0.9 }, contentHash: "new-language" } }), base)).resolves.toMatchObject({
      severity: "medium",
      affectedAreas: ["language_weights"],
    });

    await expect(
      buildUpstreamDriftReport(
        withPayload(base, "repo-medium", {
          registry: {
            ...baseRegistry,
            repositories: [{ ...baseRegistry.repositories[0]!, maintainerCut: 0.4 }],
          },
        }),
        base,
      ),
    ).resolves.toMatchObject({ severity: "high", affectedAreas: ["registry"] });

    await expect(
      buildUpstreamDriftReport(
        withPayload(base, "repo-policy", {
          registry: {
            ...baseRegistry,
            repositories: [
              {
                ...baseRegistry.repositories[0]!,
                issueDiscoveryShare: 0.25,
                labelMultipliers: { feature: 1.5, bugfix: 1.1 },
                defaultLabelMultiplier: 1.2,
                eligibilityMode: "linked_issue_required",
              },
            ],
          },
        }),
        base,
      ),
    ).resolves.toMatchObject({
      severity: "high",
      affectedAreas: ["registry"],
      summary: "4 registry hyperparameter drift event(s)",
      payload: {
        registryHyperparameterDrift: {
          totalEvents: 4,
          highImpactCount: 2,
          affectedFields: ["issueDiscoveryShare", "eligibilityMode", "defaultLabelMultiplier", "labelMultipliers"],
          affectedSurfaces: ["lane_fit", "scoreability_assumptions", "issue_discovery_behavior", "label_policy"],
        },
        repoChanges: [
          expect.stringContaining("issueDiscoveryShare 0 -> 0.25"),
        ],
      },
    });

    const policyBase = withPayload(base, "policy-base", {
      registry: {
        ...baseRegistry,
        repositories: [{ ...baseRegistry.repositories[0]!, defaultLabelMultiplier: 1.2, eligibilityMode: "linked_issue_required" }],
      },
    });
    await expect(
      buildUpstreamDriftReport(
        withPayload(policyBase, "repo-policy-unset", {
          registry: {
            ...baseRegistry,
            repositories: [{ ...baseRegistry.repositories[0]!, defaultLabelMultiplier: null, eligibilityMode: null }],
          },
        }),
        policyBase,
      ),
    ).resolves.toMatchObject({ severity: "high", affectedAreas: ["registry"] });

    await expect(
      buildUpstreamDriftReport(
        withPayload(base, "repo-added", {
          registry: {
            repoCount: 2,
            totalEmissionShare: 0.02,
            repositories: [...baseRegistry.repositories, { ...baseRegistry.repositories[0]!, repo: "entrius/gittensor", emissionShare: 0.01 }],
          },
        }),
        base,
      ),
    ).resolves.toMatchObject({ severity: "high", affectedAreas: ["registry"] });

    await expect(buildUpstreamDriftReport({ ...base, id: "source-only", semanticHash: "source-only-hash" }, { ...base, id: "previous-source", semanticHash: "previous-source-hash" })).resolves.toMatchObject({
      severity: "low",
      affectedAreas: ["source"],
      summary: expect.stringContaining("without parsed semantic drift"),
    });
  });

  it("classifies registry hyperparameter drift by field, surface, and severity", async () => {
    const base = ruleset("base", "base-hash", "pending_saturation_model", 1, 0.01, "2026-05-30T00:00:00.000Z");
    const baseRegistry = rulesetRegistry(base);
    const [baseRepo] = baseRegistry.repositories;

    const labelOnly = await buildUpstreamDriftReport(
      withPayload(base, "label-only", {
        registry: {
          ...baseRegistry,
          repositories: [{ ...baseRepo!, labelMultipliers: { feature: 1.5, bugfix: 1.1 } }],
        },
      }),
      base,
    );
    const labelDrift = registryDriftPayload(labelOnly!);
    expect(labelOnly).toMatchObject({ severity: "medium", affectedAreas: ["registry"] });
    expect(labelDrift).toMatchObject({
      totalEvents: 1,
      highImpactCount: 0,
      affectedFields: ["labelMultipliers"],
      affectedSurfaces: ["scoreability_assumptions", "label_policy"],
    });
    expect(labelDrift.events).toEqual([
      expect.objectContaining({ field: "labelMultipliers", severity: "medium", affectedSurfaces: ["label_policy", "scoreability_assumptions"] }),
    ]);

    const allFields = await buildUpstreamDriftReport(
      withPayload(base, "all-registry-fields", {
        registry: {
          ...baseRegistry,
          repositories: [
            {
              ...baseRepo!,
              emissionShare: 0.02,
              issueDiscoveryShare: 0.25,
              maintainerCut: 0.4,
              labelMultipliers: { feature: 1.5, bugfix: 1.1 },
              trustedLabelPipeline: false,
              defaultLabelMultiplier: 1.2,
              fixedBaseScore: 12,
              eligibilityMode: "linked_issue_required",
              timeDecay: { gracePeriodHours: 24, sigmoidMidpointDays: 5, sigmoidSteepness: 0.4, minMultiplier: 0.05 },
            },
          ],
        },
      }),
      base,
    );
    const allFieldsDrift = registryDriftPayload(allFields!);
    expect(allFields).toMatchObject({ severity: "high", summary: "9 registry hyperparameter drift event(s)" });
    expect(allFieldsDrift).toMatchObject({
      totalEvents: 9,
      omittedEvents: 0,
      highImpactCount: 6,
      affectedRepoCount: 1,
      affectedFields: [
        "emissionShare",
        "issueDiscoveryShare",
        "maintainerCut",
        "fixedBaseScore",
        "eligibilityMode",
        "trustedLabelPipeline",
        "defaultLabelMultiplier",
        "labelMultipliers",
        "timeDecay",
      ],
      affectedSurfaces: ["allocation", "lane_fit", "scoreability_assumptions", "maintainer_economics", "issue_discovery_behavior", "label_policy"],
    });
    expect(allFieldsDrift.events.map((event) => event.field)).toEqual([
      "emissionShare",
      "issueDiscoveryShare",
      "maintainerCut",
      "fixedBaseScore",
      "eligibilityMode",
      "timeDecay",
      "trustedLabelPipeline",
      "defaultLabelMultiplier",
      "labelMultipliers",
    ]);
    expect(allFieldsDrift.events.find((event) => event.field === "maintainerCut")).toMatchObject({ severity: "high", affectedSurfaces: ["maintainer_economics"] });
    expect(registryHyperparameterDriftWarningsForRepo([allFields!], "JSONbored/gittensory")).toEqual([
      "Upstream registry drift is open for JSONbored/gittensory: allocation changed; affected surface(s): allocation, lane_fit.",
      "Upstream registry drift is open for JSONbored/gittensory: issue-discovery share changed; affected surface(s): issue_discovery_behavior, lane_fit.",
      "Upstream registry drift is open for JSONbored/gittensory: maintainer cut changed; affected surface(s): maintainer_economics.",
      "3 additional high-impact upstream registry drift event(s) are open for JSONbored/gittensory.",
    ]);


    const timeDecayOnly = await buildUpstreamDriftReport(
      withPayload(base, "time-decay-only", {
        registry: {
          ...baseRegistry,
          repositories: [{ ...baseRepo!, timeDecay: { gracePeriodHours: 24, sigmoidMidpointDays: 5, sigmoidSteepness: 0.4, minMultiplier: 0.05 } }],
        },
      }),
      base,
    );
    const timeDecayDrift = registryDriftPayload(timeDecayOnly!);
    expect(timeDecayOnly).toMatchObject({ severity: "high", affectedAreas: ["registry"], summary: "1 registry hyperparameter drift event(s)" });
    expect(timeDecayDrift).toMatchObject({
      totalEvents: 1,
      highImpactCount: 1,
      affectedFields: ["timeDecay"],
      affectedSurfaces: ["scoreability_assumptions"],
    });
    expect(timeDecayDrift.events).toEqual([
      expect.objectContaining({ field: "timeDecay", severity: "high", summary: "timeDecay changed", affectedSurfaces: ["scoreability_assumptions"] }),
    ]);

    expect(registryHyperparameterDriftWarningsForRepo([allFields!], "JSONbored/gittensory").join(" ")).not.toMatch(/wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i);
  });

  it("keeps large registry drift payloads bounded and deterministically sorted", async () => {
    const previousRepos = Array.from({ length: 150 }, (_, index) => registryRepo(`owner/repo-${String(index).padStart(3, "0")}`, { labelMultipliers: { feature: 1 } }));
    const currentRepos = previousRepos.map((repo) => ({ ...repo, labelMultipliers: { feature: 1.1 } }));
    const previous = rulesetWithRegistry("large-previous", previousRepos);
    const current = rulesetWithRegistry("large-current", currentRepos);

    const report = await buildUpstreamDriftReport(current, previous);
    const drift = registryDriftPayload(report!);

    expect(report).toMatchObject({ severity: "medium", affectedAreas: ["registry"] });
    expect(drift).toMatchObject({ totalEvents: 150, omittedEvents: 50, highImpactCount: 0, affectedRepoCount: 150 });
    expect(drift.events).toHaveLength(100);
    expect(drift.events.map((event) => event.repoFullName).slice(0, 3)).toEqual(["owner/repo-000", "owner/repo-001", "owner/repo-002"]);
    expect(drift.events.map((event) => event.repoFullName).at(-1)).toBe("owner/repo-099");
    expect((report!.payload.repoChanges as string[])).toHaveLength(100);
  });

  it("does not treat legacy missing optional registry fields as drift", async () => {
    const base = ruleset("legacy-registry-base", "legacy-registry-base-hash", "pending_saturation_model", 1, 0.01, "2026-05-30T00:00:00.000Z");
    const baseRegistry = rulesetRegistry(base);
    const [baseRepo] = baseRegistry.repositories;
    const { defaultLabelMultiplier: _defaultLabelMultiplier, fixedBaseScore: _fixedBaseScore, eligibilityMode: _eligibilityMode, ...legacyRepo } = baseRepo!;

    const previous = withPayload(base, "legacy-registry-previous", {
      registry: {
        ...baseRegistry,
        repositories: [legacyRepo],
      },
    });
    const current = withPayload(base, "legacy-registry-current", { registry: baseRegistry });

    const report = await buildUpstreamDriftReport(current, previous);

    expect(report).toMatchObject({
      severity: "low",
      affectedAreas: ["source"],
      payload: {
        repoChanges: [],
        registryHyperparameterDrift: { totalEvents: 0, highImpactCount: 0, affectedFields: [], events: [] },
      },
    });
  });

  it("tracks registry membership drift and tolerates malformed stored registry drift payloads", async () => {
    const previous = rulesetWithRegistry("membership-previous", [registryRepo("owner/removed")]);
    const current = rulesetWithRegistry("membership-current", [registryRepo("owner/added")]);
    const membership = await buildUpstreamDriftReport(current, previous);

    expect(registryDriftPayload(membership!)).toMatchObject({
      totalEvents: 2,
      highImpactCount: 2,
      affectedFields: ["repo"],
      affectedSurfaces: ["allocation", "lane_fit"],
      events: [
        expect.objectContaining({ repoFullName: "owner/added", field: "repo", summary: "added" }),
        expect.objectContaining({ repoFullName: "owner/removed", field: "repo", summary: "removed" }),
      ],
    });
    expect(membership!.payload.repoChanges).toEqual(["owner/added: added", "owner/removed: removed"]);

    const env = createTestEnv();
    await persistUpstreamRulesetSnapshot(env, ruleset("current", "current-hash", "pending_saturation_model", 1, 0.01, new Date().toISOString()));
    await upsertUpstreamDriftReport(env, driftReport("bad-registry-payload", { affectedAreas: ["registry"], payload: { registryHyperparameterDrift: "bad" } }));
    await upsertUpstreamDriftReport(
      env,
      driftReport("summary-only-registry-payload", {
        affectedAreas: ["registry"],
        payload: {
          registryHyperparameterDrift: {
            totalEvents: 2,
            omittedEvents: 1,
            highImpactCount: 1,
            affectedRepoCount: 1,
            affectedFields: ["maintainerCut", "not-a-field"],
            affectedSurfaces: ["maintainer_economics", "not-a-surface"],
            events: "bad",
          },
        },
      }),
    );
    await upsertUpstreamDriftReport(
      env,
      driftReport("event-fallback-registry-payload", {
        affectedAreas: ["registry"],
        payload: {
          registryHyperparameterDrift: {
            events: [
              null,
              { repoFullName: "owner/repo", field: "not-a-field", severity: "high" },
              { field: "maintainerCut", severity: "high" },
              { repoFullName: "owner/repo", field: "maintainerCut", severity: "bad" },
              { repoFullName: "owner/repo", field: "repo", previous: {}, current: {}, severity: "high", affectedSurfaces: "bad" },
              { repoFullName: "owner/missing-values", field: "maintainerCut", severity: "high", affectedSurfaces: ["maintainer_economics"] },
            ],
          },
        },
      }),
    );

    await expect(loadUpstreamStatus(env)).resolves.toMatchObject({
      status: "drift_detected",
      registryHyperparameterDrift: {
        totalEvents: 4,
        omittedEvents: 1,
        highImpactCount: 3,
        // Distinct repos across reports, not the sum of per-report counts: only `owner/repo` and
        // `owner/missing-values` are identifiable (the summary-only payload reports a count with no
        // repo identity to union), so the deduped count is 2 -- previously this summed to 3.
        affectedRepoCount: 2,
        affectedFields: ["repo", "maintainerCut"],
        affectedSurfaces: ["maintainer_economics"],
      },
    });
  });

  it("counts distinct affected repos across open drift reports instead of summing per-report counts", async () => {
    const env = createTestEnv();
    await persistUpstreamRulesetSnapshot(env, ruleset("current", "current-hash", "pending_saturation_model", 1, 0.01, new Date().toISOString()));
    const driftEvent = (repoFullName: string) => ({
      repoFullName,
      field: "maintainerCut",
      previous: 0.1,
      current: 0.2,
      severity: "high",
      affectedSurfaces: ["maintainer_economics"],
      summary: `${repoFullName} maintainerCut changed`,
    });
    await upsertUpstreamDriftReport(
      env,
      driftReport("registry-drift-a", { affectedAreas: ["registry"], payload: { registryHyperparameterDrift: { events: [driftEvent("owner/x"), driftEvent("owner/y"), driftEvent("owner/z")] } } }),
    );
    await upsertUpstreamDriftReport(
      env,
      driftReport("registry-drift-b", { affectedAreas: ["registry"], payload: { registryHyperparameterDrift: { events: [driftEvent("owner/z"), driftEvent("owner/w")] } } }),
    );

    const status = await loadUpstreamStatus(env);
    // owner/z is affected in both reports: 4 distinct repos (x, y, z, w), not 3 + 2 = 5.
    expect(status.registryHyperparameterDrift.affectedRepoCount).toBe(4);
  });

  it("preserves stored affected repo counts for legacy capped registry drift reports", async () => {
    const env = createTestEnv();
    await persistUpstreamRulesetSnapshot(env, ruleset("current", "current-hash", "pending_saturation_model", 1, 0.01, new Date().toISOString()));
    const driftEvent = (repoFullName: string) => ({
      repoFullName,
      field: "maintainerCut",
      previous: 0.1,
      current: 0.2,
      severity: "high",
      affectedSurfaces: ["maintainer_economics"],
      summary: `${repoFullName} maintainerCut changed`,
    });

    await upsertUpstreamDriftReport(
      env,
      driftReport("legacy-capped-registry-drift", {
        affectedAreas: ["registry"],
        payload: {
          registryHyperparameterDrift: {
            totalEvents: 150,
            omittedEvents: 50,
            highImpactCount: 150,
            affectedRepoCount: 150,
            affectedFields: ["maintainerCut"],
            affectedSurfaces: ["maintainer_economics"],
            events: Array.from({ length: 100 }, (_, index) => driftEvent(`owner/repo-${String(index).padStart(3, "0")}`)),
          },
        },
      }),
    );

    const status = await loadUpstreamStatus(env);
    expect(status.registryHyperparameterDrift.affectedRepoCount).toBe(150);
  });

  it("builds low-severity source drift reports from legacy or partial ruleset payloads", async () => {
    const previous = {
      ...ruleset("legacy-previous", "legacy-previous-hash", "pending_saturation_model", 1, 0.01, "2026-05-30T00:00:00.000Z"),
      commitSha: null,
      payload: {},
    } as UpstreamRulesetSnapshotRecord;
    const current = {
      ...ruleset("legacy-current", "legacy-current-hash", "pending_saturation_model", 1, 0.01, "2026-05-30T00:05:00.000Z"),
      commitSha: null,
      payload: {},
    } as UpstreamRulesetSnapshotRecord;

    await expect(buildUpstreamDriftReport(current, previous)).resolves.toMatchObject({
      severity: "low",
      affectedAreas: ["source"],
      payload: {
        current: { commitSha: null },
        previous: { commitSha: null },
      },
    });
  });

  it("reports stale and unavailable upstream status without crashing readiness callers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-30T04:00:00.000Z"));
    const unavailableEnv = createTestEnv();
    await expect(loadUpstreamStatus(unavailableEnv)).resolves.toMatchObject({ status: "unavailable", latestRulesetId: null });

    const staleEnv = createTestEnv();
    await persistUpstreamRulesetSnapshot(staleEnv, ruleset("stale", "stale-hash", "pending_saturation_model", 1, 0.01, "2026-05-30T00:00:00.000Z"));
    await expect(loadUpstreamStatus(staleEnv)).resolves.toMatchObject({ status: "stale", latestRulesetId: "stale" });
  });

  it("deduplicates unchanged semantic drift fingerprints and leaves issue filing disabled by default", async () => {
    const env = createTestEnv();
    const previous = ruleset("ruleset-old", "old-hash", "current_density_model", 1, 0.01, "2026-05-30T00:00:00.000Z");
    const current = ruleset("ruleset-new", "new-hash", "pending_saturation_model", 2, 0.02, "2026-05-30T00:05:00.000Z");
    const report = await buildUpstreamDriftReport(current, previous);
    expect(report).toMatchObject({ severity: "high", affectedAreas: expect.arrayContaining(["registry", "scoring_model"]) });

    await upsertUpstreamDriftReport(env, report!);
    await upsertUpstreamDriftReport(env, { ...report!, summary: "same fingerprint, updated summary", updatedAt: "2026-05-30T00:10:00.000Z" });

    await expect(listUpstreamDriftReports(env)).resolves.toEqual([expect.objectContaining({ summary: "same fingerprint, updated summary" })]);
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "disabled", created: 0, updated: 0, skipped: 0 });
  });

  it("files or reuses upstream drift issues only when explicitly enabled", async () => {
    const missingTokenEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true" });
    await expect(fileUpstreamDriftIssues(missingTokenEnv)).resolves.toMatchObject({ status: "skipped", reason: "missing_issue_token" });

    const invalidRepoEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token", GITTENSORY_DRIFT_ISSUE_REPO: "bad-repo-name" });
    await upsertUpstreamDriftReport(invalidRepoEnv, driftReport("invalid-repo"));
    await expect(fileUpstreamDriftIssues(invalidRepoEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });

    const createEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(createEnv, driftReport("create-fingerprint"));
    vi.stubGlobal("fetch", githubIssueFetch({ create: { number: 77, url: "https://github.com/JSONbored/gittensory/issues/77" } }));
    await expect(fileUpstreamDriftIssues(createEnv)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, skipped: 0 });
    await expect(listUpstreamDriftReports(createEnv)).resolves.toEqual([expect.objectContaining({ issueNumber: 77 })]);

    const updateEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "yes", GITTENSORY_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(updateEnv, driftReport("existing-fingerprint"));
    const updateCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      githubIssueFetch({
        existing: { number: 88, url: "https://github.com/JSONbored/gittensory/issues/88", fingerprint: "existing-fingerprint" },
        update: { number: 88, url: "https://github.com/JSONbored/gittensory/issues/88" },
        calls: updateCalls,
      }),
    );
    await expect(fileUpstreamDriftIssues(updateEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 1, skipped: 0 });
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", url: "https://api.github.com/repos/JSONbored/gittensory/issues?state=open&labels=signals&per_page=50" }),
        expect.objectContaining({ method: "PATCH", url: "https://api.github.com/repos/JSONbored/gittensory/issues/88" }),
      ]),
    );
    const updateBody = updateCalls.find((call) => call.method === "PATCH")?.body;
    expect(updateBody).toMatchObject({
      title: "chore(upstream): reconcile Gittensor drift existing",
      labels: ["signals", "scoring", "data", "high-impact"],
      assignees: ["jsonbored"],
    });
    expect(String(updateBody?.body)).toContain("<!-- gittensory-upstream-drift:existing-fingerprint -->");
    expect(String(updateBody?.body)).toContain("## Suggested Tests");
    expect(String(updateBody?.body)).toContain("gittensor/constants.py");
    expect(String(updateBody?.body)).not.toMatch(/wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i);

    const failingEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "on", GITHUB_PUBLIC_TOKEN: "token" });
    await upsertUpstreamDriftReport(failingEnv, driftReport("failing-fingerprint"));
    vi.stubGlobal("fetch", githubIssueFetch({ createStatus: 500, listStatus: 500 }));
    await expect(fileUpstreamDriftIssues(failingEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });
  });

  it("handles edge cases while filing upstream drift issues", async () => {
    const defaultRepoEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "1", GITTENSORY_DRIFT_ISSUE_TOKEN: "token", GITTENSORY_DRIFT_ISSUE_REPO: "" });
    await upsertUpstreamDriftReport(defaultRepoEnv, driftReport("source-fingerprint", { severity: "medium", affectedAreas: [] }));
    vi.stubGlobal("fetch", githubIssueFetch({ create: { number: 91, url: "https://github.com/JSONbored/gittensory/issues/91" } }));
    await expect(fileUpstreamDriftIssues(defaultRepoEnv)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, skipped: 0 });

    const areaSourceEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(
      areaSourceEnv,
      driftReport("area-source-paths", { severity: "medium", affectedAreas: ["registry", "issue_discovery", "mirror_linkage", "language_weights"] }),
    );
    const areaSourceCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal("fetch", githubIssueFetch({ create: { number: 95, url: "https://github.com/JSONbored/gittensory/issues/95" }, calls: areaSourceCalls }));
    await expect(fileUpstreamDriftIssues(areaSourceEnv)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, skipped: 0 });
    const areaSourceBody = String(areaSourceCalls.find((call) => call.method === "POST")?.body?.body);
    expect(areaSourceBody).toContain("gittensor/validator/weights/master_repositories.json");
    expect(areaSourceBody).toContain("gittensor/validator/issue_discovery/scan.py");
    expect(areaSourceBody).toContain("gittensor/utils/mirror/models.py");
    expect(areaSourceBody).toContain("gittensor/validator/weights/programming_languages.json");

    const missingPayloadEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(missingPayloadEnv, driftReport("missing-payload", { currentRulesetId: null, previousRulesetId: null }));
    vi.stubGlobal("fetch", githubIssueFetch({ createPayload: {} }));
    await expect(fileUpstreamDriftIssues(missingPayloadEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });

    const throwingListEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(throwingListEnv, driftReport("throwing-list"));
    vi.stubGlobal("fetch", githubIssueFetch({ throwOnList: true, create: { number: 92, url: "https://github.com/JSONbored/gittensory/issues/92" } }));
    await expect(fileUpstreamDriftIssues(throwingListEnv)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, skipped: 0 });

    const linkedEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(linkedEnv, driftReport("linked-fingerprint", { issueNumber: 93, issueUrl: "https://github.com/JSONbored/gittensory/issues/93" }));
    const linkedCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      githubIssueFetch({
        issue: { number: 93, url: "https://github.com/JSONbored/gittensory/issues/93", fingerprint: "linked-fingerprint" },
        update: { number: 93, url: "https://github.com/JSONbored/gittensory/issues/93" },
        calls: linkedCalls,
      }),
    );
    await expect(fileUpstreamDriftIssues(linkedEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 1, skipped: 0 });
    expect(linkedCalls).toEqual([
      expect.objectContaining({ method: "GET", url: "https://api.github.com/repos/JSONbored/gittensory/issues/93" }),
      expect.objectContaining({ method: "PATCH", url: "https://api.github.com/repos/JSONbored/gittensory/issues/93" }),
    ]);

    const objectLabelLinkedEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(objectLabelLinkedEnv, driftReport("object-label-linked", { issueNumber: 129, issueUrl: "https://github.com/JSONbored/gittensory/issues/129" }));
    vi.stubGlobal(
      "fetch",
      githubIssueFetch({
        issue: { number: 129, url: "https://github.com/JSONbored/gittensory/issues/129", fingerprint: "object-label-linked", labels: [{ name: "signals" }] },
        update: { number: 129, url: "https://github.com/JSONbored/gittensory/issues/129" },
      }),
    );
    await expect(fileUpstreamDriftIssues(objectLabelLinkedEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 1, skipped: 0 });

    const staleLinkedEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token", GITTENSORY_DRIFT_ISSUE_REPO: "victim/current-repo" });
    await upsertUpstreamDriftReport(staleLinkedEnv, driftReport("stale-linked", { issueNumber: 123, issueUrl: "https://github.com/other-owner/old-repo/issues/123" }));
    const staleLinkedCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal("fetch", githubIssueFetch({ create: { number: 124, url: "https://github.com/victim/current-repo/issues/124" }, calls: staleLinkedCalls }));
    await expect(fileUpstreamDriftIssues(staleLinkedEnv)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, skipped: 0 });
    expect(staleLinkedCalls).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ method: "PATCH", url: "https://api.github.com/repos/victim/current-repo/issues/123" })]),
    );

    const invalidLinkedEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(invalidLinkedEnv, driftReport("invalid-linked", { issueNumber: 125, issueUrl: "not a github issue url" }));
    const invalidLinkedCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal("fetch", githubIssueFetch({ create: { number: 126, url: "https://github.com/JSONbored/gittensory/issues/126" }, calls: invalidLinkedCalls }));
    await expect(fileUpstreamDriftIssues(invalidLinkedEnv)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, skipped: 0 });
    expect(invalidLinkedCalls).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ method: "PATCH", url: "https://api.github.com/repos/JSONbored/gittensory/issues/125" })]),
    );

    const throwingLinkedEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(throwingLinkedEnv, driftReport("throwing-linked", { issueNumber: 127, issueUrl: "https://github.com/JSONbored/gittensory/issues/127" }));
    const throwingLinkedCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal("fetch", githubIssueFetch({ throwOnIssueGet: true, create: { number: 128, url: "https://github.com/JSONbored/gittensory/issues/128" }, calls: throwingLinkedCalls }));
    await expect(fileUpstreamDriftIssues(throwingLinkedEnv)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, skipped: 0 });
    expect(throwingLinkedCalls).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ method: "PATCH", url: "https://api.github.com/repos/JSONbored/gittensory/issues/127" })]),
    );

    for (const scenario of [
      { fingerprint: "wrong-host-linked", issueNumber: 130, issueUrl: "https://example.com/JSONbored/gittensory/issues/130" },
      { fingerprint: "wrong-path-linked", issueNumber: 131, issueUrl: "https://github.com/JSONbored/gittensory/pull/131" },
      { fingerprint: "lookup-status-linked", issueNumber: 132, issueUrl: "https://github.com/JSONbored/gittensory/issues/132", issueStatus: 500 },
      { fingerprint: "wrong-number-linked", issueNumber: 133, issueUrl: "https://github.com/JSONbored/gittensory/issues/133", issue: { number: 134, url: "https://github.com/JSONbored/gittensory/issues/133", fingerprint: "wrong-number-linked" } },
      { fingerprint: "closed-linked", issueNumber: 135, issueUrl: "https://github.com/JSONbored/gittensory/issues/135", issue: { number: 135, url: "https://github.com/JSONbored/gittensory/issues/135", fingerprint: "closed-linked", state: "closed" } },
      { fingerprint: "missing-body-linked", issueNumber: 136, issueUrl: "https://github.com/JSONbored/gittensory/issues/136", issue: { number: 136, url: "https://github.com/JSONbored/gittensory/issues/136", fingerprint: "missing-body-linked", body: null } },
      { fingerprint: "missing-label-linked", issueNumber: 137, issueUrl: "https://github.com/JSONbored/gittensory/issues/137", issue: { number: 137, url: "https://github.com/JSONbored/gittensory/issues/137", fingerprint: "missing-label-linked", labels: [{ name: "triage" }] } },
      { fingerprint: "returned-url-linked", issueNumber: 138, issueUrl: "https://github.com/JSONbored/gittensory/issues/138", issue: { number: 138, url: "https://github.com/other/repo/issues/138", fingerprint: "returned-url-linked" } },
    ]) {
      const rejectedLinkedEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token" });
      await upsertUpstreamDriftReport(rejectedLinkedEnv, driftReport(scenario.fingerprint, { issueNumber: scenario.issueNumber, issueUrl: scenario.issueUrl }));
      const rejectedLinkedCalls: GitHubIssueFetchCall[] = [];
      vi.stubGlobal(
        "fetch",
        githubIssueFetch({
          issue: scenario.issue ?? { number: scenario.issueNumber, url: scenario.issueUrl, fingerprint: scenario.fingerprint },
          issueStatus: scenario.issueStatus,
          create: { number: scenario.issueNumber + 100, url: `https://github.com/JSONbored/gittensory/issues/${scenario.issueNumber + 100}` },
          calls: rejectedLinkedCalls,
        }),
      );
      await expect(fileUpstreamDriftIssues(rejectedLinkedEnv)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, skipped: 0 });
      expect(rejectedLinkedCalls).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ method: "PATCH", url: `https://api.github.com/repos/JSONbored/gittensory/issues/${scenario.issueNumber}` })]),
      );
    }

    const failingLinkedEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(failingLinkedEnv, driftReport("failing-linked", { issueNumber: 94, issueUrl: "https://github.com/JSONbored/gittensory/issues/94" }));
    vi.stubGlobal("fetch", githubIssueFetch({ issue: { number: 94, url: "https://github.com/JSONbored/gittensory/issues/94", fingerprint: "failing-linked" }, updateStatus: 500 }));
    await expect(fileUpstreamDriftIssues(failingLinkedEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });

    const missingUpdatePayloadEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(missingUpdatePayloadEnv, driftReport("missing-update-payload", { issueNumber: 96, issueUrl: "https://github.com/JSONbored/gittensory/issues/96" }));
    vi.stubGlobal("fetch", githubIssueFetch({ issue: { number: 96, url: "https://github.com/JSONbored/gittensory/issues/96", fingerprint: "missing-update-payload" }, updatePayload: {} }));
    await expect(fileUpstreamDriftIssues(missingUpdatePayloadEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });

    const disabledEnv = createTestEnv();
    delete (disabledEnv as Partial<Env>).GITTENSORY_AUTO_FILE_DRIFT_ISSUES;
    await expect(fileUpstreamDriftIssues(disabledEnv)).resolves.toMatchObject({ status: "disabled" });
  });

  it("publishes null report references in upstream status safely", async () => {
    const env = createTestEnv();
    await persistUpstreamRulesetSnapshot(env, ruleset("current", "current-hash", "pending_saturation_model", 1, 0.01, new Date().toISOString()));
    await upsertUpstreamDriftReport(env, driftReport("null-references", { currentRulesetId: null, previousRulesetId: null, issueNumber: null, issueUrl: null }));
    await upsertUpstreamDriftReport(env, driftReport("medium-references", { severity: "medium", affectedAreas: ["registry"] }));

    await expect(loadUpstreamStatus(env)).resolves.toMatchObject({
      status: "drift_detected",
      highestSeverity: "high",
      reports: expect.arrayContaining([expect.objectContaining({ currentRulesetId: null, previousRulesetId: null, issueNumber: null, issueUrl: null })]),
    });
  });

  it("includes upstream source metadata and recommended follow-up modules in drift reports", async () => {
    const previous = ruleset("ruleset-old", "old-hash", "current_density_model", 1, 0.01, "2026-05-30T00:00:00.000Z");
    const current = ruleset("ruleset-new", "new-hash", "pending_saturation_model", 2, 0.02, "2026-05-30T00:05:00.000Z");
    const report = await buildUpstreamDriftReport(current, previous);

    expect(report).toMatchObject({
      payload: {
        source: { repo: "entrius/gittensor", ref: "test", commitSha: "ruleset-new-commit" },
        recommendedFollowUp: expect.arrayContaining(["src/scoring/model.ts", "src/upstream/ruleset.ts", "src/registry/normalize.ts"]),
      },
    });

    const env = createTestEnv();
    await persistUpstreamRulesetSnapshot(env, previous);
    await persistUpstreamRulesetSnapshot(env, current);
    await upsertUpstreamDriftReport(env, report!);

    const status = await loadUpstreamStatus(env);
    const publicReport = status.reports.find((entry) => entry.fingerprint === report!.fingerprint);
    expect(publicReport).toMatchObject({
      source: { repo: "entrius/gittensor", ref: "test", commitSha: "ruleset-new-commit" },
      recommendedFollowUp: expect.arrayContaining(["src/upstream/ruleset.ts"]),
    });
    expect(JSON.stringify(publicReport)).not.toMatch(/wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i);
  });

  it("computes a deterministic drift fingerprint for a known ruleset pair", async () => {
    const previous = ruleset("fingerprint-previous", "semantic-previous", "pending_saturation_model", 1, 0.01, "2026-05-30T00:00:00.000Z");
    const current = withPayload(previous, "fingerprint-current", {
      scoring: { activeModel: "pending_saturation_model", constants: { SRC_TOK_SATURATION_SCALE: 99 }, semanticFlags: {} },
    });

    const report = await buildUpstreamDriftReport(current, previous);
    expect(report?.fingerprint).toBe("362f9fd9666e8e8629b28cf8214b05dafb7bef7d5d72c75b80162e019052a42f");
  });

  it("records secret-safe upstream drift audit metadata without raw source payloads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-30T00:00:00.000Z"));
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "token" });
    const auditEvents: Array<Record<string, unknown>> = [];
    vi.spyOn(repositories, "recordAuditEvent").mockImplementation(async (_env, event) => {
      auditEvents.push({ eventType: event.eventType, detail: event.detail, metadata: event.metadata ?? {} });
    });
    vi.stubGlobal("fetch", upstreamFetch(fixtures("58", 0.01)));
    await refreshUpstreamDrift(env);

    vi.setSystemTime(new Date("2026-05-30T00:10:00.000Z"));
    vi.stubGlobal("fetch", upstreamFetch(fixtures("99", 0.02)));
    await refreshUpstreamDrift(env);

    const serialized = JSON.stringify(auditEvents);
    expect(auditEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["upstream.sources_refreshed", "upstream.ruleset_built", "upstream.drift_detected"]),
    );
    expect(auditEvents.filter((event) => event.eventType === "upstream.drift_detected")).toHaveLength(2);
    expect(serialized).not.toMatch(/SRC_TOK_SATURATION_SCALE|master_repositories\.json|wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i);
    expect(serialized).not.toContain("OSS_EMISSION_SHARE");
  });
});

function fixtures(scale: string, emissionShare: number): Record<string, string> {
  return {
    "gittensor/constants.py": [
      "OSS_EMISSION_SHARE = 0.90",
      "MAX_CODE_DENSITY_MULTIPLIER = 1.15",
      `SRC_TOK_SATURATION_SCALE = ${scale}`,
    ].join("\n"),
    "gittensor/validator/weights/master_repositories.json": JSON.stringify({
      "JSONbored/gittensory": {
        emission_share: emissionShare,
        issue_discovery_share: 0,
        maintainer_cut: 0.3,
        label_multipliers: { feature: 1.5 },
        trusted_label_pipeline: true,
      },
    }),
    "gittensor/validator/weights/programming_languages.json": JSON.stringify({ TypeScript: 1, Python: 0.8 }),
    "gittensor/validator/oss_contributions/mirror/scoring.py": "score = 1 - exp(-src / SRC_TOK_SATURATION_SCALE)\nsolved_by_pr = True\n",
    "gittensor/validator/issue_discovery/scan.py": "branch eligibility is required for solving branches\n",
    "gittensor/utils/mirror/models.py": "solved_by_pr: int\n",
  };
}

function fixturesWithoutOptionalRegistryFields(scale: string, emissionShare: number): Record<string, string> {
  const payload = fixtures(scale, emissionShare);
  payload["gittensor/validator/weights/master_repositories.json"] = JSON.stringify({
    "JSONbored/gittensory": {
      emission_share: emissionShare,
      issue_discovery_share: 0,
      maintainer_cut: 0.3,
      label_multipliers: { feature: 1.5 },
    },
  });
  return payload;
}

function invalidJsonFixtures(scale: string): Record<string, string> {
  const payload = fixtures(scale, 0.01);
  payload["gittensor/validator/weights/master_repositories.json"] = "{not-json";
  payload["gittensor/validator/weights/programming_languages.json"] = "{not-json";
  return payload;
}

// Two complementary repos with PARTIAL per-repo time-decay overrides: each field is present in exactly one
// repo and absent in the other, so compaction exercises both the present and the absent (-> null) path of
// every time-decay field.
function fixturesWithPartialTimeDecay(scale: string, emissionShare: number): Record<string, string> {
  const payload = fixtures(scale, emissionShare);
  payload["gittensor/validator/weights/master_repositories.json"] = JSON.stringify({
    "owner/decay-a": { emission_share: emissionShare, issue_discovery_share: 0, maintainer_cut: 0.3, scoring: { time_decay: { grace_period_hours: 24, sigmoid_steepness: 0.4 } } },
    "owner/decay-b": { emission_share: emissionShare, issue_discovery_share: 0, maintainer_cut: 0.3, scoring: { time_decay: { sigmoid_midpoint_days: 5, min_multiplier: 0.05 } } },
  });
  return payload;
}

function upstreamFetch(files: Record<string, string>, options: { etag?: string } = {}) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = input.toString();
    if (url.includes("/commits/")) return Response.json({ sha: `commit-${scaleFrom(files)}` });
    const path = Object.keys(files).find((candidate) => url.includes(`/contents/${candidate}`));
    if (!path) return new Response("not found", { status: 404 });
    return Response.json({
      content: Buffer.from(files[path]!, "utf8").toString("base64"),
      encoding: "base64",
      sha: `blob-${path}-${scaleFrom(files)}`,
      download_url: `https://raw.githubusercontent.com/entrius/gittensor/test/${path}`,
    }, options.etag ? { headers: { etag: options.etag } } : undefined);
  };
}

function upstreamNoCommitShaFetch(files: Record<string, string>) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = input.toString();
    if (url.includes("/commits/")) return Response.json({});
    const path = Object.keys(files).find((candidate) => url.includes(`/contents/${candidate}`));
    if (!path) return new Response("not found", { status: 404 });
    return Response.json({
      content: Buffer.from(files[path]!, "utf8").toString("base64"),
      encoding: "base64",
      sha: `blob-${path}-${scaleFrom(files)}`,
      download_url: null,
    });
  };
}

function upstreamRawFallbackFetch(files: Record<string, string>) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = input.toString();
    if (url.includes("api.github.com")) return new Response("server error", { status: 500 });
    const path = Object.keys(files).find((candidate) => url.endsWith(candidate));
    return path ? new Response(files[path]) : new Response("not found", { status: 404 });
  };
}

function upstreamNotModifiedFetch(commitSha: string) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = input.toString();
    if (url.includes("/commits/")) return Response.json({ sha: commitSha });
    if (url.includes("/contents/")) return new Response(null, { status: 304 });
    return new Response("not found", { status: 404 });
  };
}

function upstreamNotModifiedNoCommitFetch() {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = input.toString();
    if (url.includes("/commits/")) return new Response("missing commit", { status: 404 });
    if (url.includes("/contents/")) return new Response(null, { status: 304 });
    return new Response("not found", { status: 404 });
  };
}

function upstreamFailedFetch() {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = input.toString();
    if (url.includes("/commits/")) throw new Error("commit lookup failed");
    if (url.includes("/contents/")) return Response.json({ encoding: "base64" });
    return new Response("missing", { status: 404, statusText: "Missing" });
  };
}

type GitHubIssueFetchCall = {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
};

function githubIssueFetch(options: {
  existing?: { number: number; url: string; fingerprint: string };
  create?: { number: number; url: string };
  createPayload?: Record<string, unknown>;
  update?: { number: number; url: string };
  issue?: { number: number; url: string; fingerprint: string; state?: string; labels?: Array<string | { name?: string }>; body?: string | null };
  updatePayload?: Record<string, unknown>;
  issueStatus?: number | undefined;
  listStatus?: number;
  createStatus?: number;
  updateStatus?: number;
  throwOnList?: boolean;
  throwOnIssueGet?: boolean;
  calls?: GitHubIssueFetchCall[];
}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    options.calls?.push({
      url,
      method,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    if (url.endsWith("/issues?state=open&labels=signals&per_page=50")) {
      if (options.throwOnList) throw new Error("list failed");
      if (options.listStatus) return new Response("list failed", { status: options.listStatus });
      return Response.json(
        options.existing
          ? [{ number: options.existing.number, html_url: options.existing.url, body: `<!-- gittensory-upstream-drift:${options.existing.fingerprint} -->` }]
          : [],
      );
    }
    const issueMatch = url.match(/\/issues\/(\d+)$/);
    if (issueMatch && method === "GET") {
      if (options.throwOnIssueGet) throw new Error("issue lookup failed");
      if (options.issueStatus) return new Response("issue lookup failed", { status: options.issueStatus });
      if (!options.issue || options.issue.number !== Number(issueMatch[1])) return new Response("not found", { status: 404 });
      return Response.json({
        number: options.issue.number,
        html_url: options.issue.url,
        state: options.issue.state ?? "open",
        body: options.issue.body === undefined ? `<!-- gittensory-upstream-drift:${options.issue.fingerprint} -->` : options.issue.body,
        labels: options.issue.labels ?? ["signals"],
      });
    }
    if (issueMatch && method === "PATCH") {
      if (options.updateStatus) return new Response("update failed", { status: options.updateStatus });
      if (options.updatePayload) return Response.json(options.updatePayload);
      const number = options.update?.number ?? Number(issueMatch[1]);
      return Response.json({ number, html_url: options.update?.url ?? `https://github.com/JSONbored/gittensory/issues/${number}` });
    }
    if (url.endsWith("/issues") && method === "POST") {
      if (options.createStatus) return new Response("create failed", { status: options.createStatus });
      if (options.createPayload) return Response.json(options.createPayload);
      return Response.json({ number: options.create?.number ?? 99, html_url: options.create?.url ?? "https://github.com/JSONbored/gittensory/issues/99" });
    }
    return new Response("not found", { status: 404 });
  };
}

function scaleFrom(files: Record<string, string>): string {
  return files["gittensor/constants.py"]?.match(/SRC_TOK_SATURATION_SCALE\s*=\s*(\d+)/)?.[1] ?? "unknown";
}

function ruleset(
  id: string,
  semanticHash: string,
  activeModel: UpstreamRulesetSnapshotRecord["activeModel"],
  registryRepoCount: number,
  totalEmissionShare: number,
  generatedAt: string,
): UpstreamRulesetSnapshotRecord {
  return {
    id,
    sourceRepo: "entrius/gittensor",
    sourceRef: "test",
    commitSha: `${id}-commit`,
    sourceSnapshotIds: [],
    activeModel,
    registryRepoCount,
    totalEmissionShare,
    semanticHash,
    payload: {
      registry: {
        repoCount: registryRepoCount,
        totalEmissionShare,
        repositories: [
          {
            repo: "JSONbored/gittensory",
            emissionShare: totalEmissionShare,
            issueDiscoveryShare: 0,
            maintainerCut: 0.3,
            labelMultipliers: { feature: 1.5 },
            trustedLabelPipeline: true,
            defaultLabelMultiplier: null,
            fixedBaseScore: null,
            eligibilityMode: null,
          },
        ],
      },
      scoring: { activeModel, constants: { SRC_TOK_SATURATION_SCALE: activeModel === "pending_saturation_model" ? 58 : 0 }, semanticFlags: {} },
      issueDiscovery: { branchEligibilityRequired: false },
      mirrorLinkage: { solvedByPrRequired: false },
      languageWeights: { count: 1, weights: { TypeScript: 1 }, contentHash: "language-hash" },
      sourceSnapshots: [],
    },
    warnings: [],
    generatedAt,
  };
}

function sourceSnapshot(sourceKey: UpstreamSourceSnapshotRecord["sourceKey"], parsed: Record<string, unknown>, warnings: string[] = []): UpstreamSourceSnapshotRecord {
  return {
    id: `source-${sourceKey}`,
    sourceKey,
    sourceRepo: "entrius/gittensor",
    sourceRef: "test",
    path: `${sourceKey}.fixture`,
    sourceUrl: `https://example.test/${sourceKey}`,
    commitSha: "commit-manual",
    contentSha256: `sha-${sourceKey}`,
    status: "fetched",
    parsed: parsed as UpstreamSourceSnapshotRecord["parsed"],
    warnings,
    payload: { sourceBytes: 1 },
    fetchedAt: "2026-05-30T00:00:00.000Z",
  };
}

function rulesetPayload(snapshot: UpstreamRulesetSnapshotRecord): NonNullable<UpstreamRulesetSnapshotRecord["payload"]> {
  return snapshot.payload;
}

function rulesetRegistry(snapshot: UpstreamRulesetSnapshotRecord): {
  repoCount: number;
  totalEmissionShare: number;
  repositories: Array<{
    repo: string;
    emissionShare: number;
    issueDiscoveryShare: number;
    maintainerCut: number;
    labelMultipliers: Record<string, number>;
    trustedLabelPipeline: boolean | null;
    defaultLabelMultiplier: number | null;
    fixedBaseScore: number | null;
    eligibilityMode: string | null;
    timeDecay: { gracePeriodHours?: number | null; sigmoidMidpointDays?: number | null; sigmoidSteepness?: number | null; minMultiplier?: number | null } | null;
  }>;
} {
  return rulesetPayload(snapshot).registry as ReturnType<typeof rulesetRegistry>;
}

type TestRulesetRegistryRepo = ReturnType<typeof rulesetRegistry>["repositories"][number];

function registryRepo(repo: string, overrides: Partial<TestRulesetRegistryRepo> = {}): TestRulesetRegistryRepo {
  return {
    repo,
    emissionShare: 0.01,
    issueDiscoveryShare: 0,
    maintainerCut: 0.3,
    labelMultipliers: { feature: 1.5 },
    trustedLabelPipeline: true,
    defaultLabelMultiplier: null,
    fixedBaseScore: null,
    eligibilityMode: null,
    timeDecay: null,
    ...overrides,
  };
}

function rulesetWithRegistry(id: string, repositories: TestRulesetRegistryRepo[]): UpstreamRulesetSnapshotRecord {
  const totalEmissionShare = repositories.reduce((sum, repo) => sum + repo.emissionShare, 0);
  const base = ruleset(id, `${id}-hash`, "pending_saturation_model", repositories.length, totalEmissionShare, "2026-05-30T00:00:00.000Z");
  return withPayload(base, id, {
    registry: {
      repoCount: repositories.length,
      totalEmissionShare,
      repositories,
    },
  });
}

type RegistryDriftPayload = {
  totalEvents: number;
  omittedEvents: number;
  highImpactCount: number;
  affectedRepoCount: number;
  affectedFields: string[];
  affectedSurfaces: string[];
  events: Array<{ repoFullName: string; field: string; severity: string; affectedSurfaces: string[]; summary: string }>;
};

function registryDriftPayload(report: UpstreamDriftReportRecord): RegistryDriftPayload {
  return report.payload.registryHyperparameterDrift as unknown as RegistryDriftPayload;
}

function withPayload(
  base: UpstreamRulesetSnapshotRecord,
  id: string,
  patch: Record<string, unknown>,
): UpstreamRulesetSnapshotRecord {
  return {
    ...base,
    id,
    semanticHash: `${id}-hash`,
    payload: {
      ...base.payload,
      ...patch,
    } as UpstreamRulesetSnapshotRecord["payload"],
  };
}

function driftReport(
  fingerprint: string,
  overrides: Partial<Pick<UpstreamDriftReportRecord, "severity" | "affectedAreas" | "summary" | "previousRulesetId" | "currentRulesetId" | "issueNumber" | "issueUrl" | "payload">> = {},
): UpstreamDriftReportRecord {
  return {
    id: `report-${fingerprint}`,
    fingerprint,
    severity: overrides.severity ?? "high",
    status: "open",
    summary: overrides.summary ?? "scoring constants changed",
    affectedAreas: overrides.affectedAreas ?? ["scoring_model"],
    previousRulesetId: overrides.previousRulesetId === undefined ? "previous" : overrides.previousRulesetId,
    currentRulesetId: overrides.currentRulesetId === undefined ? "current" : overrides.currentRulesetId,
    issueNumber: overrides.issueNumber,
    issueUrl: overrides.issueUrl,
    payload: overrides.payload ?? { changes: ["scoring constants changed"] },
    generatedAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
  };
}
