import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ContributorQualityTable } from "@/components/site/app-panels/contributor-quality-table";
import type { MaintainerTopContributor } from "@/components/site/app-panels/contributor-quality-table-model";

// Mirrors the forbidden-terms guard in test/unit/maintainer-quality-dashboard.test.ts — the UI must never
// surface a raw credibility/reward signal even if a caller accidentally widened the prop type.
const FORBIDDEN_PUBLIC_TERMS =
  /wallet|hotkey|coldkey|mnemonic|reward|payout|farming|raw trust|trust score|scoreability|credibility|clean ratio|private ranking/i;

function contributor(overrides: Partial<MaintainerTopContributor> = {}): MaintainerTopContributor {
  return { login: "alice", band: "strong", openPrCount: 4, ...overrides };
}

describe("ContributorQualityTable", () => {
  it("renders a row per contributor with login, band pill, and open PR count", () => {
    render(
      <ContributorQualityTable
        topContributors={[
          contributor({ login: "alice", band: "strong", openPrCount: 5 }),
          contributor({ login: "bob", band: "developing", openPrCount: 2 }),
        ]}
      />,
    );
    expect(screen.getByText("Top contributors by quality band")).toBeTruthy();
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("bob")).toBeTruthy();
    expect(screen.getByText("strong")).toBeTruthy();
    expect(screen.getByText("developing")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("renders a single row without error when there is exactly one contributor in window", () => {
    render(
      <ContributorQualityTable
        topContributors={[contributor({ login: "carol", band: "early", openPrCount: 1 })]}
      />,
    );
    expect(screen.getByText("carol")).toBeTruthy();
    expect(screen.getByText("early")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.queryByText("No contributor quality data yet")).toBeNull();
  });

  it("renders an EmptyState instead of a table when there are no contributors in window", () => {
    render(<ContributorQualityTable topContributors={[]} />);
    expect(screen.getByText("No contributor quality data yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("falls back to the neutral 'info' pill tone for an unrecognized band value (defensive ?? fallback)", () => {
    render(
      <ContributorQualityTable
        topContributors={[contributor({ login: "dave", band: "mystery" })]}
      />,
    );
    const pill = screen.getByText("mystery");
    // "info" tone (see STATUS_STYLES in control-primitives.tsx), not the "strong"/"developing"/"early" tones.
    expect(pill.className).toContain("border-mint/30");
  });

  it("applies the 'ready' tone for the 'strong' band, distinct from the fallback tone", () => {
    render(
      <ContributorQualityTable
        topContributors={[contributor({ login: "erin", band: "strong" })]}
      />,
    );
    const pill = screen.getByText("strong");
    expect(pill.className).toContain("border-success/40");
    expect(pill.className).not.toContain("border-mint/30");
  });

  it("never renders a raw credibility/clean-ratio number — band label and open PR count only (redaction)", () => {
    const { container } = render(
      <ContributorQualityTable
        topContributors={[contributor({ login: "frank", band: "developing", openPrCount: 3 })]}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    // Only the observable open-PR count is numeric — no decimal/percentage-shaped score is ever rendered.
    expect(text).not.toMatch(/\d+\.\d+|\d+%/);
  });
});
