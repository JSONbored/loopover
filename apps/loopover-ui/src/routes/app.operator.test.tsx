import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// #6816: app.operator.tsx's StateBoundary had no loadingSkeleton, falling through to the generic spinner.
const { useApiResource } = vi.hoisted(() => ({ useApiResource: vi.fn() }));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: (...args: unknown[]) => useApiResource(...args),
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
