import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AcceptanceRateCard } from "@/components/site/app-panels/acceptance-rate-card";
import {
  bandForAcceptanceRate,
  summarizeAcceptanceRate,
} from "@/components/site/app-panels/acceptance-rate-card-model";

describe("summarizeAcceptanceRate", () => {
  it("derives the rate from the counts", () => {
    expect(summarizeAcceptanceRate({ accepted: 3, total: 4, windowDays: 30 })).toEqual({
      accepted: 3,
      total: 4,
      rate: 0.75,
    });
  });

  it("returns a null rate for an empty denominator", () => {
    expect(summarizeAcceptanceRate({ accepted: 0, total: 0, windowDays: 30 })).toEqual({
      accepted: 0,
      total: 0,
      rate: null,
    });
  });
});

describe("bandForAcceptanceRate", () => {
  it("bands the rate: >=50% ready, below warn, null info", () => {
    expect(bandForAcceptanceRate(0.75)).toBe("ready");
    expect(bandForAcceptanceRate(0.5)).toBe("ready");
    expect(bandForAcceptanceRate(0.2)).toBe("warn");
    expect(bandForAcceptanceRate(null)).toBe("info");
  });
});

describe("AcceptanceRateCard", () => {
  it("renders the rate percentage and accepted/total counts for a populated report", () => {
    render(<AcceptanceRateCard report={{ accepted: 3, total: 4, windowDays: 30 }} />);
    expect(screen.getByText("Finding acceptance rate")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText("30-day window")).toBeTruthy();
    expect(screen.getByText("accepted / findings posted")).toBeTruthy();
  });

  it("renders '—' for the rate when nothing was posted (null-rate arm)", () => {
    render(<AcceptanceRateCard report={{ accepted: 0, total: 0, windowDays: 7 }} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("7-day window")).toBeTruthy();
  });

  it("renders a graceful EmptyState when the acceptance field is absent", () => {
    render(<AcceptanceRateCard report={undefined} />);
    expect(screen.getByText("Acceptance rate not yet available")).toBeTruthy();
  });
});
