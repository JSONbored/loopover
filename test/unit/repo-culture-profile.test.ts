import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertRecentMergedPullRequest } from "../../src/db/repositories";
import * as repositoriesModule from "../../src/db/repositories";
import {
  deriveRepoCultureProfile,
  extractRepoCultureProfile,
  MIN_SAMPLE_PULL_REQUESTS,
  prSizeBand,
  REPO_CULTURE_PROFILE_SCHEMA_VERSION,
} from "../../src/review/repo-culture-profile";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import type { RecentMergedPullRequestRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

const REPO = "acme/widgets";

function mergedPr(overrides: Partial<RecentMergedPullRequestRecord> & { number: number }): RecentMergedPullRequestRecord {
  return {
    repoFullName: REPO,
    title: `PR #${overrides.number}`,
    authorLogin: "alice",
    mergedAt: "2026-06-01T00:00:00.000Z",
    labels: [],
    linkedIssues: [],
    changedFiles: ["src/a.ts"],
    payload: { body: "A description." },
    ...overrides,
  };
}

async function seedMergedPr(env: ReturnType<typeof createTestEnv>, overrides: Partial<RecentMergedPullRequestRecord> & { number: number }): Promise<void> {
  await upsertRecentMergedPullRequest(env, mergedPr(overrides));
}

// ── prSizeBand (pure banding) ────────────────────────────────────────────────────────────────────

describe("prSizeBand", () => {
  it("bands changed-file counts into tiny/small/medium/large", () => {
    expect(prSizeBand(0)).toBe("tiny");
    expect(prSizeBand(3)).toBe("tiny");
    expect(prSizeBand(4)).toBe("small");
    expect(prSizeBand(10)).toBe("small");
    expect(prSizeBand(11)).toBe("medium");
    expect(prSizeBand(30)).toBe("medium");
    expect(prSizeBand(31)).toBe("large");
  });
});

// ── deriveRepoCultureProfile (pure core) ────────────────────────────────────────────────────────

describe("deriveRepoCultureProfile", () => {
  it("returns the insufficient-data branch when below MIN_SAMPLE_PULL_REQUESTS", () => {
    const prs = [mergedPr({ number: 1 }), mergedPr({ number: 2 })];
    const profile = deriveRepoCultureProfile(REPO, prs, "2026-07-05T00:00:00.000Z");
    expect(profile).toEqual({
      version: REPO_CULTURE_PROFILE_SCHEMA_VERSION,
      present: false,
      repoFullName: REPO,
      generatedAt: "2026-07-05T00:00:00.000Z",
      reason: "only 2 merged pull request(s) on record (need at least 5)",
    });
  });

  it("returns the insufficient-data branch for zero merged PRs", () => {
    const profile = deriveRepoCultureProfile(REPO, [], "2026-07-05T00:00:00.000Z");
    expect(profile.present).toBe(false);
    if (profile.present) throw new Error("expected insufficient-data branch");
    expect(profile.reason).toContain("only 0 merged pull request(s)");
  });

  it("derives median PR size (odd sample), description length, and label frequency from a populated sample", () => {
    const prs: RecentMergedPullRequestRecord[] = [
      mergedPr({ number: 1, changedFiles: ["a.ts"], labels: ["bug"], payload: { body: "x".repeat(10) } }),
      mergedPr({ number: 2, changedFiles: ["a.ts", "b.ts"], labels: ["bug"], payload: { body: "x".repeat(20) } }),
      mergedPr({ number: 3, changedFiles: ["a.ts", "b.ts", "c.ts"], labels: ["feature"], payload: { body: "x".repeat(30) } }),
      mergedPr({ number: 4, changedFiles: Array.from({ length: 5 }, (_, i) => `f${i}.ts`), labels: [], payload: { body: "x".repeat(40) } }),
      mergedPr({ number: 5, changedFiles: Array.from({ length: 7 }, (_, i) => `g${i}.ts`), labels: ["bug"], payload: { body: "x".repeat(50) } }),
    ];
    const profile = deriveRepoCultureProfile(REPO, prs, "2026-07-05T00:00:00.000Z");
    expect(profile.present).toBe(true);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.version).toBe(REPO_CULTURE_PROFILE_SCHEMA_VERSION);
    expect(profile.repoFullName).toBe(REPO);
    // changed-file counts: 1,2,3,5,7 → median (middle of 5) = 3
    expect(profile.pullRequestNorms).toEqual({
      sampleSize: 5,
      medianChangedFiles: 3,
      medianSizeBand: "tiny",
      medianDescriptionLength: 30,
    });
    // labels: bug x3 (0.6), feature x1 (0.2)
    expect(profile.commonLabels).toEqual([
      { label: "bug", frequency: 0.6 },
      { label: "feature", frequency: 0.2 },
    ]);
  });

  it("computes an even-length median with a 6-sample set (average of the two middle changed-file counts)", () => {
    const prs = [1, 2, 3, 4, 5, 6].map((n) =>
      mergedPr({ number: n, changedFiles: Array.from({ length: n }, (_, i) => `f${i}.ts`) }),
    );
    const profile = deriveRepoCultureProfile(REPO, prs, "2026-07-05T00:00:00.000Z");
    expect(profile.present).toBe(true);
    if (!profile.present) throw new Error("expected present profile");
    // counts 1..6, median = (3+4)/2 = 3.5
    expect(profile.pullRequestNorms.medianChangedFiles).toBe(3.5);
  });

  it("degrades a non-string payload.body to a 0-length description (fail-safe on a sparse/legacy row)", () => {
    const prs = Array.from({ length: MIN_SAMPLE_PULL_REQUESTS }, (_, i) =>
      mergedPr({ number: i + 1, payload: {} }),
    );
    const profile = deriveRepoCultureProfile(REPO, prs, "2026-07-05T00:00:00.000Z");
    expect(profile.present).toBe(true);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.pullRequestNorms.medianDescriptionLength).toBe(0);
  });

  it("returns no commonLabels when no sampled PR carries any label", () => {
    const prs = Array.from({ length: MIN_SAMPLE_PULL_REQUESTS }, (_, i) => mergedPr({ number: i + 1, labels: [] }));
    const profile = deriveRepoCultureProfile(REPO, prs, "2026-07-05T00:00:00.000Z");
    expect(profile.present).toBe(true);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.commonLabels).toEqual([]);
  });

  it("caps commonLabels at 8 entries, breaking ties alphabetically", () => {
    const labels = Array.from({ length: 10 }, (_, i) => `label-${String.fromCharCode(97 + i)}`);
    const prs = Array.from({ length: MIN_SAMPLE_PULL_REQUESTS }, (_, i) => mergedPr({ number: i + 1, labels: [...labels] }));
    const profile = deriveRepoCultureProfile(REPO, prs, "2026-07-05T00:00:00.000Z");
    expect(profile.present).toBe(true);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.commonLabels).toHaveLength(8);
    expect(profile.commonLabels.map((l) => l.label)).toEqual(labels.slice(0, 8).sort());
  });
});

// ── extractRepoCultureProfile (I/O + cache) ─────────────────────────────────────────────────────

describe("extractRepoCultureProfile: cache + invalidation", () => {
  it("derives fresh, persists to the cache (including populated commonLabels), and returns the same result on a cache HIT (no re-derive)", async () => {
    const env = createTestEnv({});
    for (let i = 1; i <= MIN_SAMPLE_PULL_REQUESTS; i++) await seedMergedPr(env, { number: i, labels: ["bug"] });

    const first = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T00:00:00.000Z" });
    expect(first.present).toBe(true);
    if (!first.present) throw new Error("expected present profile");
    expect(first.commonLabels).toEqual([{ label: "bug", frequency: 1 }]);

    // A cache hit must NOT re-read recent_merged_pull_requests — prove it by adding a new merged PR to the
    // table WITHOUT going through the cache-invalidating count check (impossible to fully isolate without
    // stubbing, so instead we assert the returned generatedAt is the FIRST call's timestamp, proving reuse).
    // Round-tripping through the cache also exercises the JSON reconstruction of a POPULATED commonLabels array.
    const second = await extractRepoCultureProfile(env, REPO, { now: "2026-07-06T00:00:00.000Z" });
    expect(second).toEqual(first);
    expect(second.generatedAt).toBe("2026-07-05T00:00:00.000Z");
  });

  it("round-trips an insufficient-data (present: false) snapshot through a cache HIT unchanged", async () => {
    const env = createTestEnv({});
    // Below MIN_SAMPLE_PULL_REQUESTS, so the first derive persists a `present: false` snapshot.
    await seedMergedPr(env, { number: 1 });
    const first = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T00:00:00.000Z" });
    expect(first.present).toBe(false);

    const second = await extractRepoCultureProfile(env, REPO, { now: "2026-07-06T00:00:00.000Z" });
    expect(second).toEqual(first);
  });

  it("invalidates on TTL expiry (maxAgeMs), re-deriving with the new generatedAt", async () => {
    const env = createTestEnv({});
    for (let i = 1; i <= MIN_SAMPLE_PULL_REQUESTS; i++) await seedMergedPr(env, { number: i });
    const first = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T00:00:00.000Z" });
    expect(first.present).toBe(true);

    const stale = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T00:00:00.000Z", maxAgeMs: -1 });
    // maxAgeMs: -1 makes the freshly-written snapshot immediately stale (age >= 0 > -1) → forced re-derive.
    expect(stale.generatedAt).toBe("2026-07-05T00:00:00.000Z");
    expect(stale.present).toBe(true);
  });

  it("invalidates on merged-PR-COUNT drift even inside the TTL window (a new merged PR forces a re-derive)", async () => {
    const env = createTestEnv({});
    for (let i = 1; i <= MIN_SAMPLE_PULL_REQUESTS; i++) await seedMergedPr(env, { number: i });
    const first = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T00:00:00.000Z" });
    expect(first.present).toBe(true);
    if (!first.present) throw new Error("expected present profile");
    expect(first.pullRequestNorms.sampleSize).toBe(MIN_SAMPLE_PULL_REQUESTS);

    // One more merged PR lands — the cached snapshot's sampleCountAtGeneration no longer matches the live COUNT.
    await seedMergedPr(env, { number: MIN_SAMPLE_PULL_REQUESTS + 1 });
    const refreshed = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T01:00:00.000Z" });
    expect(refreshed.present).toBe(true);
    if (!refreshed.present) throw new Error("expected present profile");
    expect(refreshed.pullRequestNorms.sampleSize).toBe(MIN_SAMPLE_PULL_REQUESTS + 1);
    expect(refreshed.generatedAt).toBe("2026-07-05T01:00:00.000Z");
  });

  it("reuses a fresh culture-profile cache when a repo has more than the 200 sampled merged PRs", async () => {
    const env = createTestEnv({});
    for (let i = 1; i <= 201; i++) {
      await seedMergedPr(env, {
        number: i,
        mergedAt: new Date(Date.UTC(2026, 5, i)).toISOString(),
        labels: ["bug"],
      });
    }

    const first = await extractRepoCultureProfile(env, REPO, {
      now: "2026-07-05T00:00:00.000Z",
      maxAgeMs: Number.POSITIVE_INFINITY,
    });
    expect(first.present).toBe(true);
    if (!first.present) throw new Error("expected present profile");
    expect(first.pullRequestNorms.sampleSize).toBe(200);

    const second = await extractRepoCultureProfile(env, REPO, {
      now: "2026-07-05T01:00:00.000Z",
      maxAgeMs: Number.POSITIVE_INFINITY,
    });
    expect(second).toEqual(first);
    expect(second.generatedAt).toBe("2026-07-05T00:00:00.000Z");

    const snapshotCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM signal_snapshots WHERE signal_type = ? AND target_key = ?",
    )
      .bind("repo-culture-profile", REPO)
      .first<{ count: number }>();
    expect(snapshotCount?.count).toBe(1);
  });

  it("options.refresh forces a fresh derive even with a warm, non-stale cache", async () => {
    const env = createTestEnv({});
    for (let i = 1; i <= MIN_SAMPLE_PULL_REQUESTS; i++) await seedMergedPr(env, { number: i });
    const first = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T00:00:00.000Z" });
    expect(first.present).toBe(true);

    const forced = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T02:00:00.000Z", refresh: true });
    expect(forced.generatedAt).toBe("2026-07-05T02:00:00.000Z");
  });

  it("returns the insufficient-data branch (never throws) when the repo has no merged-PR history at all", async () => {
    const env = createTestEnv({});
    const profile = await extractRepoCultureProfile(env, "acme/empty-repo", { now: "2026-07-05T00:00:00.000Z" });
    expect(profile).toEqual({
      version: REPO_CULTURE_PROFILE_SCHEMA_VERSION,
      present: false,
      repoFullName: "acme/empty-repo",
      generatedAt: "2026-07-05T00:00:00.000Z",
      reason: "only 0 merged pull request(s) on record (need at least 5)",
    });
  });

  it("fail-safe: a THROWING storage read degrades to the insufficient-data branch (never throws)", async () => {
    const env = createTestEnv({});
    const throwingDb = {
      prepare: vi.fn(() => {
        throw new Error("D1 unavailable");
      }),
      batch: vi.fn(async () => []),
    } as unknown as D1Database;
    const brokenEnv = { ...env, DB: throwingDb };
    const profile = await extractRepoCultureProfile(brokenEnv, REPO, { now: "2026-07-05T00:00:00.000Z" });
    expect(profile.present).toBe(false);
    if (profile.present) throw new Error("expected insufficient-data branch");
    expect(profile.reason).toBe("repo merged-pull-request history is unavailable (storage read failed)");
  });

  it("a cache-write failure never fails the caller — the derived profile is still returned", async () => {
    const env = createTestEnv({});
    for (let i = 1; i <= MIN_SAMPLE_PULL_REQUESTS; i++) await seedMergedPr(env, { number: i });
    const realPrepare = env.DB.prepare.bind(env.DB);
    const flakyDb = {
      prepare: vi.fn((sql: string) => {
        if (/INSERT INTO signal_snapshots/i.test(sql)) throw new Error("write failed");
        return realPrepare(sql);
      }),
      batch: env.DB.batch?.bind(env.DB),
    } as unknown as D1Database;
    const flakyEnv = { ...env, DB: flakyDb };
    const profile = await extractRepoCultureProfile(flakyEnv, REPO, { now: "2026-07-05T00:00:00.000Z" });
    expect(profile.present).toBe(true);
  });

  it("a malformed cached payload (foreign/corrupted row) is treated as a cache miss, not a throw", async () => {
    const env = createTestEnv({});
    for (let i = 1; i <= MIN_SAMPLE_PULL_REQUESTS; i++) await seedMergedPr(env, { number: i });
    // Write a foreign signal_snapshots row under the SAME signal type + target key with a payload shape that
    // has neither `present: false` nor a well-formed `present: true` + pullRequestNorms object.
    await env.DB.prepare(
      "INSERT INTO signal_snapshots (id, signal_type, target_key, repo_full_name, payload_json, generated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind("foreign-1", "repo-culture-profile", REPO, REPO, JSON.stringify({ unexpected: true }), "2026-07-05T00:00:00.000Z")
      .run();
    // maxAgeMs: Infinity isolates the malformed-payload behavior from the (real-wall-clock) TTL check, which
    // would otherwise independently reject this snapshot as stale before profileFromJson ever runs.
    const profile = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T01:00:00.000Z", maxAgeMs: Number.POSITIVE_INFINITY });
    // Falls through to a fresh derive (the malformed snapshot is discarded as a miss).
    expect(profile.present).toBe(true);
    expect(profile.generatedAt).toBe("2026-07-05T01:00:00.000Z");
  });

  it("reconstructs a well-formed present:false cached payload, defaulting any missing sub-fields (sparse/legacy row)", async () => {
    const env = createTestEnv({});
    // sampleCountAtGeneration: 0 matches the live COUNT (no merged PRs seeded), so this reads as a cache HIT.
    await env.DB.prepare(
      "INSERT INTO signal_snapshots (id, signal_type, target_key, repo_full_name, payload_json, generated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind("sparse-false-1", "repo-culture-profile", REPO, REPO, JSON.stringify({ present: false, sampleCountAtGeneration: 0 }), "2026-07-05T00:00:00.000Z")
      .run();
    const profile = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T02:00:00.000Z", maxAgeMs: Number.POSITIVE_INFINITY });
    expect(profile).toEqual({
      version: REPO_CULTURE_PROFILE_SCHEMA_VERSION,
      present: false,
      repoFullName: "",
      generatedAt: "",
      reason: "",
    });
  });

  it("treats an empty-string generated_at as infinitely stale (falsy generatedAt branch)", async () => {
    const env = createTestEnv({});
    for (let i = 1; i <= MIN_SAMPLE_PULL_REQUESTS; i++) await seedMergedPr(env, { number: i });
    await env.DB.prepare(
      "INSERT INTO signal_snapshots (id, signal_type, target_key, repo_full_name, payload_json, generated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind("blank-generated-at-1", "repo-culture-profile", REPO, REPO, JSON.stringify({ present: true, pullRequestNorms: {}, sampleCountAtGeneration: MIN_SAMPLE_PULL_REQUESTS }), "")
      .run();
    // A finite maxAgeMs is required here: snapshotAgeMs also returns +Infinity for a falsy generatedAt, and
    // Infinity > Infinity is false, so an Infinity maxAgeMs would (incorrectly, for this test's purpose) never
    // treat it as stale. A large-but-finite TTL isolates the falsy-generatedAt branch from a real TTL check.
    const profile = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T02:00:00.000Z", maxAgeMs: 1_000_000_000_000 });
    expect(profile.generatedAt).toBe("2026-07-05T02:00:00.000Z");
  });

  it("treats an unparseable generated_at string as infinitely stale (non-finite Date.parse branch)", async () => {
    const env = createTestEnv({});
    for (let i = 1; i <= MIN_SAMPLE_PULL_REQUESTS; i++) await seedMergedPr(env, { number: i });
    await env.DB.prepare(
      "INSERT INTO signal_snapshots (id, signal_type, target_key, repo_full_name, payload_json, generated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        "garbage-generated-at-1",
        "repo-culture-profile",
        REPO,
        REPO,
        JSON.stringify({ present: true, pullRequestNorms: {}, sampleCountAtGeneration: MIN_SAMPLE_PULL_REQUESTS }),
        "not-a-real-date",
      )
      .run();
    // Same Infinity-vs-Infinity reasoning as the empty-generatedAt test above: a finite maxAgeMs is required.
    const profile = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T02:00:00.000Z", maxAgeMs: 1_000_000_000_000 });
    expect(profile.generatedAt).toBe("2026-07-05T02:00:00.000Z");
  });

  it("treats a missing sampleCountAtGeneration as -1 (never matches a real COUNT, so it's still a cache miss)", async () => {
    const env = createTestEnv({});
    for (let i = 1; i <= MIN_SAMPLE_PULL_REQUESTS; i++) await seedMergedPr(env, { number: i });
    await env.DB.prepare(
      "INSERT INTO signal_snapshots (id, signal_type, target_key, repo_full_name, payload_json, generated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        "no-count-1",
        "repo-culture-profile",
        REPO,
        REPO,
        JSON.stringify({
          present: true,
          repoFullName: REPO,
          generatedAt: "2026-07-05T00:00:00.000Z",
          pullRequestNorms: { sampleSize: 5, medianChangedFiles: 2, medianSizeBand: "tiny", medianDescriptionLength: 10 },
          commonLabels: [],
          // sampleCountAtGeneration deliberately omitted.
        }),
        "2026-07-05T00:00:00.000Z",
      )
      .run();
    const profile = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T02:00:00.000Z", maxAgeMs: Number.POSITIVE_INFINITY });
    // -1 never equals the real COUNT (5), so this is a miss → a fresh derive with the new generatedAt.
    expect(profile.generatedAt).toBe("2026-07-05T02:00:00.000Z");
  });

  it("reconstructs a well-formed present:true cached payload, defaulting any missing sub-fields (sparse/legacy row)", async () => {
    const env = createTestEnv({});
    // A sparse-but-parseable cached row: `present: true` + a `pullRequestNorms` object, but every individual
    // field (including repoFullName/generatedAt/commonLabels) omitted — exercises every `??`/type-guard
    // fallback in profileFromJson's present:true reconstruction.
    await env.DB.prepare(
      "INSERT INTO signal_snapshots (id, signal_type, target_key, repo_full_name, payload_json, generated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        "sparse-1",
        "repo-culture-profile",
        REPO,
        REPO,
        JSON.stringify({ present: true, pullRequestNorms: {}, sampleCountAtGeneration: 5 }),
        "2026-07-05T00:00:00.000Z",
      )
      .run();
    // countRecentMergedPullRequests must match sampleCountAtGeneration (5) for this to read as a cache HIT.
    for (let i = 1; i <= 5; i++) await seedMergedPr(env, { number: i });
    const profile = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T02:00:00.000Z", maxAgeMs: Number.POSITIVE_INFINITY });
    expect(profile).toEqual({
      version: REPO_CULTURE_PROFILE_SCHEMA_VERSION,
      present: true,
      repoFullName: "",
      generatedAt: "",
      pullRequestNorms: { sampleSize: 0, medianChangedFiles: 0, medianSizeBand: "tiny", medianDescriptionLength: 0 },
      commonLabels: [],
    });
  });

  it("defaults a sparse commonLabels entry's missing label/frequency fields when reconstructing from cache", async () => {
    const env = createTestEnv({});
    await env.DB.prepare(
      "INSERT INTO signal_snapshots (id, signal_type, target_key, repo_full_name, payload_json, generated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        "sparse-labels-1",
        "repo-culture-profile",
        REPO,
        REPO,
        JSON.stringify({
          present: true,
          repoFullName: REPO,
          generatedAt: "2026-07-05T00:00:00.000Z",
          pullRequestNorms: { sampleSize: 5, medianChangedFiles: 2, medianSizeBand: "tiny", medianDescriptionLength: 10 },
          commonLabels: [{}],
          sampleCountAtGeneration: 5,
        }),
        "2026-07-05T00:00:00.000Z",
      )
      .run();
    for (let i = 1; i <= 5; i++) await seedMergedPr(env, { number: i });
    const profile = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T02:00:00.000Z", maxAgeMs: Number.POSITIVE_INFINITY });
    expect(profile.present).toBe(true);
    if (!profile.present) throw new Error("expected present profile");
    expect(profile.commonLabels).toEqual([{ label: "", frequency: 0 }]);
  });
});

// ── cache hit/miss telemetry (#4509) ────────────────────────────────────────────────────────────

describe("extractRepoCultureProfile: cache hit/miss telemetry (#4509)", () => {
  afterEach(() => resetMetrics());

  async function auditEvent(env: ReturnType<typeof createTestEnv>, eventType: string) {
    return env.DB.prepare("SELECT outcome, target_key FROM audit_events WHERE event_type = ? AND target_key = ?")
      .bind(eventType, REPO)
      .first<{ outcome: string; target_key: string }>();
  }

  it("INVARIANT: a cache HIT fires exactly the hit counter/audit-event pair, and NOT the miss pair", async () => {
    const env = createTestEnv({});
    for (let i = 1; i <= MIN_SAMPLE_PULL_REQUESTS; i++) await seedMergedPr(env, { number: i });
    await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T00:00:00.000Z" }); // first call: a miss (cold cache)
    resetMetrics();
    await env.DB.prepare("DELETE FROM audit_events").run(); // isolate to the SECOND call's telemetry only

    const second = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T00:30:00.000Z" }); // within TTL, no drift
    expect(second.present).toBe(true);

    const rendered = await renderMetrics();
    expect(rendered).toContain("gittensory_repo_culture_profile_cache_hit_total 1");
    expect(rendered).not.toContain("gittensory_repo_culture_profile_cache_miss_total");
    const hitEvent = await auditEvent(env, "github_app.repo_culture_profile_cache_hit");
    expect(hitEvent?.outcome).toBe("completed");
    expect(await auditEvent(env, "github_app.repo_culture_profile_cache_miss")).toBeUndefined();
  });

  it("swallows a failing cache-hit audit-event write without throwing, still returning the cached profile", async () => {
    const env = createTestEnv({});
    for (let i = 1; i <= MIN_SAMPLE_PULL_REQUESTS; i++) await seedMergedPr(env, { number: i });
    await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T00:00:00.000Z" }); // populates the cache

    const writeSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 write error"));
    const second = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T00:30:00.000Z" }); // a cache hit
    writeSpy.mockRestore();

    expect(second.present).toBe(true); // the failed audit write never surfaces to the caller
  });

  it("INVARIANT: a cache MISS (TTL expired) fires exactly the miss counter/audit-event pair, and NOT the hit pair", async () => {
    const env = createTestEnv({});
    for (let i = 1; i <= MIN_SAMPLE_PULL_REQUESTS; i++) await seedMergedPr(env, { number: i });
    await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T00:00:00.000Z" }); // first call populates the cache
    resetMetrics();
    await env.DB.prepare("DELETE FROM audit_events").run();

    // maxAgeMs: -1 makes the freshly-written snapshot immediately stale, forcing a miss/re-derive.
    const second = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T00:00:00.000Z", maxAgeMs: -1 });
    expect(second.present).toBe(true);

    const rendered = await renderMetrics();
    expect(rendered).toContain("gittensory_repo_culture_profile_cache_miss_total 1");
    expect(rendered).not.toContain("gittensory_repo_culture_profile_cache_hit_total");
    const missEvent = await auditEvent(env, "github_app.repo_culture_profile_cache_miss");
    expect(missEvent?.outcome).toBe("completed");
    expect(await auditEvent(env, "github_app.repo_culture_profile_cache_hit")).toBeUndefined();
  });

  it("REGRESSION: the merged-PR-count drift-invalidation path is correctly counted as a miss, not silently uninstrumented", async () => {
    const env = createTestEnv({});
    for (let i = 1; i <= MIN_SAMPLE_PULL_REQUESTS; i++) await seedMergedPr(env, { number: i });
    const first = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T00:00:00.000Z" });
    expect(first.present).toBe(true);

    // A new merged PR lands — the cached snapshot's sampleCountAtGeneration no longer matches the live COUNT,
    // even though the TTL (maxAgeMs: POSITIVE_INFINITY below) never expires.
    await seedMergedPr(env, { number: MIN_SAMPLE_PULL_REQUESTS + 1 });
    resetMetrics();
    await env.DB.prepare("DELETE FROM audit_events").run();

    const refreshed = await extractRepoCultureProfile(env, REPO, { now: "2026-07-05T01:00:00.000Z", maxAgeMs: Number.POSITIVE_INFINITY });
    expect(refreshed.present).toBe(true);
    if (!refreshed.present) throw new Error("expected present profile");
    expect(refreshed.pullRequestNorms.sampleSize).toBe(MIN_SAMPLE_PULL_REQUESTS + 1); // confirms the drift path actually re-derived

    const rendered = await renderMetrics();
    expect(rendered).toContain("gittensory_repo_culture_profile_cache_miss_total 1");
    expect(rendered).not.toContain("gittensory_repo_culture_profile_cache_hit_total");
    expect((await auditEvent(env, "github_app.repo_culture_profile_cache_miss"))?.outcome).toBe("completed");
  });
});
