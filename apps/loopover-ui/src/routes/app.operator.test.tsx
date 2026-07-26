import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #6816: app.operator.tsx's StateBoundary had no loadingSkeleton, falling through to the generic spinner.
const { useApiResource } = vi.hoisted(() => ({ useApiResource: vi.fn() }));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: (...args: unknown[]) => useApiResource(...args),
}));

// The Markdown export path goes through apiFetch — mock it so the copy handler can be exercised without
// hitting the network, and so its ok:false arm can be exercised deterministically.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

// The copy handler routes both success and failure through sonner's toast — capture both channels so
// each branch can be asserted directly.
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
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

// #8700: qualityStatus, formatPct/formatMs, the Recommendation Quality + Fleet Metrics render blocks,
// and the copyWeeklyReport handler were all unexercised — the whole scoring/calibration surface could
// be silently broken and no test would fail.
describe("qualityStatus threshold boundaries (#8700)", () => {
  it("returns 'ready' at and above the 0.67 boundary", () => {
    expect(qualityStatus(0.67)).toBe("ready");
    expect(qualityStatus(0.9)).toBe("ready");
    expect(qualityStatus(1)).toBe("ready");
  });

  it("returns 'stale' in the [0.4, 0.67) band, including the lower boundary", () => {
    expect(qualityStatus(0.4)).toBe("stale");
    expect(qualityStatus(0.5)).toBe("stale");
    // Just under the 'ready' threshold to prove the strict `>= 0.67` split, not off-by-one.
    expect(qualityStatus(0.6699)).toBe("stale");
  });

  it("returns 'warn' below 0.4, including zero", () => {
    expect(qualityStatus(0.39)).toBe("warn");
    expect(qualityStatus(0)).toBe("warn");
  });
});

describe("formatPct null and rounding branches (#8700)", () => {
  it("returns the em dash for null so a missing metric never renders as a bogus 0%", () => {
    expect(formatPct(null)).toBe("—");
  });

  it("rounds the ratio to an integer percent for every non-null input", () => {
    expect(formatPct(0)).toBe("0%");
    expect(formatPct(0.5)).toBe("50%");
    expect(formatPct(1)).toBe("100%");
    // 66.7% rounds to 67%, matching the qualityStatus 'ready' boundary as displayed.
    expect(formatPct(0.667)).toBe("67%");
  });
});

describe("formatMs null and hour-threshold branches (#8700)", () => {
  it("returns the em dash for null", () => {
    expect(formatMs(null)).toBe("—");
  });

  it("shows minutes below the 3_600_000ms hour boundary", () => {
    expect(formatMs(60_000)).toBe("1m");
    // One millisecond under an hour still uses minutes, proving the strict `>= 3_600_000` split.
    expect(formatMs(3_599_999)).toBe("60m");
  });

  it("switches to fractional hours at and above the hour boundary", () => {
    expect(formatMs(3_600_000)).toBe("1.0h");
    expect(formatMs(5_400_000)).toBe("1.5h");
    expect(formatMs(7_200_000)).toBe("2.0h");
  });
});

type MockFleetMetrics = {
  windowDays: number;
  instanceCount: number;
  fleet: {
    mergePrecision: number | null;
    closePrecision: number | null;
    fpRate: number | null;
    reversalRate: number | null;
    cycleP50Ms: number | null;
    cycleP95Ms: number | null;
  };
  outliers: Array<{ instanceId: string; metric: string; value: number; fleetMedian: number }>;
};

function mockOperatorDashboard(extra: Record<string, unknown>) {
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

describe("OperatorDashboard Fleet health (gate calibration) section (#8700)", () => {
  const outliers = [
    { instanceId: "inst-1", metric: "fpRate", value: 0.5, fleetMedian: 0.1 },
    { instanceId: "inst-2", metric: "reversalRate", value: 0.4, fleetMedian: 0.05 },
  ];

  it("renders no section when instanceCount is 0 (backend has no self-hosted fleet yet)", () => {
    mockOperatorDashboard({
      fleetMetrics: {
        windowDays: 14,
        instanceCount: 0,
        fleet: {
          mergePrecision: null,
          closePrecision: null,
          fpRate: null,
          reversalRate: null,
          cycleP50Ms: null,
          cycleP95Ms: null,
        },
        outliers: [],
      } satisfies MockFleetMetrics,
    });
    render(<OperatorDashboard />);
    expect(screen.queryByText("Fleet health")).toBeNull();
  });

  it("renders every gate-calibration stat via formatPct/formatMs and the outlier count", () => {
    mockOperatorDashboard({
      fleetMetrics: {
        windowDays: 14,
        instanceCount: 3,
        fleet: {
          // Populated values cover the non-null formatPct arm.
          mergePrecision: 0.9,
          closePrecision: 0.5,
          fpRate: 0.1,
          // A null cell proves the '—' arm is reachable in the rendered UI, not just in the unit test.
          reversalRate: null,
          // Below the hour boundary — minutes.
          cycleP50Ms: 300_000,
          cycleP95Ms: null,
        },
        outliers,
      } satisfies MockFleetMetrics,
    });
    render(<OperatorDashboard />);
    expect(screen.getByText("Fleet health")).toBeTruthy();
    expect(
      screen.getByText(/Gate calibration aggregated \(median\) across 3 self-hosted/),
    ).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("10%")).toBeTruthy();
    // Reversal rate cell shows the em dash when the fleet median is null.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText("5m")).toBeTruthy();
    // Outlier stat prints the array length as a string.
    expect(screen.getByText("Instance outliers")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("switches Cycle time (p50) to the fractional-hour formatter above the 1h boundary", () => {
    mockOperatorDashboard({
      fleetMetrics: {
        windowDays: 30,
        instanceCount: 1,
        fleet: {
          mergePrecision: 0.8,
          closePrecision: 0.7,
          fpRate: 0.05,
          reversalRate: 0.02,
          // 1.5h → covers the `>= 3_600_000` branch inside the rendered UI.
          cycleP50Ms: 5_400_000,
          cycleP95Ms: 9_000_000,
        },
        outliers: [],
      } satisfies MockFleetMetrics,
    });
    render(<OperatorDashboard />);
    expect(screen.getByText("1.5h")).toBeTruthy();
  });
});

const QUALITY_REPORT = {
  windowDays: 14,
  visibility: "operator_only" as const,
  empty: false,
  sparse: false,
  totals: {
    total: 100,
    positive: 67,
    negative: 33,
    positiveRate: 0.67,
    maintainerLaneTotal: 20,
    highConfidence: 40,
    mediumConfidence: 40,
    lowConfidence: 20,
  },
  trends: [
    {
      periodStart: "2026-06-24T00:00:00.000Z",
      periodEnd: "2026-06-30T00:00:00.000Z",
      total: 50,
      positive: 35,
      negative: 15,
      positiveRate: 0.7,
      maintainerLaneTotal: 10,
      highConfidence: 20,
      mediumConfidence: 20,
      lowConfidence: 10,
    },
  ],
  failureCategories: [
    { category: "closed", label: "Closed unmatched", count: 5, detail: "PRs closed without merge" },
  ],
  roleSurfaces: [
    {
      role: "miner" as const,
      label: "Miner",
      positive: 9,
      negative: 1,
      total: 10,
      positiveRate: 0.9,
      maintainerLaneTotal: 0,
      highConfidence: 5,
      mediumConfidence: 3,
      lowConfidence: 2,
      topRepos: [
        { repoFullName: "acme/one", total: 5, positive: 4, negative: 1, signal: "positive" as const },
      ],
    },
    {
      role: "maintainer" as const,
      label: "Maintainer",
      positive: 5,
      negative: 5,
      total: 10,
      positiveRate: 0.5,
      maintainerLaneTotal: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      lowConfidence: 0,
      topRepos: [],
    },
    {
      role: "owner" as const,
      label: "Owner",
      positive: 2,
      negative: 8,
      total: 10,
      positiveRate: 0.2,
      maintainerLaneTotal: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      lowConfidence: 0,
      topRepos: [],
    },
  ],
  warnings: ["Sample size below the confidence floor"],
  publicExport: { available: false as const, reason: "opt-in required" },
  privateSummary: "Operator-only recommendation quality snapshot",
};

describe("OperatorDashboard Recommendation quality section (#8700)", () => {
  it("renders totals, per-role surface pills, failure categories, trend bars, and warnings", () => {
    mockOperatorDashboard({ recommendationQuality: QUALITY_REPORT });
    const { container } = render(<OperatorDashboard />);

    expect(screen.getByText("Recommendation quality")).toBeTruthy();
    expect(screen.getByText("Operator-only recommendation quality snapshot")).toBeTruthy();
    // Window-days badge next to the empty/sparse/populated pill.
    expect(screen.getByText("14d")).toBeTruthy();
    expect(screen.getByText("populated")).toBeTruthy();
    // Positive rate stat text.
    expect(screen.getByText("67%")).toBeTruthy();
    expect(screen.getByText("67/100 evaluated")).toBeTruthy();
    // Confidence hint composed from the totals.
    expect(screen.getByText("40 medium · 20 low")).toBeTruthy();
    // Every role surface label renders.
    expect(screen.getByText("Miner")).toBeTruthy();
    expect(screen.getByText("Maintainer")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    // Per-surface signal counts render for the miner card.
    expect(screen.getByText("9 positive · 1 negative")).toBeTruthy();
    // Top-repos row on the miner surface.
    expect(screen.getByText("acme/one")).toBeTruthy();
    expect(screen.getByText("4/5")).toBeTruthy();
    // Failure category and warning render.
    expect(screen.getByText("Closed unmatched")).toBeTruthy();
    expect(screen.getByText("PRs closed without merge")).toBeTruthy();
    expect(screen.getByText("· Sample size below the confidence floor")).toBeTruthy();
    // One trend bucket → one trend bar.
    expect(container.querySelectorAll("[title^='6/24/2026']").length).toBe(1);
  });

  it("shows the empty/sparse pill and the empty-surface / empty-category placeholders", () => {
    mockOperatorDashboard({
      recommendationQuality: {
        ...QUALITY_REPORT,
        empty: true,
        sparse: false,
        roleSurfaces: [],
        failureCategories: [],
        trends: [],
        warnings: [],
      },
    });
    render(<OperatorDashboard />);
    expect(screen.getByText("empty")).toBeTruthy();
    expect(screen.getByText("No role-specific outcomes in this window.")).toBeTruthy();
    expect(screen.getByText("No failure categories in this window.")).toBeTruthy();
  });

  it("shows the 'sparse' pill when the report has data but too little of it", () => {
    mockOperatorDashboard({
      recommendationQuality: { ...QUALITY_REPORT, empty: false, sparse: true },
    });
    render(<OperatorDashboard />);
    expect(screen.getByText("sparse")).toBeTruthy();
  });
});

const WEEKLY_VALUE_REPORT = {
  freshness: { status: "current", latestRollupDay: "2026-07-14" },
  warnings: ["backfill running"],
  metrics: [
    { id: "runs", label: "Runs", value: 12, detail: "successful runs" },
    { id: "reviews", label: "Reviews", value: 34, detail: "reviews shipped" },
  ],
};

function mockClipboardWriteText(fn: (text: string) => Promise<void>) {
  const spy = vi.fn(fn);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: spy },
    configurable: true,
    writable: true,
  });
  return spy;
}

describe("OperatorDashboard copyWeeklyReport (#8700)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockDashboardWithReport() {
    mockOperatorDashboard({
      weeklyValueReport: WEEKLY_VALUE_REPORT,
      upstreamDrift: { status: "current" },
    });
  }

  it("copies exactly JSON.stringify(weeklyValueReport, null, 2) when the JSON button is clicked", async () => {
    const writeText = mockClipboardWriteText(() => Promise.resolve());
    mockDashboardWithReport();
    render(<OperatorDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Copy weekly report JSON" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(JSON.stringify(WEEKLY_VALUE_REPORT, null, 2)),
    );
    // JSON branch never hits the network — apiFetch stays untouched.
    expect(apiFetch).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("Weekly report copied", {
      description: "JSON export copied.",
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("fetches the Markdown export via apiFetch and copies the response body", async () => {
    const writeText = mockClipboardWriteText(() => Promise.resolve());
    apiFetch.mockResolvedValue({
      ok: true,
      data: "# Weekly value report\n\nHello",
      status: 200,
      durationMs: 1,
    });
    mockDashboardWithReport();
    render(<OperatorDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Copy weekly report Markdown" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("# Weekly value report\n\nHello"),
    );
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = apiFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe(
      "https://api.test/v1/app/analytics/weekly-value-report?variant=operator&format=markdown",
    );
    expect(opts.headers.Accept).toBe("text/markdown");
    expect(toastSuccess).toHaveBeenCalledWith("Weekly report copied", {
      description: "Markdown export copied.",
    });
  });

  it("surfaces the apiFetch failure message through toast.error and never writes to the clipboard", async () => {
    const writeText = mockClipboardWriteText(() => Promise.resolve());
    apiFetch.mockResolvedValue({
      ok: false,
      kind: "network",
      message: "offline",
      durationMs: 1,
    });
    mockDashboardWithReport();
    render(<OperatorDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Copy weekly report Markdown" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Copy failed", {
        description: "offline. Select the report text and copy manually.",
      }),
    );
    expect(writeText).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("routes a clipboard rejection to toast.error with the rejected error's message", async () => {
    mockClipboardWriteText(() => Promise.reject(new Error("denied")));
    mockDashboardWithReport();
    render(<OperatorDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Copy weekly report JSON" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Copy failed", {
        description: "denied. Select the report text and copy manually.",
      }),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("falls back to the generic copy-manually description when the thrown error has no message", async () => {
    // Empty-string message hits the else arm of the description ternary; also covers the branch where
    // a caught value has no useful `.message` to surface.
    mockClipboardWriteText(() => Promise.reject(new Error("")));
    mockDashboardWithReport();
    render(<OperatorDashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Copy weekly report JSON" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Copy failed", {
        description: "Select the report text and copy manually.",
      }),
    );
  });
});
