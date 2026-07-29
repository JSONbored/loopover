import { screen } from "@testing-library/react";
import { renderWithQueryClient as render } from "@/lib/test-query-client";
import { describe, expect, it, vi } from "vitest";

// Control the session role + stub the data hook so the dashboard branch never hits the network.
const { useSession, useApiResource } = vi.hoisted(() => ({
  useSession: vi.fn(),
  useApiResource: vi.fn(),
}));
vi.mock("@/lib/api/session", () => ({ useSession: () => useSession() }));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: () => useApiResource(),
}));
useApiResource.mockReturnValue({ status: "loading", data: null, reload: () => {}, error: null });

import { MaintainerPanel } from "@/components/site/app-panels/maintainer-panel";

describe("MaintainerPanel role gate", () => {
  it("shows a loading state until the session is hydrated", () => {
    useSession.mockReturnValue({ session: null, hydrated: false });
    render(<MaintainerPanel />);
    expect(screen.getByText(/Checking maintainer access/i)).toBeTruthy();
  });

  it("blocks a non-maintainer: shows 'Maintainer access required' and never mounts the BYOK panel", () => {
    useSession.mockReturnValue({ session: { login: "miner", roles: ["miner"] }, hydrated: true });
    render(<MaintainerPanel />);
    expect(screen.getByText(/Maintainer access required/i)).toBeTruthy();
    // The BYOK key field (the only sk-ant- placeholder) must not exist for a non-maintainer.
    expect(screen.queryByPlaceholderText("sk-ant-…")).toBeNull();
  });

  it("admits a maintainer (no access-required message) and proceeds to the dashboard", () => {
    useSession.mockReturnValue({
      session: { login: "maint", roles: ["maintainer"] },
      hydrated: true,
    });
    render(<MaintainerPanel />);
    expect(screen.queryByText(/Maintainer access required/i)).toBeNull();
  });

  it("shows a content-shaped skeleton (not the generic spinner) while the dashboard loads (#793)", () => {
    // Default mock: an admitted maintainer whose dashboard resource is still loading.
    useSession.mockReturnValue({
      session: { login: "maint", roles: ["maintainer"] },
      hydrated: true,
    });
    const { container } = render(<MaintainerPanel />);
    // The custom skeleton replaces the generic LoadingState spinner while the payload is in flight.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Loading maintainer context…")).toBeNull();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(1);
  });
});

const emptyGateOutcomeBreakdown = {
  windowDays: 30,
  generatedAt: "2026-07-11T00:00:00.000Z",
  counts: { autoMerged: 0, autoClosed: 0, held: 0 },
  total: 0,
  rates: { autoMerged: null, autoClosed: null, held: null },
  summary: "No gate-outcome audit events in the last 30 day(s) for the scoped repos.",
};

describe("MaintainerPanel install health — Orb broker mode (#selfhost-runtime-drift)", () => {
  const dashboardData = {
    metrics: [],
    health: [
      {
        installationId: 1,
        accountLogin: "brokered-owner",
        installedReposCount: 2,
        status: "healthy" as const,
        missingPermissions: [],
        missingEvents: [],
        checkedAt: "2026-07-03T00:00:00.000Z",
        authMode: "broker" as const,
      },
      {
        installationId: 2,
        accountLogin: "local-owner",
        installedReposCount: 1,
        status: "needs_attention" as const,
        missingPermissions: ["pull_requests"],
        missingEvents: [],
        checkedAt: "2026-07-03T00:00:00.000Z",
        authMode: "local" as const,
      },
    ],
    reviewability: [],
    settingsPreview: { removed: [], added: [] },
    qualityDashboard: { topContributors: [], gateOutcomeBreakdown: emptyGateOutcomeBreakdown },
  };

  it("shows a neutral 'n/a (broker)' pill instead of a fabricated perms/webhook verdict for a brokered install", () => {
    useSession.mockReturnValue({
      session: { login: "maint", roles: ["maintainer"] },
      hydrated: true,
    });
    useApiResource.mockReturnValue({
      status: "ready",
      data: dashboardData,
      reload: () => {},
      error: null,
    });

    render(<MaintainerPanel />);

    expect(screen.getByText("perms n/a (broker)")).toBeTruthy();
    expect(screen.getByText("webhook n/a (broker)")).toBeTruthy();
    // The local-mode install is unaffected — still shows a real missing/ok verdict, not the broker text.
    expect(screen.getByText("perms missing")).toBeTruthy();
    expect(screen.getByText("webhook ok")).toBeTruthy();
    expect(screen.queryAllByText(/n\/a \(broker\)/)).toHaveLength(2); // scoped to the brokered install only
  });
});

describe("MaintainerPanel MCP tool usage panel (#6241)", () => {
  // MaintainerPanel's own isEmpty check requires a non-empty health OR reviewability array to reach
  // the real dashboard content branch at all -- an all-empty payload short-circuits to its own
  // top-level EmptyState before any qualityDashboard card (including this one) ever renders.
  const nonEmptyHealth = [
    {
      installationId: 1,
      accountLogin: "an-owner",
      installedReposCount: 1,
      status: "healthy" as const,
      missingPermissions: [],
      missingEvents: [],
      checkedAt: "2026-07-03T00:00:00.000Z",
      authMode: "local" as const,
    },
  ];

  it("shows the not-yet-available empty state when mcpToolUsage is absent from the payload", () => {
    useSession.mockReturnValue({
      session: { login: "maint", roles: ["maintainer"] },
      hydrated: true,
    });
    useApiResource.mockReturnValue({
      status: "ready",
      data: {
        metrics: [],
        health: nonEmptyHealth,
        reviewability: [],
        settingsPreview: { removed: [], added: [] },
        qualityDashboard: { topContributors: [], gateOutcomeBreakdown: emptyGateOutcomeBreakdown },
      },
      reload: () => {},
      error: null,
    });

    render(<MaintainerPanel />);

    // Scoped to this card's own copy, not the generic "Not yet available" title QueueHealthCard's
    // own (also-absent) empty state shares.
    expect(
      screen.getByText(
        "Per-tool MCP usage appears here once tool-call telemetry is aggregated into the dashboard payload.",
      ),
    ).toBeTruthy();
  });

  it("renders real per-tool rows once mcpToolUsage is present in the payload", () => {
    useSession.mockReturnValue({
      session: { login: "maint", roles: ["maintainer"] },
      hydrated: true,
    });
    useApiResource.mockReturnValue({
      status: "ready",
      data: {
        metrics: [],
        health: nonEmptyHealth,
        reviewability: [],
        settingsPreview: { removed: [], added: [] },
        qualityDashboard: {
          topContributors: [],
          gateOutcomeBreakdown: emptyGateOutcomeBreakdown,
          mcpToolUsage: {
            windowDays: 14,
            tools: [
              {
                tool: "loopover_check_slop_risk",
                callCount: 5,
                successCount: 5,
                failureCount: 0,
                localCallCount: 5,
                remoteCallCount: 0,
              },
            ],
          },
        },
      },
      reload: () => {},
      error: null,
    });

    render(<MaintainerPanel />);

    expect(screen.getByText("loopover_check_slop_risk")).toBeTruthy();
    expect(screen.getByText("14d window")).toBeTruthy();
  });
});
