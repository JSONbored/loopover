import { describe, expect, it } from "vitest";
import {
  PUBLIC_SUMMARY_FIELDS,
  computeTrackRecord,
  renderTrackRecordSummary,
  toPublicSummary,
} from "../../packages/gittensory-miner/lib/track-record.js";

describe("gittensory-miner track-record summary (#3008)", () => {
  it("exposes a frozen public-field allowlist", () => {
    expect(Object.isFrozen(PUBLIC_SUMMARY_FIELDS)).toBe(true);
    expect(PUBLIC_SUMMARY_FIELDS).toEqual([
      "mergedCount",
      "closedCount",
      "mergeRatePercent",
      "tenureDays",
      "cleanRecord",
    ]);
  });

  describe("computeTrackRecord", () => {
    it("computes merge rate, tenure, and a clean attestation for a positive track record", () => {
      const record = computeTrackRecord({
        mergedCount: 11,
        closedCount: 1,
        firstMergedAtIso: "2026-05-20T00:00:00Z",
        nowIso: "2026-07-04T00:00:00Z",
        incidents: [],
      });
      expect(record).toEqual({
        mergedCount: 11,
        closedCount: 1,
        mergeRatePercent: 92, // 11/12 = 0.9166 → 92
        tenureDays: 45,
        cleanRecord: true,
      });
    });

    it("returns a zero-history summary for a brand-new miner without inventing numbers", () => {
      const record = computeTrackRecord({ mergedCount: 0, closedCount: 0, incidents: [] });
      expect(record).toEqual({
        mergedCount: 0,
        closedCount: 0,
        mergeRatePercent: 0, // no attempts → 0, not a divide-by-zero
        tenureDays: 0,
        cleanRecord: true,
      });
    });

    it("does not claim a clean record when an incident is present or the list is unknown", () => {
      expect(
        computeTrackRecord({ mergedCount: 5, closedCount: 0, incidents: [{ kind: "ban" }] }).cleanRecord,
      ).toBe(false);
      // A MISSING incident list must not default to a clean claim — the attestation has to be earned.
      expect(computeTrackRecord({ mergedCount: 5, closedCount: 0 }).cleanRecord).toBe(false);
    });

    it("never produces a negative or fabricated tenure from bad/incoherent dates", () => {
      // start after now → 0, not a negative span
      expect(
        computeTrackRecord({ firstMergedAtIso: "2026-07-04T00:00:00Z", nowIso: "2026-05-01T00:00:00Z" })
          .tenureDays,
      ).toBe(0);
      // unparseable / missing dates → 0
      expect(computeTrackRecord({ firstMergedAtIso: "not-a-date", nowIso: "2026-07-04T00:00:00Z" }).tenureDays).toBe(0);
      expect(computeTrackRecord({}).tenureDays).toBe(0);
    });

    it("coerces malformed counts to non-negative integers", () => {
      const record = computeTrackRecord({ mergedCount: -3, closedCount: Number.NaN, incidents: [] });
      expect(record.mergedCount).toBe(0);
      expect(record.closedCount).toBe(0);
    });
  });

  describe("renderTrackRecordSummary", () => {
    it("renders a deterministic single-line block for a positive record", () => {
      const record = computeTrackRecord({
        mergedCount: 11,
        closedCount: 1,
        firstMergedAtIso: "2026-05-20T00:00:00Z",
        nowIso: "2026-07-04T00:00:00Z",
        incidents: [],
      });
      expect(renderTrackRecordSummary(record)).toBe(
        "Track record: 92% merge rate (11 merged / 1 closed) · 45 days active · no code-of-conduct incidents",
      );
    });

    it("reports incidents honestly rather than attesting a clean record", () => {
      const record = computeTrackRecord({ mergedCount: 5, closedCount: 0, incidents: [{ kind: "ban" }] });
      expect(renderTrackRecordSummary(record)).toContain("code-of-conduct incidents on record");
    });

    it("is opt-out: an explicitly disabled summary renders nothing", () => {
      const record = computeTrackRecord({ mergedCount: 5, closedCount: 0, incidents: [] });
      expect(renderTrackRecordSummary(record, { enabled: false })).toBe("");
    });

    it("HARD GUARD: no internal scoring/reward/trust field can reach the rendered output", () => {
      // A record deliberately polluted with internal metrics the summary must never surface.
      const polluted = {
        mergedCount: 9,
        closedCount: 3,
        mergeRatePercent: 75,
        tenureDays: 30,
        cleanRecord: true,
        trustScore: 0.97,
        reward: 12.34,
        rank: 4,
        emissionWeight: 0.1,
        incentive: 8675309,
      };
      const summary = toPublicSummary(polluted);
      expect(Object.keys(summary).sort()).toEqual([...PUBLIC_SUMMARY_FIELDS].sort()); // only allowlisted keys
      const rendered = renderTrackRecordSummary(polluted);
      for (const banned of ["trust", "reward", "rank", "weight", "incentive", "0.97", "12.34", "8675309"]) {
        expect(rendered.toLowerCase()).not.toContain(banned);
      }
    });
  });
});
