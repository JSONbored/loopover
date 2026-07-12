import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SlopDuplicateCard } from "@/components/site/app-panels/slop-duplicate-card";

describe("SlopDuplicateCard", () => {
  it("renders both signal rows with rates and flagged/total counts when populated", () => {
    render(
      <SlopDuplicateCard
        signal={{
          openPullRequests: 20,
          slopFlaggedPullRequests: 3,
          duplicateFlaggedPullRequests: 8,
          slopRate: 0.15,
          duplicateRate: 0.4,
        }}
      />,
    );
    expect(screen.getByText("Slop-flagged")).toBeTruthy();
    expect(screen.getByText("Duplicate-flagged")).toBeTruthy();
    expect(screen.getByText("15%")).toBeTruthy();
    expect(screen.getByText("40%")).toBeTruthy();
    expect(screen.getByText(/3 of 20 open PRs/)).toBeTruthy();
    expect(screen.getByText(/8 of 20 open PRs/)).toBeTruthy();
  });

  it("renders an em-dash when a rate is null (unassessed)", () => {
    render(
      <SlopDuplicateCard
        signal={{
          openPullRequests: 5,
          slopFlaggedPullRequests: 0,
          duplicateFlaggedPullRequests: 1,
          slopRate: null,
          duplicateRate: 0.2,
        }}
      />,
    );
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("no data")).toBeTruthy();
  });

  it("shows the 'queue is clear' empty state when there are no open PRs", () => {
    render(
      <SlopDuplicateCard
        signal={{
          openPullRequests: 0,
          slopFlaggedPullRequests: 0,
          duplicateFlaggedPullRequests: 0,
          slopRate: null,
          duplicateRate: null,
        }}
      />,
    );
    expect(screen.getByText("Queue is clear")).toBeTruthy();
    expect(screen.queryByText("Slop-flagged")).toBeNull();
  });

  it("shows the 'not yet available' empty state when the signal is absent", () => {
    render(<SlopDuplicateCard />);
    expect(screen.getByText("Not yet available")).toBeTruthy();
  });
});
