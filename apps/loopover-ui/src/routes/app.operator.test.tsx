import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #6816: app.operator.tsx's StateBoundary had no loadingSkeleton, falling through to the generic spinner.
const { useApiResource } = vi.hoisted(() => ({ useApiResource: vi.fn() }));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: (...args: unknown[]) => useApiResource(...args),
}));

// The Weekly-value-report copy handlers signal success/failure through sonner and pull the Markdown
// variant through apiFetch -- mock both so those branches can be asserted without a live clipboard/API.
const { success, error } = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success, error } }));
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { OperatorDashboard } from "@/routes/app.operator";

describe("OperatorDashboard loading skeleton (#6816)", () => {
  it("shows a content-shaped skeleton (not the generic spinner) while the dashboard loads", () => {
    useApiResource.mockReturnValue({
      status: "loading",
      data: null,
      error: null,
      loadedAt: null,
      reload: () => {},
    });

    const { container } = render(<OperatorDashboard />);
    // The custom skeleton replaces the generic LoadingState — neither its title nor its spinner shows.
    expect(screen.queryByText("Loading operator dashboard…")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    // The placeholder renders animate-pulse blocks approximating the dashboard's stat + section grid.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(1);
  });

  it("does not show the skeleton once the dashboard has real data", () => {
    // OperatorDashboard also renders NotificationReadinessCard and DeadLetterQueuePanel, both of which call
    // this SAME hook for their own resources -- key the mock by path so their unrelated states (including
    // DeadLetterQueuePanel's own loadingSkeleton) don't leak into the dashboard's own animate-pulse count.
    useApiResource.mockImplementation((path: string) => {
      if (path === "/v1/app/operator-dashboard") {
        return {
          status: "ready",
          data: {
            metrics: [{ label: "Installs", value: "12", delta: "+2" }],
            noiseReduction: [],
            weeklyReport: [],
          },
          error: null,
          loadedAt: "2026-07-17T00:00:00.000Z",
          reload: () => {},
        };
      }
      return {
        status: "error",
        data: null,
        error: "unavailable in this test",
        errorKind: "unknown",
        loadedAt: null,
        reload: () => {},
      };
    });

    const { container } = render(<OperatorDashboard />);
    expect(screen.getByText("Usage & value")).toBeTruthy();
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
  });
});

describe("OperatorDashboard AI cost by tenant (#4916)", () => {
  function mockDashboard(aiCostByTenant?: Array<{ installationId: string; totalCostUsd: number }>) {
    useApiResource.mockImplementation((path: string) => {
      if (path === "/v1/app/operator-dashboard") {
        return {
          status: "ready",
          data: {
            metrics: [{ label: "Installs", value: "12", delta: "+2" }],
            noiseReduction: [],
            weeklyReport: [],
            aiCostByTenant,
          },
          error: null,
          loadedAt: "2026-07-17T00:00:00.000Z",
          reload: () => {},
        };
      }
      return {
        status: "error",
        data: null,
        error: "unavailable in this test",
        errorKind: "unknown",
        loadedAt: null,
        reload: () => {},
      };
    });
  }

  it("renders no section at all when aiCostByTenant is absent (self-host, the common case)", () => {
    mockDashboard(undefined);
    render(<OperatorDashboard />);
    expect(screen.queryByText("AI cost by tenant")).toBeNull();
  });

  it("renders no section when aiCostByTenant is an empty list", () => {
    mockDashboard([]);
    render(<OperatorDashboard />);
    expect(screen.queryByText("AI cost by tenant")).toBeNull();
  });

  it("renders each tenant's formatted cost, highest-cost-first as the backend already ordered them", () => {
    mockDashboard([
      { installationId: "inst-2", totalCostUsd: 4 },
      { installationId: "inst-1", totalCostUsd: 2 },
    ]);
    render(<OperatorDashboard />);
    expect(screen.getByText("AI cost by tenant")).toBeTruthy();
    expect(screen.getByText("inst-2")).toBeTruthy();
    expect(screen.getByText("$4.00")).toBeTruthy();
    expect(screen.getByText("inst-1")).toBeTruthy();
    expect(screen.getByText("$2.00")).toBeTruthy();
  });
});

describe("OperatorDashboard storage by tenant (#4890)", () => {
  function mockDashboard(
    storageRowCountByTenant?: Array<{ installationId: string; rowCount: number }>,
  ) {
    useApiResource.mockImplementation((path: string) => {
      if (path === "/v1/app/operator-dashboard") {
        return {
          status: "ready",
          data: {
            metrics: [{ label: "Installs", value: "12", delta: "+2" }],
            noiseReduction: [],
            weeklyReport: [],
            storageRowCountByTenant,
          },
          error: null,
          loadedAt: "2026-07-17T00:00:00.000Z",
          reload: () => {},
        };
      }
      return {
        status: "error",
        data: null,
        error: "unavailable in this test",
        errorKind: "unknown",
        loadedAt: null,
        reload: () => {},
      };
    });
  }

  it("renders no section at all when storageRowCountByTenant is absent (self-host, the common case)", () => {
    mockDashboard(undefined);
    render(<OperatorDashboard />);
    expect(screen.queryByText("Storage by tenant")).toBeNull();
  });

  it("renders no section when storageRowCountByTenant is an empty list", () => {
    mockDashboard([]);
    render(<OperatorDashboard />);
    expect(screen.queryByText("Storage by tenant")).toBeNull();
  });

  it("renders each tenant's formatted row count, highest-count-first as the backend already ordered them", () => {
    mockDashboard([
      { installationId: "inst-2", rowCount: 3000 },
      { installationId: "inst-1", rowCount: 2 },
    ]);
    render(<OperatorDashboard />);
    expect(screen.getByText("Storage by tenant")).toBeTruthy();
    expect(screen.getByText("inst-2")).toBeTruthy();
    expect(screen.getByText("3,000 rows")).toBeTruthy();
    expect(screen.getByText("inst-1")).toBeTruthy();
    expect(screen.getByText("2 rows")).toBeTruthy();
  });
});

describe("OperatorDashboard instance status (#4933)", () => {
  function mockDashboard(fleetHealth?: {
    healthyCount: number;
    unhealthyCount: number;
    unknownCount: number;
    totalCount: number;
  }) {
    useApiResource.mockImplementation((path: string) => {
      if (path === "/v1/app/operator-dashboard") {
        return {
          status: "ready",
          data: {
            metrics: [{ label: "Installs", value: "12", delta: "+2" }],
            noiseReduction: [],
            weeklyReport: [],
            fleetHealth,
          },
          error: null,
          loadedAt: "2026-07-17T00:00:00.000Z",
          reload: () => {},
        };
      }
      return {
        status: "error",
        data: null,
        error: "unavailable in this test",
        errorKind: "unknown",
        loadedAt: null,
        reload: () => {},
      };
    });
  }

  it("renders no section at all when fleetHealth is absent (self-host, the common case)", () => {
    mockDashboard(undefined);
    render(<OperatorDashboard />);
    expect(screen.queryByText("Instance status")).toBeNull();
  });

  it("renders no section when fleetHealth.totalCount is 0", () => {
    mockDashboard({ healthyCount: 0, unhealthyCount: 0, unknownCount: 0, totalCount: 0 });
    render(<OperatorDashboard />);
    expect(screen.queryByText("Instance status")).toBeNull();
  });

  it("renders the healthy/unhealthy/unknown counts, distinct from the gate-calibration Fleet health card", () => {
    mockDashboard({ healthyCount: 3, unhealthyCount: 1, unknownCount: 2, totalCount: 6 });
    render(<OperatorDashboard />);
    expect(screen.getByText("Instance status")).toBeTruthy();
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("Unhealthy")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });
});

// #8700: mount the dashboard with `recommendationQuality` / `fleetMetrics` / `weeklyValueReport` populated so
// the previously-untested Fleet-health, Recommendation-quality, and Weekly-report render paths (and their
// formatPct/formatMs/qualityStatus/copyWeeklyReport helpers) get direct branch coverage.

function mockOperator(extra: Record<string, unknown>) {
  useApiResource.mockImplementation((path: string) => {
    if (path === "/v1/app/operator-dashboard") {
      return {
        status: "ready",
        data: {
          metrics: [{ label: "Installs", value: "12", delta: "+2" }],
          noiseReduction: [],
          weeklyReport: [],
          ...extra,
        },
        error: null,
        loadedAt: "2026-07-17T00:00:00.000Z",
        reload: () => {},
      };
    }
    return {
      status: "error",
      data: null,
      error: "unavailable in this test",
      errorKind: "unknown",
      loadedAt: null,
      reload: () => {},
    };
  });
}

const baseTotals = {
  total: 100,
  positive: 82,
  negative: 7,
  positiveRate: 0.82,
  maintainerLaneTotal: 5,
  highConfidence: 9,
  mediumConfidence: 2,
  lowConfidence: 1,
};

function makeFleetMetrics(over: Partial<Record<string, unknown>> = {}) {
  return {
    windowDays: 14,
    instanceCount: 3,
    fleet: {
      mergePrecision: 0.5,
      closePrecision: 0.9,
      fpRate: 0.1,
      reversalRate: 0.25,
      cycleP50Ms: 300_000,
      cycleP95Ms: 600_000,
    },
    outliers: [{ instanceId: "i1", metric: "fpRate", value: 0.3, fleetMedian: 0.1 }],
    ...over,
  };
}

describe("OperatorDashboard fleet health (#8700 — formatPct/formatMs)", () => {
  it("renders no section when fleetMetrics is absent", () => {
    mockOperator({});
    render(<OperatorDashboard />);
    expect(screen.queryByText("Fleet health")).toBeNull();
  });

  it("renders no section when instanceCount is 0", () => {
    mockOperator({ fleetMetrics: makeFleetMetrics({ instanceCount: 0 }) });
    render(<OperatorDashboard />);
    expect(screen.queryByText("Fleet health")).toBeNull();
  });

  it("formats populated fleet numbers as percentages and sub-hour cycle time in minutes", () => {
    mockOperator({ fleetMetrics: makeFleetMetrics() });
    render(<OperatorDashboard />);
    expect(screen.getByText("Fleet health")).toBeTruthy();
    expect(screen.getByText("Merge precision")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
    expect(screen.getByText("10%")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();
    // formatMs's sub-3.6M-ms branch: 300_000ms rounds to 5m.
    expect(screen.getByText("5m")).toBeTruthy();
    // outliers.length rendered verbatim.
    expect(screen.getByText("Instance outliers")).toBeTruthy();
  });

  it("formats a multi-hour cycle time via formatMs's hour branch", () => {
    mockOperator({
      fleetMetrics: makeFleetMetrics({
        fleet: {
          mergePrecision: 0.5,
          closePrecision: 0.9,
          fpRate: 0.1,
          reversalRate: 0.25,
          cycleP50Ms: 7_200_000,
          cycleP95Ms: 9_000_000,
        },
      }),
    });
    render(<OperatorDashboard />);
    // >= 3_600_000ms takes the hour branch: 7_200_000ms -> 2.0h.
    expect(screen.getByText("2.0h")).toBeTruthy();
  });

  it("renders an em dash for every null fleet metric via formatPct/formatMs's null branch", () => {
    mockOperator({
      fleetMetrics: makeFleetMetrics({
        fleet: {
          mergePrecision: null,
          closePrecision: null,
          fpRate: null,
          reversalRate: null,
          cycleP50Ms: null,
          cycleP95Ms: null,
        },
      }),
    });
    render(<OperatorDashboard />);
    // Four null percentages + one null cycle time all collapse to the em dash.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(5);
  });
});

describe("OperatorDashboard recommendation quality (#8700 — qualityStatus)", () => {
  function makeQuality(over: Partial<Record<string, unknown>> = {}) {
    return {
      windowDays: 30,
      visibility: "operator_only",
      empty: false,
      sparse: false,
      totals: baseTotals,
      trends: [],
      failureCategories: [],
      roleSurfaces: [],
      warnings: [],
      publicExport: { available: false, reason: "operator-only" },
      privateSummary: "Operator-only recommendation quality summary.",
      ...over,
    };
  }

  it("renders no section when recommendationQuality is absent", () => {
    mockOperator({});
    render(<OperatorDashboard />);
    expect(screen.queryByText("Recommendation quality")).toBeNull();
  });

  it("renders the totals block and colours each role surface's pill by qualityStatus's three thresholds", () => {
    mockOperator({
      recommendationQuality: makeQuality({
        roleSurfaces: [
          {
            ...baseTotals,
            role: "miner",
            label: "Miner",
            positive: 7,
            negative: 3,
            positiveRate: 0.7, // >= 0.67 -> ready
            topRepos: [
              { repoFullName: "acme/api", total: 10, positive: 8, negative: 2, signal: "positive" },
            ],
          },
          {
            ...baseTotals,
            role: "maintainer",
            label: "Maintainer",
            positive: 5,
            negative: 5,
            positiveRate: 0.5, // >= 0.4 -> stale
            topRepos: [],
          },
          {
            ...baseTotals,
            role: "owner",
            label: "Owner",
            positive: 3,
            negative: 7,
            positiveRate: 0.3, // below -> warn
            topRepos: [],
          },
        ],
        failureCategories: [
          {
            category: "stale",
            label: "Went stale",
            count: 4,
            detail: "no merge inside the window",
          },
        ],
        trends: [
          {
            ...baseTotals,
            periodStart: "2026-07-01",
            periodEnd: "2026-07-07",
            positiveRate: 0.6,
          },
        ],
        warnings: ["Low sample size for owner lane."],
      }),
    });
    render(<OperatorDashboard />);

    expect(screen.getByText("Recommendation quality")).toBeTruthy();
    // "populated" status pill: neither empty nor sparse.
    expect(screen.getByText("populated")).toBeTruthy();
    // Totals stats.
    expect(screen.getByText("82%")).toBeTruthy();
    expect(screen.getByText("2 medium · 1 low")).toBeTruthy();
    // Role-specific content and failure category rendered.
    expect(screen.getByText("Miner")).toBeTruthy();
    expect(screen.getByText("acme/api")).toBeTruthy();
    expect(screen.getByText("Went stale")).toBeTruthy();
    expect(screen.getByText("Low sample size for owner lane.", { exact: false })).toBeTruthy();

    // qualityStatus branch coverage, read off each role-surface pill's status colour.
    expect(screen.getByText("70%").className).toContain("border-success/40"); // ready
    expect(screen.getByText("50%").className).toContain("border-warning/30"); // stale
    expect(screen.getByText("30%").className).toContain("border-warning/40"); // warn
  });

  it("renders the empty-window fallbacks and the 'empty' pill when there is no data", () => {
    mockOperator({ recommendationQuality: makeQuality({ empty: true }) });
    render(<OperatorDashboard />);
    expect(screen.getByText("empty")).toBeTruthy();
    expect(screen.getByText("No role-specific outcomes in this window.")).toBeTruthy();
    expect(screen.getByText("No failure categories in this window.")).toBeTruthy();
  });

  it("renders the 'sparse' pill when the window is populated but thin", () => {
    mockOperator({ recommendationQuality: makeQuality({ empty: false, sparse: true }) });
    render(<OperatorDashboard />);
    expect(screen.getByText("sparse")).toBeTruthy();
  });
});

describe("OperatorDashboard weekly report copy (#8700 — copyWeeklyReport)", () => {
  const weeklyValueReport = {
    freshness: { status: "fresh", latestRollupDay: "2026-07-20" },
    warnings: [],
    metrics: [{ id: "reviews", label: "Reviews", value: 42, detail: "reviews this week" }],
  };
  const expectedJson = JSON.stringify(weeklyValueReport, null, 2);

  function mockClipboard(writeText: () => Promise<void>) {
    const spy = vi.fn(writeText);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: spy },
      configurable: true,
      writable: true,
    });
    return spy;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockOperator({ weeklyValueReport });
  });

  it("copies the fetched Markdown variant and reports success via toast", async () => {
    const writeText = mockClipboard(() => Promise.resolve());
    apiFetch.mockResolvedValue({ ok: true, data: "# Weekly value report" });
    render(<OperatorDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Copy weekly report Markdown" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("# Weekly value report"));
    expect(success).toHaveBeenCalledWith("Weekly report copied", {
      description: "Markdown export copied.",
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("copies the serialized JSON variant without touching the Markdown endpoint", async () => {
    const writeText = mockClipboard(() => Promise.resolve());
    render(<OperatorDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Copy weekly report JSON" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expectedJson));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith("Weekly report copied", {
      description: "JSON export copied.",
    });
  });

  it("surfaces a toast instead of throwing when the clipboard write is rejected", async () => {
    mockClipboard(() => Promise.reject(new Error("denied")));
    render(<OperatorDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Copy weekly report JSON" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Copy failed", {
        description: "denied. Select the report text and copy manually.",
      }),
    );
    expect(success).not.toHaveBeenCalled();
  });

  it("surfaces a toast when the clipboard API is unavailable altogether", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    render(<OperatorDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Copy weekly report JSON" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Copy failed", {
        description: "Clipboard API unavailable. Select the report text and copy manually.",
      }),
    );
    expect(success).not.toHaveBeenCalled();
  });
});
