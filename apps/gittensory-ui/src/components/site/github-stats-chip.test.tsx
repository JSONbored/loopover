import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  notifyApiFailure: vi.fn(),
  notifyApiRecovered: vi.fn(),
}));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

import { GithubStatsChip } from "@/components/site/github-stats-chip";

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const GH_OK = {
  ok: true,
  json: async () => ({ stargazers_count: 10, forks_count: 45 }),
};

describe("GithubStatsChip", () => {
  it("shows stars and forks when the Worker proxy succeeds", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: { stargazers_count: 10, forks_count: 45 },
      status: 200,
      durationMs: 50,
    });

    renderWithClient(<GithubStatsChip />);

    await waitFor(() => {
      expect(screen.getByText("10")).toBeTruthy();
    });
    expect(screen.getByText("45")).toBeTruthy();
  });

  it("falls back to the direct GitHub API when the Worker proxy returns 503", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      kind: "http",
      status: 503,
      message: "github_repo_stats_unavailable",
      durationMs: 50,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(GH_OK));

    renderWithClient(<GithubStatsChip />);

    await waitFor(() => {
      expect(screen.getByText("10")).toBeTruthy();
    });
    expect(screen.getByText("45")).toBeTruthy();

    // The fallback should have been called with the direct GitHub repos endpoint
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://api.github.com/repos/jsonbored/gittensory",
      expect.objectContaining({ headers: { accept: "application/vnd.github+json" } }),
    );
  });

  it("shows unavailable when both the proxy and the direct GitHub API fail", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      kind: "http",
      status: 503,
      message: "github_repo_stats_unavailable",
      durationMs: 50,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({}),
      }),
    );

    renderWithClient(<GithubStatsChip />);

    await waitFor(
      () => {
        expect(screen.getByText(/unavailable/i)).toBeTruthy();
      },
      { timeout: 5000 },
    );
  });

  it("normalizes malformed count fields from the GitHub fallback (finiteCount parity)", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      kind: "http",
      status: 503,
      message: "github_repo_stats_unavailable",
      durationMs: 50,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ stargazers_count: -1, forks_count: "not-a-number" }),
      }),
    );

    renderWithClient(<GithubStatsChip />);

    // finiteCount normalizes negative/non-number to 0 — both stars and forks render "0"
    await waitFor(
      () => {
        const zeros = screen.getAllByText("0");
        expect(zeros.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 5000 },
    );
  });
});
