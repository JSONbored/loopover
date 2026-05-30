import { afterEach, describe, expect, it, vi } from "vitest";
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
      eligibilityMode: null,
    });
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
    ).resolves.toMatchObject({ severity: "medium", affectedAreas: ["registry"] });

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
      severity: "medium",
      affectedAreas: ["registry"],
      summary: "1 repo hyperparameter change(s)",
      payload: {
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
    ).resolves.toMatchObject({ severity: "medium", affectedAreas: ["registry"] });

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
    ).resolves.toMatchObject({ severity: "medium", affectedAreas: ["registry"] });

    await expect(buildUpstreamDriftReport({ ...base, id: "source-only", semanticHash: "source-only-hash" }, { ...base, id: "previous-source", semanticHash: "previous-source-hash" })).resolves.toMatchObject({
      severity: "low",
      affectedAreas: ["source"],
      summary: expect.stringContaining("without parsed semantic drift"),
    });
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
    vi.stubGlobal("fetch", githubIssueFetch({ existing: { number: 88, url: "https://github.com/JSONbored/gittensory/issues/88", fingerprint: "existing-fingerprint" } }));
    await expect(fileUpstreamDriftIssues(updateEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 1, skipped: 0 });

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

    const missingPayloadEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(missingPayloadEnv, driftReport("missing-payload", { currentRulesetId: null, previousRulesetId: null }));
    vi.stubGlobal("fetch", githubIssueFetch({ createPayload: {} }));
    await expect(fileUpstreamDriftIssues(missingPayloadEnv)).resolves.toMatchObject({ status: "completed", created: 0, updated: 0, skipped: 1 });

    const throwingListEnv = createTestEnv({ GITTENSORY_AUTO_FILE_DRIFT_ISSUES: "true", GITTENSORY_DRIFT_ISSUE_TOKEN: "token" });
    await upsertUpstreamDriftReport(throwingListEnv, driftReport("throwing-list"));
    vi.stubGlobal("fetch", githubIssueFetch({ throwOnList: true, create: { number: 92, url: "https://github.com/JSONbored/gittensory/issues/92" } }));
    await expect(fileUpstreamDriftIssues(throwingListEnv)).resolves.toMatchObject({ status: "completed", created: 1, updated: 0, skipped: 0 });

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

function githubIssueFetch(options: {
  existing?: { number: number; url: string; fingerprint: string };
  create?: { number: number; url: string };
  createPayload?: Record<string, unknown>;
  listStatus?: number;
  createStatus?: number;
  throwOnList?: boolean;
}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    if (url.endsWith("/issues?state=open&labels=signals&per_page=50")) {
      if (options.throwOnList) throw new Error("list failed");
      if (options.listStatus) return new Response("list failed", { status: options.listStatus });
      return Response.json(
        options.existing
          ? [{ number: options.existing.number, html_url: options.existing.url, body: `<!-- gittensory-upstream-drift:${options.existing.fingerprint} -->` }]
          : [],
      );
    }
    if (url.endsWith("/issues") && init?.method === "POST") {
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
    eligibilityMode: string | null;
  }>;
} {
  return rulesetPayload(snapshot).registry as ReturnType<typeof rulesetRegistry>;
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
  overrides: Partial<Pick<UpstreamDriftReportRecord, "severity" | "affectedAreas" | "summary" | "previousRulesetId" | "currentRulesetId" | "issueNumber" | "issueUrl">> = {},
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
    payload: { changes: ["scoring constants changed"] },
    generatedAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
  };
}
