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

// Mirrors proof-of-power-stats.test.tsx: <Link> needs a real router context; render a plain <a>.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: ReactNode;
    className?: string;
    "aria-label"?: string;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

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

  it("renders the measured per-rule precision table with the insufficient-data null state — never 0% (#8231)", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...FIXTURE,
        rulePrecision: {
          windowDays: 90,
          rules: [
            { ruleId: "linked_issue_scope_mismatch", decided: 42, precision: 0.952 },
            { ruleId: "slop_gate_score", decided: 3, precision: null },
          ],
          reversals: { reopened: 2, reverted: 1, superseded: 0 },
          latestBacktestRun: { corpusChecksum: "a".repeat(64), at: "2026-07-22T00:00:00.000Z" },
        },
      },
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Measured accuracy per rule")).toBeTruthy());
    expect(screen.getByText("linked_issue_scope_mismatch")).toBeTruthy();
    expect(screen.getByText("95.2%")).toBeTruthy();
    // The below-floor rule renders the deliberate null state — the literal words, not a zero.
    expect(screen.getAllByText("insufficient data").length).toBeGreaterThanOrEqual(2); // the explainer + the table cell
    expect(screen.queryByText("0%")).toBeNull();
    // The reproducibility freeze point surfaces the truncated corpus checksum.
    expect(screen.getByText(/Reproducibility freeze point/)).toBeTruthy();
    expect(screen.getByText(/aaaaaaaaaaaaaaaa…/)).toBeTruthy();
    // And the walkthrough link points at the docs page.
    expect(screen.getByRole("link", { name: /verify this review/i })).toBeTruthy();
  });

  it("hides the per-rule section entirely when the API response predates rulePrecision (deployment skew) or has no rules (#8231)", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: FIXTURE, durationMs: 10 });
    renderWithClient(<FairnessReportPage />);
    await waitFor(() =>
      expect(screen.getByText("Is ORB treating contributors fairly?")).toBeTruthy(),
    );
    expect(screen.queryByText("Measured accuracy per rule")).toBeNull();
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

  it("REGRESSION: does not crash when the API response predates the fleetAccuracy field (old backend/new frontend deployment skew)", async () => {
    const { fleetAccuracy: _omitted, ...payloadWithoutFleetAccuracy } = FIXTURE;
    apiFetch.mockResolvedValue({
      ok: true,
      data: payloadWithoutFleetAccuracy,
      status: 200,
      durationMs: 10,
    });
    renderWithClient(<FairnessReportPage />);

    await waitFor(() => expect(screen.getByText("Decision accuracy")).toBeTruthy());
    const accuracyCard = screen.getByText("Decision accuracy").closest("div")!.parentElement!;
    expect(accuracyCard.textContent).toContain("97.8%"); // falls back to the own-ledger number
    expect(
      screen.getByText("Anti-gaming flags caught").closest("div")!.parentElement!.textContent,
    ).toContain("—");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
