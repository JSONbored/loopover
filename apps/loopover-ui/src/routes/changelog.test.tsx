import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// #6822: changelog.tsx hand-rolled its loading/error branches (no role="status"/role="alert", no retry).
// This mirrors github-stats-chip.test.tsx's QueryClientProvider + mocked apiFetch harness.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  notifyApiFailure: vi.fn(),
  notifyApiRecovered: vi.fn(),
}));

import { Changelog } from "@/routes/changelog";

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

// Deliberately NOT the "0.9.0" MCP_PACKAGE_KNOWN_LATEST_VERSION fallback the component renders in its
// always-present intro paragraph even before data loads -- using a distinct fixture version means a
// match can only come from the real fetched data, not a loading-state false positive.
const NPM_METADATA = {
  "dist-tags": { latest: "1.2.0" },
  time: { "1.2.0": "2026-07-01T00:00:00.000Z", "1.1.0": "2026-06-01T00:00:00.000Z" },
  versions: { "1.2.0": {}, "1.1.0": {} },
};

describe("Changelog (#6822)", () => {
  afterEach(() => {
    apiFetch.mockReset();
  });

  it("renders an accessible loading state (role=status), not the old plain text", async () => {
    apiFetch.mockReturnValue(new Promise(() => {})); // never resolves -- stays in the loading state
    renderWithClient(<Changelog />);

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("Loading from npm…")).toBeTruthy();
  });

  it("renders an accessible error state (role=alert) with a retry action that refetches, instead of the old dead-end text", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      kind: "http",
      status: 503,
      message: "npm_registry_unavailable",
      durationMs: 20,
    });
    renderWithClient(<Changelog />);

    // useMcpPackageMetadata hardcodes retry: 1, which wins over this QueryClient's own retry: false default,
    // so the first failure isn't final -- isError only settles true after the retried attempt also fails.
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy(), { timeout: 5000 });
    expect(screen.getByText("Could not reach the npm registry")).toBeTruthy();

    apiFetch.mockResolvedValueOnce({ ok: true, data: NPM_METADATA, status: 200, durationMs: 20 });
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    // Each version renders twice (main list card + the sticky sidebar TOC, always in the DOM regardless
    // of the `hidden lg:` breakpoint class jsdom doesn't apply layout for), hence getAllByText.
    await waitFor(() => expect(screen.getAllByText("v1.2.0").length).toBeGreaterThan(0));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the version list once the npm metadata loads", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: NPM_METADATA, status: 200, durationMs: 20 });
    renderWithClient(<Changelog />);

    await waitFor(() => expect(screen.getAllByText("v1.1.0").length).toBeGreaterThan(0));
    expect(screen.getAllByText("v1.2.0").length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
