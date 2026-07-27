import { afterEach, describe, expect, it, vi } from "vitest";
import { getRepository, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { getCustomerPoolAssociation, getRepoOrigin, getRepoPoolAssociation, normalizeRegistryPayload } from "../../src/registry/normalize";
import { DEFAULT_ISSUE_DISCOVERY_SHARE } from "../../src/scoring/model";
import { getLatestRegistrySnapshot, persistRegistrySnapshot, refreshRegistry } from "../../src/registry/sync";
import { createCloudTestEnv, createTestEnv } from "../helpers/d1";

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
        // JSONbored/loopover's real master_repositories.json shape: a partial override (no steepness).
        "JSONbored/loopover": {
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
    expect(byName["JSONbored/loopover"]!.timeDecay).toEqual({
      gracePeriodHours: 24,
      sigmoidMidpointDays: 10,
      sigmoidSteepness: null, // absent → falls back to the global default at resolve time
      minMultiplier: 0.05,
    });
    expect(byName["other/repo"]!.timeDecay ?? null).toBeNull();
    expect(byName["empty/decay"]!.timeDecay ?? null).toBeNull();
  });

  it("parses a subnet-funded pool association and leaves organic repos with none (#6320)", () => {
    const snapshot = normalizeRegistryPayload(
      {
        // A subnet-funded repo carries both a pool id and a subnet netuid → a full association reads back intact.
        "JSONbored/funded": { emission_share: 0.02, pool_id: "pool-74", subnet_id: 74 },
        // An organic repo has no pool fields → no association, byte-identical to today.
        "JSONbored/organic": { emission_share: 0.01 },
        // A partial association (pool id but no subnet) is not a valid association → null, not a half-populated object.
        "JSONbored/pool-only": { emission_share: 0.01, pool_id: "pool-9" },
        // A partial association (subnet but no pool id) is likewise dropped.
        "JSONbored/subnet-only": { emission_share: 0.01, subnet_id: 12 },
      },
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    );
    const byName = Object.fromEntries(snapshot.repositories.map((r) => [r.repo, r]));
    expect(byName["JSONbored/funded"]!.poolAssociation).toEqual({ poolId: "pool-74", subnetId: 74 });
    expect(byName["JSONbored/organic"]!.poolAssociation ?? null).toBeNull();
    expect(byName["JSONbored/pool-only"]!.poolAssociation ?? null).toBeNull();
    expect(byName["JSONbored/subnet-only"]!.poolAssociation ?? null).toBeNull();
  });

  it("parses a customer-funded pool association, parallel to and distinct from the subnet-funded one (#7679)", () => {
    const snapshot = normalizeRegistryPayload(
      {
        // A customer-funded repo carries a pool id and a funder account → a full customer association reads back.
        "JSONbored/customer": { emission_share: 0.02, pool_id: "pool-cust", funder_account: "acme-corp" },
        // A subnet-funded repo has pool_id + subnet_id but no funder_account → NO customer association (they stay distinct).
        "JSONbored/subnet": { emission_share: 0.02, pool_id: "pool-74", subnet_id: 74 },
        // An organic repo has neither → no customer association, byte-identical to today.
        "JSONbored/organic": { emission_share: 0.01 },
        // A partial customer association (pool id but no funder) is dropped, not a half-populated object.
        "JSONbored/pool-only": { emission_share: 0.01, pool_id: "pool-x" },
        // A partial customer association (funder but no pool id) is likewise dropped.
        "JSONbored/funder-only": { emission_share: 0.01, funder_account: "acme-corp" },
      },
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    );
    const byName = Object.fromEntries(snapshot.repositories.map((r) => [r.repo, r]));
    expect(byName["JSONbored/customer"]!.customerPoolAssociation).toEqual({ poolId: "pool-cust", funderAccount: "acme-corp" });
    // The subnet-funded repo has its own poolAssociation but NO customer association — the two are independent.
    expect(byName["JSONbored/subnet"]!.customerPoolAssociation ?? null).toBeNull();
    expect(byName["JSONbored/subnet"]!.poolAssociation).toEqual({ poolId: "pool-74", subnetId: 74 });
    expect(byName["JSONbored/organic"]!.customerPoolAssociation ?? null).toBeNull();
    expect(byName["JSONbored/pool-only"]!.customerPoolAssociation ?? null).toBeNull();
    expect(byName["JSONbored/funder-only"]!.customerPoolAssociation ?? null).toBeNull();
  });

  it("reads a repo's customer-funded pool via the getCustomerPoolAssociation accessor (#7679)", () => {
    const snapshot = normalizeRegistryPayload(
      { "JSONbored/customer": { emission_share: 0.02, pool_id: "pool-cust", funder_account: "acme-corp" } },
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    );
    const config = snapshot.repositories.find((r) => r.repo === "JSONbored/customer")!;
    expect(getCustomerPoolAssociation(config)).toEqual({ poolId: "pool-cust", funderAccount: "acme-corp" });
    expect(getCustomerPoolAssociation(null)).toBeNull();
    expect(getCustomerPoolAssociation(undefined)).toBeNull();
    const { customerPoolAssociation: _omitted, ...withoutCustomerPool } = config;
    expect(getCustomerPoolAssociation(withoutCustomerPool)).toBeNull();
  });

  it("parses a repo provisioning origin (BYOR/APR) and leaves unmarked repos with none (#7589)", () => {
    const snapshot = normalizeRegistryPayload(
      {
        // An explicit BYOR marker → the customer-provided origin reads back.
        "JSONbored/byor": { emission_share: 0.02, repo_origin: "byor" },
        // An APR marker carries the loopover org it was provisioned under → full APR origin.
        "JSONbored/apr": { emission_share: 0.02, repo_origin: "apr", hosting_org: "loopover-repos" },
        // An unmarked repo has no origin field → null, byte-identical to today (NOT assumed BYOR).
        "JSONbored/legacy": { emission_share: 0.01 },
        // An APR marker missing its hosting org is malformed → null, not a half-populated object.
        "JSONbored/apr-no-org": { emission_share: 0.01, repo_origin: "apr" },
        // An unrecognized origin string is ignored → null.
        "JSONbored/bogus": { emission_share: 0.01, repo_origin: "mystery" },
      },
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    );
    const byName = Object.fromEntries(snapshot.repositories.map((r) => [r.repo, r]));
    expect(byName["JSONbored/byor"]!.repoOrigin).toEqual({ kind: "byor" });
    expect(byName["JSONbored/apr"]!.repoOrigin).toEqual({ kind: "apr", hostingOrg: "loopover-repos" });
    expect(byName["JSONbored/legacy"]!.repoOrigin ?? null).toBeNull();
    expect(byName["JSONbored/apr-no-org"]!.repoOrigin ?? null).toBeNull();
    expect(byName["JSONbored/bogus"]!.repoOrigin ?? null).toBeNull();
    // The unmarked repo carries NO origin key at all, so it round-trips byte-identical to before this field.
    expect("repoOrigin" in byName["JSONbored/legacy"]!).toBe(true);
    expect(byName["JSONbored/legacy"]!.repoOrigin).toBeNull();
  });

  it("reads a repo's origin via the getRepoOrigin accessor (#7589)", () => {
    const snapshot = normalizeRegistryPayload(
      { "JSONbored/apr": { emission_share: 0.02, repo_origin: "apr", hosting_org: "loopover-repos" } },
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    );
    const config = snapshot.repositories.find((r) => r.repo === "JSONbored/apr")!;
    expect(getRepoOrigin(config)).toEqual({ kind: "apr", hostingOrg: "loopover-repos" });
    expect(getRepoOrigin(null)).toBeNull();
    expect(getRepoOrigin(undefined)).toBeNull();
    // A config object with no repoOrigin key at all resolves to null through the nullish accessor (the
    // "pre-dates this field" case). Omit the key rather than set it to undefined, per exactOptionalPropertyTypes.
    const { repoOrigin: _omitted, ...withoutOrigin } = config;
    expect(getRepoOrigin(withoutOrigin)).toBeNull();
  });

  it("getRepoPoolAssociation reads a repo's pool association or null (#6320)", () => {
    const snapshot = normalizeRegistryPayload(
      {
        "JSONbored/funded": { emission_share: 0.02, pool_id: "pool-74", subnet_id: 74 },
        "JSONbored/organic": { emission_share: 0.01 },
      },
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    );
    const byName = Object.fromEntries(snapshot.repositories.map((r) => [r.repo, r]));
    expect(getRepoPoolAssociation(byName["JSONbored/funded"])).toEqual({ poolId: "pool-74", subnetId: 74 });
    expect(getRepoPoolAssociation(byName["JSONbored/organic"])).toBeNull();
    // A missing/undefined config (an unregistered repo) reads back as no association, never throws.
    expect(getRepoPoolAssociation(null)).toBeNull();
    expect(getRepoPoolAssociation(undefined)).toBeNull();
  });

  it("normalizes repository-list and array payload shapes defensively", () => {
    const fromObjectMap = normalizeRegistryPayload(
      {
        "JSONbored/loopover": { emission_share: 0.03 },
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
          repository_full_name: "JSONbored/loopover",
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
    expect(fromObjectMap.repositories.map((repo) => repo.repo)).toEqual(["JSONbored/loopover"]);
    expect(fromObjectMap.repositories[0]).toMatchObject({
      repo: "JSONbored/loopover",
      issueDiscoveryShare: DEFAULT_ISSUE_DISCOVERY_SHARE,
    });
    expect(fromArray.repositories.map((repo) => repo.repo)).toEqual(["JSONbored/loopover", "bad/numbers"]);
    expect(fromArray.repositories.find((repo) => repo.repo === "bad/numbers")).toMatchObject({
      emissionShare: 0,
      issueDiscoveryShare: DEFAULT_ISSUE_DISCOVERY_SHARE,
    });
    expect(empty.repoCount).toBe(0);
  });

  it("persists and reads the latest snapshot from D1", async () => {
    const env = createTestEnv();
    const snapshot = normalizeRegistryPayload(
      { "JSONbored/loopover": { emission_share: 0.02, issue_discovery_share: 0.5 } },
      { kind: "raw-github", url: "https://example.test/master_repositories.json" },
      "2026-05-22T00:00:00.000Z",
    );

    await persistRegistrySnapshot(env, snapshot);
    const latest = await getLatestRegistrySnapshot(env);

    expect(latest?.repositories[0]?.repo).toBe("JSONbored/loopover");
    expect(latest?.source.kind).toBe("raw-github");
  });

  it("marks previously registered repos as unregistered when they disappear from the latest snapshot", async () => {
    const env = createCloudTestEnv();
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "JSONbored/loopover": { emission_share: 0.02, issue_discovery_share: 0 },
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

    await expect(getRepository(env, "JSONbored/loopover")).resolves.toMatchObject({
      isRegistered: false,
      registryConfig: null,
    });
    await expect(getRepository(env, "JSONbored/awesome-claude")).resolves.toMatchObject({
      isRegistered: true,
      registryConfig: expect.objectContaining({ repo: "JSONbored/awesome-claude" }),
    });
  });

  it("updates an existing case-variant repo row instead of inserting a duplicate", async () => {
    const env = createCloudTestEnv();
    // A GitHub-sourced row already exists under canonical casing.
    await upsertRepositoryFromGitHub(env, { name: "loopover", full_name: "JSONbored/loopover", private: false, owner: { login: "JSONbored" } });

    // The registry supplies the same repo with different casing.
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "jsonbored/loopover": { emission_share: 0.02, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "fixture://registry" },
        "2026-05-22T00:00:00.000Z",
      ),
    );

    // The existing canonical row is updated to registered -- no duplicate primary-key row.
    await expect(getRepository(env, "JSONbored/loopover")).resolves.toMatchObject({ isRegistered: true });
    const rows = await env.DB.prepare("SELECT full_name FROM repositories WHERE lower(full_name) = ?").bind("jsonbored/loopover").all();
    expect(rows.results).toHaveLength(1);
    expect((rows.results[0] as { full_name: string }).full_name).toBe("JSONbored/loopover");
  });

  it("does not de-register a repo whose snapshot casing differs from the stored row", async () => {
    const env = createCloudTestEnv();
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/loopover": { emission_share: 0.02, issue_discovery_share: 0 } }, { kind: "raw-github", url: "fixture://old" }, "2026-05-22T00:00:00.000Z"),
    );
    // The next snapshot uses different casing for the same repo.
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "jsonbored/loopover": { emission_share: 0.02, issue_discovery_share: 0 } }, { kind: "raw-github", url: "fixture://new" }, "2026-05-23T00:00:00.000Z"),
    );

    await expect(getRepository(env, "JSONbored/loopover")).resolves.toMatchObject({ isRegistered: true });
    const rows = await env.DB.prepare("SELECT full_name FROM repositories WHERE lower(full_name) = ?").bind("jsonbored/loopover").all();
    expect(rows.results).toHaveLength(1);
  });

  it("does not de-register existing repos when the snapshot is empty", async () => {
    const env = createCloudTestEnv();
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload({ "JSONbored/loopover": { emission_share: 0.02, issue_discovery_share: 0 } }, { kind: "raw-github", url: "fixture://seed" }, "2026-05-22T00:00:00.000Z"),
    );
    // An empty snapshot (e.g. a failed/empty registry fetch) must preserve registrations, not wipe them.
    await persistRegistrySnapshot(env, normalizeRegistryPayload({}, { kind: "raw-github", url: "fixture://empty" }, "2026-05-23T00:00:00.000Z"));
    await expect(getRepository(env, "JSONbored/loopover")).resolves.toMatchObject({ isRegistered: true });
  });

  it("collapses case-variant duplicates within a single snapshot to one row", async () => {
    const env = createCloudTestEnv();
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        {
          "JSONbored/loopover": { emission_share: 0.02, issue_discovery_share: 0 },
          "jsonbored/loopover": { emission_share: 0.03, issue_discovery_share: 0 },
        },
        { kind: "raw-github", url: "fixture://dup-casing" },
        "2026-05-22T00:00:00.000Z",
      ),
    );
    const rows = await env.DB.prepare("SELECT full_name FROM repositories WHERE lower(full_name) = ?").bind("jsonbored/loopover").all();
    expect(rows.results).toHaveLength(1);
    await expect(getRepository(env, "JSONbored/loopover")).resolves.toMatchObject({ isRegistered: true });
  });

  it("falls back to raw GitHub when registry API probes fail", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("raw.githubusercontent.com")) {
        return Response.json({ "JSONbored/loopover": { emission_share: 0.02, issue_discovery_share: 0.5 } });
      }
      return new Response("not found", { status: 404 });
    });

    const snapshot = await refreshRegistry(createTestEnv());

    expect(snapshot.source.kind).toBe("raw-github");
    expect(snapshot.warnings.length).toBeGreaterThan(0);
    expect(snapshot.repositories[0]?.repo).toBe("JSONbored/loopover");
  });

  it("marks the sync run as error when every registry source fails (#9314)", async () => {
    // Cover both warning-push branches: non-OK responses and thrown fetch errors.
    let probeIndex = 0;
    vi.stubGlobal("fetch", async () => {
      probeIndex += 1;
      if (probeIndex % 2 === 0) throw new Error(`network down ${probeIndex}`);
      return new Response("not found", { status: 404 });
    });

    const env = createTestEnv();
    await expect(refreshRegistry(env)).rejects.toThrow("No registry source returned usable data.");

    const row = await env.DB.prepare("SELECT status, warnings_json, error_summary FROM sync_runs WHERE job_type = ? ORDER BY rowid DESC LIMIT 1")
      .bind("refresh-registry")
      .first<{ status: string; warnings_json: string; error_summary: string }>();
    expect(row?.status).toBe("error");
    expect(row?.error_summary).toContain("No registry source returned usable data.");
    const warnings = JSON.parse(row?.warnings_json ?? "[]") as string[];
    // 6 API candidates + the GITTENSOR_REGISTRY_URL raw fallback.
    expect(warnings).toHaveLength(7);
    expect(warnings.every((warning) => warning.startsWith("Registry probe failed:"))).toBe(true);
  });
});
