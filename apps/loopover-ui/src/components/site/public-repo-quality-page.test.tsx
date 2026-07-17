import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// #6821: public-repo-quality-page hand-rolled loading/error (plain <p>, no role="status"/alert, no retry).
// Mirror changelog.test.tsx's QueryClientProvider + mocked apiFetch harness.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  notifyApiFailure: vi.fn(),
  notifyApiRecovered: vi.fn(),
}));
vi.mock("@/lib/api/origin", () => ({
  getApiOrigin: () => "https://api.example.test",
}));

import { PublicRepoQualityPage } from "./public-repo-quality-page";

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const FIXTURE = {
  repoFullName: "JSONbored/loopover",
  generatedAt: "2026-07-17T00:00:00.000Z",
  gate: {
    blocked: 10,
    blockedThenMerged: 2,
    falsePositiveRate: 0.2,
    precisionPct: 80,
    topGateTypes: [
      {
        gateType: "linked_issue",
        blocked: 4,
        blockedThenMerged: 1,
        falsePositiveRate: 0.25,
        precisionPct: 75,
      },
    ],
  },
  outcomes: { merged: 20, closed: 5, mergeRatioPct: 80 },
  slop: { totalResolved: 12, overallMergeRate: 50, discriminates: true },
  trend: [
    {
      weekStart: "2026-07-07",
      gateBlocked: 3,
      gateBlockedThenMerged: 1,
      gateFalsePositiveRate: 0.3,
      outcomesMerged: 4,
      outcomesClosed: 1,
      mergeRatioPct: 80,
    },
  ],
};

describe("PublicRepoQualityPage (#6821)", () => {
  afterEach(() => {
    apiFetch.mockReset();
  });

  it("renders a content-shaped loading skeleton instead of the old plain loading text", () => {
    apiFetch.mockReturnValue(new Promise(() => {}));
    const { container } = renderWithClient(
      <PublicRepoQualityPage owner="JSONbored" repo="loopover" />,
    );

    // REGRESSION: the old branch was a bare <p>Loading review-quality metrics…</p> with no skeleton.
    expect(screen.queryByText("Loading review-quality metrics…")).toBeNull();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(1);
  });

  it("renders an accessible error state (role=alert) with a retry that refetches", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      kind: "http",
      status: 503,
      message: "unavailable",
      durationMs: 10,
    });
    renderWithClient(<PublicRepoQualityPage owner="JSONbored" repo="loopover" />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("Review quality unavailable")).toBeTruthy();

    apiFetch.mockResolvedValueOnce({ ok: true, data: FIXTURE, status: 200, durationMs: 10 });
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(screen.getByText("JSONbored/loopover")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the empty-state copy when the repo has not opted in (null payload)", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: null, status: 200, durationMs: 10 });
    renderWithClient(<PublicRepoQualityPage owner="JSONbored" repo="loopover" />);

    await waitFor(() => expect(screen.getByText("Review quality unavailable")).toBeTruthy());
    // Empty (opt-out) is not an alert — that role is reserved for fetch failures with retry.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the 3-stat cards once metrics load", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: FIXTURE, status: 200, durationMs: 10 });
    renderWithClient(<PublicRepoQualityPage owner="JSONbored" repo="loopover" />);

    await waitFor(() => expect(screen.getByText("Gate precision")).toBeTruthy());
    // "Merge ratio" appears on both the stat card and the trend table header.
    expect(screen.getAllByText("Merge ratio").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Slop calibration")).toBeTruthy();
    expect(screen.getByText("Weekly trend")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
