import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ResponsiveContainer measures its parent through a ResizeObserver, and under jsdom that measurement never
// resolves -- it renders NOTHING, discarding its children entirely. Every assertion below would then fail, and
// the "renders nothing" ones would pass for entirely the wrong reason.
//
// Only that one measuring wrapper is replaced, with a plain passthrough; everything else -- including
// ChartContainer, which is the context provider under test -- stays real. Stubbing the whole module would mean
// asserting against a mock rather than against `chart.tsx`.
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="responsive">{children}</div>
  ),
}));

import {
  ChartContainer,
  ChartLegendContent,
  ChartStyle,
  ChartTooltipContent,
  type ChartConfig,
} from "./chart.js";

// #9937: `chart.tsx` is the one file the recharts v3 migration (#8610) rewrote, and it shipped with no tests
// at all -- so the migration's load-bearing behaviours were resting on the type-checker alone.
//
// What v3 actually changed here: `payload` and `label` moved OFF Tooltip's own props and are supplied through
// context, and the render-prop shape is published as `TooltipContentProps`. Everything below drives
// ChartTooltipContent the way recharts now drives it -- as a component receiving that shape -- inside the real
// ChartContainer, so the context wiring the migration touched is exercised rather than assumed.

const config = {
  revenue: { label: "Revenue", color: "#0ea5e9" },
  cost: { label: "Cost", theme: { light: "#111827", dark: "#f9fafb" } },
} satisfies ChartConfig;

const payload = [
  {
    dataKey: "revenue",
    name: "revenue",
    value: 120,
    color: "#0ea5e9",
    payload: { month: "Jan", revenue: 120 },
  },
  {
    dataKey: "cost",
    name: "cost",
    value: 80,
    color: "#111827",
    payload: { month: "Jan", cost: 80 },
  },
];

/** ChartTooltipContent calls useChart(), so it must render inside a provider. ChartContainer is that
 *  provider and is exercised deliberately rather than mocked. Queries are scoped to the slot, never the whole
 *  container: ChartContainer also emits a <style> element, so a container-wide "rendered nothing" assertion
 *  would be comparing against that stylesheet. */
function renderInChart(node: React.ReactNode) {
  const result = render(
    <ChartContainer config={config}>
      <div data-testid="slot">{node}</div>
    </ChartContainer>,
  );
  // Scoped through this render's OWN container, not the shared document: a test that renders twice would
  // otherwise match both slots and fail on "found multiple elements".
  return {
    ...result,
    slot: () => result.container.querySelector('[data-testid="slot"]')!,
  };
}

describe("ChartTooltipContent (recharts v3, #8610)", () => {
  it("renders one row per payload entry, labelled from the chart config", () => {
    // The config's `label` -- not the raw dataKey -- is what a reader sees. Regressing to the dataKey is the
    // most likely silent breakage, and it still "renders fine".
    const chart = renderInChart(
      <ChartTooltipContent active payload={payload} label="Jan" />,
    );

    expect(chart.getByText("Revenue")).toBeTruthy();
    expect(chart.getByText("Cost")).toBeTruthy();
    expect(chart.getByText("120")).toBeTruthy();
    expect(chart.getByText("80")).toBeTruthy();
  });

  it("INVARIANT: renders nothing when inactive or when the payload is empty", () => {
    // A tooltip that paints on an empty payload follows the cursor around an empty chart. Both arms, because
    // `!active || !payload?.length` is two conditions and only testing one leaves the other free to invert.
    const inactive = renderInChart(
      <ChartTooltipContent active={false} payload={payload} />,
    );
    expect(inactive.slot().textContent).toBe("");

    const empty = renderInChart(<ChartTooltipContent active payload={[]} />);
    expect(empty.slot().textContent).toBe("");
  });

  it("hides the label when asked, and formats it through labelFormatter otherwise", () => {
    const formatted = renderInChart(
      <ChartTooltipContent
        active
        payload={payload}
        label="Jan"
        labelFormatter={(value) => `Month: ${String(value)}`}
      />,
    );
    expect(formatted.getByText("Month: Jan")).toBeTruthy();

    const hidden = renderInChart(
      <ChartTooltipContent active payload={payload} label="Jan" hideLabel />,
    );
    expect(hidden.queryByText("Jan")).toBeNull();
  });

  it("routes the value through a custom formatter when one is supplied", () => {
    const chart = renderInChart(
      <ChartTooltipContent
        active
        payload={[payload[0]!]}
        formatter={(value) => `$${String(value)}`}
      />,
    );
    expect(chart.getByText("$120")).toBeTruthy();
  });

  // #10051: a numeric 0 is a real data point — the old `item.value &&` guard rendered it as a bare
  // React text child (losing tabular-nums / toLocaleString). Pin both arms of the nullish guard and
  // assert the digit sits inside the formatted span, not beside it.
  it("REGRESSION (#10051): zero value renders inside the tabular-nums span, not as a bare text child", () => {
    const zeroPayload = [
      {
        dataKey: "revenue",
        name: "revenue",
        value: 0,
        color: "#0ea5e9",
        payload: { month: "Jan", revenue: 0 },
      },
    ];
    const chart = renderInChart(
      <ChartTooltipContent active payload={zeroPayload} label="Jan" />,
    );

    const valueSpan = chart.slot().querySelector("span.tabular-nums");
    expect(valueSpan).not.toBeNull();
    expect(valueSpan!.className).toContain("font-mono");
    expect(valueSpan!.className).toContain("tabular-nums");
    expect(valueSpan!.textContent).toBe("0");

    // The formatted "0" must be a descendant of the span — not a direct text child of the row.
    const row = valueSpan!.closest(".flex.w-full");
    expect(row).not.toBeNull();
    const directZero = Array.from(row!.childNodes).some(
      (node) =>
        node.nodeType === Node.TEXT_NODE && node.textContent?.trim() === "0",
    );
    expect(directZero).toBe(false);
    expect(chart.getByText("Revenue")).toBeTruthy();
  });

  it("omits the value span only when value is undefined or null (#10051)", () => {
    const undefinedPayload = [
      {
        dataKey: "revenue",
        name: "revenue",
        value: undefined,
        color: "#0ea5e9",
        payload: { month: "Jan", revenue: 0 },
      },
    ];
    const missing = renderInChart(
      <ChartTooltipContent active payload={undefinedPayload} label="Jan" />,
    );
    expect(missing.slot().textContent).toContain("Revenue");
    expect(missing.slot().querySelector("span.tabular-nums")).toBeNull();
    missing.unmount();

    const nullPayload = [
      {
        dataKey: "revenue",
        name: "revenue",
        value: null,
        color: "#0ea5e9",
        payload: { month: "Jan", revenue: 0 },
      },
    ];
    const nullish = renderInChart(
      <ChartTooltipContent
        active
        payload={nullPayload as typeof payload}
        label="Jan"
      />,
    );
    expect(nullish.slot().textContent).toContain("Revenue");
    expect(nullish.slot().querySelector("span.tabular-nums")).toBeNull();
  });

  it("renders an empty-string value through the tabular-nums span (#10051)", () => {
    const emptyPayload = [
      {
        dataKey: "revenue",
        name: "revenue",
        value: "",
        color: "#0ea5e9",
        payload: { month: "Jan", revenue: "" },
      },
    ];
    const chart = renderInChart(
      <ChartTooltipContent active payload={emptyPayload} label="Jan" />,
    );
    const valueSpan = chart.slot().querySelector("span.tabular-nums");
    expect(valueSpan).not.toBeNull();
    expect(valueSpan!.textContent).toBe("");
    expect(chart.getByText("Revenue")).toBeTruthy();
  });

  it("resolves a series by nameKey when the payload's own key is not the config key", () => {
    const chart = renderInChart(
      <ChartTooltipContent
        active
        payload={[{ ...payload[0]!, dataKey: "unmapped", name: "unmapped" }]}
        nameKey="revenue"
      />,
    );
    expect(chart.getByText("Revenue")).toBeTruthy();
  });
});

describe("ChartLegendContent (recharts v3, #8610)", () => {
  it("labels each legend entry from the config", () => {
    const chart = renderInChart(
      <ChartLegendContent
        payload={[{ value: "revenue", dataKey: "revenue", color: "#0ea5e9" }]}
      />,
    );
    expect(chart.getByText("Revenue")).toBeTruthy();
  });

  it("renders nothing without a payload", () => {
    const legend = renderInChart(<ChartLegendContent payload={[]} />);
    expect(legend.slot().textContent).toBe("");
  });
});

describe("ChartStyle", () => {
  it("emits per-theme CSS variables only for series that declare a colour", () => {
    // The `theme` and `color` arms of ChartConfig are a union, and both have to reach the stylesheet -- a
    // series configured with `theme` produces one variable per theme selector.
    const { container } = render(
      <ChartStyle id="chart-test" config={config} />,
    );
    const css = container.querySelector("style")?.innerHTML ?? "";

    expect(css).toContain("--color-revenue: #0ea5e9");
    expect(css).toContain("--color-cost: #111827");
    expect(css).toContain("--color-cost: #f9fafb");
    expect(css).toContain("[data-chart=chart-test]");
  });

  it("emits no stylesheet at all when no series declares a colour", () => {
    const { container } = render(
      <ChartStyle id="chart-empty" config={{ plain: { label: "Plain" } }} />,
    );
    expect(container.querySelector("style")).toBeNull();
  });
});

describe("useChart", () => {
  it("REGRESSION: throws a named error outside a ChartContainer rather than reading null", () => {
    // Without the guard this is a `Cannot read properties of null` deep inside a tooltip render, which is a
    // materially harder thing to diagnose than the message the component actually throws.
    expect(() =>
      render(<ChartTooltipContent active payload={payload} />),
    ).toThrow(/useChart must be used within a <ChartContainer \/>/);
  });
});
