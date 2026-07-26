import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AppOverview, SparkStat } from "./app.index";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  useNavigate: () => () => Promise.resolve(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

const { useSession } = vi.hoisted(() => ({ useSession: vi.fn() }));
vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/session")>();
  return { ...actual, useSession: () => useSession() };
});

const { useApiResource } = vi.hoisted(() => ({ useApiResource: vi.fn() }));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: (...args: unknown[]) => useApiResource(...args),
}));

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

describe("AppOverview error state (#8668)", () => {
  const SESSION = {
    login: "octo",
    roles: ["miner"] as const,
    confirmed_miner: true,
  };

  it("REGRESSION: shows the WifiOff icon, not the generic AlertTriangle, when the overview fetch fails with a network errorKind", () => {
    useSession.mockReturnValue({ session: SESSION });
    useApiResource.mockReturnValue({
      status: "error",
      data: null,
      error: "fetch failed",
      errorKind: "network",
      loadedAt: null,
      reload: vi.fn(),
    });

    const { container } = render(<AppOverview />);
    expect(screen.getByText("App overview is unavailable right now")).toBeTruthy();
    expect(container.querySelector(".lucide-wifi-off")).toBeTruthy();
    expect(container.querySelector(".lucide-triangle-alert")).toBeNull();
  });

  it("keeps the generic AlertTriangle icon for a non-network (e.g. http) errorKind", () => {
    useSession.mockReturnValue({ session: SESSION });
    useApiResource.mockReturnValue({
      status: "error",
      data: null,
      error: "server exploded",
      errorKind: "http",
      loadedAt: null,
      reload: vi.fn(),
    });

    const { container } = render(<AppOverview />);
    expect(container.querySelector(".lucide-triangle-alert")).toBeTruthy();
    expect(container.querySelector(".lucide-wifi-off")).toBeNull();
  });

  it("REGRESSION: clicking retry on the overview error state re-triggers the fetch", () => {
    const reload = vi.fn();
    useSession.mockReturnValue({ session: SESSION });
    useApiResource.mockReturnValue({
      status: "error",
      data: null,
      error: "fetch failed",
      errorKind: "network",
      loadedAt: null,
      reload,
    });

    render(<AppOverview />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
