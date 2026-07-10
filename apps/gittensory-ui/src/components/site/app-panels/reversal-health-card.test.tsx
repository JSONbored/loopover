import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReversalHealthCard } from "@/components/site/app-panels/reversal-health-card";
import {
  formatRatePct,
  reversalHealthStatus,
  type ReversalHealth,
} from "@/components/site/app-panels/reversal-health-card-model";

function health(overrides: Partial<ReversalHealth> = {}): ReversalHealth {
  return {
    reversals: 0,
    reversalRate: 0,
    manualRate: 0.1,
    recentAutoActions: 20,
    reversedTargets: [],
    ...overrides,
  };
}

describe("reversalHealthStatus", () => {
  it("returns ready when there are auto-actions but zero reversals", () => {
    expect(reversalHealthStatus(health())).toEqual({ tone: "ready", label: "0 reversals" });
  });

  it("returns warn when reversals meet the documented alert minimum (above-threshold arm)", () => {
    expect(reversalHealthStatus(health({ reversals: 2, reversalRate: 0.1 }))).toEqual({
      tone: "warn",
      label: "2 reversal(s)",
    });
  });

  it("returns info when recentAutoActions is 0 (empty-denominator arm keeps reversalRate at 0)", () => {
    expect(reversalHealthStatus(health({ recentAutoActions: 0, reversalRate: 0 }))).toEqual({
      tone: "info",
      label: "no auto-actions in window",
    });
  });
});

describe("ReversalHealthCard", () => {
  it("renders zero-reversals stats and the empty reversed-targets state", () => {
    render(<ReversalHealthCard health={health()} />);
    expect(screen.getByText("Reversal health")).toBeTruthy();
    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByText("0 reversals")).toBeTruthy();
    expect(screen.getByText("No reversals in window")).toBeTruthy();
    expect(formatRatePct(0.1)).toBe("10%");
    expect(screen.getByText("10%")).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy();
  });

  it("renders above-threshold reversal stats and lists reversed targets", () => {
    render(
      <ReversalHealthCard
        health={health({
          reversals: 1,
          reversalRate: 0.25,
          recentAutoActions: 4,
          reversedTargets: [
            {
              number: 42,
              repo: "acme/widgets",
              status: "merged",
              eventType: "reversal_reopened",
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("25%")).toBeTruthy();
    expect(screen.getByText("1 reversal(s)")).toBeTruthy();
    expect(screen.getByText("acme/widgets#42")).toBeTruthy();
    expect(screen.getByText(/close reopened · merged/)).toBeTruthy();
    expect(screen.queryByText("No reversals in window")).toBeNull();
  });

  it("shows 0% reversal rate when recentAutoActions is 0 (empty-denominator branch)", () => {
    render(
      <ReversalHealthCard
        health={health({ recentAutoActions: 0, reversalRate: 0, reversals: 0 })}
      />,
    );
    expect(screen.getByText("no auto-actions in window")).toBeTruthy();
    expect(screen.getAllByText("0%").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("No reversals in window")).toBeTruthy();
  });
});
