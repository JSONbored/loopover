import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { SparkStat } from "./app.index";

// #6984: SparkStat's loading branch hand-rolled its own animate-pulse divs instead of the shared
// Skeleton primitive every other loading placeholder in this app already uses.
describe("SparkStat loading state (#6984)", () => {
  it("renders Skeleton placeholders (not the raw hand-rolled divs) while loading", () => {
    const { container } = render(
      <SparkStat
        label="Open PRs"
        value="4"
        values={[1, 2, 3, 4]}
        live
        statusLabel="live"
        loading
      />,
    );

    expect(screen.getByRole("status", { name: "Loading Open PRs" })).toBeTruthy();
    // Skeleton renders animate-pulse blocks; the label/value/sparkline placeholders are 3 in total.
    expect(container.querySelectorAll(".animate-pulse").length).toBe(3);
    // The real label/value text never renders while loading.
    expect(screen.queryByText("Open PRs")).toBeNull();
    expect(screen.queryByText("4")).toBeNull();
  });

  it("renders the real label and value once data is available (not loading)", () => {
    render(
      <TooltipProvider>
        <SparkStat label="Open PRs" value="4" values={[1, 2, 3, 4]} live statusLabel="live" />
      </TooltipProvider>,
    );

    expect(screen.getByText("Open PRs")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading Open PRs" })).toBeNull();
  });
});
