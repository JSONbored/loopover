import { afterEach, describe, expect, it, vi } from "vitest";

import { loadExtensionModules } from "./helpers.js";

const NOW_MS = Date.parse("2026-07-10T12:00:00.000Z");

describe("opportunity-badge exports", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("builds stable repo#issue lookup keys and finds ranked entries", async () => {
    const { opportunityExports: badge } = await loadExtensionModules();
    expect(badge.issueLookupKey("JSONbored/gittensory", 145)).toBe("jsonbored/gittensory#145");
    expect(badge.issueLookupKey("", 1)).toBeNull();
    expect(badge.issueLookupKey("a/b", 0)).toBeNull();

    const ranked = [
      { repoFullName: "JSONbored/gittensory", issueNumber: 145, rankScore: 0.8 },
      { repoFullName: "owner/repo", issueNumber: 2, rankScore: 0.4 },
    ];
    expect(badge.lookupRankedOpportunity(ranked, "JSONbored/gittensory", 145)?.rankScore).toBe(0.8);
    expect(badge.lookupRankedOpportunity(ranked, "JSONbored/gittensory", 404)).toBeNull();
    expect(badge.lookupRankedOpportunity(null, "a/b", 1)).toBeNull();
  });

  it("formats tier, score, and why without duplicating ranking math", async () => {
    const { opportunityExports: badge } = await loadExtensionModules();
    const entry = {
      rankScore: 0.82,
      laneFit: 0.9,
      freshness: 0.8,
      potential: 0.7,
      feasibility: 0.75,
      dupRisk: 0.1,
    };
    const formatted = badge.formatOpportunityBadge(entry);
    expect(formatted.tier).toBe("High");
    expect(formatted.score).toBe("0.82");
    expect(formatted.why.length).toBeGreaterThan(0);
    expect(badge.scoreToTier(0.6)).toBe("Medium");
    expect(badge.scoreToTier(0.2)).toBe("Low");

    const fallback = badge.formatOpportunityBadge({ rankScore: Number.NaN });
    expect(fallback.tier).toBe("Unknown");
    expect(fallback.score).toBe("—");
    expect(fallback.rankScore).toBeNull();
    expect(badge.buildOpportunityWhy({})).toBe("Balanced opportunity signals");
    expect(badge.buildOpportunityWhy({ laneFit: 0.8 })).toContain("lane fit");
    expect(badge.buildOpportunityWhy({ freshness: 0.8 })).toContain("Fresh issue");
    expect(badge.buildOpportunityWhy({ potential: 0.8 })).toContain("reward potential");
    expect(badge.buildOpportunityWhy({ feasibility: 0.8 })).toContain("Feasible scope");
    expect(badge.buildOpportunityWhy({ dupRisk: 0.1 })).toContain("duplicate risk");
  });

  it("skips malformed ranked entries while scanning the cache", async () => {
    const { opportunityExports: badge } = await loadExtensionModules();
    const ranked = [
      null,
      { repoFullName: "a/b", issueNumber: "nope" },
      { repoFullName: "JSONbored/gittensory", issueNumber: 145, rankScore: 0.5 },
    ];
    expect(badge.lookupRankedOpportunity(ranked, "JSONbored/gittensory", 145)?.rankScore).toBe(0.5);
  });

  it("formats relative last-synced labels and escapes badge markup", async () => {
    const { opportunityExports: badge } = await loadExtensionModules();
    expect(badge.formatLastSyncedLabel(NOW_MS, NOW_MS)).toBe("last synced just now");
    expect(badge.formatLastSyncedLabel(NOW_MS - 60_000, NOW_MS)).toBe("last synced 1m ago");
    expect(badge.formatLastSyncedLabel(NOW_MS - 60 * 60_000, NOW_MS)).toBe("last synced 1h ago");
    expect(badge.formatLastSyncedLabel(NOW_MS - 24 * 60 * 60_000, NOW_MS)).toBe("last synced 1d ago");
    expect(badge.formatLastSyncedLabel(null, NOW_MS)).toBeNull();

    const formatted = badge.formatOpportunityBadge({ rankScore: 0.6 });
    const markup = badge.renderOpportunityBadgeMarkup(formatted, "last synced 3m ago");
    expect(markup).toContain("Read-only");
    expect(markup).toContain("last synced 3m ago");
    expect(markup).not.toContain("<script>");
    expect(badge.renderOpportunityBadgeMarkup(null as unknown as Record<string, unknown>)).toBe("");
    expect(badge.renderOpportunityBadgeMarkup(formatted, null)).not.toContain("last synced");
    expect(badge.escapeOpportunityHtml(`<&>"'>`)).toContain("&gt;");
  });
});
