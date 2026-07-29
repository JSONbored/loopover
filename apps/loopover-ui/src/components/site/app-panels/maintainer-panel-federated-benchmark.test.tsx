import { screen } from "@testing-library/react";
import { renderWithQueryClient as render } from "@/lib/test-query-client";
import { describe, expect, it, vi } from "vitest";

// A maintainer session + a path-aware data hook: the dashboard call resolves with a minimal payload; every
// other call stays in loading so sub-panels render harmlessly (mirrors maintainer-panel-slop.test.tsx).
const { useSession } = vi.hoisted(() => ({ useSession: vi.fn() }));
vi.mock("@/lib/api/session", () => ({ useSession: () => useSession() }));

const baseDashboard = {
  metrics: [],
  health: [],
  // Non-empty so MaintainerDashboardView's isEmpty check doesn't short-circuit to its own empty state
  // before the federated-benchmark wiring under test ever renders (mirrors maintainer-panel-slop.test.tsx).
  reviewability: [
    {
      pr: "acme/widgets#7",
      title: "Tidy things",
      author: "alice",
      bucket: "review-now",
      reason: "cached open PR",
      slop: null,
      chatQaEnabled: false,
    },
  ],
  settingsPreview: { removed: [], added: [] },
  qualityDashboard: {
    topContributors: [],
    gateOutcomeBreakdown: {
      windowDays: 30,
      generatedAt: "2026-07-11T00:00:00.000Z",
      counts: { autoMerged: 0, autoClosed: 0, held: 0 },
      total: 0,
      rates: { autoMerged: null, autoClosed: null, held: null },
      summary: "No gate-outcome audit events in the last 30 day(s) for the scoped repos.",
    },
  },
};

vi.mock("@/lib/api/request", () => ({ apiFetch: vi.fn(async () => ({ ok: false })) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

async function renderWithDashboard(federatedBenchmark: unknown) {
  vi.resetModules();
  vi.doMock("@/lib/api/use-api-resource", () => ({
    useApiResource: (path: string) =>
      path.includes("maintainer-dashboard")
        ? {
            status: "ready",
            data: {
              ...baseDashboard,
              qualityDashboard: { ...baseDashboard.qualityDashboard, federatedBenchmark },
            },
            reload: () => {},
            error: null,
          }
        : { status: "loading", data: null, reload: () => {}, error: null },
  }));
  const { MaintainerPanel } = await import("@/components/site/app-panels/maintainer-panel");
  useSession.mockReturnValue({
    session: { login: "maint", roles: ["maintainer"] },
    hydrated: true,
  });
  render(<MaintainerPanel />);
}

describe("MaintainerPanel federated benchmark wiring (#6481)", () => {
  it("renders no benchmark UI at all when the instance has not opted in (federatedBenchmark: null)", async () => {
    await renderWithDashboard(null);
    expect(screen.queryByText("Gate precision vs peer median")).toBeNull();
  });

  it("renders the benchmark card when opted in, even with zero peer data yet", async () => {
    await renderWithDashboard({
      localMergePrecision: 0.75,
      peerMedianMergePrecision: null,
      peerCount: 0,
      generatedAt: "2026-07-16T00:00:00.000Z",
    });
    expect(screen.getByText("Gate precision vs peer median")).toBeTruthy();
    expect(screen.getByText("No peer data yet")).toBeTruthy();
  });

  it("renders a real comparison when opted in with peer data", async () => {
    await renderWithDashboard({
      localMergePrecision: 0.9,
      peerMedianMergePrecision: 0.8,
      peerCount: 2,
      generatedAt: "2026-07-16T00:00:00.000Z",
    });
    expect(screen.getByText("Gate precision vs peer median")).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
    expect(screen.getByText("2 peers")).toBeTruthy();
  });
});
