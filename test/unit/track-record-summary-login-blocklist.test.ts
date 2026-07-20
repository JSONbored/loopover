import { describe, expect, it } from "vitest";
import { computeTrackRecordSummary, renderTrackRecordSummaryMarkdown } from "../../packages/loopover-engine/src/track-record-summary";

// #6772: `renderTrackRecordSummaryMarkdown` used to scan the ENTIRE rendered block -- including the caller-
// provided `GitHub login:` identity line -- against PUBLIC_FIELD_BLOCKLIST, so a genuine username that merely
// contains a blocklisted word bounded by hyphens (e.g. "team-wallet") crashed rendering. The fix scans only the
// computed fields. This is a ROOT vitest suite (not the engine's node:test one) so the changed lines land in the
// Codecov patch measurement for `packages/loopover-engine/src/**`.
const NOW = "2026-07-04T18:00:00.000Z";
const config = { includeTrackRecordSummary: true, warnings: [] as string[] };

describe("renderTrackRecordSummaryMarkdown login vs public-field blocklist (#6772)", () => {
  it("REGRESSION: renders a genuine GitHub login containing a blocklisted word (team-wallet) instead of throwing", () => {
    const summary = computeTrackRecordSummary({ login: "team-wallet", now: NOW, config, outcomes: [] });
    const md = renderTrackRecordSummaryMarkdown(summary);
    expect(md).toContain("- GitHub login: team-wallet");
  });

  it("still fails closed when a COMPUTED field carries a blocklisted term (the exemption is identity-line-only)", () => {
    const summary = computeTrackRecordSummary({ login: "miner", now: NOW, config, outcomes: [] });
    expect(() =>
      renderTrackRecordSummaryMarkdown({ ...summary, incidents: { ...summary.incidents, label: "trust score leaked" } }),
    ).toThrow(/blocked public field/u);
  });

  it("returns an empty string for a disabled summary (no rendering, no scan)", () => {
    const base = computeTrackRecordSummary({ login: "miner", now: NOW, config, outcomes: [] });
    expect(renderTrackRecordSummaryMarkdown({ ...base, enabled: false })).toBe("");
  });

  it("renders the optional open-ignored and public-evidence lines when present (both conditional branches)", () => {
    const base = computeTrackRecordSummary({ login: "octocat", now: NOW, config, outcomes: [] });
    const md = renderTrackRecordSummaryMarkdown({
      ...base,
      outcomes: { ...base.outcomes, openIgnored: 3 },
      incidents: { ...base.incidents, hasPublicIncident: true, evidenceUrls: ["https://example.test/record"] },
    });
    expect(md).toContain("- Open PRs ignored for rate: 3");
    expect(md).toMatch(/- Public evidence: .*example\.test\/record/u);
  });

  it("REGRESSION (#7444): renders an evidence URL whose path contains a blocklisted substring instead of throwing", () => {
    const base = computeTrackRecordSummary({ login: "miner", now: NOW, config, outcomes: [] });
    const md = renderTrackRecordSummaryMarkdown({
      ...base,
      incidents: {
        ...base.incidents,
        hasPublicIncident: true,
        label: "public conduct incident present",
        evidenceUrls: ["https://example.test/org/wallet-connect/issues/1"],
      },
    });
    expect(md).toContain("https://example.test/org/wallet-connect/issues/1");
  });
});
