import { afterEach, describe, expect, it, vi } from "vitest";
import { getRepository, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { DEFAULT_ISSUE_DISCOVERY_SHARE } from "../../src/scoring/model";
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
    // No scoring block → no per-repo time-decay overrides (uses global defaults downstream).
    expect(snapshot.repositories[0]!.timeDecay ?? null).toBeNull();
  });

  it("REGRESSION: drops non-finite label multiplier values (NaN/Infinity are typeof 'number' but not finite)", () => {
    const snapshot = normalizeRegistryPayload(
      {
        "JSONbored/awesome-claude": {
          label_multipliers: { bug: 1.2, broken: Number.NaN, unbounded: Number.POSITIVE_INFINITY },
        },
      },
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    );

    expect(snapshot.repositories[0]!.labelMultipliers).toEqual({ bug: 1.2 });
  });

  it("dedupes case-variant repo names so snapshot totals match the single row that persists", () => {
    const snapshot = normalizeRegistryPayload(
      {
        "Owner/Repo": { emission_share: 0.02 },
        "owner/repo": { emission_share: 0.03 },
      },
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    );

    // Persist collapses these to one canonical row; the snapshot must report one repo and the last-wins share,
    // not two repos summing to 0.05.
    expect(snapshot.repoCount).toBe(1);
    expect(snapshot.totalEmissionShare).toBe(0.03);
    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.repositories[0]).toMatchObject({ repo: "owner/repo", emissionShare: 0.03 });
  });

  it("parses per-repo time-decay overrides from the registry scoring.time_decay block (#703)", () => {
    const snapshot = normalizeRegistryPayload(
      {
        // JSONbored/gittensory's real master_repositories.json shape: a partial override (no steepness).
        "JSONbored/gittensory": {
          emission_share: 0.01,
          scoring: { pr_lookback_days: 45, time_decay: { grace_period_hours: 24, sigmoid_midpoint_days: 10, min_multiplier: 0.05 } },
        },
        // A scoring block without time_decay → no overrides.
        "other/repo": { emission_share: 0.02, scoring: { pr_lookback_days: 30 } },
        // A time_decay object with no usable numeric fields → still no overrides (every field null).
        "empty/decay": { emission_share: 0.01, scoring: { time_decay: { note: "tbd" } } },
      },
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    );
    const byName = Object.fromEntries(snapshot.repositories.map((r) => [r.repo, r]));
    expect(byName["JSONbored/gittensory"]!.timeDecay).toEqual({
      gracePeriodHours: 24,
      sigmoidMidpointDays: 10,
      sigmoidSteepness: null, // absent → falls back to the global default at resolve time
      minMultiplier: 0.05,
    });
    expect(byName["other/repo"]!.timeDecay ?? null).toBeNull();
    expect(byName["empty/decay"]!.timeDecay ?? null).toBeNull();
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
    expect(fromObjectMap.repositories[0]).toMatchObject({
      repo: "JSONbored/gittensory",
      issueDiscoveryShare: DEFAULT_ISSUE_DISCOVERY_SHARE,
    });
    expect(fromArray.repositories.map((repo) => repo.repo)).toEqual(["JSONbored/gittensory", "bad/numbers"]);
    expect(fromArray.repositories.find((repo) => repo.repo === "bad/numbers")).toMatchObject({
      emissionShare: 0,
      issueDiscoveryShare: DEFAULT_ISSUE_DISCOVERY_SHARE,
    });
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

  it("updates an existing case-variant repo row instead of inserting a duplicate", async () => {
    const env = createTestEnv();
    // A GitHub-sourced row already exists under canonical casing.
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } });

    // The registry supplies the same repo with different casing.
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "jsonbored/gittensory": { emission_share: 0.02, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-22T00:00:00.000Z",
      ),
    );

    // The existing canonical row is updated to registered -- no duplicate primary-key row.
    await expect(getRepository(env, "JSONbored/gittensory")).resolves.toMatchObject({ isRegistered: true });
    const rows = await env.DB.prepare("SELECT full_name FROM repositories WHERE lower(full_name) = ?").bind("jsonbored/gittensory").all();
    expect(rows.results).toHaveLength(1);
    expect((rows.results[0] as { full_name: string }).full_name).toBe("JSONbored/gittensory");
  });

  it("does not de-register a repo whose snapshot casing differs from the stored row", async () => {
    const env = createTestEnv();
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.02, issue_discovery_share: 0 } }, { kind: "raw-github", url: "fixture://old" }, "2026-05-22T00:00:00.000Z"),
    );
    // The next snapshot uses different casing for the same repo.
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "jsonbored/gittensory": { emission_share: 0.02, issue_discovery_share: 0 } }, { kind: "raw-github", url: "fixture://new" }, "2026-05-23T00:00:00.000Z"),
    );

    await expect(getRepository(env, "JSONbored/gittensory")).resolves.toMatchObject({ isRegistered: true });
    const rows = await env.DB.prepare("SELECT full_name FROM repositories WHERE lower(full_name) = ?").bind("jsonbored/gittensory").all();
    expect(rows.results).toHaveLength(1);
  });

  it("does not de-register existing repos when the snapshot is empty", async () => {
    const env = createTestEnv();
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/gittensory": { emission_share: 0.02, issue_discovery_share: 0 } }, { kind: "raw-github", url: "fixture://seed" }, "2026-05-22T00:00:00.000Z"),
    );
    // An empty snapshot (e.g. a failed/empty registry fetch) must preserve registrations, not wipe them.
    await persistRegistrySnapshot(env, normalizeRegistryPayload({}, { kind: "raw-github", url: "fixture://empty" }, "2026-05-23T00:00:00.000Z"));
    await expect(getRepository(env, "JSONbored/gittensory")).resolves.toMatchObject({ isRegistered: true });
  });

  it("collapses case-variant duplicates within a single snapshot to one row", async () => {
    const env = createTestEnv();
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "JSONbored/gittensory": { emission_share: 0.02, issue_discovery_share: 0 },
          "jsonbored/gittensory": { emission_share: 0.03, issue_discovery_share: 0 },
        },
        { kind: "raw-github", url: "fixture://dup-casing" },
        "2026-05-22T00:00:00.000Z",
      ),
    );
    const rows = await env.DB.prepare("SELECT full_name FROM repositories WHERE lower(full_name) = ?").bind("jsonbored/gittensory").all();
    expect(rows.results).toHaveLength(1);
    await expect(getRepository(env, "JSONbored/gittensory")).resolves.toMatchObject({ isRegistered: true });
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
