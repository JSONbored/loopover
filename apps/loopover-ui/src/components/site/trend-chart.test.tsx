import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TrendChart } from "@/components/site/trend-chart";

function getPaths(container: HTMLElement) {
  const paths = container.querySelectorAll("path");
  return { area: paths[0]?.getAttribute("d") ?? "", line: paths[1]?.getAttribute("d") ?? "" };
}

describe("TrendChart", () => {
  // The named regression test for this bug (#9674): a null between two numeric points must break
  // the polyline into two separate `M`-started sub-paths, never an `L` segment drawn through it.
  it("breaks [10, null, 30] into two sub-paths instead of interpolating through the gap", () => {
    const { container } = render(<TrendChart values={[10, null, 30]} label="Test trend" />);
    const { line } = getPaths(container);
    expect(line).toBe("M 0.0 52.0 M 120.0 4.0");
  });

  it("closes a filled area per contiguous run, not once across the whole series", () => {
    const { container } = render(<TrendChart values={[10, null, 30]} label="Test trend" />);
    const { area } = getPaths(container);
    expect((area.match(/M /g) ?? []).length).toBe(2);
    expect((area.match(/Z/g) ?? []).length).toBe(2);
  });

  it("renders empty d and area attributes for an all-null series", () => {
    const { container } = render(<TrendChart values={[null, null]} label="Test trend" />);
    const { area, line } = getPaths(container);
    expect(line).toBe("");
    expect(area).toBe("");
  });

  it("renders empty d and area attributes for an empty series", () => {
    const { container } = render(<TrendChart values={[]} label="Test trend" />);
    const { area, line } = getPaths(container);
    expect(line).toBe("");
    expect(area).toBe("");
  });

  it("starts a single sub-path after a leading null", () => {
    const { container } = render(<TrendChart values={[null, 10, 20]} label="Test trend" />);
    const { line } = getPaths(container);
    expect((line.match(/M /g) ?? []).length).toBe(1);
    expect(line).not.toContain("NaN");
  });

  it("ends a single sub-path before a trailing null", () => {
    const { container } = render(<TrendChart values={[10, 20, null]} label="Test trend" />);
    const { line } = getPaths(container);
    expect((line.match(/M /g) ?? []).length).toBe(1);
    expect(line).not.toContain("NaN");
  });

  it("renders one continuous sub-path when no null is present", () => {
    const { container } = render(<TrendChart values={[10, 20, 30]} label="Test trend" />);
    const { line } = getPaths(container);
    expect((line.match(/M /g) ?? []).length).toBe(1);
    expect((line.match(/L /g) ?? []).length).toBe(2);
  });

  it("excludes null entries from the min/max/range computation", () => {
    // If a null were coerced into the range computation (e.g. via `?? 0`), the numeric points here
    // would be plotted relative to a fabricated 0 floor instead of their own 10..30 span.
    const withGap = getPaths(
      render(<TrendChart values={[10, null, 30]} label="Test trend" />).container,
    ).line;
    const dense = getPaths(
      render(<TrendChart values={[10, 30]} label="Test trend" />).container,
    ).line;
    expect(withGap).toBe("M 0.0 52.0 M 120.0 4.0");
    expect(dense).toBe("M 0.0 52.0 L 120.0 4.0");
  });

  it("renders the required label as the svg's aria-label", () => {
    render(<TrendChart values={[1, 2, 3]} label="Kept-rate curve" />);
    expect(screen.getByLabelText("Kept-rate curve")).toBeTruthy();
  });

  it("renders a distinct aria-label for a second instance", () => {
    render(<TrendChart values={[4, 5, 6]} label="Slop flag rate trend" />);
    expect(screen.getByLabelText("Slop flag rate trend")).toBeTruthy();
    expect(screen.queryByLabelText("Trend chart")).toBeNull();
  });
});
