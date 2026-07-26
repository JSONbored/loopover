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

  // #8876: a provider re-reviewing the same PR (a second audit row after a push) must count ONCE per
  // (provider, targetKey), scored on the LATEST vote — not inflate its signals/precision/agreement per raw row.
  it("collapses a provider's repeated same-target signals to the latest, not double-counting (#8876)", () => {
    const records = computeProviderTrackRecords(
      [
        signal("solo", "acme/widgets#1", "pass"), // first review
        signal("solo", "acme/widgets#1", "fail"), // re-review after a new push — the latest vote wins
      ],
      [labeled("acme/widgets#1", "confirmed")],
    );
    const overall = records.find((r) => r.provider === "solo" && r.repoFullName === null)!;
    // Before the fix this was signals: 2 / agreementRate: 0.5 (both raw rows counted); now one distinct pair,
    // scored on the latest fail vote against the confirmed firing.
    expect(overall).toMatchObject({ signals: 1, decided: 1, confirmed: 1, precision: 1, agreementRate: 1 });
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
});
