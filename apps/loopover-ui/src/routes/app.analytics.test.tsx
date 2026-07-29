import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// #6817: app.analytics.tsx's StateBoundary had no loadingSkeleton, falling through to the generic spinner
// -- the same gap #6816 fixed for app.operator.tsx.
const { useApiResource } = vi.hoisted(() => ({ useApiResource: vi.fn() }));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: (...args: unknown[]) => useApiResource(...args),
}));

import { ProductAnalytics } from "@/routes/app.analytics";

describe("ProductAnalytics loading skeleton (#6817)", () => {
  it("shows a content-shaped skeleton (not the generic spinner) while the dashboard loads", () => {
    useApiResource.mockReturnValue({
      status: "loading",
      data: null,
      error: null,
      loadedAt: null,
      reload: () => {},
    });

    const { container } = render(<ProductAnalytics />);
    // The custom skeleton replaces the generic LoadingState — neither its title nor its spinner shows.
    expect(screen.queryByText("Loading analytics…")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    // The placeholder renders animate-pulse blocks approximating the dashboard's header + stat + card grid.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(1);
  });

  it("does not show the skeleton once the dashboard has real data", () => {
    useApiResource.mockReturnValue({
      status: "ready",
      data: { metrics: [{ label: "Active repos", value: "12", delta: "+2" }], noiseReduction: [] },
      error: null,
      loadedAt: "2026-07-17T00:00:00.000Z",
      reload: () => {},
    });

    const { container } = render(<ProductAnalytics />);
    expect(screen.getByText("Usage & value analytics")).toBeTruthy();
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
  });
});

// #8699: the analytics window preference was renamed from "gittensory.analytics.windowDays" to
// "loopover.analytics.windowDays" in the rebrand (75450f1d5) without the one-time legacyKey fallback
// app.runs.tsx / app.workbench.tsx got, silently resetting returning users to the 7-day default.
describe("ProductAnalytics window preference rebrand migration (#8699)", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("migrates a pre-rebrand gittensory window preference forward instead of resetting to 7d", async () => {
    window.localStorage.setItem("gittensory.analytics.windowDays", "30");
    useApiResource.mockReturnValue({
      status: "ready",
      data: { metrics: [{ label: "Active repos", value: "12", delta: "+2" }], noiseReduction: [] },
      error: null,
      loadedAt: "2026-07-17T00:00:00.000Z",
      reload: () => {},
    });

    render(<ProductAnalytics />);

    // The toggle group renders once the preference has hydrated -- with the legacy value carried
    // over, 30d is the selected window (not the 7-day default the user never chose).
    const thirtyDay = await screen.findByRole("radio", { name: "30 day window" });
    await waitFor(() => expect(thirtyDay.getAttribute("data-state")).toBe("on"));
    expect(screen.getByRole("radio", { name: "7 day window" }).getAttribute("data-state")).toBe(
      "off",
    );
    // The dashboard is fetched for the migrated window, not the default.
    await waitFor(() =>
      expect(useApiResource).toHaveBeenLastCalledWith(
        "/v1/app/operator-dashboard?days=30",
        "Product analytics",
      ),
    );
    // Backfilled: the new key now holds the value directly (the hook migrates it forward on first read).
    expect(window.localStorage.getItem("loopover.analytics.windowDays")).toBe("30");
  });

  it("still uses the 7-day default when neither the new nor the legacy key is present", async () => {
    useApiResource.mockReturnValue({
      status: "ready",
      data: { metrics: [{ label: "Active repos", value: "12", delta: "+2" }], noiseReduction: [] },
      error: null,
      loadedAt: "2026-07-17T00:00:00.000Z",
      reload: () => {},
    });

    render(<ProductAnalytics />);

    const sevenDay = await screen.findByRole("radio", { name: "7 day window" });
    await waitFor(() => expect(sevenDay.getAttribute("data-state")).toBe("on"));
    // Nothing to migrate: no value is invented under either key.
    expect(window.localStorage.getItem("loopover.analytics.windowDays")).toBeNull();
    expect(window.localStorage.getItem("gittensory.analytics.windowDays")).toBeNull();
  });
});

// #9674: TrendChart's aria-label was the fixed string "Trend chart" on every instance -- each
// operational trend signal now passes its own label so screen readers hear which chart is which.
describe("ProductAnalytics operational trend signal chart labels (#9674)", () => {
  it("labels each signal's chart with its own metric label, not a shared constant", () => {
    useApiResource.mockReturnValue({
      status: "ready",
      data: {
        metrics: [{ label: "Active repos", value: "12", delta: "+2" }],
        noiseReduction: [
          { label: "False-positive rate", value: 4, spark: [10, 8, 6] },
          { label: "Repo coverage", value: 92, spark: [80, 85, 92] },
        ],
      },
      error: null,
      loadedAt: "2026-07-17T00:00:00.000Z",
      reload: () => {},
    });

    render(<ProductAnalytics />);

    expect(screen.getByLabelText("False-positive rate trend")).toBeTruthy();
    expect(screen.getByLabelText("Repo coverage trend")).toBeTruthy();
    expect(screen.queryByLabelText("Trend chart")).toBeNull();
  });
});
