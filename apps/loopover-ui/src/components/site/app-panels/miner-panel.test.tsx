import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Stub the data hook + session so the panel renders without touching the network, and neuter the
// router Link / MCP badge that the miner dashboard pulls in.
const { useApiResource, useSession } = vi.hoisted(() => ({
  useApiResource: vi.fn(),
  useSession: vi.fn(),
}));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: (...args: unknown[]) => useApiResource(...args),
  API_RESOURCE_DISABLED: "disabled",
}));
vi.mock("@/lib/api/session", () => ({ useSession: () => useSession() }));
vi.mock("@/components/site/mcp-version-badge", () => ({
  McpVersionBadge: () => <span>mcp</span>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: React.ReactNode; to?: string }) => (
    <a href={props.to ?? "#"}>{children}</a>
  ),
}));

import { MinerPanel } from "@/components/site/app-panels/miner-panel";

describe("MinerPanel loading skeleton (#793)", () => {
  it("shows a content-shaped skeleton (not the generic spinner) while the decision pack loads", () => {
    useSession.mockReturnValue({
      session: { login: "miner", roles: ["miner"] },
      hydrated: true,
    });
    useApiResource.mockReturnValue({
      status: "loading",
      data: null,
      error: null,
      loadedAt: null,
      reload: () => {},
    });

    const { container } = render(<MinerPanel />);
    // The custom skeleton replaces the generic LoadingState — neither its title nor its spinner shows.
    // (A distinct always-present sr-only status live-region in the action bar rules out a role query.)
    expect(screen.queryByText("Loading miner signals…")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    // The placeholder renders animate-pulse blocks approximating the dashboard's metric + card grid.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(1);
  });
});

// #9672: `useApiResource` writes the literal "disabled" into `error` as a synthetic sentinel for "this
// resource is switched off" (see `enabled: Boolean(login)` above) -- MinerPanel used to render that
// sentinel through the same warning box as a real `apiFetch` failure, so a signed-out visitor saw
// "Miner dashboard is unavailable right now (disabled)" instead of a sign-in prompt.
describe("MinerPanel signed-out sentinel (#9672)", () => {
  it("renders a sign-in prompt, not the disabled sentinel, when signed out", () => {
    useSession.mockReturnValue({ session: null, hydrated: true });
    useApiResource.mockReturnValue({
      status: "error",
      data: null,
      error: "disabled",
      loadedAt: null,
      reload: () => {},
    });

    render(<MinerPanel />);

    expect(screen.getByText("Sign in to see your miner dashboard")).toBeTruthy();
    expect(document.body.textContent).not.toContain("disabled");
  });

  it("renders the loading skeleton, not the signed-out state, before the session hydrates", () => {
    useSession.mockReturnValue({ session: null, hydrated: false });
    useApiResource.mockReturnValue({
      status: "error",
      data: null,
      error: "disabled",
      loadedAt: null,
      reload: () => {},
    });

    const { container } = render(<MinerPanel />);

    expect(screen.queryByText("Sign in to see your miner dashboard")).toBeNull();
    expect(document.body.textContent).not.toContain("disabled");
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(1);
  });

  it("still renders the unavailable-now warning box for a real, signed-in dashboard failure", () => {
    useSession.mockReturnValue({
      session: { login: "miner", roles: ["miner"] },
      hydrated: true,
    });
    useApiResource.mockReturnValue({
      status: "error",
      data: null,
      error: "500 Internal Server Error",
      loadedAt: null,
      reload: () => {},
    });

    render(<MinerPanel />);

    expect(
      screen.getByText("Miner dashboard is unavailable right now (500 Internal Server Error)."),
    ).toBeTruthy();
    expect(screen.queryByText("Sign in to see your miner dashboard")).toBeNull();
  });
});
