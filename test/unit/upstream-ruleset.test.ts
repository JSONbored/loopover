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
  isAutoFileDriftIssuesEnabled,
  loadUpstreamStatus,
  registryHyperparameterDriftWarningsForRepo,
  refreshUpstreamDrift,
  refreshUpstreamSourceSnapshots,
  resolveAutoFileDriftIssuesManifestOverride,
  resolveDriftAssignees,
} from "../../src/upstream/ruleset";
import type { UpstreamDriftReportRecord, UpstreamRulesetSnapshotRecord, UpstreamSourceSnapshotRecord } from "../../src/types";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

// This whole describe block's fixtures hardcode "JSONbored/gittensory" GitHub issue URLs as their expected
// drift-issue target repo. createTestEnv()'s own default deliberately does NOT resolve to that (to avoid
// leaking the bundled self-repo manifest into unrelated tests elsewhere) -- pin it locally here instead so
// every fileUpstreamDriftIssues() call in this block keeps resolving against the same fixed repo its own
// GET/PATCH mocks expect. An explicit per-call override (e.g. a deliberately invalid repo) still wins.
function driftEnv(overrides: Partial<Env> = {}): Env {
  return createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: "JSONbored/gittensory", ...overrides });
}

describe("upstream ruleset drift tracking", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("builds a versioned ruleset from GitHub contents snapshots", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-30T00:00:00.000Z"));
    const env = driftEnv({ GITHUB_PUBLIC_TOKEN: "token" });
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
    const env = driftEnv({ GITHUB_PUBLIC_TOKEN: "token" });
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

  it("skips unmodeled-constant drift sync when the constants source fetch failed", async () => {
    const env = driftEnv();
    vi.stubGlobal("fetch", upstreamFetch(fixtures("58", 0.01)));
    await refreshUpstreamSourceSnapshots(env);

    vi.stubGlobal("fetch", upstreamFailedFetch());
    const result = await refreshUpstreamDrift(env);

    expect(result.sources.find((source) => source.sourceKey === "constants")?.status).toBe("error");
    expect((await listUpstreamDriftReports(env, 10)).some((report) => report.payload.kind === "unmodeled_scoring_constants")).toBe(false);
  });

  it("detects high-severity scoring and registry drift between semantic rulesets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = driftEnv({ GITHUB_PUBLIC_TOKEN: "token" });

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
    const env = driftEnv();
    vi.stubGlobal("fetch", upstreamRawFallbackFetch(fixtures("58", 0.01)));

    const sources = await refreshUpstreamSourceSnapshots(env);
    const stored = await listLatestUpstreamSourceSnapshotsByKey(env);

    expect(sources.map((source) => source.status)).toEqual(Array(6).fill("fallback"));
    expect(sources.flatMap((source) => source.warnings)).toEqual(expect.arrayContaining([expect.stringContaining("raw fallback used")]));
    expect(stored).toHaveLength(6);
  });

  it("degrades a single hung/timed-out source to an error snapshot without blocking its siblings (#9165)", async () => {
    // The raw-GitHub fallback used to be the only fetch in ruleset.ts with no timeout: a stalled
    // raw.githubusercontent.com connection hung the entire scheduled refresh. This simulates exactly that --
    // the registry source's contents-API read fails (forcing the fallback) and its fallback fetch rejects the
    // way AbortSignal.timeout does -- and asserts the fan-out still completes: the registry source degrades to
    // an "error" snapshot instead of the whole Promise.all hanging, and every other source is unaffected.
    const env = driftEnv({ GITHUB_PUBLIC_TOKEN: "token" });
    const files = fixtures("58", 0.01);
    const failingPath = "gittensor/validator/weights/master_repositories.json";
    vi.stubGlobal("fetch", upstreamPartialTimeoutFetch(files, failingPath));

    const sources = await refreshUpstreamSourceSnapshots(env);
    const byKey = new Map(sources.map((source) => [source.sourceKey, source]));

    expect(byKey.get("registry")?.status).toBe("error");
    expect(byKey.get("registry")?.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Raw fallback failed")]));
    for (const key of ["constants", "programming_languages", "mirror_scoring", "issue_discovery_scan", "mirror_models"]) {
      expect(byKey.get(key)?.status).toBe("fetched");
    }
  });

  it("reuses previous snapshots on not-modified responses", async () => {
    const env = driftEnv({ GITHUB_PUBLIC_TOKEN: "token" });
    vi.stubGlobal("fetch", upstreamFetch(fixtures("58", 0.01), { etag: "\"etag-58\"" }));
    await refreshUpstreamSourceSnapshots(env);

    vi.stubGlobal("fetch", upstreamNotModifiedFetch("commit-58"));
    const sources = await refreshUpstreamSourceSnapshots(env);

    expect(sources.map((source) => source.status)).toEqual(Array(6).fill("not_modified"));
    expect(sources.every((source) => typeof source.payload.previousSnapshotId === "string")).toBe(true);
  });

  it("preserves previous parsed payloads when both GitHub contents and raw fallback fail", async () => {
    const env = driftEnv();
    vi.stubGlobal("fetch", upstreamFetch(fixtures("58", 0.01)));
    await refreshUpstreamSourceSnapshots(env);

    vi.stubGlobal("fetch", upstreamFailedFetch());
    const sources = await refreshUpstreamSourceSnapshots(env);

    expect(sources.map((source) => source.status)).toEqual(Array(6).fill("error"));
    expect(sources.flatMap((source) => source.warnings)).toEqual(expect.arrayContaining([expect.stringContaining("Raw fallback failed")]));
    expect(sources.find((source) => source.sourceKey === "constants")?.parsed).toEqual(expect.objectContaining({ activeModel: "pending_saturation_model" }));
  });

  it("returns empty parsed payloads when no previous source snapshot exists", async () => {
    const env = driftEnv();
    vi.stubGlobal("fetch", upstreamFailedFetch());

    const sources = await refreshUpstreamSourceSnapshots(env);

    expect(sources.map((source) => source.status)).toEqual(Array(6).fill("error"));
    expect(sources.every((source) => Object.keys(source.parsed).length === 0)).toBe(true);
    expect(sources.every((source) => source.payload.previousSnapshotId === null)).toBe(true);
  });

  it("keeps previous commit SHA when not-modified refresh cannot resolve a new commit", async () => {
    const env = driftEnv();
    vi.stubGlobal("fetch", upstreamFetch(fixtures("58", 0.01)));
    await refreshUpstreamSourceSnapshots(env);

    vi.stubGlobal("fetch", upstreamNotModifiedNoCommitFetch());
    const sources = await refreshUpstreamSourceSnapshots(env);

    expect(sources.map((source) => source.status)).toEqual(Array(6).fill("not_modified"));
    expect(sources.every((source) => source.commitSha === "commit-58")).toBe(true);
  });

  it("parses invalid upstream JSON as an empty semantic payload", async () => {
    const env = driftEnv();
    vi.stubGlobal("fetch", upstreamFetch(invalidJsonFixtures("58")));

    const sources = await refreshUpstreamSourceSnapshots(env);
    const registry = sources.find((source) => source.sourceKey === "registry");
    const languages = sources.find((source) => source.sourceKey === "programming_languages");

    expect(registry?.parsed).toMatchObject({ registry: { repoCount: 0, totalEmissionShare: 0, repositories: [] } });
    expect(languages?.parsed).toMatchObject({ weights: {}, count: 0 });
  });

  it("builds a ruleset from supplied source snapshots and surfaces source warnings", async () => {
    const env = driftEnv({ GITTENSOR_UPSTREAM_REPO: "", GITTENSOR_UPSTREAM_REF: "" });
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
    const env = driftEnv();

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

    const emptySnapshot = await buildUpstreamRulesetSnapshot(driftEnv(), []);
    expect(emptySnapshot).toMatchObject({
      commitSha: null,
      activeModel: "unknown",
      registryRepoCount: 0,
      totalEmissionShare: 0,
    });
    expect(emptySnapshot.payload).toMatchObject({ languageWeights: { count: 0 } });
  });

  it("normalizes stored ruleset registry repositories defensively", async () => {
    const snapshot = await buildUpstreamRulesetSnapshot(driftEnv(), [
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
    const env = driftEnv();
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
    const env = driftEnv();
    vi.stubGlobal("fetch", upstreamNoCommitShaFetch(fixturesWithPartialTimeDecay("58", 0.01)));

    await refreshUpstreamSourceSnapshots(env);
    const snapshot = await buildUpstreamRulesetSnapshot(env);

    const byRepo = Object.fromEntries(rulesetRegistry(snapshot).repositories.map((repo) => [repo.repo, repo.timeDecay]));
    expect(byRepo["owner/decay-a"]).toEqual({ gracePeriodHours: 24, sigmoidMidpointDays: null, sigmoidSteepness: 0.4, minMultiplier: null });
    expect(byRepo["owner/decay-b"]).toEqual({ gracePeriodHours: null, sigmoidMidpointDays: 5, sigmoidSteepness: null, minMultiplier: 0.05 });
  });

  it("records no drift when no ruleset exists and detects drift after two snapshots exist", async () => {
    const env = driftEnv();

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

    // (#1792) A casing-only registry rename with identical hyperparameters must NOT surface as add + remove.
    const casingPrevious = rulesetWithRegistry("casing-previous", [registryRepo("Owner/Repo")]);
    const casingCurrent = rulesetWithRegistry("casing-current", [registryRepo("owner/repo")]);
    const casingOnly = await buildUpstreamDriftReport(casingCurrent, casingPrevious);
    // No registry drift events at all → the report degrades to the source-only signal, not a registry membership change.
    expect(registryDriftPayload(casingOnly!).events).toEqual([]);
    expect(casingOnly!.payload.repoChanges).toEqual([]);
    expect(casingOnly!.affectedAreas).not.toContain("registry");

    // (#1792) A casing change that ALSO changes a hyperparameter still reports the field change (under the new
    // casing) and never a spurious repo add/remove.
    const fieldChangePrevious = rulesetWithRegistry("casing-field-previous", [registryRepo("Owner/Repo", { maintainerCut: 0.3 })]);
    const fieldChangeCurrent = rulesetWithRegistry("casing-field-current", [registryRepo("owner/repo", { maintainerCut: 0.5 })]);
    const casingWithFieldChange = await buildUpstreamDriftReport(fieldChangeCurrent, fieldChangePrevious);
    const fieldDrift = registryDriftPayload(casingWithFieldChange!);
    expect(fieldDrift.affectedFields).toEqual(["maintainerCut"]);
    expect(fieldDrift.events.map((event) => ({ repoFullName: event.repoFullName, field: event.field }))).toEqual([{ repoFullName: "owner/repo", field: "maintainerCut" }]);

    const env = driftEnv();
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
    const env = driftEnv();
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
    const env = driftEnv();
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
    const unavailableEnv = driftEnv();
    await expect(loadUpstreamStatus(unavailableEnv)).resolves.toMatchObject({ status: "unavailable", latestRulesetId: null });

    const staleEnv = driftEnv();
    await persistUpstreamRulesetSnapshot(staleEnv, ruleset("stale", "stale-hash", "pending_saturation_model", 1, 0.01, "2026-05-30T00:00:00.000Z"));
    await expect(loadUpstreamStatus(staleEnv)).resolves.toMatchObject({ status: "stale", latestRulesetId: "stale" });
  });

  it("treats an unparseable ruleset generatedAt as stale (fail-safe), not current", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-30T04:00:00.000Z"));
    // A malformed generatedAt would make Date.parse return NaN; pre-fix the staleness check silently
    // evaluated false and the status was reported as "current". Fail-safe direction is stale.
    const corruptEnv = driftEnv();
    await persistUpstreamRulesetSnapshot(corruptEnv, ruleset("corrupt", "corrupt-hash", "pending_saturation_model", 1, 0.01, "not-a-date"));
    await expect(loadUpstreamStatus(corruptEnv)).resolves.toMatchObject({
      status: "stale",
      latestRulesetId: "corrupt",
      latestRulesetGeneratedAt: "not-a-date",
    });
  });

  it("deduplicates unchanged semantic drift fingerprints and leaves issue filing disabled by default", async () => {
    const env = driftEnv();
    const previous = ruleset("ruleset-old", "old-hash", "current_density_model", 1, 0.01, "2026-05-30T00:00:00.000Z");
    const current = ruleset("ruleset-new", "new-hash", "pending_saturation_model", 2, 0.02, "2026-05-30T00:05:00.000Z");
    const report = await buildUpstreamDriftReport(current, previous);
    expect(report).toMatchObject({ severity: "high", affectedAreas: expect.arrayContaining(["registry", "scoring_model"]) });

    await upsertUpstreamDriftReport(env, report!);
    await upsertUpstreamDriftReport(env, { ...report!, summary: "same fingerprint, updated summary", updatedAt: "2026-05-30T00:10:00.000Z" });

    await expect(listUpstreamDriftReports(env)).resolves.toEqual([expect.objectContaining({ summary: "same fingerprint, updated summary" })]);
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "disabled", created: 0, updated: 0, skipped: 0 });
  });

  it("REGRESSION (#audit-rawfetch-pause): the global agent brake / freeze halts drift-issue filing (raw PAT writes outside the chokepoint)", async () => {
    // DB freeze arm: enabled + token + a real report, but a global freeze must skip ALL GitHub writes.
    const frozenEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(frozenEnv, driftReport("frozen-fingerprint"));
    await repositories.setGlobalAgentFrozen(frozenEnv, true);
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${String(input)}`);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    await expect(fileUpstreamDriftIssues(frozenEnv)).resolves.toMatchObject({ status: "paused", created: 0, updated: 0, skipped: 0 });
    expect(calls.some((c) => c.startsWith("POST") || c.startsWith("PATCH"))).toBe(false); // no GitHub issue write reached the network

    // env brake arm: AGENT_ACTIONS_PAUSED short-circuits before the DB freeze read.
    const pausedEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token", AGENT_ACTIONS_PAUSED: "true" });
    await upsertUpstreamDriftReport(pausedEnv, driftReport("paused-fingerprint"));
    await expect(fileUpstreamDriftIssues(pausedEnv)).resolves.toMatchObject({ status: "paused", created: 0, updated: 0, skipped: 0 });
  });

  it("files or reuses upstream drift issues only when explicitly enabled", async () => {
    const missingTokenEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true" });
    await expect(fileUpstreamDriftIssues(missingTokenEnv)).resolves.toMatchObject({ status: "skipped", reason: "missing_issue_token" });

    const invalidRepoEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token", LOOPOVER_DRIFT_ISSUE_REPO: "bad-repo-name" });
    await upsertUpstreamDriftReport(invalidRepoEnv, driftReport("invalid-repo"));
    await expect(fileUpstreamDriftIssues(invalidRepoEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });

    // A leading-slash repo splits to an empty owner segment (as opposed to invalidRepoEnv's missing name
    // segment above) -- exercises the other arm of findGitHubIssueForFingerprint's `!owner || !name` guard.
    const emptyOwnerRepoEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token", LOOPOVER_DRIFT_ISSUE_REPO: "/bad-repo" });
    await upsertUpstreamDriftReport(emptyOwnerRepoEnv, driftReport("empty-owner-repo"));
    await expect(fileUpstreamDriftIssues(emptyOwnerRepoEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });

    const createEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(createEnv, driftReport("create-fingerprint"));
    vi.stubGlobal("fetch", githubIssueFetch({ create: { number: 77, url: "https://github.com/JSONbored/gittensory/issues/77" } }));
    await expect(fileUpstreamDriftIssues(createEnv)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, skipped: 0 });
    await expect(listUpstreamDriftReports(createEnv)).resolves.toEqual([expect.objectContaining({ issueNumber: 77 })]);

    const updateEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "yes", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
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
        expect.objectContaining({ method: "GET", url: "https://api.github.com/repos/JSONbored/gittensory/issues?state=open&labels=signals&per_page=100&page=1" }),
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

    const failingEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "on", GITHUB_PUBLIC_TOKEN: "token" });
    await upsertUpstreamDriftReport(failingEnv, driftReport("failing-fingerprint"));
    vi.stubGlobal("fetch", githubIssueFetch({ createStatus: 500, listStatus: 500 }));
    await expect(fileUpstreamDriftIssues(failingEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });
  });

  it("INVARIANT (#4503): a second run against an UNCHANGED open drift issue makes zero PATCH calls", async () => {
    const env = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(env, driftReport("stable-fingerprint"));
    const createCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal("fetch", githubIssueFetch({ create: { number: 101, url: "https://github.com/JSONbored/gittensory/issues/101" }, calls: createCalls }));
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, unchanged: 0 });
    const posted = createCalls.find((call) => call.method === "POST")?.body;

    // Second run: the "existing" issue's GET reflects EXACTLY what was just posted -- a fresh PATCH would be a no-op.
    const secondCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      githubIssueFetch({
        issue: {
          number: 101,
          url: "https://github.com/JSONbored/gittensory/issues/101",
          fingerprint: "stable-fingerprint",
          body: String(posted?.body),
          labels: posted?.labels as string[],
          assignees: posted?.assignees as string[],
        },
        calls: secondCalls,
      }),
    );
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, unchanged: 1 });
    expect(secondCalls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("REGRESSION (#4503): two consecutive cycles against an unchanged report only PATCH on the first", async () => {
    const env = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(env, driftReport("cycle-fingerprint", { issueNumber: 202, issueUrl: "https://github.com/JSONbored/gittensory/issues/202" }));

    // Cycle 1: the recorded issue's live body/labels are STALE (drift from before the report's current content) --
    // this cycle must PATCH to bring them into sync.
    const firstCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      githubIssueFetch({
        issue: { number: 202, url: "https://github.com/JSONbored/gittensory/issues/202", fingerprint: "cycle-fingerprint", body: "<!-- gittensory-upstream-drift:cycle-fingerprint -->\nstale", labels: ["signals"] },
        calls: firstCalls,
      }),
    );
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "completed", created: 0, updated: 1, unchanged: 0 });
    const firstPatchBody = firstCalls.find((call) => call.method === "PATCH")?.body;

    // Cycle 2 (the next 6-hour tick): the live issue now reflects exactly what cycle 1 just wrote -- zero PATCH calls.
    const secondCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      githubIssueFetch({
        issue: {
          number: 202,
          url: "https://github.com/JSONbored/gittensory/issues/202",
          fingerprint: "cycle-fingerprint",
          body: String(firstPatchBody?.body),
          labels: firstPatchBody?.labels as string[],
          assignees: firstPatchBody?.assignees as string[],
        },
        calls: secondCalls,
      }),
    );
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, unchanged: 1 });
    expect(secondCalls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("negative-path (#4503): a genuinely changed report (severity escalation) still triggers a fresh PATCH", async () => {
    const env = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(env, driftReport("escalating-fingerprint", { severity: "low" }));
    const createCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal("fetch", githubIssueFetch({ create: { number: 303, url: "https://github.com/JSONbored/gittensory/issues/303" }, calls: createCalls }));
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, unchanged: 0 });
    const posted = createCalls.find((call) => call.method === "POST")?.body;

    // The SAME fingerprint's report is re-upserted with an ESCALATED severity -- both the body (severity line) and
    // the labels ("backend" -> "high-impact") change; the live issue still reflects the OLD (low-severity) content.
    await upsertUpstreamDriftReport(env, driftReport("escalating-fingerprint", { severity: "blocking" }));
    const secondCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      githubIssueFetch({
        issue: {
          number: 303,
          url: "https://github.com/JSONbored/gittensory/issues/303",
          fingerprint: "escalating-fingerprint",
          body: String(posted?.body),
          labels: posted?.labels as string[],
        },
        calls: secondCalls,
      }),
    );
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "completed", created: 0, updated: 1, unchanged: 0 });
    const escalatedPatch = secondCalls.find((call) => call.method === "PATCH")?.body;
    expect(escalatedPatch?.labels).toEqual(["signals", "scoring", "data", "high-impact"]);
    expect(String(escalatedPatch?.body)).toContain("Severity: blocking");
  });

  it("REGRESSION (#4503): the list-search fallback tolerates malformed label/assignee shapes (missing name/login) without crashing", async () => {
    const env = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(env, driftReport("malformed-shape-fingerprint"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/issues?state=open&labels=signals&per_page=100&page=")) {
        return Response.json([
          {
            number: 404,
            html_url: "https://github.com/JSONbored/gittensory/issues/404",
            body: "<!-- gittensory-upstream-drift:malformed-shape-fingerprint -->",
            // A nameless label object and a loginless assignee object -- both must be dropped, not crash the map.
            labels: [{}, "signals"],
            assignees: [{}, { login: "jsonbored" }],
          },
        ]);
      }
      if (url.match(/\/issues\/404$/) && method === "PATCH") return Response.json({ number: 404, html_url: "https://github.com/JSONbored/gittensory/issues/404" });
      return new Response("not found", { status: 404 });
    });

    // Content genuinely differs (the mocked body is just the fingerprint comment, not a full drift body), so this
    // still PATCHes -- the point of this test is that resolving the malformed shapes above never throws.
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "completed", created: 0, updated: 1, skipped: 0 });
  });

  it("REGRESSION (#4503): validateRecordedGitHubIssue's fast path tolerates a malformed (loginless) assignee without crashing", async () => {
    const env = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(env, driftReport("malformed-assignee-fingerprint", { issueNumber: 505, issueUrl: "https://github.com/JSONbored/gittensory/issues/505" }));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.match(/\/issues\/505$/) && method === "GET") {
        return Response.json({
          number: 505,
          html_url: "https://github.com/JSONbored/gittensory/issues/505",
          state: "open",
          body: "<!-- gittensory-upstream-drift:malformed-assignee-fingerprint -->",
          labels: ["signals"],
          // A loginless assignee object -- must be dropped, not crash the map.
          assignees: [{}, { login: "jsonbored" }],
        });
      }
      if (url.match(/\/issues\/505$/) && method === "PATCH") return Response.json({ number: 505, html_url: "https://github.com/JSONbored/gittensory/issues/505" });
      return new Response("not found", { status: 404 });
    });

    // Content genuinely differs (the mocked body is just the fingerprint comment), so this still PATCHes -- the
    // point of this test is that resolving the malformed assignee shape above never throws.
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "completed", created: 0, updated: 1, skipped: 0 });
  });

  it("REGRESSION (#4503): validateRecordedGitHubIssue tolerates an issue response with the assignees field entirely absent", async () => {
    const env = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(env, driftReport("no-assignees-field-fingerprint", { issueNumber: 606, issueUrl: "https://github.com/JSONbored/gittensory/issues/606" }));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.match(/\/issues\/606$/) && method === "GET") {
        // No `assignees` key at all -- distinct from an explicit empty array.
        return Response.json({ number: 606, html_url: "https://github.com/JSONbored/gittensory/issues/606", state: "open", body: "<!-- gittensory-upstream-drift:no-assignees-field-fingerprint -->", labels: ["signals"] });
      }
      if (url.match(/\/issues\/606$/) && method === "PATCH") return Response.json({ number: 606, html_url: "https://github.com/JSONbored/gittensory/issues/606" });
      return new Response("not found", { status: 404 });
    });

    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "completed", created: 0, updated: 1, skipped: 0 });
  });

  it("assigns filed drift issues to LOOPOVER_DRIFT_ISSUE_ASSIGNEES when a self-host operator sets it", async () => {
    const env = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token", LOOPOVER_DRIFT_ISSUE_ASSIGNEES: "alice, ,bob" });
    await upsertUpstreamDriftReport(env, driftReport("assignee-override"));
    const calls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal("fetch", githubIssueFetch({ create: { number: 70, url: "https://github.com/acme/widgets/issues/70" }, calls }));
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "completed", created: 1 });
    expect(calls.find((call) => call.method === "POST")?.body?.assignees).toEqual(["alice", "bob"]); // trimmed, empty segment dropped
  });

  // 29 distinct real-D1-backed scenarios run sequentially in this one test -- legitimately more work than
  // the default 15s test timeout reliably covers under concurrent CI shard/system load (observed timing out
  // under heavy parallel contention with no assertion failure). An explicit timeout says so instead of
  // relying on ambient headroom.
  it("handles edge cases while filing upstream drift issues", async () => {
    const defaultRepoEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "1", LOOPOVER_DRIFT_ISSUE_TOKEN: "token", LOOPOVER_DRIFT_ISSUE_REPO: "" });
    await upsertUpstreamDriftReport(defaultRepoEnv, driftReport("source-fingerprint", { severity: "medium", affectedAreas: [] }));
    vi.stubGlobal("fetch", githubIssueFetch({ create: { number: 91, url: "https://github.com/JSONbored/gittensory/issues/91" } }));
    await expect(fileUpstreamDriftIssues(defaultRepoEnv)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, skipped: 0 });

    const areaSourceEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
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

    const missingPayloadEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(missingPayloadEnv, driftReport("missing-payload", { currentRulesetId: null, previousRulesetId: null }));
    vi.stubGlobal("fetch", githubIssueFetch({ createPayload: {} }));
    await expect(fileUpstreamDriftIssues(missingPayloadEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });

    // #10027: a thrown fingerprint search is a read failure, not "no match" -- it must NOT fall through to create.
    const throwingListEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(throwingListEnv, driftReport("throwing-list"));
    const throwingListCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal("fetch", githubIssueFetch({ throwOnList: true, create: { number: 92, url: "https://github.com/JSONbored/gittensory/issues/92" }, calls: throwingListCalls }));
    await expect(fileUpstreamDriftIssues(throwingListEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });
    expect(throwingListCalls.some((call) => call.method === "POST")).toBe(false);

    const linkedEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
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

    const objectLabelLinkedEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(objectLabelLinkedEnv, driftReport("object-label-linked", { issueNumber: 129, issueUrl: "https://github.com/JSONbored/gittensory/issues/129" }));
    vi.stubGlobal(
      "fetch",
      githubIssueFetch({
        issue: { number: 129, url: "https://github.com/JSONbored/gittensory/issues/129", fingerprint: "object-label-linked", labels: [{ name: "signals" }] },
        update: { number: 129, url: "https://github.com/JSONbored/gittensory/issues/129" },
      }),
    );
    await expect(fileUpstreamDriftIssues(objectLabelLinkedEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 1, skipped: 0 });

    // GitHub labels are case-insensitive: a repo whose "signals" label is stored with different casing
    // (e.g. "Signals") must still be recognized as the recorded drift issue, so it is updated, not duplicated.
    const caseVariantLabelEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(caseVariantLabelEnv, driftReport("case-variant-label-linked", { issueNumber: 139, issueUrl: "https://github.com/JSONbored/gittensory/issues/139" }));
    vi.stubGlobal(
      "fetch",
      githubIssueFetch({
        issue: { number: 139, url: "https://github.com/JSONbored/gittensory/issues/139", fingerprint: "case-variant-label-linked", labels: [{ name: "Signals" }] },
        update: { number: 139, url: "https://github.com/JSONbored/gittensory/issues/139" },
      }),
    );
    await expect(fileUpstreamDriftIssues(caseVariantLabelEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 1, skipped: 0 });

    const staleLinkedEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token", LOOPOVER_DRIFT_ISSUE_REPO: "victim/current-repo" });
    await upsertUpstreamDriftReport(staleLinkedEnv, driftReport("stale-linked", { issueNumber: 123, issueUrl: "https://github.com/other-owner/old-repo/issues/123" }));
    const staleLinkedCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal("fetch", githubIssueFetch({ create: { number: 124, url: "https://github.com/victim/current-repo/issues/124" }, calls: staleLinkedCalls }));
    await expect(fileUpstreamDriftIssues(staleLinkedEnv)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, skipped: 0 });
    expect(staleLinkedCalls).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ method: "PATCH", url: "https://api.github.com/repos/victim/current-repo/issues/123" })]),
    );

    const invalidLinkedEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(invalidLinkedEnv, driftReport("invalid-linked", { issueNumber: 125, issueUrl: "not a github issue url" }));
    const invalidLinkedCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal("fetch", githubIssueFetch({ create: { number: 126, url: "https://github.com/JSONbored/gittensory/issues/126" }, calls: invalidLinkedCalls }));
    await expect(fileUpstreamDriftIssues(invalidLinkedEnv)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, skipped: 0 });
    expect(invalidLinkedCalls).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ method: "PATCH", url: "https://api.github.com/repos/JSONbored/gittensory/issues/125" })]),
    );

    // #10027: a thrown GET on the recorded-issue fast path is a read failure -- the search fallback still runs
    // (mirroring the original `??` fallback) but finding nothing there must not create a duplicate either.
    const throwingLinkedEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(throwingLinkedEnv, driftReport("throwing-linked", { issueNumber: 127, issueUrl: "https://github.com/JSONbored/gittensory/issues/127" }));
    const throwingLinkedCalls: GitHubIssueFetchCall[] = [];
    vi.stubGlobal("fetch", githubIssueFetch({ throwOnIssueGet: true, create: { number: 128, url: "https://github.com/JSONbored/gittensory/issues/128" }, calls: throwingLinkedCalls }));
    await expect(fileUpstreamDriftIssues(throwingLinkedEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });
    expect(throwingLinkedCalls).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ method: "PATCH", url: "https://api.github.com/repos/JSONbored/gittensory/issues/127" })]),
    );
    expect(throwingLinkedCalls.some((call) => call.method === "POST")).toBe(false);

    for (const scenario of [
      { fingerprint: "wrong-host-linked", issueNumber: 130, issueUrl: "https://example.com/JSONbored/gittensory/issues/130" },
      { fingerprint: "wrong-path-linked", issueNumber: 131, issueUrl: "https://github.com/JSONbored/gittensory/pull/131" },
      // #10027: a non-OK GET (rate-limit/5xx) on the recorded-issue fast path is a READ FAILURE, not "not
      // found" -- it must skip rather than fall through to filing a duplicate.
      { fingerprint: "lookup-status-linked", issueNumber: 132, issueUrl: "https://github.com/JSONbored/gittensory/issues/132", issueStatus: 500, readFailure: true },
      // The mock 404s here because its own number-in-URL match fails (it never reaches ruleset.ts's in-body
      // number check) -- same non-OK-response read-failure path as the case above.
      { fingerprint: "wrong-number-linked", issueNumber: 133, issueUrl: "https://github.com/JSONbored/gittensory/issues/133", issue: { number: 134, url: "https://github.com/JSONbored/gittensory/issues/133", fingerprint: "wrong-number-linked" }, readFailure: true },
      { fingerprint: "closed-linked", issueNumber: 135, issueUrl: "https://github.com/JSONbored/gittensory/issues/135", issue: { number: 135, url: "https://github.com/JSONbored/gittensory/issues/135", fingerprint: "closed-linked", state: "closed" } },
      { fingerprint: "missing-body-linked", issueNumber: 136, issueUrl: "https://github.com/JSONbored/gittensory/issues/136", issue: { number: 136, url: "https://github.com/JSONbored/gittensory/issues/136", fingerprint: "missing-body-linked", body: null } },
      { fingerprint: "missing-label-linked", issueNumber: 137, issueUrl: "https://github.com/JSONbored/gittensory/issues/137", issue: { number: 137, url: "https://github.com/JSONbored/gittensory/issues/137", fingerprint: "missing-label-linked", labels: [{ name: "triage" }] } },
      { fingerprint: "nameless-label-linked", issueNumber: 141, issueUrl: "https://github.com/JSONbored/gittensory/issues/141", issue: { number: 141, url: "https://github.com/JSONbored/gittensory/issues/141", fingerprint: "nameless-label-linked", labels: [{}] } },
      { fingerprint: "returned-url-linked", issueNumber: 138, issueUrl: "https://github.com/JSONbored/gittensory/issues/138", issue: { number: 138, url: "https://github.com/other/repo/issues/138", fingerprint: "returned-url-linked" } },
      // The returned html_url parses fine and matches the expected owner/repo, but its OWN embedded issue
      // number disagrees with the recorded report.issueNumber (distinct from "wrong-number-linked" above, which
      // never gets past the fetch itself) -- still a not-found, not a read failure.
      { fingerprint: "mismatched-url-number-linked", issueNumber: 142, issueUrl: "https://github.com/JSONbored/gittensory/issues/142", issue: { number: 142, url: "https://github.com/JSONbored/gittensory/issues/999", fingerprint: "mismatched-url-number-linked" } },
    ]) {
      const rejectedLinkedEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
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
      await expect(fileUpstreamDriftIssues(rejectedLinkedEnv)).resolves.toMatchObject(
        scenario.readFailure ? { status: "completed", created: 0, updated: 0, skipped: 1 } : { status: "completed", created: 1, updated: 0, skipped: 0 },
      );
      expect(rejectedLinkedCalls).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ method: "PATCH", url: `https://api.github.com/repos/JSONbored/gittensory/issues/${scenario.issueNumber}` })]),
      );
      if (scenario.readFailure) expect(rejectedLinkedCalls.some((call) => call.method === "POST")).toBe(false);
    }

    const failingLinkedEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(failingLinkedEnv, driftReport("failing-linked", { issueNumber: 94, issueUrl: "https://github.com/JSONbored/gittensory/issues/94" }));
    vi.stubGlobal("fetch", githubIssueFetch({ issue: { number: 94, url: "https://github.com/JSONbored/gittensory/issues/94", fingerprint: "failing-linked" }, updateStatus: 500 }));
    await expect(fileUpstreamDriftIssues(failingLinkedEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });

    const missingUpdatePayloadEnv = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(missingUpdatePayloadEnv, driftReport("missing-update-payload", { issueNumber: 96, issueUrl: "https://github.com/JSONbored/gittensory/issues/96" }));
    vi.stubGlobal("fetch", githubIssueFetch({ issue: { number: 96, url: "https://github.com/JSONbored/gittensory/issues/96", fingerprint: "missing-update-payload" }, updatePayload: {} }));
    await expect(fileUpstreamDriftIssues(missingUpdatePayloadEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });

    const disabledEnv = driftEnv();
    delete (disabledEnv as Partial<Env>).LOOPOVER_AUTO_FILE_DRIFT_ISSUES;
    await expect(fileUpstreamDriftIssues(disabledEnv)).resolves.toMatchObject({ status: "disabled" });
  }, 45000);

  it("finds the existing drift issue on page 2 when the repo has more than 100 open signals issues", async () => {
    const env = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(env, driftReport("page-2-fingerprint"));
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/issues?state=open&labels=signals&per_page=100&page=1")) {
        return Response.json(
          Array.from({ length: 100 }, (_, i) => ({
            number: i + 1,
            html_url: `https://github.com/JSONbored/gittensory/issues/${i + 1}`,
            body: `<!-- gittensory-upstream-drift:other-fingerprint-${i} -->`,
          })),
          { headers: { link: '<https://api.github.com/repos/JSONbored/gittensory/issues?page=2>; rel="next"' } },
        );
      }
      if (url.includes("/issues?state=open&labels=signals&per_page=100&page=2")) {
        return Response.json([
          { number: 201, html_url: "https://github.com/JSONbored/gittensory/issues/201", body: "<!-- gittensory-upstream-drift:page-2-fingerprint -->" },
        ]);
      }
      if (url.match(/\/issues\/201$/) && method === "PATCH") {
        return Response.json({ number: 201, html_url: "https://github.com/JSONbored/gittensory/issues/201" });
      }
      return new Response("not found", { status: 404 });
    });
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "completed", created: 0, updated: 1, skipped: 0 });
    expect(calls.some((call) => call.includes("page=2"))).toBe(true);
    expect(calls.some((call) => call.startsWith("PATCH ") && call.includes("/issues/201"))).toBe(true);
    expect(calls.every((call) => !call.startsWith("POST "))).toBe(true);
  });

  it("REGRESSION (#10027): a failed fingerprint search must not file a duplicate drift issue", async () => {
    const env = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(env, driftReport("duplicate-guard-fingerprint"));
    const calls: GitHubIssueFetchCall[] = [];
    // A 403 on page 1 of the search (the shape a shared REST rate-limit produces) used to fall straight through
    // to createGitHubDriftIssue -- assert zero POSTs and the report's stored issue reference stays untouched.
    vi.stubGlobal("fetch", githubIssueFetch({ listStatus: 403, create: { number: 999, url: "https://github.com/JSONbored/gittensory/issues/999" }, calls }));
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    await expect(listUpstreamDriftReports(env)).resolves.toEqual([expect.objectContaining({ issueNumber: null, issueUrl: null })]);
  });

  it("REGRESSION (#10027): a non-OK response on the fingerprint search's page 2 is a read failure, not a truncated match", async () => {
    const env = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(env, driftReport("page-2-failure-fingerprint"));
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/issues?state=open&labels=signals&per_page=100&page=1")) {
        return Response.json(
          [{ number: 1, html_url: "https://github.com/JSONbored/gittensory/issues/1", body: "<!-- gittensory-upstream-drift:other-fingerprint -->" }],
          { headers: { link: '<https://api.github.com/repos/JSONbored/gittensory/issues?page=2>; rel="next"' } },
        );
      }
      if (url.includes("/issues?state=open&labels=signals&per_page=100&page=2")) return new Response("rate limited", { status: 403 });
      return new Response("not found", { status: 404 });
    });
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });
    expect(calls.every((call) => !call.startsWith("POST "))).toBe(true);
  });

  it("REGRESSION (#10027): the fingerprint search is bounded to 10 pages, and exhausting the cap is a read failure", async () => {
    const env = driftEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(env, driftReport("page-cap-fingerprint"));
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/issues?state=open&labels=signals&per_page=100&page=")) {
        // Every page reports a next page AND never matches -- a pathological repo with more than 1000 open
        // `signals`-labeled issues, or an endlessly-looping stub. The cap must stop the walk at page 10.
        return Response.json([{ number: 1, html_url: "https://github.com/JSONbored/gittensory/issues/1", body: "<!-- gittensory-upstream-drift:other-fingerprint -->" }], {
          headers: { link: '<https://api.github.com/repos/JSONbored/gittensory/issues?page=99>; rel="next"' },
        });
      }
      return new Response("not found", { status: 404 });
    });
    await expect(fileUpstreamDriftIssues(env)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });
    const listCalls = calls.filter((call) => call.includes("/issues?state=open&labels=signals"));
    expect(listCalls).toHaveLength(10);
    expect(calls.every((call) => !call.startsWith("POST "))).toBe(true);
  });

  it("publishes null report references in upstream status safely", async () => {
    const env = driftEnv();
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

    const env = driftEnv();
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
    const env = driftEnv({ GITHUB_PUBLIC_TOKEN: "token" });
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

describe("isAutoFileDriftIssuesEnabled — default OFF, truthy convention (#6275)", () => {
  it("is OFF for unset / false / empty, ON for 1/true/yes/on", () => {
    for (const off of [undefined, "", "false", "no", "0", "off"]) expect(isAutoFileDriftIssuesEnabled({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isAutoFileDriftIssuesEnabled({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: on })).toBe(true);
  });

  it("a present manifest override wins outright over the env flag, in both directions", () => {
    expect(isAutoFileDriftIssuesEnabled({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "false" }, { present: true, enabled: true })).toBe(true);
    expect(isAutoFileDriftIssuesEnabled({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true" }, { present: true, enabled: false })).toBe(false);
  });

  it("falls back to the env flag when the manifest override is not present", () => {
    expect(isAutoFileDriftIssuesEnabled({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true" }, { present: false, enabled: false })).toBe(true);
    expect(isAutoFileDriftIssuesEnabled({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "false" }, undefined)).toBe(false);
  });
});

describe("resolveAutoFileDriftIssuesManifestOverride — config-as-code lookup (#6275)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SELF_REPO = "JSONbored/gittensory";

  it("returns the self-repo's configured upstreamDriftIssues block when present", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { upstreamDriftIssues: { enabled: true } });

    expect(await resolveAutoFileDriftIssuesManifestOverride(env)).toEqual({ present: true, enabled: true });
  });

  it("returns present: false when the self-repo has no upstreamDriftIssues block configured", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { wantedPaths: ["src/"] });

    expect(await resolveAutoFileDriftIssuesManifestOverride(env)).toEqual({ present: false, enabled: false });
  });

  it("degrades to present: false (never throws) when the manifest load itself fails", async () => {
    const env = createTestEnv();
    // loadRepoFocusManifest reads signal_snapshots (the persisted-record cache) before any live fetch fallback.
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/"signal_snapshots"|signal_snapshots/i.test(sql)) throw new Error("poisoned query");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await resolveAutoFileDriftIssuesManifestOverride(env)).toEqual({ present: false, enabled: false });
    expect(warnings.mock.calls.map((c) => String(c[0])).some((line) => line.includes("upstream_drift_issues_manifest_override_error"))).toBe(true);
    warnings.mockRestore();
  });
});

describe("fileUpstreamDriftIssues — manifest override param (#6275)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("byte-identical when the override param is omitted: the env var alone still fully decides", async () => {
    const offEnv = createTestEnv();
    await expect(fileUpstreamDriftIssues(offEnv)).resolves.toMatchObject({ status: "disabled", created: 0, updated: 0, skipped: 0 });

    const onEnv = createTestEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(onEnv, driftReport("omitted-override-fingerprint"));
    vi.stubGlobal("fetch", githubIssueFetch({ create: { number: 501, url: "https://github.com/JSONbored/gittensory/issues/501" } }));
    await expect(fileUpstreamDriftIssues(onEnv)).resolves.toMatchObject({ status: "completed", created: 1 });
  });

  it("a present override enables filing even when the env var is off", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_TOKEN: "token" }); // LOOPOVER_AUTO_FILE_DRIFT_ISSUES defaults to "false"
    await upsertUpstreamDriftReport(env, driftReport("override-enabled-fingerprint"));
    vi.stubGlobal("fetch", githubIssueFetch({ create: { number: 502, url: "https://github.com/JSONbored/gittensory/issues/502" } }));

    await expect(fileUpstreamDriftIssues(env, { present: true, enabled: true })).resolves.toMatchObject({ status: "completed", created: 1 });
  });

  it("a present override disables filing even when the env var is on", async () => {
    const env = createTestEnv({ LOOPOVER_AUTO_FILE_DRIFT_ISSUES: "true", LOOPOVER_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(env, driftReport("override-disabled-fingerprint"));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fileUpstreamDriftIssues(env, { present: true, enabled: false })).resolves.toEqual({ status: "disabled", created: 0, updated: 0, skipped: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
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

// One source's contents-API read fails (forcing the raw-GitHub fallback), and that source's fallback fetch
// rejects the way AbortSignal.timeout does on a real stalled connection -- every other source's contents-API
// read succeeds normally. Exercises the #9165 fix: the failing source degrades to an "error" snapshot instead
// of the Promise.all fan-out hanging on it.
function upstreamPartialTimeoutFetch(files: Record<string, string>, failingPath: string) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = input.toString();
    if (url.includes("/commits/")) return Response.json({ sha: `commit-${scaleFrom(files)}` });
    if (url.includes(`/contents/${failingPath}`)) return new Response("server error", { status: 500 });
    if (url.endsWith(failingPath)) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const path = Object.keys(files).find((candidate) => url.includes(`/contents/${candidate}`));
    if (!path) return new Response("not found", { status: 404 });
    return Response.json({
      content: Buffer.from(files[path]!, "utf8").toString("base64"),
      encoding: "base64",
      sha: `blob-${path}-${scaleFrom(files)}`,
      download_url: `https://raw.githubusercontent.com/entrius/gittensor/test/${path}`,
    });
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
  issue?: { number: number; url: string; fingerprint: string; state?: string; labels?: Array<string | { name?: string }>; body?: string | null; assignees?: string[] };
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
    if (url.includes("/issues?state=open&labels=signals&per_page=100&page=")) {
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
        assignees: (options.issue.assignees ?? []).map((login) => ({ login })),
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

describe("resolveDriftAssignees", () => {
  it("defaults to the gittensory maintainer when unset, empty, or whitespace-only", () => {
    expect(resolveDriftAssignees(createTestEnv())).toEqual(["jsonbored"]);
    expect(resolveDriftAssignees(createTestEnv({ LOOPOVER_DRIFT_ISSUE_ASSIGNEES: "" }))).toEqual(["jsonbored"]);
    expect(resolveDriftAssignees(createTestEnv({ LOOPOVER_DRIFT_ISSUE_ASSIGNEES: "   " }))).toEqual(["jsonbored"]);
  });

  it("parses a comma-separated list, trimming and dropping empty segments", () => {
    expect(resolveDriftAssignees(createTestEnv({ LOOPOVER_DRIFT_ISSUE_ASSIGNEES: "alice" }))).toEqual(["alice"]);
    expect(resolveDriftAssignees(createTestEnv({ LOOPOVER_DRIFT_ISSUE_ASSIGNEES: " alice , ,bob " }))).toEqual(["alice", "bob"]);
  });
});
