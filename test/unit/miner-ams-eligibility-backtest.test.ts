import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContributionProfile } from "../../packages/loopover-miner/lib/contribution-profile.js";
import { ELIGIBILITY_EXCLUSION_REASONS } from "../../packages/loopover-miner/lib/contribution-profile-filter.js";
import { filterCandidatesByProfiles } from "../../packages/loopover-miner/lib/contribution-profile-filter.js";
import { initEventLedger, resolveEventLedgerDbPath, type EventLedger } from "../../packages/loopover-miner/lib/event-ledger.js";
import {
  SIGNAL_HUMAN_OVERRIDE_EVENT,
  SIGNAL_RULE_FIRED_EVENT,
} from "../../packages/loopover-miner/lib/signal-tracking-store.js";

const AMS_CALIBRATION_MODULE = "../../packages/loopover-miner/lib/ams-calibration.ts";
const AMS_ELIGIBILITY_MODULE = "../../packages/loopover-miner/lib/ams-eligibility-backtest.ts";
const {
  AMS_MIN_RANK_SHIPPED,
  MINER_AMS_ELIGIBILITY_BACKTEST_EVENT,
  backtestMinRankCandidate,
  computeAmsBacktestTrackRecord,
  readAmsEligibilityBacktestRuns,
  readAmsThresholdBacktestRuns,
  recordAmsEligibilityBacktestRun,
  recordAmsThresholdBacktestRun,
} = (await import(AMS_CALIBRATION_MODULE)) as typeof import("../../packages/loopover-miner/lib/ams-calibration.js");
const {
  AMS_ELIGIBILITY_RULE_ID,
  backtestEligibilityCandidate,
  buildEligibilityExclusionCorpus,
  buildEligibilityProfileClassifier,
  extractEligibilitySignalEvents,
  reconstructEligibilityFilterCandidate,
  repoFullNamesInEligibilityEvents,
  runAmsEligibilityBacktest,
} = (await import(AMS_ELIGIBILITY_MODULE)) as typeof import("../../packages/loopover-miner/lib/ams-eligibility-backtest.js");

const tempDirs: string[] = [];
const ledgers: EventLedger[] = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempLedger(): EventLedger {
  const dir = mkdtempSync(join(tmpdir(), "miner-ams-eligibility-backtest-"));
  tempDirs.push(dir);
  const ledger = initEventLedger(resolveEventLedgerDbPath({ LOOPOVER_MINER_CONFIG_DIR: dir }));
  ledgers.push(ledger);
  return ledger;
}

function trustworthyProfile(over: Partial<ContributionProfile> = {}): ContributionProfile {
  return {
    repoFullName: "acme/widgets",
    schemaVersion: 1,
    generatedAt: "2026-07-18T00:00:00.000Z",
    eligibilityLabels: {
      value: [{ field: "name", contains: "help wanted" }],
      confidence: "explicit",
      provenance: [{ source: "labels", detail: "help wanted" }],
    },
    exclusionLabels: {
      value: [{ field: "name", contains: "blocked" }],
      confidence: "inferred",
      provenance: [{ source: "labels", detail: "blocked" }],
    },
    prBody: { value: null, confidence: "absent", provenance: [] },
    completeness: "inferred",
    ...over,
  };
}

function stricterCandidateProfile(): ContributionProfile {
  return trustworthyProfile({
    eligibilityLabels: {
      value: [{ field: "name", contains: "help wanted" }, { field: "name", contains: "good first issue" }],
      confidence: "explicit",
      provenance: [
        { source: "labels", detail: "help wanted" },
        { source: "labels", detail: "good first issue" },
      ],
    },
  });
}

function seedEligibilityFired(
  ledger: EventLedger,
  issueNumber: number,
  ruleId: string,
  metadata: Record<string, unknown> | undefined,
  occurredAt: string,
) {
  ledger.appendEvent({
    type: SIGNAL_RULE_FIRED_EVENT,
    repoFullName: "acme/widgets",
    payload: {
      ruleId,
      targetKey: `acme/widgets#issue-${issueNumber}`,
      outcome: "exclude",
      occurredAt,
      ...(metadata ? { metadata } : {}),
    },
  });
}

function seedEligibilityOverride(
  ledger: EventLedger,
  issueNumber: number,
  ruleId: string,
  verdict: "reversed" | "confirmed",
  occurredAt: string,
) {
  ledger.appendEvent({
    type: SIGNAL_HUMAN_OVERRIDE_EVENT,
    repoFullName: "acme/widgets",
    payload: {
      ruleId,
      targetKey: `acme/widgets#issue-${issueNumber}`,
      verdict,
      occurredAt,
    },
  });
}

function seedLabeledCorpus(ledger: EventLedger, count: number): void {
  for (let issueNumber = 1; issueNumber <= count; issueNumber += 1) {
    const ruleId =
      issueNumber % 4 === 0
        ? ELIGIBILITY_EXCLUSION_REASONS.EXCLUDED_ASSIGNEE
        : issueNumber % 3 === 0
          ? ELIGIBILITY_EXCLUSION_REASONS.MISSING_ELIGIBILITY_LABEL
          : issueNumber % 2 === 0
            ? ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL
            : ELIGIBILITY_EXCLUSION_REASONS.CONFLICTING_SIGNALS;
    const labels =
      ruleId === ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL
        ? ["blocked"]
        : ruleId === ELIGIBILITY_EXCLUSION_REASONS.CONFLICTING_SIGNALS
          ? ["help wanted", "blocked"]
          : ruleId === ELIGIBILITY_EXCLUSION_REASONS.MISSING_ELIGIBILITY_LABEL
            ? ["bug"]
            : ["help wanted"];
    const assignees = ruleId === ELIGIBILITY_EXCLUSION_REASONS.EXCLUDED_ASSIGNEE ? ["acme"] : [];
    const firedAt = `2026-07-${String((issueNumber % 28) + 1).padStart(2, "0")}T12:00:00.000Z`;
    seedEligibilityFired(
      ledger,
      issueNumber,
      ruleId,
      { owner: "acme", labels, ...(assignees.length > 0 ? { assignees } : {}) },
      firedAt,
    );
    seedEligibilityOverride(ledger, issueNumber, ruleId, issueNumber % 5 === 0 ? "reversed" : "confirmed", `${firedAt.replace("T12:", "T13:")}`);
  }
}

describe("ams-eligibility-backtest pure core (#8545)", () => {
  it("counts metadata-less fired events in skippedNoContext and never fabricates corpus rows for them", () => {
    const ledger = tempLedger();
    seedEligibilityFired(ledger, 1, ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL, undefined, "2026-07-01T12:00:00.000Z");
    seedEligibilityFired(ledger, 2, ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL, {}, "2026-07-02T12:00:00.000Z");
    seedEligibilityFired(
      ledger,
      3,
      ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
      { owner: "acme", labels: ["blocked"] },
      "2026-07-03T12:00:00.000Z",
    );
    seedEligibilityOverride(
      ledger,
      3,
      ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
      "confirmed",
      "2026-07-03T13:00:00.000Z",
    );
    const events = ledger.readEvents();
    expect(extractEligibilitySignalEvents(events).skippedNoContext).toBe(2);
    const { cases, skippedNoContext } = buildEligibilityExclusionCorpus(events);
    expect(skippedNoContext).toBe(2);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.ruleId).toBe(AMS_ELIGIBILITY_RULE_ID);
    expect(cases[0]?.metadata).toEqual({ owner: "acme", labels: ["blocked"] });
  });

  it("reconstructs FilterCandidate fields from targetKey + metadata", () => {
    expect(
      reconstructEligibilityFilterCandidate("acme/widgets#issue-7", {
        owner: "acme",
        labels: ["blocked"],
        assignees: ["alice"],
      }),
    ).toEqual({
      repoFullName: "acme/widgets",
      owner: "acme",
      labels: ["blocked"],
      assignees: ["alice"],
    });
    expect(reconstructEligibilityFilterCandidate("acme/widgets#issue-7", { labels: ["bug"] })).toEqual({
      repoFullName: "acme/widgets",
      labels: ["bug"],
    });
    expect(reconstructEligibilityFilterCandidate("bad-target", { labels: ["bug"] })).toBeNull();
    expect(
      reconstructEligibilityFilterCandidate("acme/widgets#issue-8", {
        owner: "",
        labels: "not-an-array" as unknown as string[],
        assignees: 42 as unknown as string[],
      }),
    ).toEqual({ repoFullName: "acme/widgets" });
  });

  it("extractEligibilitySignalEvents tolerates garbage rows and records overrides with optional metadata", () => {
    const extracted = extractEligibilitySignalEvents([
      null,
      { type: SIGNAL_RULE_FIRED_EVENT, payload: "not-an-object" },
      { type: SIGNAL_RULE_FIRED_EVENT, payload: { ruleId: "exclusion_label" } },
      {
        type: SIGNAL_RULE_FIRED_EVENT,
        repoFullName: "acme/widgets",
        payload: {
          ruleId: ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
          targetKey: "acme/widgets#issue-1",
          outcome: "exclude",
          occurredAt: "2026-07-01T12:00:00.000Z",
          metadata: { labels: ["blocked"] },
        },
      },
      {
        type: SIGNAL_HUMAN_OVERRIDE_EVENT,
        repoFullName: "acme/widgets",
        payload: {
          ruleId: ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
          targetKey: "acme/widgets#issue-1",
          verdict: "confirmed",
          occurredAt: "2026-07-01T13:00:00.000Z",
          metadata: { note: "reviewed" },
        },
      },
      {
        type: "discovered_issue",
        payload: {
          ruleId: ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
          targetKey: "acme/widgets#issue-9",
          outcome: "exclude",
          occurredAt: "2026-07-02T12:00:00.000Z",
          metadata: { labels: ["blocked"] },
        },
      },
    ]);
    expect(extracted.skippedNoContext).toBe(0);
    expect(extracted.fired).toHaveLength(1);
    expect(extracted.overrides).toEqual([
      expect.objectContaining({
        targetKey: "acme/widgets#issue-1",
        metadata: { note: "reviewed" },
      }),
    ]);
    expect(extractEligibilitySignalEvents("not-an-array" as unknown as readonly unknown[])).toEqual({
      fired: [],
      overrides: [],
      skippedNoContext: 0,
    });
  });

  it("repoFullNamesInEligibilityEvents ignores fired rows whose targetKey does not parse", () => {
    const repos = repoFullNamesInEligibilityEvents([
      {
        type: SIGNAL_RULE_FIRED_EVENT,
        payload: {
          ruleId: ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
          targetKey: "not-a-valid-target",
          outcome: "exclude",
          occurredAt: "2026-07-01T12:00:00.000Z",
          metadata: { labels: ["blocked"] },
        },
      },
      {
        type: SIGNAL_RULE_FIRED_EVENT,
        payload: {
          ruleId: ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
          targetKey: "acme/widgets#issue-2",
          outcome: "exclude",
          occurredAt: "2026-07-02T12:00:00.000Z",
          metadata: { labels: ["blocked"] },
        },
      },
    ]);
    expect([...repos]).toEqual(["acme/widgets"]);
  });

  it("sorts corpus rows with the same targetKey by firedAt", () => {
    const targetKey = "acme/widgets#issue-42";
    const metadata = { owner: "acme", labels: ["blocked"] };
    const { cases } = buildEligibilityExclusionCorpus([
      {
        type: SIGNAL_RULE_FIRED_EVENT,
        payload: {
          ruleId: ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
          targetKey,
          outcome: "exclude",
          occurredAt: "2026-07-02T12:00:00.000Z",
          metadata,
        },
      },
      {
        type: SIGNAL_HUMAN_OVERRIDE_EVENT,
        payload: {
          ruleId: ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
          targetKey,
          verdict: "confirmed",
          occurredAt: "2026-07-02T13:00:00.000Z",
        },
      },
      {
        type: SIGNAL_RULE_FIRED_EVENT,
        payload: {
          ruleId: ELIGIBILITY_EXCLUSION_REASONS.CONFLICTING_SIGNALS,
          targetKey,
          outcome: "exclude",
          occurredAt: "2026-07-01T12:00:00.000Z",
          metadata: { owner: "acme", labels: ["help wanted", "blocked"] },
        },
      },
      {
        type: SIGNAL_HUMAN_OVERRIDE_EVENT,
        payload: {
          ruleId: ELIGIBILITY_EXCLUSION_REASONS.CONFLICTING_SIGNALS,
          targetKey,
          verdict: "confirmed",
          occurredAt: "2026-07-01T13:00:00.000Z",
        },
      },
    ]);
    const sameTarget = cases.filter((entry) => entry.targetKey === targetKey);
    expect(sameTarget.length).toBeGreaterThanOrEqual(2);
    expect(sameTarget.map((entry) => entry.firedAt)).toEqual([...sameTarget.map((entry) => entry.firedAt)].sort());
  });

  it("classifier returns reversed when metadata is missing, targetKey is invalid, or the candidate is kept", () => {
    const profiles = new Map([["acme/widgets", trustworthyProfile()]]);
    const classify = buildEligibilityProfileClassifier(profiles);
    expect(
      classify({
        ruleId: AMS_ELIGIBILITY_RULE_ID,
        targetKey: "acme/widgets#issue-1",
        outcome: "exclude",
        firedAt: "2026-07-01T12:00:00.000Z",
        decidedAt: "2026-07-01T13:00:00.000Z",
        label: "confirmed",
      }),
    ).toBe("reversed");
    expect(
      classify({
        ruleId: AMS_ELIGIBILITY_RULE_ID,
        targetKey: "bad-target",
        outcome: "exclude",
        firedAt: "2026-07-01T12:00:00.000Z",
        decidedAt: "2026-07-01T13:00:00.000Z",
        label: "confirmed",
        metadata: { labels: ["blocked"] },
      }),
    ).toBe("reversed");
    expect(
      classify({
        ruleId: AMS_ELIGIBILITY_RULE_ID,
        targetKey: "acme/widgets#issue-2",
        outcome: "exclude",
        firedAt: "2026-07-02T12:00:00.000Z",
        decidedAt: "2026-07-02T13:00:00.000Z",
        label: "confirmed",
        metadata: { labels: ["help wanted"] },
      }),
    ).toBe("reversed");
  });

  it("classifier agreement matches filterCandidatesByProfiles on a fixture case", () => {
    const ledger = tempLedger();
    seedEligibilityFired(
      ledger,
      9,
      ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
      { owner: "acme", labels: ["blocked"] },
      "2026-07-09T12:00:00.000Z",
    );
    seedEligibilityOverride(
      ledger,
      9,
      ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
      "confirmed",
      "2026-07-09T13:00:00.000Z",
    );
    const { cases } = buildEligibilityExclusionCorpus(ledger.readEvents());
    expect(cases).toHaveLength(1);
    const backtestCase = cases[0]!;
    const profiles = new Map([["acme/widgets", trustworthyProfile()]]);
    const candidate = reconstructEligibilityFilterCandidate(backtestCase.targetKey, backtestCase.metadata!);
    expect(candidate).not.toBeNull();
    const { excluded } = filterCandidatesByProfiles([candidate!], profiles);
    expect(buildEligibilityProfileClassifier(profiles)(backtestCase)).toBe(excluded.length > 0 ? "confirmed" : "reversed");
  });

  it("returns null when the labeled corpus is under the shared sample floors", () => {
    const ledger = tempLedger();
    seedLabeledCorpus(ledger, 10);
    const current = new Map([["acme/widgets", trustworthyProfile()]]);
    const candidate = new Map([["acme/widgets", stricterCandidateProfile()]]);
    expect(backtestEligibilityCandidate(ledger.readEvents(), current, candidate)).toBeNull();
    expect(runAmsEligibilityBacktest(buildEligibilityExclusionCorpus(ledger.readEvents()).cases, current, candidate)).toBeNull();
  });

  it("composes into a full current-vs-candidate advisory result over a real ledger", () => {
    const ledger = tempLedger();
    seedLabeledCorpus(ledger, 40);
    const current = new Map([["acme/widgets", trustworthyProfile()]]);
    const candidate = new Map([["acme/widgets", stricterCandidateProfile()]]);
    const result = backtestEligibilityCandidate(ledger.readEvents(), current, candidate);
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe(AMS_ELIGIBILITY_RULE_ID);
    expect(result!.visibleCases).toBeGreaterThanOrEqual(20);
    expect(result!.heldOutCases).toBeGreaterThanOrEqual(5);
    expect(["improved", "regressed", "unchanged"]).toContain(result!.visible.verdict);
    expect(["improved", "regressed", "unchanged"]).toContain(result!.heldOut.verdict);
  });

  it("persists and aggregates eligibility backtest runs into the shared track record (#8545/#8185 parity)", () => {
    const ledger = tempLedger();
    seedLabeledCorpus(ledger, 40);
    const current = new Map([["acme/widgets", trustworthyProfile()]]);
    const candidate = new Map([["acme/widgets", stricterCandidateProfile()]]);
    const result = backtestEligibilityCandidate(ledger.readEvents(), current, candidate);
    expect(result).not.toBeNull();
    recordAmsEligibilityBacktestRun(result!, { eventLedger: ledger });
    const runs = readAmsEligibilityBacktestRuns(ledger);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      skippedNoContext: result!.skippedNoContext,
      visibleCases: result!.visibleCases,
      heldOutCases: result!.heldOutCases,
    });
    ledger.appendEvent({ type: MINER_AMS_ELIGIBILITY_BACKTEST_EVENT, payload: { skippedNoContext: 1 } });
    expect(readAmsEligibilityBacktestRuns(ledger)).toHaveLength(1);
    const trackRecord = computeAmsBacktestTrackRecord([], runs);
    expect(trackRecord.totalRuns).toBe(2);
    expect(() => recordAmsEligibilityBacktestRun(result!, {})).toThrow("invalid_event_ledger");
  });

  it("readAmsEligibilityBacktestRuns skips malformed rows and defaults missing case counts", () => {
    const ledger = tempLedger();
    seedLabeledCorpus(ledger, 40);
    const result = backtestEligibilityCandidate(
      ledger.readEvents(),
      new Map([["acme/widgets", trustworthyProfile()]]),
      new Map([["acme/widgets", stricterCandidateProfile()]]),
    );
    recordAmsEligibilityBacktestRun(result!, { eventLedger: ledger });
    ledger.appendEvent({ type: MINER_AMS_ELIGIBILITY_BACKTEST_EVENT, payload: { skippedNoContext: 1.5 } });
    ledger.appendEvent({
      type: MINER_AMS_ELIGIBILITY_BACKTEST_EVENT,
      payload: {
        skippedNoContext: 2,
        visible: { ruleId: "x", verdict: "weird" },
        heldOut: result!.heldOut,
      },
    });
    const runs = readAmsEligibilityBacktestRuns(ledger);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.visibleCases).toBe(result!.visibleCases);
    expect(computeAmsBacktestTrackRecord([], runs).totalRuns).toBe(2);
    const malformed = readAmsEligibilityBacktestRuns({
      readEvents: () => [
        { type: MINER_AMS_ELIGIBILITY_BACKTEST_EVENT, payload: "bad" },
        {
          type: MINER_AMS_ELIGIBILITY_BACKTEST_EVENT,
          createdAt: 123,
          payload: {
            skippedNoContext: 0,
            visibleCases: "many",
            heldOutCases: null,
            visible: result!.visible,
            heldOut: result!.heldOut,
          },
        },
      ],
    });
    expect(malformed).toHaveLength(1);
    expect(malformed[0]?.createdAt).toBeNull();
    expect(malformed[0]?.visibleCases).toBe(0);
    expect(malformed[0]?.heldOutCases).toBe(0);
  });

  it("aggregates threshold and eligibility backtest runs in one track record", () => {
    const ledger = tempLedger();
    for (let i = 1; i <= 60; i += 1) {
      ledger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: { issueNumber: i, rankScore: 0.15, title: "t", labels: [] } });
      ledger.appendEvent({
        type: "pr_outcome",
        repoFullName: "acme/widgets",
        payload: { prNumber: 1000 + i, decision: "closed", closedAt: "2026-07-10T00:00:00Z", reason: null, issueNumber: i },
      });
    }
    const threshold = backtestMinRankCandidate(ledger.readEvents(), AMS_MIN_RANK_SHIPPED, 0.2);
    expect(threshold).not.toBeNull();
    recordAmsThresholdBacktestRun(threshold!, { eventLedger: ledger });
    seedLabeledCorpus(ledger, 40);
    const eligibility = backtestEligibilityCandidate(
      ledger.readEvents(),
      new Map([["acme/widgets", trustworthyProfile()]]),
      new Map([["acme/widgets", stricterCandidateProfile()]]),
    );
    recordAmsEligibilityBacktestRun(eligibility!, { eventLedger: ledger });
    const trackRecord = computeAmsBacktestTrackRecord(
      readAmsThresholdBacktestRuns(ledger),
      readAmsEligibilityBacktestRuns(ledger),
    );
    expect(trackRecord.totalRuns).toBe(4);
  });
});
