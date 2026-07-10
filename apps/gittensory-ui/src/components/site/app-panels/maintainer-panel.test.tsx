import { render, screen } from "@testing-library/react";
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
});

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

describe("MaintainerPanel slop + duplicate trend card (#2202)", () => {
  const trendCard = {
    generatedAt: "2026-06-14T12:00:00.000Z",
    stale: false,
    summary: "8-week slop + duplicate flag rates across 1 shaped repo(s).",
    weeks: [
      {
        weekStart: "2026-06-09",
        slopFlagRatePct: 12.5,
        slopBandLabel: "low" as const,
        duplicateFlagRatePct: 25,
      },
    ],
  };

  it("renders the slop + duplicate trend card when qualityDashboard includes trend data", () => {
    useSession.mockReturnValue({
      session: { login: "maint", roles: ["maintainer"] },
      hydrated: true,
    });
    useApiResource.mockReturnValue({
      status: "ready",
      data: {
        metrics: [{ label: "Installations", value: 1, spark: [1] }],
        health: [
          {
            installationId: 1,
            accountLogin: "preview-org",
            installedReposCount: 1,
            status: "healthy" as const,
            missingPermissions: [],
            missingEvents: [],
            checkedAt: "2026-07-10T00:00:00.000Z",
          },
        ],
        reviewability: [],
        settingsPreview: { removed: [], added: [] },
        qualityDashboard: { slopDuplicateTrend: trendCard },
      },
      reload: () => {},
      error: null,
    });

    render(<MaintainerPanel />);
    expect(screen.getByText("Slop + duplicate trend")).toBeTruthy();
  });
});
