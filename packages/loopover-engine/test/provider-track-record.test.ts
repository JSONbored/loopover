import assert from "node:assert/strict";
import { test } from "node:test";

import { computeProviderTrackRecords, type BacktestCase, type ProviderReviewSignal } from "../dist/index.js";

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

function signal(provider: string, targetKey: string, vote: ProviderReviewSignal["vote"]): ProviderReviewSignal {
  return { provider, repoFullName: "acme/widgets", targetKey, vote };
}

test("barrel: the public entrypoint re-exports the provider track-record computation (#8228)", () => {
  assert.equal(typeof computeProviderTrackRecords, "function");
});

test("both-provider round-trip: precision + agreement + consensus rates land per provider", () => {
  const records = computeProviderTrackRecords(
    [
      signal("a", "acme/widgets#1", "fail"),
      signal("b", "acme/widgets#1", "fail"),
      signal("a", "acme/widgets#2", "fail"),
      signal("b", "acme/widgets#2", "pass"),
    ],
    [labeled("acme/widgets#1", "confirmed"), labeled("acme/widgets#2", "reversed")],
  );
  const aOverall = records.find((r) => r.provider === "a" && r.repoFullName === null)!;
  assert.equal(aOverall.precision, 0.5);
  assert.equal(aOverall.consensusRate, 0.5);
  const bOverall = records.find((r) => r.provider === "b" && r.repoFullName === null)!;
  assert.equal(bOverall.precision, 1);
  assert.equal(bOverall.agreementRate, 1);
});

test("null discipline: no fail votes -> null precision; no shared targets -> null consensus/split", () => {
  const records = computeProviderTrackRecords(
    [signal("solo", "acme/widgets#1", "pass")],
    [labeled("acme/widgets#1", "reversed")],
  );
  const overall = records.find((r) => r.repoFullName === null)!;
  assert.equal(overall.precision, null);
  assert.equal(overall.consensusRate, null);
  assert.equal(overall.splitRate, null);
  assert.equal(overall.agreementRate, 1);
});

test("computeProviderTrackRecords counts a provider's repeated votes on one target once, latest-vote-wins (#8876)", () => {
  const cases = [labeled("acme/widgets#1", "confirmed"), labeled("acme/widgets#2", "confirmed")];
  const signals = [
    signal("provider-a", "acme/widgets#1", "pass"),
    signal("provider-a", "acme/widgets#1", "fail"),
    signal("provider-b", "acme/widgets#1", "fail"),
    signal("provider-a", "acme/widgets#2", "fail"),
  ];
  const records = computeProviderTrackRecords(signals, cases);
  const aOverall = records.find((r) => r.provider === "provider-a" && r.repoFullName === null)!;
  // Without dedup this would be signals:3 (the stale pass on #1 counted); deduped it is 2 distinct targets,
  // #1 resolving to the latest fail so precision stays 1.
  assert.equal(aOverall.signals, 2);
  assert.equal(aOverall.decided, 2);
  assert.equal(aOverall.precision, 1);
  assert.equal(aOverall.consensusRate, 1);
  const bOverall = records.find((r) => r.provider === "provider-b" && r.repoFullName === null)!;
  assert.equal(bOverall.signals, 1);
});
