import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { SparkStat } from "./app.index";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => () => Promise.resolve(),
}));

import { AppOverview } from "./app.index";

function mockOverviewFetch(
  overview: { ok: true } | { ok: false; kind?: "network" | "timeout" | "http" },
) {
  apiFetch.mockImplementation((url: string) => {
    if (url.endsWith("/v1/auth/session")) {
      return Promise.resolve({
        ok: true,
        data: {
          status: "authenticated",
          login: "test-user",
          roles: ["miner"],
          confirmed_miner: false,
        },
      });
    }
    if (url.endsWith("/v1/app/overview")) {
      return overview.ok
        ? Promise.resolve({ ok: true, data: { metrics: [], recentRuns: [] } })
        : Promise.resolve({ ok: false, message: "fetch failed", kind: overview.kind });
    }
    return Promise.resolve({ ok: false, message: "unhandled in test" });
  });
}

// #6984: SparkStat's loading branch hand-rolled its own animate-pulse divs instead of the shared
// Skeleton primitive every other loading placeholder in this app already uses.
describe("SparkStat loading state (#6984)", () => {
  it("renders Skeleton placeholders (not the raw hand-rolled divs) while loading", () => {
    const { container } = render(
      <SparkStat
        label="Open PRs"
        value="4"
        values={[1, 2, 3, 4]}
        live
        statusLabel="live"
        loading
      />,
    );

    expect(screen.getByRole("status", { name: "Loading Open PRs" })).toBeTruthy();
    // Skeleton renders animate-pulse blocks; the label/value/sparkline placeholders are 3 in total.
    expect(container.querySelectorAll(".animate-pulse").length).toBe(3);
    // The real label/value text never renders while loading.
    expect(screen.queryByText("Open PRs")).toBeNull();
    expect(screen.queryByText("4")).toBeNull();
  });

  it("renders the real label and value once data is available (not loading)", () => {
    render(
      <TooltipProvider>
        <SparkStat label="Open PRs" value="4" values={[1, 2, 3, 4]} live statusLabel="live" />
      </TooltipProvider>,
    );

    expect(screen.getByText("Open PRs")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading Open PRs" })).toBeNull();
  });
});

// #8668: the overview metrics ErrorState passed only title/description (both fixed strings), never
// errorKind or onRetry -- so a network outage always rendered the generic AlertTriangle treatment
// with no retry action, even though `overview.errorKind`/`overview.reload` were both already
// available from useApiResource.
describe("AppOverview metrics error state (#8668)", () => {
  it("shows the offline (WifiOff) icon for a network-kind overview failure, not the generic one", async () => {
    mockOverviewFetch({ ok: false, kind: "network" });
    const { container } = render(<AppOverview />);
    await screen.findByText("App overview is unavailable right now");
    expect(container.querySelector(".lucide-wifi-off")).toBeTruthy();
    expect(container.querySelector(".lucide-triangle-alert")).toBeNull();
  });

  it("keeps the generic (AlertTriangle) icon for a non-network overview failure", async () => {
    mockOverviewFetch({ ok: false, kind: "http" });
    const { container } = render(<AppOverview />);
    await screen.findByText("App overview is unavailable right now");
    expect(container.querySelector(".lucide-triangle-alert")).toBeTruthy();
    expect(container.querySelector(".lucide-wifi-off")).toBeNull();
  });

  it("retrying the overview error re-fetches /v1/app/overview", async () => {
    mockOverviewFetch({ ok: false, kind: "network" });
    render(<AppOverview />);
    await screen.findByText("App overview is unavailable right now");

    apiFetch.mockClear();
    mockOverviewFetch({ ok: false, kind: "network" });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith("https://api.test/v1/app/overview", expect.any(Object)),
    );
  });
});
