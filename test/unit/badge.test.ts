import { describe, expect, it } from "vitest";
import {
  buildBadgeColor,
  buildBadgeMessage,
  buildShieldsBadge,
  escapeXml,
  renderBadgeSvg,
  renderUnavailableBadgeSvg,
} from "../../src/api/badge";
import type { PublicRepoQuality } from "../../src/services/public-repo-quality";

function quality(overrides: Partial<PublicRepoQuality> = {}): PublicRepoQuality {
  return {
    medianTimeToMergeHours: 30,
    realContributionPct: 92,
    queueHealthLevel: "low",
    mergedSampleSize: 10,
    assessedSampleSize: 8,
    ...overrides,
  };
}

describe("buildBadgeMessage", () => {
  it("summarizes the whitelisted metrics", () => {
    expect(buildBadgeMessage(quality())).toBe("92% real · merge 30h · queue low");
  });

  it("renders n/a for missing metrics and formats duration by magnitude", () => {
    expect(buildBadgeMessage(quality({ realContributionPct: null, medianTimeToMergeHours: null }))).toBe(
      "real n/a · merge n/a · queue low",
    );
    expect(buildBadgeMessage(quality({ medianTimeToMergeHours: 0 }))).toContain("merge <1h");
    expect(buildBadgeMessage(quality({ medianTimeToMergeHours: 72 }))).toContain("merge 3d");
  });
});

describe("buildBadgeColor", () => {
  it("tracks queue health when contribution quality is healthy", () => {
    expect(buildBadgeColor(quality({ queueHealthLevel: "low" }))).toBe("#3fb950");
    expect(buildBadgeColor(quality({ queueHealthLevel: "medium" }))).toBe("#d29922");
    expect(buildBadgeColor(quality({ queueHealthLevel: "critical" }))).toBe("#f85149");
  });

  it("downgrades the color when the real-contribution share is low", () => {
    expect(buildBadgeColor(quality({ queueHealthLevel: "low", realContributionPct: 40 }))).toBe("#db6d28");
  });

  it("never renders a lower severity than the queue color when the real-contribution share is low", () => {
    // A low real-contribution share floors the color at `high` (orange) but must not DOWNGRADE a more-severe
    // queue: a critical queue (red) with low contribution is doubly bad and must stay red, not become orange.
    expect(buildBadgeColor(quality({ queueHealthLevel: "critical", realContributionPct: 20 }))).toBe("#f85149");
    // A `high` queue with low contribution stays high (no double-count), and medium still escalates to high.
    expect(buildBadgeColor(quality({ queueHealthLevel: "high", realContributionPct: 20 }))).toBe("#db6d28");
    expect(buildBadgeColor(quality({ queueHealthLevel: "medium", realContributionPct: 20 }))).toBe("#db6d28");
  });

  it("uses queue color when the contribution share is unknown", () => {
    expect(buildBadgeColor(quality({ queueHealthLevel: "low", realContributionPct: null }))).toBe("#3fb950");
  });
});

describe("buildShieldsBadge", () => {
  it("emits a shields endpoint payload", () => {
    expect(buildShieldsBadge(quality(), 600)).toEqual({
      schemaVersion: 1,
      label: "gittensory",
      message: "92% real · merge 30h · queue low",
      color: "#3fb950",
      cacheSeconds: 600,
    });
  });
});

describe("renderBadgeSvg", () => {
  it("renders a valid SVG carrying the label and message", () => {
    const svg = renderBadgeSvg(quality());
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("gittensory");
    expect(svg).toContain("92% real");
    expect(svg).toContain('role="img"');
    expect(svg).not.toMatch(/wallet|hotkey|trust|reward|login/i);
  });

  it("renders a benign unavailable badge", () => {
    const svg = renderUnavailableBadgeSvg();
    expect(svg).toContain("unavailable");
    expect(svg.startsWith("<svg")).toBe(true);
  });
});

describe("escapeXml", () => {
  it("escapes all XML-significant characters", () => {
    expect(escapeXml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeXml("safe text 92%")).toBe("safe text 92%");
  });
});
