import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

afterEach(() => vi.unstubAllGlobals());

import { ProofOfPowerStats } from "@/components/site/proof-of-power-stats";
import {
  formatStatsAgo,
  formatTimeSaved,
  type PublicStats,
} from "@/components/site/proof-of-power-stats-model";

// Real prod proportions: reviewed 2,708 (merged 1,392 + closed 724 + commented 514 + manual 78), 33 reversals
// over 2,116 auto-actions → 98.4% accuracy; filtered (reviewed−merged)/reviewed = 48.6%; 2,708×20min ≈ 38 days.
const PAYLOAD: PublicStats = {
  generatedAt: "2026-06-22T01:00:00.000Z",
  updatedAt: "2026-06-22T01:00:00.000Z",
  totals: {
    handled: 3233,
    reviewed: 2708,
    merged: 1392,
    closed: 724,
    commented: 514,
    ignored: 491,
    manual: 78,
    error: 34,
    reversed: 33,
    filteredPct: 48.6,
    accuracyPct: 98.4,
    minutesSaved: 54160,
  },
  weekly: { reviewed: 2000, merged: 900 },
  byProject: [
    {
      project: "JSONbored/awesome-claude",
      reviewed: 1986,
      merged: 1231,
      closed: 524,
      accuracyPct: 98.9,
    },
    {
      project: "JSONbored/metagraphed",
      reviewed: 529,
      merged: 137,
      closed: 176,
      accuracyPct: 96.8,
    },
    { project: "JSONbored/gittensory", reviewed: 193, merged: 24, closed: 24, accuracyPct: 93.8 },
  ],
  accuracyTrend: [
    { weekStart: "2026-05-04", merged: 40, closed: 10, reversed: 2, accuracyPct: 96 },
    { weekStart: "2026-05-11", merged: 42, closed: 9, reversed: 1, accuracyPct: 98 },
    { weekStart: "2026-05-18", merged: 38, closed: 12, reversed: 1, accuracyPct: 98 },
    { weekStart: "2026-05-25", merged: 45, closed: 8, reversed: 0, accuracyPct: 100 },
    { weekStart: "2026-06-01", merged: 41, closed: 11, reversed: 1, accuracyPct: 98 },
    { weekStart: "2026-06-08", merged: 1, closed: 0, reversed: 0, accuracyPct: null },
    { weekStart: "2026-06-15", merged: 44, closed: 9, reversed: 1, accuracyPct: 98 },
    { weekStart: "2026-06-22", merged: 39, closed: 10, reversed: 1, accuracyPct: 98 },
  ],
  reuseRateTrend: [
    { weekStart: "2026-05-04", hits: 60, misses: 40, reuseRatePct: 60 },
    { weekStart: "2026-05-11", hits: 65, misses: 35, reuseRatePct: 65 },
    { weekStart: "2026-05-18", hits: 70, misses: 30, reuseRatePct: 70 },
    { weekStart: "2026-05-25", hits: 72, misses: 28, reuseRatePct: 72 },
    { weekStart: "2026-06-01", hits: 75, misses: 25, reuseRatePct: 75 },
    { weekStart: "2026-06-08", hits: 78, misses: 22, reuseRatePct: 78 },
    { weekStart: "2026-06-15", hits: 80, misses: 20, reuseRatePct: 80 },
    { weekStart: "2026-06-22", hits: 83, misses: 17, reuseRatePct: 83 },
  ],
  reviewVolumeTrend: [
    { weekStart: "2026-05-04", reviewed: 2, merged: 1, filteredPct: null },
    { weekStart: "2026-05-11", reviewed: 300, merged: 150, filteredPct: 50 },
    { weekStart: "2026-05-18", reviewed: 310, merged: 160, filteredPct: 48.4 },
    { weekStart: "2026-05-25", reviewed: 320, merged: 165, filteredPct: 48.4 },
    { weekStart: "2026-06-01", reviewed: 330, merged: 170, filteredPct: 48.5 },
    { weekStart: "2026-06-08", reviewed: 340, merged: 175, filteredPct: 48.5 },
    { weekStart: "2026-06-15", reviewed: 350, merged: 180, filteredPct: 48.6 },
    { weekStart: "2026-06-22", reviewed: 358, merged: 185, filteredPct: 48.3 },
  ],
};

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("formatStatsAgo", () => {
  const base = Date.parse("2026-06-22T01:00:00.000Z");
  it("formats null/invalid as just now", () => {
    expect(formatStatsAgo(null, base)).toBe("just now");
    expect(formatStatsAgo("not-a-date", base)).toBe("just now");
  });
  it("formats seconds, minutes, hours, days", () => {
    expect(formatStatsAgo("2026-06-22T00:59:30.000Z", base)).toBe("30s ago");
    expect(formatStatsAgo("2026-06-22T00:50:00.000Z", base)).toBe("10m ago");
    expect(formatStatsAgo("2026-06-21T23:00:00.000Z", base)).toBe("2h ago");
    expect(formatStatsAgo("2026-06-20T01:00:00.000Z", base)).toBe("2d ago");
  });
});

describe("formatTimeSaved", () => {
  it("uses days at scale, hours below 2 days, minutes below an hour", () => {
    expect(formatTimeSaved(54160)).toEqual({ value: 38, unit: "days" }); // 2708 × 20 min
    expect(formatTimeSaved(180)).toEqual({ value: 3, unit: "hrs" });
    expect(formatTimeSaved(90)).toEqual({ value: 2, unit: "hrs" });
    expect(formatTimeSaved(40)).toEqual({ value: 40, unit: "min" });
  });
});

describe("ProofOfPowerStats", () => {
  it("renders nothing when the endpoint 404s (flag off)", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      kind: "http",
      status: 404,
      message: "404 Not Found",
      durationMs: 1,
    });
    const { container } = renderWithClient(<ProofOfPowerStats />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when nothing has been reviewed yet", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      durationMs: 1,
      data: { ...PAYLOAD, totals: { ...PAYLOAD.totals, handled: 0 } },
    });
    const { container } = renderWithClient(<ProofOfPowerStats />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("renders the five headline stats when data is live", async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, durationMs: 1, data: PAYLOAD });
    renderWithClient(<ProofOfPowerStats />);
    expect(await screen.findByText("PRs reviewed")).toBeTruthy();
    expect(screen.getByText("Filtered without merge")).toBeTruthy();
    expect(screen.getByText("Maintainer time saved")).toBeTruthy();
    expect(screen.getByText("Decision accuracy")).toBeTruthy();
    expect(screen.getByText("48.6%")).toBeTruthy();
    expect(screen.getByText("98.4%")).toBeTruthy();
    expect(screen.getByText("33 human-reversed")).toBeTruthy();
    expect(screen.getByText("1,316 closed, advised, or escalated")).toBeTruthy(); // 2708 − 1392
    // #4448: the fifth tile, its latest week's reuse rate, and its own sparkline.
    expect(screen.getByText("AI work reused")).toBeTruthy();
    expect(screen.getByText("83%")).toBeTruthy(); // reuseRateTrend's last entry
    expect(screen.getByText("avoided redoing prior AI work")).toBeTruthy();
  });

  it("renders a sparkline beside all four trend-backed tiles, each labeled by its own week count", async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, durationMs: 1, data: PAYLOAD });
    renderWithClient(<ProofOfPowerStats />);
    await screen.findByText("Decision accuracy");
    const sparklines = screen.getAllByRole("img", { name: "Trend over the last 8 weeks" });
    // PRs reviewed + Filtered without merge + Decision accuracy + AI work reused, all 8-week payloads.
    expect(sparklines).toHaveLength(4);
  });

  it("settles the count-up on the real reviewed total (not stuck at 0 when rAF never fires)", async () => {
    // Deterministic (#flake): force prefers-reduced-motion so useCountUp lands the final value synchronously on
    // mount, instead of running the requestAnimationFrame tween. jsdom has no matchMedia, so the unfixed test took
    // the animated path and raced the 3s findByText timeout under CI load. This still pins the intent — the count
    // settles on the real reviewed total, never stuck at 0 — without depending on animation-frame timing.
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    apiFetch.mockResolvedValue({ ok: true, status: 200, durationMs: 1, data: PAYLOAD });
    renderWithClient(<ProofOfPowerStats />);
    expect(await screen.findByText("2,708")).toBeTruthy();
  });
});
