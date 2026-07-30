import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";
import { clearPublicStatsManifestOverrideCacheForTest } from "../../src/review/public-stats";
import { recordAuditEvent } from "../../src/db/repositories";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
import { contentDigest } from "../../src/review/decision-record";
import { ORB_GATE_SUBJECT_ID, type EvalScoreRecord } from "../../src/review/eval-score-records";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");

async function seedConfirmedPrecisionData(env: Env): Promise<void> {
  const store = createSignalStore(env);
  for (let i = 0; i < 20; i += 1) {
    const occurredAt = new Date(NOW - 1000 - i).toISOString();
    // #9966 made the DOWNLOADABLE corpus the only commitment source, so a record is publishable only where
    // /v1/public/eval-corpus can actually serve the cases behind it. That corpus is built from rule-FIRED
    // events joined to their overrides, and this fixture recorded only the overrides -- so it produced a
    // 0-case corpus, no commitment, and no record, which is why this suite went red on main.
    //
    // Seeding both halves restores what the fixture was always meant to represent: 20 decided cases a reader
    // can download and re-hash. Asserting `records: []` instead would have kept the suite green while
    // silently dropping the recordDigest-recomputability check these tests exist for.
    await store.recordRuleFired({ ruleId: "ai_consensus_defect", targetKey: `acme/widgets#${i + 1}`, outcome: "close", occurredAt });
    await store.recordHumanOverride({
      ruleId: "ai_consensus_defect",
      targetKey: `acme/widgets#${i + 1}`,
      verdict: i < 16 ? "confirmed" : "reversed",
      occurredAt,
    });
  }
  await recordAuditEvent(env, {
    eventType: "calibration.logic_backtest_run",
    targetKey: "rule",
    outcome: "completed",
    metadata: { corpusChecksum: "freeze-point-checksum", comparison: {} },
    createdAt: new Date(NOW - 60_000).toISOString(),
  });
}

describe("GET /v1/public/eval-scores (#9266, epic #8534, spec #9215)", () => {
  beforeEach(() => {
    clearPublicStatsManifestOverrideCacheForTest();
  });

  it("404s when LOOPOVER_PUBLIC_STATS is off (default) -- same flag as /v1/public/stats", async () => {
    const env = createTestEnv();
    const res = await createApp().request("/v1/public/eval-scores", {}, env);
    expect(res.status).toBe(404);
  });

  it("200s with an empty records array when there is no persisted backtest run yet", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "1" });
    const res = await createApp().request("/v1/public/eval-scores", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ records: [] });
  });

  it("returns records whose recordDigest is independently recomputable from the record's own content", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "1" });
    await seedConfirmedPrecisionData(env);

    const res = await createApp().request("/v1/public/eval-scores", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: EvalScoreRecord[] };
    expect(body.records).toHaveLength(1);
    const [record] = body.records;
    expect(record?.workUnit).toEqual({ kind: "outcome_confirmed_precision", ruleId: "ai_consensus_defect" });
    // coverage is 1, not null: abstained is structurally 0 for this work-unit kind, so the record's own
    // decided/(decided+abstained) is fully determined and the published field states it (#9643).
    expect(record?.score).toEqual({ decided: 20, confirmed: 16, precision: 0.8, recall: null, coverage: 1, abstained: 0 });
    // #9966: the commitment is the checksum of the corpus a reader can DOWNLOAD, not the persisted backtest
    // run's freeze point. That is the whole point of the change -- a commitment must name bytes someone can
    // fetch and re-hash. Asserted against what /v1/public/eval-corpus actually serves rather than a literal,
    // so the two surfaces cannot drift apart while both still look correct in isolation.
    const corpusRes = await createApp().request("/v1/public/eval-corpus?ruleId=ai_consensus_defect", {}, env);
    const corpus = (await corpusRes.json()) as { checksum: string; caseCount: number };
    expect(corpus.caseCount).toBe(20);
    expect(record?.commitments.corpusChecksum).toBe(corpus.checksum);
    expect(record?.subject).toEqual({ kind: "agent", id: ORB_GATE_SUBJECT_ID });

    const { recordDigest, ...rest } = record as EvalScoreRecord;
    expect(await contentDigest(rest)).toBe(recordDigest);
  });

  it("filters by ?subject=", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "1" });
    await seedConfirmedPrecisionData(env);

    const matching = await createApp().request(`/v1/public/eval-scores?subject=${ORB_GATE_SUBJECT_ID}`, {}, env);
    expect(((await matching.json()) as { records: EvalScoreRecord[] }).records).toHaveLength(1);

    const nonMatching = await createApp().request("/v1/public/eval-scores?subject=some-other-agent", {}, env);
    expect(((await nonMatching.json()) as { records: EvalScoreRecord[] }).records).toHaveLength(0);
  });

  it("filters by ?since= (an unparseable value excludes nothing, fail-open on a malformed optional filter)", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "1" });
    await seedConfirmedPrecisionData(env);

    const future = await createApp().request("/v1/public/eval-scores?since=2099-01-01T00:00:00.000Z", {}, env);
    expect(((await future.json()) as { records: EvalScoreRecord[] }).records).toHaveLength(0);

    const malformed = await createApp().request("/v1/public/eval-scores?since=not-a-date", {}, env);
    expect(((await malformed.json()) as { records: EvalScoreRecord[] }).records).toHaveLength(1);
  });

  it("sets the same Cache-Control posture as /v1/public/stats", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "1" });
    const res = await createApp().request("/v1/public/eval-scores", {}, env);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60, stale-while-revalidate=300");
  });

  it("degrades to an empty records array (not a thrown error) on a broken store, mirroring loadPublicRulePrecision's own fail-safe contract", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "1" });
    env.DB = { prepare: () => { throw new Error("boom"); } } as never;
    const res = await createApp().request("/v1/public/eval-scores", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ records: [] });
  });
});

// #9805 Deliverable 5: the reader's ACTUAL workflow, end to end over both public routes. Everything else in
// this file feeds the builder a seeded backtest-run row; this one has no persisted run at all -- the hosted
// topology, where review execution is retired -- and checks that what /v1/public/eval-scores commits to is
// byte-identical to what /v1/public/eval-corpus serves.
describe("a stranger can tie a record to the corpus they downloaded (#9805)", () => {
  beforeEach(() => {
    clearPublicStatsManifestOverrideCacheForTest();
  });

  async function seedDecidedCorpus(env: Env, ruleId: string, count: number): Promise<void> {
    const store = createSignalStore(env);
    for (let i = 0; i < count; i += 1) {
      await store.recordRuleFired({
        ruleId,
        targetKey: `acme/widgets#${i + 1}`,
        outcome: "close",
        occurredAt: new Date(NOW - 5000 - i).toISOString(),
        metadata: { confidence: 0.4 + (i % 5) * 0.1 },
      });
      await store.recordHumanOverride({
        ruleId,
        targetKey: `acme/widgets#${i + 1}`,
        verdict: i % 4 === 0 ? "reversed" : "confirmed",
        occurredAt: new Date(NOW - 1000 - i).toISOString(),
      });
    }
  }

  it("REGRESSION: publishes records with NO persisted backtest run, each committing to the corpus the other route serves", async () => {
    const env = createTestEnv();
    env.LOOPOVER_PUBLIC_STATS = "true";
    await seedDecidedCorpus(env, "ai_consensus_defect", 20);

    const app = createApp();
    const scores = await (await app.request("/v1/public/eval-scores", {}, env)).json<{ records: EvalScoreRecord[] }>();
    expect(scores.records).toHaveLength(1);

    // Exactly what the walkthrough tells a reader to do: download the corpus, hash it, compare.
    const corpus = await (await app.request("/v1/public/eval-corpus?ruleId=ai_consensus_defect", {}, env)).json<{ checksum: string; caseCount: number; truncated: boolean }>();
    expect(corpus.caseCount).toBe(20);
    expect(corpus.truncated).toBe(false);
    expect(scores.records[0]!.commitments.corpusChecksum).toBe(corpus.checksum);

    // And the record still commits to its own content, so the freeze point cannot be swapped undetected.
    const { recordDigest, ...rest } = scores.records[0]!;
    expect(await contentDigest(rest)).toBe(recordDigest);
    expect(scores.records[0]!.subject.id).toBe(ORB_GATE_SUBJECT_ID);
  });

  it("publishes nothing for a rule with no corpus, rather than a record a reader could not check", async () => {
    const env = createTestEnv();
    env.LOOPOVER_PUBLIC_STATS = "true";
    // Overrides only: `decided` counts them via SQL, so the rule reaches rulePrecision -- but with no firings
    // there are no labeled cases, so there is no corpus to commit to. This is the exact shape that would
    // otherwise publish a record against the rule-independent empty-corpus digest.
    const store = createSignalStore(env);
    for (let i = 0; i < 20; i += 1) {
      await store.recordHumanOverride({
        ruleId: "ai_consensus_defect",
        targetKey: `acme/widgets#${i + 1}`,
        verdict: "confirmed",
        occurredAt: new Date(NOW - 1000 - i).toISOString(),
      });
    }

    const res = await createApp().request("/v1/public/eval-scores", {}, env);
    expect(await res.json<{ records: EvalScoreRecord[] }>()).toEqual({ records: [] });
  });
});
