import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GateOutcomeCard } from "@/components/site/app-panels/gate-outcome-card";
import type { GateOutcomeCardData } from "@/components/site/app-panels/gate-outcome-card-model";
import {
  formatGateOutcomeRate,
  gateOutcomeHasSamples,
  gateOutcomeSegments,
} from "@/components/site/app-panels/gate-outcome-card-model";

const FORBIDDEN_PUBLIC_TERMS =
  /wallet|hotkey|coldkey|mnemonic|reward|payout|farming|raw trust|trust score|scoreability|credibility|private ranking/i;

function breakdown(overrides: Partial<GateOutcomeCardData> = {}): GateOutcomeCardData {
  return {
    windowDays: 30,
    generatedAt: "2026-07-11T00:00:00.000Z",
    counts: { autoMerged: 6, autoClosed: 3, held: 1 },
    total: 10,
    rates: { autoMerged: 60, autoClosed: 30, held: 10 },
    summary:
      "10 gate outcome(s) in the last 30 day(s): 6 auto-merged, 3 auto-closed, 1 held for manual review.",
    ...overrides,
  };
}

describe("gate-outcome-card-model (#2203)", () => {
  it("builds stacked segments when all three outcome buckets are present", () => {
    const segments = gateOutcomeSegments(breakdown());
    expect(segments.map((segment) => segment.key)).toEqual(["autoMerged", "autoClosed", "held"]);
    expect(segments.map((segment) => segment.widthPct)).toEqual([60, 30, 10]);
    expect(new Set(segments.map((segment) => segment.barClassName)).size).toBe(3);
    expect(segments.find((segment) => segment.key === "autoMerged")?.barClassName).toBe(
      "bg-success/80",
    );
    expect(segments.find((segment) => segment.key === "autoClosed")?.barClassName).toBe(
      "bg-danger/80",
    );
  });

  it("omits a zero-count bucket from the stacked bar while keeping rates on the card", () => {
    const segments = gateOutcomeSegments(
      breakdown({
        counts: { autoMerged: 4, autoClosed: 0, held: 1 },
        total: 5,
        rates: { autoMerged: 80, autoClosed: 0, held: 20 },
      }),
    );
    expect(segments.map((segment) => segment.key)).toEqual(["autoMerged", "held"]);
    expect(formatGateOutcomeRate(0)).toBe("0%");
  });

  it("returns no segments and no samples when the breakdown is empty", () => {
    const empty = breakdown({
      counts: { autoMerged: 0, autoClosed: 0, held: 0 },
      total: 0,
      rates: { autoMerged: null, autoClosed: null, held: null },
      summary: "No gate-outcome audit events in the last 30 day(s) for the scoped repos.",
    });
    expect(gateOutcomeHasSamples(empty)).toBe(false);
    expect(gateOutcomeSegments(empty)).toEqual([]);
  });
});

describe("GateOutcomeCard (#2203)", () => {
  it("renders three stat tiles and a stacked proportion bar when all outcomes are present", () => {
    render(<GateOutcomeCard breakdown={breakdown()} />);
    expect(screen.getByText("Gate outcomes")).toBeTruthy();
    expect(screen.getByText("Auto-merged")).toBeTruthy();
    expect(screen.getByText("Auto-closed")).toBeTruthy();
    expect(screen.getByText("Held / manual")).toBeTruthy();
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("60% of outcomes")).toBeTruthy();
    expect(
      screen.getByLabelText(/Gate outcome mix: 6 auto-merged, 3 auto-closed, 1 held/i),
    ).toBeTruthy();
  });

  it("shows a zero bucket as 0% while still rendering the other segments", () => {
    render(
      <GateOutcomeCard
        breakdown={breakdown({
          counts: { autoMerged: 2, autoClosed: 0, held: 2 },
          total: 4,
          rates: { autoMerged: 50, autoClosed: 0, held: 50 },
        })}
      />,
    );
    expect(screen.getByText("0% of outcomes")).toBeTruthy();
    expect(
      screen.getByLabelText(/Gate outcome mix: 2 auto-merged, 0 auto-closed, 2 held/i),
    ).toBeTruthy();
  });

  it("renders an empty state instead of the proportion bar when there are no audit events", () => {
    render(
      <GateOutcomeCard
        breakdown={breakdown({
          counts: { autoMerged: 0, autoClosed: 0, held: 0 },
          total: 0,
          rates: { autoMerged: null, autoClosed: null, held: null },
        })}
      />,
    );
    expect(screen.getByText("No gate-outcome events yet")).toBeTruthy();
    expect(screen.queryByLabelText(/Gate outcome mix/i)).toBeNull();
    expect(screen.getAllByText("n/a of outcomes")).toHaveLength(3);
  });

  it("never surfaces forbidden reward/wallet/score terms", () => {
    const { container } = render(<GateOutcomeCard breakdown={breakdown()} />);
    expect(container.textContent ?? "").not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("renders its generatedAt timestamp (#6174)", () => {
    render(<GateOutcomeCard breakdown={breakdown({ generatedAt: "2026-07-11T00:00:00.000Z" })} />);
    expect(screen.getByText("generated 11 Jul 2026 00:00")).toBeTruthy();
  });
});
