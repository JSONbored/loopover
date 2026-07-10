import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AcceptanceRateCard } from "@/components/site/app-panels/acceptance-rate-card";

describe("AcceptanceRateCard", () => {
  it("renders the rounded rate, plural counts, healthy band, and window label when data is present", () => {
    render(
      <AcceptanceRateCard acceptance={{ windowDays: 30, accepted: 9, total: 12, rate: 0.75 }} />,
    );
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText(/9 of 12 inline findings acted on/)).toBeTruthy();
    expect(screen.getByText("healthy")).toBeTruthy();
    expect(screen.getByText("30d window")).toBeTruthy();
  });

  it("uses the singular 'finding' wording when exactly one finding is in the window", () => {
    render(<AcceptanceRateCard acceptance={{ windowDays: 14, accepted: 1, total: 1, rate: 1 }} />);
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByText(/1 of 1 inline finding acted on/)).toBeTruthy();
  });

  it("bands a mid-range rate as 'mixed'", () => {
    render(<AcceptanceRateCard acceptance={{ windowDays: 7, accepted: 2, total: 5, rate: 0.4 }} />);
    expect(screen.getByText("40%")).toBeTruthy();
    expect(screen.getByText("mixed")).toBeTruthy();
  });

  it("bands a low rate as 'low'", () => {
    render(
      <AcceptanceRateCard acceptance={{ windowDays: 7, accepted: 1, total: 10, rate: 0.1 }} />,
    );
    expect(screen.getByText("10%")).toBeTruthy();
    expect(screen.getByText("low")).toBeTruthy();
  });

  it("shows an em-dash and 'no findings' band when the window is empty (rate null)", () => {
    render(
      <AcceptanceRateCard acceptance={{ windowDays: 7, accepted: 0, total: 0, rate: null }} />,
    );
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText(/0 of 0 inline findings acted on/)).toBeTruthy();
    expect(screen.getByText("no findings")).toBeTruthy();
  });

  it("renders the 'not yet available' empty state when the acceptance field is absent", () => {
    render(<AcceptanceRateCard />);
    expect(screen.getByText("Not yet available")).toBeTruthy();
    expect(screen.queryByText("Acceptance rate")).toBeNull();
  });
});
