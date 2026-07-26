import { describe, expect, it } from "vitest";

// Import the engine SOURCE directly (not the built dist) -- coverage.include lists
// packages/loopover-engine/src/**, so only a source-path import exercises the .ts these branches live in
// (the dist-importing twin in packages/loopover-engine/test/ covers the built barrel for the workspace
// suite). Same pattern as backtest-corpus-engine.test.ts / repo-corpus-engine.test.ts.
import {
  computeProviderTrackRecords,
  type ProviderReviewSignal,
} from "../../packages/loopover-engine/src/calibration/provider-track-record";
import type { BacktestCase } from "../../packages/loopover-engine/src/calibration/backtest-corpus";

function labeled(targetKey: string, label: BacktestCase["label"]): BacktestCase {
  return {
    ruleId: "ai_consensus_defect",
    targetKey,
    outcome: "close",
    label,
    firedAt: "2026-07-01T00:00:00.000Z",
    decidedAt: "2026-07-02T00:00:00.000Z",
  };
}

function signal(provider: string, targetKey: string, vote: ProviderReviewSignal["vote"], repoFullName = "acme/widgets"): ProviderReviewSignal {
  return { provider, repoFullName, targetKey, vote };
}

describe("computeProviderTrackRecords (#8228)", () => {
  it("computes precision, agreement, and consensus/split rates for a both-provider corpus, per repo and overall", () => {
    const cases = [
      labeled("acme/widgets#1", "confirmed"),
      labeled("acme/widgets#2", "reversed"),
      labeled("acme/widgets#3", "confirmed"),
    ];
    const signals = [
      // #1: both fail on a confirmed firing — consensus, both correct.
      signal("provider-a", "acme/widgets#1", "fail"),
      signal("provider-b", "acme/widgets#1", "fail"),
      // #2: split — a fails (wrong: label reversed), b passes (right).
      signal("provider-a", "acme/widgets#2", "fail"),
      signal("provider-b", "acme/widgets#2", "pass"),
      // #3: only a reviews it, warns (non-fail on a confirmed firing — disagreed with the human).
      signal("provider-a", "acme/widgets#3", "warn"),
    ];
    const records = computeProviderTrackRecords(signals, cases);

    const aOverall = records.find((r) => r.provider === "provider-a" && r.repoFullName === null)!;
    expect(aOverall).toMatchObject({
      signals: 3,
      decided: 3,
      confirmed: 2,
      reversed: 1,
      precision: 0.5, // of a's 2 fail votes, 1 hit a confirmed firing
      agreementRate: 1 / 3, // matched the human only on #1
      consensusRate: 0.5, // shared #1 (agreed) and #2 (split)
      splitRate: 0.5,
    });
    const bOverall = records.find((r) => r.provider === "provider-b" && r.repoFullName === null)!;
    expect(bOverall).toMatchObject({ signals: 2, decided: 2, precision: 1, agreementRate: 1, consensusRate: 0.5, splitRate: 0.5 });

    // Single-repo corpus: each provider's per-repo row equals its overall rollup.
    const aRepo = records.find((r) => r.provider === "provider-a" && r.repoFullName === "acme/widgets")!;
    expect(aRepo).toMatchObject({ signals: aOverall.signals, decided: aOverall.decided, precision: aOverall.precision });
  });

  it("keeps a one-provider corpus's consensus/split rates null — no shared targets, no consensus to measure", () => {
    const records = computeProviderTrackRecords(
      [signal("solo", "acme/widgets#1", "fail"), signal("solo", "acme/widgets#2", "pass")],
      [labeled("acme/widgets#1", "confirmed"), labeled("acme/widgets#2", "reversed")],
    );
    const overall = records.find((r) => r.repoFullName === null)!;
    expect(overall.consensusRate).toBeNull();
    expect(overall.splitRate).toBeNull();
    expect(overall.precision).toBe(1);
    expect(overall.agreementRate).toBe(1);
  });

  it("reports null (never 0) precision below the sample floor: undecided targets and providers that never voted fail", () => {
    const records = computeProviderTrackRecords(
      [
        signal("quiet", "acme/widgets#9", "pass"), // undecided target — no label exists
        signal("quiet", "acme/widgets#1", "warn"), // decided, but never a fail vote
      ],
      [labeled("acme/widgets#1", "reversed")],
    );
    const overall = records.find((r) => r.repoFullName === null)!;
    expect(overall).toMatchObject({ signals: 2, decided: 1, precision: null, agreementRate: 1 });
  });

  it("rolls per-repo rows up into the overall row exactly, with deterministic provider→overall→repo ordering", () => {
    const cases = [labeled("acme/widgets#1", "confirmed"), labeled("acme/gadgets#2", "confirmed")];
    const signals = [
      signal("zeta", "acme/widgets#1", "fail", "acme/widgets"),
      signal("zeta", "acme/gadgets#2", "fail", "acme/gadgets"),
      signal("alpha", "acme/widgets#1", "fail", "acme/widgets"),
    ];
    const records = computeProviderTrackRecords(signals, cases);
    expect(records.map((r) => [r.provider, r.repoFullName])).toEqual([
      ["alpha", null],
      ["alpha", "acme/widgets"],
      ["zeta", null],
      ["zeta", "acme/gadgets"],
      ["zeta", "acme/widgets"],
    ]);
    const zetaOverall = records.find((r) => r.provider === "zeta" && r.repoFullName === null)!;
    const zetaRepos = records.filter((r) => r.provider === "zeta" && r.repoFullName !== null);
    expect(zetaRepos.reduce((sum, r) => sum + r.decided, 0)).toBe(zetaOverall.decided);
    expect(zetaRepos.reduce((sum, r) => sum + r.signals, 0)).toBe(zetaOverall.signals);
    // Determinism: identical inputs yield the identical result.
    expect(computeProviderTrackRecords(signals, cases)).toEqual(records);
  });

  it("never leaks target keys into any returned shape — provider ids, repo names, and numbers only", () => {
    const records = computeProviderTrackRecords(
      [signal("provider-a", "acme/widgets#42", "fail")],
      [labeled("acme/widgets#42", "confirmed")],
    );
    expect(JSON.stringify(records)).not.toContain("#42");
  });

  it("reports null agreement (never 0) for a provider whose every signal is undecided", () => {
    const records = computeProviderTrackRecords([signal("unjoined", "acme/widgets#404", "fail")], []);
    const overall = records.find((r) => r.repoFullName === null)!;
    expect(overall).toMatchObject({ signals: 1, decided: 0, precision: null, agreementRate: null });
  });

  it("returns an empty list for empty inputs", () => {
    expect(computeProviderTrackRecords([], [])).toEqual([]);
  });

  it("counts a provider's repeated votes on one target exactly once, latest-vote-wins (#8876)", () => {
    const cases = [labeled("acme/widgets#1", "confirmed"), labeled("acme/widgets#2", "confirmed")];
    const signals = [
      // provider-a re-reviews #1: an earlier pass then a later fail. Only the latest (fail) should count, once.
      signal("provider-a", "acme/widgets#1", "pass"),
      signal("provider-a", "acme/widgets#1", "fail"),
      // provider-b reviews #1 once (fail) so #1 is a shared target with a consensus stance.
      signal("provider-b", "acme/widgets#1", "fail"),
      // provider-a also reviews #2 once, to prove distinct (provider, target) pairs still each count.
      signal("provider-a", "acme/widgets#2", "fail"),
    ];
    const records = computeProviderTrackRecords(signals, cases);

    const aOverall = records.find((r) => r.provider === "provider-a" && r.repoFullName === null)!;
    // Without dedup this would be signals:3/decided:3 (the pass+fail on #1 both counted). Deduped: 2 distinct
    // targets, and #1 resolves to the latest fail vote (so precision stays 1, not diluted by the stale pass).
    expect(aOverall).toMatchObject({ signals: 2, decided: 2, confirmed: 2, precision: 1, agreementRate: 1 });
    const bOverall = records.find((r) => r.provider === "provider-b" && r.repoFullName === null)!;
    // #1 is shared by a (latest fail) and b (fail): a genuine consensus, counted once for each provider.
    expect(bOverall).toMatchObject({ signals: 1, decided: 1, consensusRate: 1 });
    expect(aOverall.consensusRate).toBe(1);
  });
});
