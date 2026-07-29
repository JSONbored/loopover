import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Sparkline } from "./sparkline";
import type { TrendPoint } from "./proof-of-power-stats-model";

// The sparkline is the one place this app renders a chart library, so a major bump of that library
// (#8610: recharts 2 -> 3) needs a guard that the thing still DRAWS -- a type-clean upgrade that renders
// nothing looks identical to a passing build.
//
// ResponsiveContainer measures its parent, and jsdom reports 0x0 for everything, so the fixed pixel size
// the component already sets is stubbed onto the element's box here. Without it recharts correctly draws
// nothing and every assertion below would pass vacuously against an empty SVG.
function renderSparkline(points: TrendPoint[]) {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width: 64,
      height: 28,
      top: 0,
      left: 0,
      right: 64,
      bottom: 28,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  try {
    return render(<Sparkline points={points} color="#ff0000" />);
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", original);
  }
}

const WEEKS: TrendPoint[] = [
  { label: "w1", value: 10 },
  { label: "w2", value: 20 },
  { label: "w3", value: 15 },
];

describe("Sparkline (#8610 recharts v3)", () => {
  it("renders an accessible trend image with a drawn line path", () => {
    const { container, getByRole } = renderSparkline(WEEKS);
    expect(getByRole("img", { name: /trend over the last 3 weeks/i })).toBeTruthy();
    // The actual regression this guards: a v3 API change that type-checks but draws nothing.
    const paths = container.querySelectorAll("path.recharts-line-curve, .recharts-line path");
    expect(paths.length).toBeGreaterThan(0);
  });

  it("renders NOTHING when every point is null — a sparkline of no data is not a flat line at zero", () => {
    const { container } = renderSparkline([
      { label: "w1", value: null },
      { label: "w2", value: null },
    ]);
    expect(container.firstChild).toBeNull();
  });

  it("still renders when only some weeks are below their sample floor", () => {
    // connectNulls={false} is what makes a gap read as "insufficient data" rather than as a straight line
    // drawn through it; the component must not bail just because one point is null.
    const { getByRole } = renderSparkline([
      { label: "w1", value: 10 },
      { label: "w2", value: null },
      { label: "w3", value: 30 },
    ]);
    expect(getByRole("img")).toBeTruthy();
  });

  it("labels itself with the real number of weeks it was given", () => {
    const { getByRole } = renderSparkline([...WEEKS, { label: "w4", value: 12 }]);
    expect(getByRole("img", { name: /last 4 weeks/i })).toBeTruthy();
  });
});
