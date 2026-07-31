import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { CACHE_OUTCOME_EVENTS, CACHE_SURFACES, CACHE_SURFACE_NOTES, cacheOutcomeMetadata } from "../../src/services/cache-outcome";
import { createTestEnv } from "../helpers/d1";
import { recordAuditEvent } from "../../src/db/repositories";

type TestEnv = ReturnType<typeof createTestEnv>;

/** Read the stored metadata bag for the most recent event of `eventType`, straight from the row. */
async function storedMetadata(env: TestEnv, eventType: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("select metadata_json from audit_events where event_type = ? order by created_at desc limit 1")
    .bind(eventType)
    .first<{ metadata_json: string }>();
  return JSON.parse(row?.metadata_json ?? "{}") as Record<string, unknown>;
}

/** Every source file under src/, so the guard below scans the real tree rather than a hand-kept list. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("cache outcome vocabulary (#10208)", () => {
  it("GUARD: every cache-shaped audit event in src/** is classified", () => {
    // The whole point of the module. Eight surfaces already drifted into three vocabularies for one concept
    // (`*_cache_hit`, `*_reuse`, `*_one_shot_skip`) because nothing forced a new one to be registered. This
    // fails the build if a ninth appears unclassified, so the single aggregate query can never go quietly
    // incomplete again -- the failure mode that made the naive query understate ai_review by 177x.
    const pattern = /"(github_app\.[a-z_]*(?:cache_hit|cache_miss|one_shot_skip|one_shot_reuse|frozen_reuse))"/g;
    const found = new Set<string>();
    for (const file of sourceFiles("src")) {
      for (const match of readFileSync(file, "utf8").matchAll(pattern)) found.add(match[1]!);
    }

    // Sanity: the scan itself must be finding things, or an accidentally-broken regex would make this pass
    // vacuously forever.
    expect(found.size).toBeGreaterThanOrEqual(20);

    const unclassified = [...found].filter((eventType) => !(eventType in CACHE_OUTCOME_EVENTS)).sort();
    expect(unclassified).toEqual([]);
  });

  it("GUARD: no classified event has gone stale — every registered event still exists in src/**", () => {
    // The other direction: an event removed from the code but left registered here makes the registry lie
    // about what the aggregate covers.
    const all = sourceFiles("src")
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const missing = Object.keys(CACHE_OUTCOME_EVENTS).filter((eventType) => !all.includes(`"${eventType}"`)).sort();
    expect(missing).toEqual([]);
  });

  it("classifies every registered event to a declared surface and a real outcome", () => {
    for (const [eventType, entry] of Object.entries(CACHE_OUTCOME_EVENTS)) {
      expect(CACHE_SURFACES).toContain(entry.surface);
      expect(["hit", "miss"]).toContain(entry.outcome);
      expect(cacheOutcomeMetadata(eventType)).toEqual({ cache_surface: entry.surface, cache_outcome: entry.outcome });
    }
  });

  it("counts the three vocabularies as one: reuse and one_shot_skip are hits, not a separate concept", () => {
    // The measured failure this module exists for: `ai_review_one_shot_reuse` / `ai_review_frozen_reuse` are
    // 811 of the AI review cache's 1039 avoided runs, and contain neither "cache" nor "hit".
    expect(cacheOutcomeMetadata("github_app.ai_review_one_shot_reuse")).toEqual({ cache_surface: "ai_review", cache_outcome: "hit" });
    expect(cacheOutcomeMetadata("github_app.ai_review_frozen_reuse")).toEqual({ cache_surface: "ai_review", cache_outcome: "hit" });
    expect(cacheOutcomeMetadata("github_app.ai_slop_one_shot_skip")).toEqual({ cache_surface: "ai_slop", cache_outcome: "hit" });
    expect(cacheOutcomeMetadata("github_app.linked_issue_satisfaction_one_shot_skip")).toEqual({
      cache_surface: "linked_issue_satisfaction",
      cache_outcome: "hit",
    });
  });

  it("returns undefined for an unregistered event rather than guessing from its name", () => {
    // Inferring from the name would make the exhaustiveness guard above unfalsifiable.
    expect(cacheOutcomeMetadata("github_app.some_future_cache_hit")).toBeUndefined();
    expect(cacheOutcomeMetadata("github_app.pull_request_opened")).toBeUndefined();
    expect(cacheOutcomeMetadata("")).toBeUndefined();
  });

  it("flags grounding as not comparable to the fingerprint-keyed surfaces", () => {
    expect(CACHE_SURFACE_NOTES.grounding).toMatch(/churn/);
    // Only grounding carries a caveat today; the others are genuinely comparable.
    expect(Object.keys(CACHE_SURFACE_NOTES)).toEqual(["grounding"]);
  });
});

describe("recordAuditEvent stamps the cache outcome centrally (#10208)", () => {
  it("adds cache_surface/cache_outcome to a cache event without the call site doing anything", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "github_app.ai_review_one_shot_reuse",
      targetKey: "JSONbored/loopover#1",
      outcome: "completed",
      detail: "reused",
      metadata: { repoFullName: "JSONbored/loopover" },
    });
    const metadata = await storedMetadata(env, "github_app.ai_review_one_shot_reuse");
    expect(metadata.cache_surface).toBe("ai_review");
    expect(metadata.cache_outcome).toBe("hit");
    // The caller's own metadata survives alongside it.
    expect(metadata.repoFullName).toBe("JSONbored/loopover");
  });

  it("stamps a miss, and a cache event that carries no metadata of its own", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, { eventType: "github_app.grounding_cache_miss", targetKey: "JSONbored/loopover", outcome: "completed" });
    expect(await storedMetadata(env, "github_app.grounding_cache_miss")).toEqual({ cache_surface: "grounding", cache_outcome: "miss" });
  });

  it("leaves a non-cache event's metadata exactly as the caller passed it", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "github_app.pull_request_opened",
      targetKey: "JSONbored/loopover#2",
      outcome: "completed",
      metadata: { pull: 2 },
    });
    expect(await storedMetadata(env, "github_app.pull_request_opened")).toEqual({ pull: 2 });
  });

  it("stores an empty bag for a non-cache event that carries no metadata", async () => {
    // The fourth corner of the two-by-two (cache/non-cache x metadata/none): a non-cache event with nothing of
    // its own must still round-trip to {}, not to the classification and not to null.
    const env = createTestEnv();
    await recordAuditEvent(env, { eventType: "github_app.pull_request_closed", targetKey: "JSONbored/loopover#4", outcome: "completed" });
    expect(await storedMetadata(env, "github_app.pull_request_closed")).toEqual({});
  });

  it("never overwrites a value the call site set explicitly", async () => {
    // An explicit value at a call site is more specific than the classification; silently replacing it would
    // make this stamping lossy.
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "github_app.ai_slop_cache_hit",
      targetKey: "JSONbored/loopover#3",
      outcome: "completed",
      metadata: { cache_outcome: "miss" },
    });
    const metadata = await storedMetadata(env, "github_app.ai_slop_cache_hit");
    expect(metadata.cache_outcome).toBe("miss");
    expect(metadata.cache_surface).toBe("ai_slop");
  });
});
