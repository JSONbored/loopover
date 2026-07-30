import { describe, expect, it } from "vitest";
import {
  applyPublicEvalCorpusCap,
  buildPublicCorpusCommitments,
  checksumPublicEvalCorpus,
  isCommittableCorpus,
  loadPublicEvalCorpus,
  PUBLIC_EVAL_CORPUS_MAX_CASES,
  redactBacktestCase,
  sortPublicEvalCorpusCases,
  type PublicEvalCorpusCase,
} from "../../src/review/public-eval-corpus";
import { canonicalJson, sha256Hex } from "../../src/review/decision-record";
import { PUBLIC_PRECISION_WINDOW_DAYS } from "../../src/review/public-rule-precision";
import { createSignalStore, MAX_RULE_HISTORY_LIMIT } from "../../src/review/signal-tracking-wire";
import { createTestEnv } from "../helpers/d1";

// #9636: the anonymously-downloadable corpus. The load-bearing properties are that NOTHING identifying
// is published, that the one field the shipped classifier reads survives in the shape it reads it from,
// and that the checksum commits to the bytes a reader can actually obtain.

const NOW = Date.parse("2026-07-23T12:00:00.000Z");

async function seedPair(
  env: Env,
  input: { ruleId: string; targetKey: string; verdict: "confirmed" | "reversed"; confidence?: number; provenance?: string; firedOffsetMs?: number },
): Promise<void> {
  const store = createSignalStore(env);
  await store.recordRuleFired({
    ruleId: input.ruleId,
    targetKey: input.targetKey,
    outcome: "close",
    occurredAt: new Date(NOW - (input.firedOffsetMs ?? 20_000)).toISOString(),
    ...(input.confidence === undefined ? {} : { metadata: { confidence: input.confidence } }),
  });
  await store.recordHumanOverride({
    ruleId: input.ruleId,
    targetKey: input.targetKey,
    verdict: input.verdict,
    occurredAt: new Date(NOW - 10_000).toISOString(),
    ...(input.provenance === undefined ? {} : { metadata: { provenance: input.provenance } }),
  });
}

describe("redactBacktestCase (#9636)", () => {
  const raw = {
    ruleId: "ai_consensus_defect",
    targetKey: "acme/private-widgets#42",
    outcome: "close",
    label: "reversed" as const,
    firedAt: "2026-07-20T14:37:11.482Z",
    decidedAt: "2026-07-21T09:02:55.001Z",
    metadata: { confidence: 0.4, prompt: "secret prompt text", repo: "acme/private-widgets" },
  };

  it("INVARIANT: drops targetKey and every metadata key except confidence", () => {
    const redacted = redactBacktestCase(raw);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toMatch(/acme|private-widgets|#42|secret prompt|targetKey|repo/i);
    expect(redacted.metadata).toEqual({ confidence: 0.4 });
    expect(Object.keys(redacted).sort()).toEqual(["decidedAt", "firedAt", "label", "metadata", "outcome", "ruleId"]);
  });

  it("keeps confidence NESTED under metadata, where buildConfidenceThresholdClassifier reads it", () => {
    // Flattening this to a top-level `confidence` would make the shipped classifier hit its `?? 1`
    // fallback and label every case "confirmed" -- a wrong replay that looks like a working one.
    expect(redactBacktestCase(raw).metadata?.confidence).toBe(0.4);
  });

  it("omits metadata entirely (never undefined) when the firing recorded no confidence", () => {
    const redacted = redactBacktestCase({ ...raw, metadata: { prompt: "x" } });
    expect("metadata" in redacted).toBe(false);
  });

  it("omits metadata when confidence is present but not a number", () => {
    expect("metadata" in redactBacktestCase({ ...raw, metadata: { confidence: "0.4" } })).toBe(false);
  });

  it("truncates both timestamps to the UTC day", () => {
    const redacted = redactBacktestCase(raw);
    expect(redacted.firedAt).toBe("2026-07-20T00:00:00.000Z");
    expect(redacted.decidedAt).toBe("2026-07-21T00:00:00.000Z");
  });

  it("passes an unparseable timestamp through rather than emitting an Invalid Date", () => {
    const redacted = redactBacktestCase({ ...raw, firedAt: "not-a-date" });
    expect(redacted.firedAt).toBe("not-a-date");
  });
});

describe("sortPublicEvalCorpusCases", () => {
  const base: PublicEvalCorpusCase = { ruleId: "r", outcome: "close", label: "confirmed", firedAt: "2026-07-02T00:00:00.000Z", decidedAt: "2026-07-03T00:00:00.000Z" };

  it("is a deterministic total order over the published fields (targetKey is gone as a tiebreak)", () => {
    const cases: PublicEvalCorpusCase[] = [
      { ...base, firedAt: "2026-07-05T00:00:00.000Z" },
      { ...base, metadata: { confidence: 0.9 } },
      { ...base, metadata: { confidence: 0.1 } },
      { ...base, label: "reversed" },
      { ...base, outcome: "advise" },
      { ...base, decidedAt: "2026-07-01T00:00:00.000Z" },
    ];
    const once = sortPublicEvalCorpusCases(cases);
    // Stable regardless of input order -- the property the checksum depends on.
    expect(sortPublicEvalCorpusCases([...cases].reverse())).toEqual(once);
    expect(once[0]?.decidedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(once[once.length - 1]?.firedAt).toBe("2026-07-05T00:00:00.000Z");
  });

  it("orders a case with no confidence before one that has it (both sides of the ?? tiebreak)", () => {
    // Identical in every earlier field, so the comparator actually reaches the confidence tiebreak with
    // one side absent -- the only way the `?? -1` fallbacks are exercised at all.
    const withConfidence: PublicEvalCorpusCase = { ...base, metadata: { confidence: 0.3 } };
    const sorted = sortPublicEvalCorpusCases([withConfidence, base]);
    expect(sorted[0]).toEqual(base);
    expect(sorted[1]).toEqual(withConfidence);
    // And the reverse input yields the same order, so the fallback is symmetric.
    expect(sortPublicEvalCorpusCases([base, withConfidence])).toEqual(sorted);
  });

  it("does not mutate its input", () => {
    const cases = [{ ...base, firedAt: "2026-07-09T00:00:00.000Z" }, base];
    sortPublicEvalCorpusCases(cases);
    expect(cases[0]?.firedAt).toBe("2026-07-09T00:00:00.000Z");
  });
});

describe("applyPublicEvalCorpusCap", () => {
  const one = (i: number): PublicEvalCorpusCase => ({ ruleId: "r", outcome: "close", label: "confirmed", firedAt: `2026-07-20T00:00:00.00${i % 10}Z`, decidedAt: "2026-07-21T00:00:00.000Z" });

  it("passes an under-cap corpus through untruncated", () => {
    const result = applyPublicEvalCorpusCap([one(1), one(2)]);
    expect(result).toEqual({ cases: [one(1), one(2)], truncated: false });
  });

  it("caps an over-cap corpus and says so", () => {
    const result = applyPublicEvalCorpusCap(Array.from({ length: PUBLIC_EVAL_CORPUS_MAX_CASES + 1 }, (_, i) => one(i)));
    expect(result.truncated).toBe(true);
    expect(result.cases).toHaveLength(PUBLIC_EVAL_CORPUS_MAX_CASES);
  });

  it("returns exactly the cap without truncating at the boundary", () => {
    const result = applyPublicEvalCorpusCap(Array.from({ length: PUBLIC_EVAL_CORPUS_MAX_CASES }, (_, i) => one(i)));
    expect(result.truncated).toBe(false);
    expect(result.cases).toHaveLength(PUBLIC_EVAL_CORPUS_MAX_CASES);
  });
});

describe("checksumPublicEvalCorpus", () => {
  it("is sha256 over canonicalJson of the published cases -- independently recomputable", async () => {
    const cases: PublicEvalCorpusCase[] = [{ ruleId: "r", outcome: "close", label: "confirmed", firedAt: "2026-07-02T00:00:00.000Z", decidedAt: "2026-07-03T00:00:00.000Z" }];
    expect(await checksumPublicEvalCorpus(cases)).toBe(await sha256Hex(canonicalJson(cases)));
  });

  it("commits to an empty corpus distinguishably (the value #9636 made unpublishable elsewhere)", async () => {
    expect(await checksumPublicEvalCorpus([])).toBe(await sha256Hex("[]"));
  });
});

describe("loadPublicEvalCorpus — end to end over the real signal tables", () => {
  it("builds a redacted, checksummed corpus from real fired/override pairs", async () => {
    const env = createTestEnv();
    await seedPair(env, { ruleId: "ai_consensus_defect", targetKey: "acme/widgets#1", verdict: "confirmed", confidence: 0.8 });
    await seedPair(env, { ruleId: "ai_consensus_defect", targetKey: "acme/widgets#2", verdict: "reversed", confidence: 0.2, firedOffsetMs: 30_000 });

    const corpus = await loadPublicEvalCorpus(env, "ai_consensus_defect", NOW);
    expect(corpus.ruleId).toBe("ai_consensus_defect");
    expect(corpus.windowDays).toBe(PUBLIC_PRECISION_WINDOW_DAYS);
    expect(corpus.caseCount).toBe(2);
    expect(corpus.truncated).toBe(false);
    expect(corpus.checksum).toBe(await checksumPublicEvalCorpus(corpus.cases));
    expect(corpus.cases.map((c) => c.label).sort()).toEqual(["confirmed", "reversed"]);
  });

  it("INVARIANT: the serialized corpus never carries a target key, repo, or PR number", async () => {
    const env = createTestEnv();
    await seedPair(env, { ruleId: "ai_consensus_defect", targetKey: "acme/private-widgets#4242", verdict: "confirmed", confidence: 0.5 });
    const serialized = JSON.stringify(await loadPublicEvalCorpus(env, "ai_consensus_defect", NOW));
    expect(serialized).not.toMatch(/acme|private-widgets|4242|targetKey/i);
  });

  it("excludes counterfactual-replay overrides, so the corpus agrees with the precision it explains", async () => {
    const env = createTestEnv();
    await seedPair(env, { ruleId: "slop_gate_score", targetKey: "acme/widgets#7", verdict: "confirmed", provenance: "slop_replay_backfill_v1" });
    expect((await loadPublicEvalCorpus(env, "slop_gate_score", NOW)).caseCount).toBe(0);
  });

  it("keeps a synthesized override whose labels ARE about the rule it is filed under", async () => {
    const env = createTestEnv();
    await seedPair(env, { ruleId: "ai_consensus_defect", targetKey: "acme/widgets#8", verdict: "confirmed", provenance: "review_targets_decision_level" });
    expect((await loadPublicEvalCorpus(env, "ai_consensus_defect", NOW)).caseCount).toBe(1);
  });

  it("returns an empty, still-checksummed corpus for a rule with no history", async () => {
    const corpus = await loadPublicEvalCorpus(createTestEnv(), "never_fired", NOW);
    expect(corpus).toMatchObject({ caseCount: 0, truncated: false, readFailed: false, cases: [] });
    expect(corpus.checksum).toBe(await sha256Hex("[]"));
  });

  it("degrades to an empty corpus (never throws) when the store read fails", async () => {
    const broken = createTestEnv();
    broken.DB = { prepare: () => { throw new Error("boom"); } } as never;
    const corpus = await loadPublicEvalCorpus(broken, "ai_consensus_defect", NOW);
    expect(corpus.caseCount).toBe(0);
    expect(corpus.checksum).toBe(await sha256Hex("[]"));
  });

  // #9962: fail-safe must not also mean "indistinguishable from a fact about the rule". Both corpora below are
  // byte-identical apart from this one flag, which is exactly why the flag has to exist -- without it a
  // transient D1 blip publishes "this rule has decided nothing" and a reader cannot tell.
  it("REGRESSION: says READ FAILED when it degraded, and does not when the rule is genuinely quiet", async () => {
    const broken = createTestEnv();
    broken.DB = { prepare: () => { throw new Error("boom"); } } as never;
    const degraded = await loadPublicEvalCorpus(broken, "ai_consensus_defect", NOW);
    const quiet = await loadPublicEvalCorpus(createTestEnv(), "ai_consensus_defect", NOW);

    expect(degraded.readFailed).toBe(true);
    expect(quiet.readFailed).toBe(false);
    // Everything a reader could otherwise go on is identical between the two, so `readFailed` is the ONLY
    // thing carrying the distinction -- pin that, or the flag could be quietly derived from caseCount later.
    expect(degraded.caseCount).toBe(quiet.caseCount);
    expect(degraded.checksum).toBe(quiet.checksum);
    expect(degraded.cases).toEqual(quiet.cases);
  });

  it("does not claim a read failure on a healthy read that returned cases", async () => {
    const env = createTestEnv();
    await seedPair(env, { ruleId: "ai_consensus_defect", targetKey: "acme/widgets#1", verdict: "reversed", confidence: 0.8 });
    expect((await loadPublicEvalCorpus(env, "ai_consensus_defect", NOW)).readFailed).toBe(false);
  });

  it("reports truncation honestly rather than silently trimming", async () => {
    expect((await loadPublicEvalCorpus(createTestEnv(), "r", NOW)).truncated).toBe(false);
  });
});

// #9805: the commitment map behind /v1/public/eval-scores' fallback. Every entry must be a checksum a reader
// can reproduce from the corpus this same deployment serves -- so the interesting cases are the ones this
// deliberately OMITS, since a wrong entry is worse than a missing record.
describe("buildPublicCorpusCommitments (#9805)", () => {
  it("maps each rule to the SAME checksum /v1/public/eval-corpus publishes for it", async () => {
    const env = createTestEnv();
    await seedPair(env, { ruleId: "rule_a", targetKey: "acme/widgets#1", verdict: "reversed", confidence: 0.8 });
    await seedPair(env, { ruleId: "rule_b", targetKey: "acme/widgets#2", verdict: "confirmed", confidence: 0.4 });

    const commitments = await buildPublicCorpusCommitments(env, ["rule_a", "rule_b"], NOW);

    // The record's commitment and the reader's download must be the same bytes, by construction.
    expect(commitments.get("rule_a")).toBe((await loadPublicEvalCorpus(env, "rule_a", NOW)).checksum);
    expect(commitments.get("rule_b")).toBe((await loadPublicEvalCorpus(env, "rule_b", NOW)).checksum);
  });

  it("gives two rules DIFFERENT checksums -- the per-rule bug this exists to prevent", async () => {
    const env = createTestEnv();
    await seedPair(env, { ruleId: "rule_a", targetKey: "acme/widgets#1", verdict: "reversed", confidence: 0.8 });
    await seedPair(env, { ruleId: "rule_b", targetKey: "acme/widgets#2", verdict: "confirmed", confidence: 0.4 });

    const commitments = await buildPublicCorpusCommitments(env, ["rule_a", "rule_b"], NOW);
    expect(commitments.get("rule_a")).not.toBe(commitments.get("rule_b"));
  });

  it("omits a rule with an EMPTY corpus rather than mapping it to the rule-independent empty digest", async () => {
    const env = createTestEnv();
    const commitments = await buildPublicCorpusCommitments(env, ["never_fired"], NOW);
    expect(commitments.has("never_fired")).toBe(false);
    // The value it would otherwise have carried is identical for every rule and deployment.
    expect((await loadPublicEvalCorpus(env, "never_fired", NOW)).checksum).toBe(await checksumPublicEvalCorpus([]));
  });

  it("omits a TRUNCATED corpus -- its checksum covers a prefix while the score covers the whole window", async () => {
    // Real saturation, not a stub: MAX_RULE_HISTORY_LIMIT firings so the read comes back AT its bound, plus
    // one override so the corpus is non-empty -- otherwise the empty check would be doing the omitting and
    // this would prove nothing about truncation.
    const env = createTestEnv();
    const store = createSignalStore(env);
    for (let i = 0; i < MAX_RULE_HISTORY_LIMIT; i += 1) {
      await store.recordRuleFired({
        ruleId: "busy_rule",
        targetKey: `acme/widgets#${i}`,
        outcome: "close",
        occurredAt: new Date(NOW - 20_000 - i).toISOString(),
        metadata: { confidence: 0.5 },
      });
    }
    await store.recordHumanOverride({ ruleId: "busy_rule", targetKey: "acme/widgets#0", verdict: "reversed", occurredAt: new Date(NOW - 10_000).toISOString() });

    const corpus = await loadPublicEvalCorpus(env, "busy_rule", NOW);
    expect(corpus.truncated).toBe(true);
    expect(corpus.caseCount).toBeGreaterThan(0); // so the omission below is truncation, not emptiness

    expect((await buildPublicCorpusCommitments(env, ["busy_rule"], NOW)).has("busy_rule")).toBe(false);
  }, 60_000);

  it("omits a rule whose corpus read FAILED, because that degrades to an empty corpus", async () => {
    const broken = createTestEnv();
    broken.DB = { prepare: () => { throw new Error("boom"); } } as never;
    expect((await buildPublicCorpusCommitments(broken, ["rule_a"], NOW)).size).toBe(0);
  });

  it("asks isCommittableCorpus rather than restating the rule, so the two cannot drift", async () => {
    const env = createTestEnv();
    await seedPair(env, { ruleId: "rule_a", targetKey: "acme/widgets#1", verdict: "reversed", confidence: 0.8 });
    const committable = await loadPublicEvalCorpus(env, "rule_a", NOW);
    const notCommittable = await loadPublicEvalCorpus(env, "never_fired", NOW);

    expect(isCommittableCorpus(committable)).toBe(true);
    expect(isCommittableCorpus(notCommittable)).toBe(false);
    const commitments = await buildPublicCorpusCommitments(env, ["rule_a", "never_fired"], NOW);
    expect(commitments.has("rule_a")).toBe(isCommittableCorpus(committable));
    expect(commitments.has("never_fired")).toBe(isCommittableCorpus(notCommittable));
  });

  it("returns an empty map for no rules, without touching the database", async () => {
    const env = createTestEnv();
    expect((await buildPublicCorpusCommitments(env, [], NOW)).size).toBe(0);
  });
});

// #9962: the predicate the commitment path delegates to. Driven with plain values rather than through the
// store precisely so each arm is reachable on its own -- the read-failure arm in particular cannot be reached
// via the store (a failed read is also an empty one), and an arm that only ever fires alongside another arm is
// an arm no test can prove is doing anything.
describe("isCommittableCorpus (#9962)", () => {
  const base = {
    ruleId: "rule_a",
    windowDays: PUBLIC_PRECISION_WINDOW_DAYS,
    caseCount: 3,
    truncated: false,
    readFailed: false,
    checksum: "a".repeat(64),
    cases: [] as PublicEvalCorpusCase[],
  };

  it("commits to a healthy, non-empty, complete corpus", () => {
    expect(isCommittableCorpus(base)).toBe(true);
  });

  it("REGRESSION: refuses a DEGRADED corpus even when it carries cases -- the arm the store cannot reach", () => {
    // The whole point of the flag. With `readFailed` absorbed into the empty check, this corpus would be
    // committed to: it has cases, it is not truncated, and nothing else says the read went wrong.
    expect(isCommittableCorpus({ ...base, readFailed: true })).toBe(false);
  });

  it("refuses an empty corpus (its checksum is the same 32 bytes everywhere) and a truncated one", () => {
    expect(isCommittableCorpus({ ...base, caseCount: 0 })).toBe(false);
    expect(isCommittableCorpus({ ...base, truncated: true })).toBe(false);
  });
});
