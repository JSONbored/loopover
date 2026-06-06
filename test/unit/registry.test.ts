import { afterEach, describe, expect, it, vi } from "vitest";
import { getRepository } from "../../src/db/repositories";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { getLatestRegistrySnapshot, persistRegistrySnapshot, refreshRegistry } from "../../src/registry/sync";
import { createTestEnv } from "../helpers/d1";

describe("registry normalization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes raw master repository config", () => {
    const snapshot = normalizeRegistryPayload(
      {
        "JSONbored/awesome-claude": {
          emission_share: 0.01,
          issue_discovery_share: 0,
          label_multipliers: { feature: 1.5 },
          maintainer_cut: 0.25,
        },
      },
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    );

    expect(snapshot.repoCount).toBe(1);
    expect(snapshot.totalEmissionShare).toBe(0.01);
    expect(snapshot.repositories[0]).toMatchObject({
      repo: "JSONbored/awesome-claude",
      emissionShare: 0.01,
      issueDiscoveryShare: 0,
      labelMultipliers: { feature: 1.5 },
      maintainerCut: 0.25,
    });
  });

  it("normalizes repository-list and array payload shapes defensively", () => {
    const fromObjectMap = normalizeRegistryPayload(
      {
        "JSONbored/gittensory": { emission_share: 0.03 },
        "ignored/null": null,
        "ignored/array": [],
      },
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    );

    const fromRepositoryList = normalizeRegistryPayload(
      {
        ignored: null,
        alsoIgnored: ["not", "a", "config"],
        repositories: [
          {
            full_name: "entrius/allways",
            emission_share: 0.02,
            issue_discovery_share: 1,
            trusted_label_pipeline: true,
            label_multipliers: { bug: 1.2, ignored: "not-a-number" },
          },
          { repo: "", emission_share: 1 },
          null,
        ],
      },
      { kind: "api", url: "https://example.test/api" },
      "2026-05-22T00:00:00.000Z",
    );

    const fromArray = normalizeRegistryPayload(
      [
        {
          repository_full_name: "JSONbored/gittensory",
          emission_share: 0.03,
          issue_discovery_share: 0,
          maintainer_cut: 0.1,
          default_label_multiplier: 0.5,
          fixed_base_score: 2,
          eligibility_mode: "active",
        },
        { repo: "bad/numbers", emission_share: Number.NaN, issue_discovery_share: "bad" },
        {},
        "not-a-repo",
      ],
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    );

    const empty = normalizeRegistryPayload("not-json-object", { kind: "raw-github", url: "https://example.test" }, "2026-05-22T00:00:00.000Z");

    expect(fromRepositoryList.repositories[0]).toMatchObject({
      repo: "entrius/allways",
      issueDiscoveryShare: 1,
      labelMultipliers: { bug: 1.2 },
      trustedLabelPipeline: true,
    });
    expect(fromObjectMap.repositories.map((repo) => repo.repo)).toEqual(["JSONbored/gittensory"]);
    expect(fromArray.repositories.map((repo) => repo.repo)).toEqual(["JSONbored/gittensory", "bad/numbers"]);
    expect(fromArray.repositories.find((repo) => repo.repo === "bad/numbers")).toMatchObject({ emissionShare: 0, issueDiscoveryShare: 0.5 });
    expect(empty.repoCount).toBe(0);
  });

  it("persists and reads the latest snapshot from D1", async () => {
    const env = createTestEnv();
    const snapshot = normalizeRegistryPayload(
      { "JSONbored/gittensory": { emission_share: 0.02, issue_discovery_share: 0.5 } },
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    );

    await persistRegistrySnapshot(env, snapshot);
    const latest = await getLatestRegistrySnapshot(env);

    expect(latest?.repositories[0]?.repo).toBe("JSONbored/gittensory");
    expect(latest?.source.kind).toBe("raw-github");
  });

  it("marks previously registered repos as unregistered when they disappear from the latest snapshot", async () => {
    const env = createTestEnv();
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "JSONbored/gittensory": { emission_share: 0.02, issue_discovery_share: 0 },
          "JSONbored/awesome-claude": { emission_share: 0.01, issue_discovery_share: 0 },
        },
        { kind: "raw-github", url: "fixture://old-registry" },
        "2026-05-22T00:00:00.000Z",
      ),
    );
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "JSONbored/awesome-claude": { emission_share: 0.01, issue_discovery_share: 0 },
        },
        { kind: "raw-github", url: "fixture://current-registry" },
        "2026-05-23T00:00:00.000Z",
      ),
    );

    await expect(getRepository(env, "JSONbored/gittensory")).resolves.toMatchObject({
      isRegistered: false,
      registryConfig: null,
    });
    await expect(getRepository(env, "JSONbored/awesome-claude")).resolves.toMatchObject({
      isRegistered: true,
      registryConfig: expect.objectContaining({ repo: "JSONbored/awesome-claude" }),
    });
  });

  it("falls back to raw GitHub when registry API probes fail", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("raw.githubusercontent.com")) {
        return Response.json({ "JSONbored/gittensory": { emission_share: 0.02, issue_discovery_share: 0.5 } });
      }
      return new Response("not found", { status: 404 });
    });

    const snapshot = await refreshRegistry(createTestEnv());

    expect(snapshot.source.kind).toBe("raw-github");
    expect(snapshot.warnings.length).toBeGreaterThan(0);
    expect(snapshot.repositories[0]?.repo).toBe("JSONbored/gittensory");
  });
});
