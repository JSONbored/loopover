import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  notifyApiFailure: vi.fn(),
  notifyApiRecovered: vi.fn(),
}));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.example.test" }));

import { FairnessReportPage } from "./fairness-report-page";
import type { PublicStats } from "./proof-of-power-stats-model";

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const FIXTURE: PublicStats = {
  generatedAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  totals: {
    handled: 100,
    reviewed: 100,
    merged: 60,
    closed: 30,
    commented: 10,
    ignored: 0,
    manual: 0,
    error: 0,
    reversed: 2,
    filteredPct: 40,
    accuracyPct: 97.8,
    minutesSaved: 2000,
  },
  weekly: { reviewed: 10, merged: 6 },
  byProject: [{ project: "owner/repo", reviewed: 100, merged: 60, closed: 30, accuracyPct: 95.5 }],
  fleetAccuracy: { accuracyPct: 92, instanceCount: 4, windowDays: 90, gamingFlagsCaught: 1 },
  accuracyTrend: [
    { weekStart: "2026-07-13", merged: 30, closed: 15, reversed: 1, accuracyPct: 97.8 },
  ],
  reuseRateTrend: [],
  reviewVolumeTrend: [],
};

describe("FairnessReportPage (#fairness-analytics)", () => {
  afterEach(() => {
    apiFetch.mockReset();
  });

  it("renders a content-shaped loading skeleton", () => {
    apiFetch.mockReturnValue(new Promise(() => {}));
    const { container } = renderWithClient(<FairnessReportPage />);
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
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("Fairness report unavailable")).toBeTruthy();

    apiFetch.mockResolvedValueOnce({ ok: true, data: FIXTURE, status: 200, durationMs: 10 });
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() =>
      expect(screen.getByText("Is ORB treating contributors fairly?")).toBeTruthy(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the empty-state copy when nothing has been reviewed yet", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: { ...FIXTURE, totals: { ...FIXTURE.totals, handled: 0 } },
      status: 200,
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Fairness report unavailable")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("prefers the live fleet accuracy over the own-ledger number, and shows the anti-gaming + reviewed cards", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: FIXTURE, status: 200, durationMs: 10 });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Decision accuracy")).toBeTruthy());
    // fleetAccuracy (92%), not the own-ledger totals.accuracyPct (97.8%) -- scoped to the stat card specifically,
    // since 97.8% legitimately also appears in the trend table below regardless of which headline is shown.
    const accuracyCard = screen.getByText("Decision accuracy").closest("div")!.parentElement!;
    expect(accuracyCard.textContent).toContain("92%");
    expect(accuracyCard.textContent).not.toContain("97.8%");
    expect(screen.getByText("Anti-gaming flags caught")).toBeTruthy();
    const gamingCard = screen.getByText("Anti-gaming flags caught").closest("div")!.parentElement!;
    expect(gamingCard.textContent).toContain("1");
    expect(screen.getByText("PRs reviewed")).toBeTruthy();
    expect(screen.getByText("By repository")).toBeTruthy();
    expect(screen.getByText("Weekly trend")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("falls back to the own-ledger accuracy when the fleet has no eligible instances", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...FIXTURE,
        fleetAccuracy: {
          accuracyPct: null,
          instanceCount: 0,
          windowDays: 90,
          gamingFlagsCaught: 0,
        },
      },
      status: 200,
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Decision accuracy")).toBeTruthy());
    const accuracyCard = screen.getByText("Decision accuracy").closest("div")!.parentElement!;
    expect(accuracyCard.textContent).toContain("97.8%");
    expect(screen.getByText("2 human-reversed, lifetime")).toBeTruthy();
  });
});
