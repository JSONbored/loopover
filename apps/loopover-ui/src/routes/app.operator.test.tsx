import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #6816: app.operator.tsx's StateBoundary had no loadingSkeleton, falling through to the generic spinner.
const { useApiResource } = vi.hoisted(() => ({ useApiResource: vi.fn() }));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: (...args: unknown[]) => useApiResource(...args),
}));

// #8700: the weekly-report copy flow reports through sonner and fetches its Markdown variant through
// apiFetch -- mock both so the copy handlers' branches can be asserted directly. notifyApiFailure /
// notifyApiRecovered are stubbed only because modules in this render tree (state-views) import them.
const { success, error } = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success, error } }));
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/api/request", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  notifyApiFailure: vi.fn(),
  notifyApiRecovered: vi.fn(),
}));

import { formatMs, formatPct, OperatorDashboard, qualityStatus } from "@/routes/app.operator";

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

// ---------------------------------------------------------------------------------------------------
// #8700: the formatting helpers, the Fleet health (gate calibration) and Recommendation quality
// sections, and the weekly-report copy flow previously had zero direct coverage.
// ---------------------------------------------------------------------------------------------------

describe("operator formatting helpers (#8700)", () => {
  it("formatPct renders an em dash for null and rounds fractions to a whole percent", () => {
    expect(formatPct(null)).toBe("—");
    expect(formatPct(0)).toBe("0%");
    expect(formatPct(0.678)).toBe("68%");
    expect(formatPct(1)).toBe("100%");
  });

  it("formatMs renders an em dash for null", () => {
    expect(formatMs(null)).toBe("—");
  });

  it("formatMs switches to hours at exactly 3,600,000 ms and stays in minutes below it", () => {
    expect(formatMs(3_600_000)).toBe("1.0h");
    expect(formatMs(5_400_000)).toBe("1.5h");
    expect(formatMs(3_599_999)).toBe("60m");
    expect(formatMs(120_000)).toBe("2m");
  });

  it("qualityStatus maps the documented thresholds: >=0.67 ready, >=0.4 stale, below warn", () => {
    expect(qualityStatus(1)).toBe("ready");
    expect(qualityStatus(0.67)).toBe("ready");
    expect(qualityStatus(0.669)).toBe("stale");
    expect(qualityStatus(0.4)).toBe("stale");
    expect(qualityStatus(0.399)).toBe("warn");
    expect(qualityStatus(0)).toBe("warn");
  });
});

function mockDashboardWith(overrides: Record<string, unknown>) {
  useApiResource.mockImplementation((path: string) => {
    if (path === "/v1/app/operator-dashboard") {
      return {
        status: "ready",
        data: {
          metrics: [{ label: "Installs", value: "12", delta: "+2" }],
          noiseReduction: [],
          weeklyReport: [],
          ...overrides,
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

const fleetMetricsFixture = {
  windowDays: 30,
  instanceCount: 4,
  fleet: {
    mergePrecision: 0.92,
    closePrecision: 0.81,
    fpRate: 0.07,
    reversalRate: null,
    cycleP50Ms: 5_400_000,
    cycleP95Ms: 9_000_000,
  },
  outliers: [{ instanceId: "inst-9", metric: "fpRate", value: 0.4, fleetMedian: 0.07 }],
};

describe("OperatorDashboard fleet health / gate calibration (#8700)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders no section when fleetMetrics is absent", () => {
    mockDashboardWith({});
    render(<OperatorDashboard />);
    expect(screen.queryByText("Fleet health")).toBeNull();
  });

  it("renders no section when fleetMetrics.instanceCount is 0", () => {
    mockDashboardWith({ fleetMetrics: { ...fleetMetricsFixture, instanceCount: 0 } });
    render(<OperatorDashboard />);
    expect(screen.queryByText("Fleet health")).toBeNull();
  });

  it("renders each fleet stat through formatPct/formatMs, including the null and hours branches", () => {
    mockDashboardWith({ fleetMetrics: fleetMetricsFixture });
    render(<OperatorDashboard />);
    expect(screen.getByText("Fleet health")).toBeTruthy();
    expect(screen.getByText("Merge precision")).toBeTruthy();
    expect(screen.getByText("92%")).toBeTruthy();
    expect(screen.getByText("Close precision")).toBeTruthy();
    expect(screen.getByText("81%")).toBeTruthy();
    expect(screen.getByText("False-positive rate")).toBeTruthy();
    expect(screen.getByText("7%")).toBeTruthy();
    // reversalRate is null -- the pipeline can't compute it yet -- so its Stat shows the em dash.
    expect(screen.getByText("Reversal rate")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    // cycleP50Ms is 5,400,000 ms -- the >=1h branch of formatMs.
    expect(screen.getByText("Cycle time (p50)")).toBeTruthy();
    expect(screen.getByText("1.5h")).toBeTruthy();
    expect(screen.getByText("Instance outliers")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });
});

const qualityTotalsFixture = {
  total: 40,
  positive: 30,
  negative: 10,
  positiveRate: 0.75,
  maintainerLaneTotal: 14,
  highConfidence: 20,
  mediumConfidence: 15,
  lowConfidence: 5,
};

const qualityFixture = {
  windowDays: 30,
  visibility: "operator_only" as const,
  empty: false,
  sparse: false,
  totals: qualityTotalsFixture,
  trends: [
    {
      ...qualityTotalsFixture,
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-07-08T00:00:00.000Z",
    },
  ],
  failureCategories: [
    {
      category: "stale",
      label: "Stale recommendations",
      count: 4,
      detail: "Closed without action inside the window.",
    },
  ],
  roleSurfaces: [
    {
      ...qualityTotalsFixture,
      positiveRate: 0.7,
      role: "miner" as const,
      label: "Miner guidance",
      topRepos: [
        {
          repoFullName: "JSONbored/loopover",
          total: 10,
          positive: 8,
          negative: 2,
          signal: "positive" as const,
        },
      ],
    },
    {
      ...qualityTotalsFixture,
      positiveRate: 0.5,
      role: "maintainer" as const,
      label: "Maintainer lane surface",
      topRepos: [],
    },
    {
      ...qualityTotalsFixture,
      positiveRate: 0.2,
      role: "operator" as const,
      label: "Operator surface",
      topRepos: [],
    },
  ],
  warnings: ["Sparse window: fewer than 50 evaluated recommendations."],
  publicExport: { available: false as const, reason: "operator-only" },
  privateSummary: "30/40 recommendations resolved positively over 30 days.",
};

describe("OperatorDashboard recommendation quality (#8700)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders no section when recommendationQuality is absent", () => {
    mockDashboardWith({});
    render(<OperatorDashboard />);
    expect(screen.queryByText("Recommendation quality")).toBeNull();
  });

  it("renders the totals stats, role surfaces, failure categories, trend, and warnings", () => {
    mockDashboardWith({ recommendationQuality: qualityFixture });
    const { container } = render(<OperatorDashboard />);

    expect(screen.getByText("Recommendation quality")).toBeTruthy();
    expect(
      screen.getByText("30/40 recommendations resolved positively over 30 days."),
    ).toBeTruthy();
    // Neither empty nor sparse -- the state pill reads "populated"; the window pill shows the window.
    expect(screen.getByText("populated")).toBeTruthy();
    expect(screen.getByText("30d")).toBeTruthy();

    expect(screen.getByText("Positive rate")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText("30/40 evaluated")).toBeTruthy();
    expect(screen.getByText("Unresolved or negative")).toBeTruthy();
    expect(screen.getByText("Maintainer lane")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
    expect(screen.getByText("High confidence")).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy();
    expect(screen.getByText("15 medium · 5 low")).toBeTruthy();

    // Role surfaces: each pill's tone comes from qualityStatus(surface.positiveRate).
    expect(screen.getByText("Miner guidance")).toBeTruthy();
    const readyPill = screen.getByText("70%").closest("span");
    expect(readyPill?.className).toContain("text-success");
    const stalePill = screen.getByText("50%").closest("span");
    expect(stalePill?.className).toContain("text-warning");
    expect(stalePill?.className).toContain("bg-warning/5");
    const warnPill = screen.getByText("20%").closest("span");
    expect(warnPill?.className).toContain("text-warning");
    expect(warnPill?.className).toContain("bg-warning/10");
    expect(screen.getByText("JSONbored/loopover")).toBeTruthy();
    expect(screen.getByText("8/10")).toBeTruthy();

    expect(screen.getByText("Stale recommendations")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("Closed without action inside the window.")).toBeTruthy();

    // Trend: one bucket, height driven by positiveRate, tooltip title carries positive/total.
    const bar = container.querySelector('[title*="30/40"]');
    expect(bar).toBeTruthy();
    expect((bar as HTMLElement).style.height).toBe("75%");

    expect(
      screen.getByText(/Sparse window: fewer than 50 evaluated recommendations\./),
    ).toBeTruthy();
  });

  it("falls back to the empty-state pills and placeholders when the report is empty", () => {
    mockDashboardWith({
      recommendationQuality: {
        ...qualityFixture,
        empty: true,
        sparse: false,
        trends: [],
        failureCategories: [],
        roleSurfaces: [],
        warnings: [],
      },
    });
    const { container } = render(<OperatorDashboard />);
    const emptyPill = screen.getByText("empty").closest("span");
    expect(emptyPill?.className).toContain("text-warning");
    expect(screen.getByText("No role-specific outcomes in this window.")).toBeTruthy();
    expect(screen.getByText("No failure categories in this window.")).toBeTruthy();
    expect(screen.queryByText("Trend")).toBeNull();
    expect(container.querySelector('[title*="30/40"]')).toBeNull();
  });

  it("labels a non-empty but thin report as sparse, with the stale pill tone", () => {
    mockDashboardWith({ recommendationQuality: { ...qualityFixture, sparse: true } });
    render(<OperatorDashboard />);
    const sparsePill = screen.getByText("sparse").closest("span");
    expect(sparsePill?.className).toContain("bg-warning/5");
  });
});

const weeklyValueReportFixture = {
  freshness: { status: "fresh", latestRollupDay: "2026-07-24" },
  warnings: [],
  metrics: [{ id: "m1", label: "Noise filtered", value: 120, detail: "comments suppressed" }],
};

describe("OperatorDashboard copyWeeklyReport (#8700)", () => {
  function mockClipboard(writeText: (text: string) => Promise<void>) {
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
    mockDashboardWith({ weeklyValueReport: weeklyValueReportFixture });
  });

  it("JSON branch: copies the weeklyValueReport payload verbatim without fetching anything", async () => {
    const writeText = mockClipboard(() => Promise.resolve());
    render(<OperatorDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Copy weekly report JSON" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(JSON.stringify(weeklyValueReportFixture, null, 2)),
    );
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith("Weekly report copied", {
      description: "JSON export copied.",
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("Markdown branch: fetches the operator Markdown variant and copies the returned text", async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      data: "# Weekly value report",
      status: 200,
      durationMs: 5,
    });
    const writeText = mockClipboard(() => Promise.resolve());
    render(<OperatorDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Copy weekly report Markdown" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("# Weekly value report"));
    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /\/v1\/app\/analytics\/weekly-value-report\?variant=operator&format=markdown$/,
      ),
      expect.objectContaining({ label: "Weekly report export" }),
    );
    expect(success).toHaveBeenCalledWith("Weekly report copied", {
      description: "Markdown export copied.",
    });
  });

  it("Markdown branch: surfaces the export fetch failure through toast.error and never writes", async () => {
    apiFetchMock.mockResolvedValue({
      ok: false,
      kind: "http",
      status: 500,
      message: "HTTP 500",
      durationMs: 5,
    });
    const writeText = mockClipboard(() => Promise.resolve());
    render(<OperatorDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Copy weekly report Markdown" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Copy failed", {
        description: "HTTP 500. Select the report text and copy manually.",
      }),
    );
    expect(writeText).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it("throws into the catch arm when the Clipboard API is unavailable", async () => {
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

  it("reports a rejected clipboard write through toast.error with the rejection's message", async () => {
    mockClipboard(() => Promise.reject(new Error("NotAllowedError")));
    render(<OperatorDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Copy weekly report JSON" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Copy failed", {
        description: "NotAllowedError. Select the report text and copy manually.",
      }),
    );
    expect(success).not.toHaveBeenCalled();
  });

  it("falls back to the generic manual-copy hint when the rejection carries no message", async () => {
    mockClipboard(() => Promise.reject(new Error("")));
    render(<OperatorDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Copy weekly report JSON" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Copy failed", {
        description: "Select the report text and copy manually.",
      }),
    );
  });
});
