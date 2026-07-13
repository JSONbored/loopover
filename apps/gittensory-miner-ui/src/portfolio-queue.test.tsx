import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  emptyPortfolioQueueSummary,
  fetchPortfolioQueue,
  PORTFOLIO_QUEUE_API_PATH,
  type PortfolioQueueResult,
  type PortfolioQueueSummary,
} from "./lib/portfolio-queue";
import { PortfolioPage, PortfolioQueueView } from "./routes/portfolio";
import { handlePortfolioQueueRequest, type PortfolioQueueApiDeps } from "../vite-portfolio-queue-api";

const fixtureSummary: PortfolioQueueSummary = {
  total: 4,
  byStatus: { queued: 2, in_progress: 1, done: 1 },
  repos: [
    { repoFullName: "acme/another-repo", byStatus: { queued: 1, in_progress: 0, done: 1 }, total: 2 },
    { repoFullName: "acme/secret-repo", byStatus: { queued: 1, in_progress: 1, done: 0 }, total: 2 },
  ],
  oldestQueuedAgeMs: 5_400_000,
};

const rawQueueRows = [
  {
    repoFullName: "private-org/secret-repo",
    identifier: "issue:12",
    priority: 5,
    status: "queued",
    enqueuedAt: "2026-07-10T06:00:00.000Z",
  },
  {
    repoFullName: "private-org/secret-repo",
    identifier: "issue:13",
    priority: 3,
    status: "in_progress",
    enqueuedAt: "2026-07-10T06:05:00.000Z",
  },
  {
    repoFullName: "private-org/another-repo",
    identifier: "issue:7",
    priority: 8,
    status: "done",
    enqueuedAt: "2026-07-10T05:00:00.000Z",
  },
  {
    repoFullName: "private-org/another-repo",
    identifier: "issue:8",
    priority: 1,
    status: "queued",
    enqueuedAt: "2026-07-10T05:30:00.000Z",
  },
];

describe("emptyPortfolioQueueSummary (#4306)", () => {
  it("summarizes an empty queue to zeros with no repos", () => {
    expect(emptyPortfolioQueueSummary()).toEqual({
      total: 0,
      byStatus: { queued: 0, in_progress: 0, done: 0 },
      repos: [],
      oldestQueuedAgeMs: null,
    });
  });
});

describe("PortfolioQueueView (#4306, per-repo detail added by #4846)", () => {
  it("renders one card per status with the aggregated global counts", () => {
    render(<PortfolioQueueView result={{ ok: true, summary: fixtureSummary }} />);
    // Scoped to <dt> since the per-repo table below also has "Queued"/"In progress"/"Done" column headers.
    expect(screen.getByText("Queued", { selector: "dt" }).nextSibling?.textContent).toBe("2");
    expect(screen.getByText("In progress", { selector: "dt" }).nextSibling?.textContent).toBe("1");
    expect(screen.getByText("Done", { selector: "dt" }).nextSibling?.textContent).toBe("1");
  });

  it("renders one table row per repo with its own status breakdown and total", () => {
    render(<PortfolioQueueView result={{ ok: true, summary: fixtureSummary }} />);
    expect(screen.getByRole("columnheader", { name: "Repository" })).toBeTruthy();
    expect(screen.getByText("acme/another-repo")).toBeTruthy();
    expect(screen.getByText("acme/secret-repo")).toBeTruthy();
    // header + 2 repo rows
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("renders the fresh-install empty state without erroring", () => {
    render(<PortfolioQueueView result={{ ok: true, summary: emptyPortfolioQueueSummary() }} />);
    expect(screen.getByText(/No queued work yet/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders an error message when the local API is unreachable", () => {
    render(<PortfolioQueueView result={{ ok: false, error: "connection refused" }} />);
    expect(screen.getByRole("alert").textContent).toContain("connection refused");
  });

  it("renders the loading state before the first result arrives", () => {
    render(<PortfolioQueueView result={null} />);
    expect(screen.getByText(/Loading local portfolio queue/i)).toBeTruthy();
  });
});

describe("PortfolioPage (#4306)", () => {
  const loadPortfolioQueueItems = async () => ({ ok: true as const, items: [] });

  it("loads the summary through the injected loader and renders the cards", async () => {
    const loadPortfolioQueue = async (): Promise<PortfolioQueueResult> => ({ ok: true, summary: fixtureSummary });
    render(<PortfolioPage loadPortfolioQueue={loadPortfolioQueue} loadPortfolioQueueItems={loadPortfolioQueueItems} />);
    expect(screen.getByRole("heading", { name: "Portfolio queue" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Queued", { selector: "dt" }).nextSibling?.textContent).toBe("2"));
  });

  describe("live refresh (#4856)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("polls the injected loader again on the configured interval, without a manual page reload", async () => {
      vi.useFakeTimers();
      const loadPortfolioQueue = vi.fn(async (): Promise<PortfolioQueueResult> => ({
        ok: true,
        summary: fixtureSummary,
      }));
      render(
        <PortfolioPage
          loadPortfolioQueue={loadPortfolioQueue}
          loadPortfolioQueueItems={loadPortfolioQueueItems}
          pollIntervalMs={1000}
        />,
      );

      await vi.waitFor(() => expect(loadPortfolioQueue).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(loadPortfolioQueue).toHaveBeenCalledTimes(2));
    });
  });
});

describe("fetchPortfolioQueue (#4306)", () => {
  const jsonResponse = (status: number, payload: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as unknown as Response;

  it("returns a typed summary from a well-formed payload, requesting the local API path", async () => {
    let requested: string | undefined;
    const result = await fetchPortfolioQueue(async (input) => {
      requested = String(input);
      return jsonResponse(200, { summary: fixtureSummary });
    });
    expect(requested).toBe(PORTFOLIO_QUEUE_API_PATH);
    expect(result).toEqual({ ok: true, summary: fixtureSummary });
  });

  it("surfaces non-2xx, malformed payloads, and thrown fetches as typed errors", async () => {
    expect(await fetchPortfolioQueue(async () => jsonResponse(500, {}))).toEqual({
      ok: false,
      error: "local portfolio-queue API responded 500",
    });
    expect(await fetchPortfolioQueue(async () => jsonResponse(200, { rows: rawQueueRows }))).toMatchObject({
      ok: false,
    });
    expect(
      await fetchPortfolioQueue(async () => jsonResponse(200, { summary: { total: 1, byStatus: { queued: "1" } } })),
    ).toMatchObject({ ok: false });
    expect(
      await fetchPortfolioQueue(async () =>
        jsonResponse(200, {
          summary: {
            total: 1,
            byStatus: { queued: 1, in_progress: 0, done: 0 },
            repos: "nope",
            oldestQueuedAgeMs: null,
          },
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await fetchPortfolioQueue(async () => {
        throw new Error("connection refused");
      }),
    ).toEqual({ ok: false, error: "connection refused" });
  });
});

// Test-local re-implementation of collectPortfolioDashboard's aggregation, used only as the fake behind
// loadPortfolioDashboardModule below. The API handler tests here exercise WIRING (does the handler call
// listQueue and pass the right sources/nowMs into the dashboard aggregator, and does it serialize whatever
// comes back without leaking raw rows) -- the aggregation algorithm's own correctness (sorting, per-repo
// grouping, oldest-queued-age math, edge cases) is exhaustively covered by
// test/unit/miner-portfolio-dashboard.test.ts. The real portfolio-dashboard.js module cannot be imported
// directly here: it transitively pulls in `node:sqlite` via portfolio-queue.js, which this app's Vite
// client/test environment cannot bundle (the same reason the real handler loads it dynamically).
function fakeCollectPortfolioDashboard(
  sources: { portfolioQueue: { listQueue: () => Array<{ repoFullName: string; status: string; enqueuedAt: string }> } },
  options: { nowMs: number },
): PortfolioQueueSummary {
  const byStatus = { queued: 0, in_progress: 0, done: 0 };
  const perRepo = new Map<string, { repoFullName: string; byStatus: typeof byStatus; total: number }>();
  let total = 0;
  let oldestQueuedMs: number | null = null;
  for (const entry of sources.portfolioQueue.listQueue()) {
    const status = entry.status as "queued" | "in_progress" | "done";
    total += 1;
    byStatus[status] += 1;
    let repo = perRepo.get(entry.repoFullName);
    if (!repo) {
      repo = { repoFullName: entry.repoFullName, byStatus: { queued: 0, in_progress: 0, done: 0 }, total: 0 };
      perRepo.set(entry.repoFullName, repo);
    }
    repo.byStatus[status] += 1;
    repo.total += 1;
    if (status === "queued") {
      const ms = Date.parse(entry.enqueuedAt);
      if (oldestQueuedMs === null || ms < oldestQueuedMs) oldestQueuedMs = ms;
    }
  }
  const repos = [...perRepo.values()].sort((a, b) => a.repoFullName.localeCompare(b.repoFullName));
  return {
    total,
    byStatus,
    repos,
    oldestQueuedAgeMs: oldestQueuedMs === null ? null : options.nowMs - oldestQueuedMs,
  };
}

describe("handlePortfolioQueueRequest (#4306, reunified with the CLI's queue dashboard by #4846)", () => {
  const rows = rawQueueRows;
  const NOW_MS = Date.parse("2026-07-10T07:00:00.000Z");

  function deps(overrides: Partial<PortfolioQueueApiDeps> = {}): PortfolioQueueApiDeps {
    return {
      loadPortfolioQueueModule: async () => ({
        resolvePortfolioQueueDbPath: () => "/home/miner/.config/gittensory-miner/portfolio-queue.sqlite3",
        listQueue: () => rows,
      }),
      loadPortfolioDashboardModule: async () => ({ collectPortfolioDashboard: fakeCollectPortfolioDashboard }),
      fileExists: () => true,
      now: () => NOW_MS,
      ...overrides,
    };
  }

  it("serves the same per-repo dashboard shape the CLI's queue dashboard computes, with repo names but no raw identifiers or priorities", async () => {
    const handled = await handlePortfolioQueueRequest("GET", "/api/portfolio-queue", deps());
    expect(handled?.status).toBe(200);
    const body = JSON.parse(handled?.body ?? "{}") as { summary: PortfolioQueueSummary };
    expect(body.summary).toEqual({
      total: 4,
      byStatus: { queued: 2, in_progress: 1, done: 1 },
      repos: [
        {
          repoFullName: "private-org/another-repo",
          byStatus: { queued: 1, in_progress: 0, done: 1 },
          total: 2,
        },
        {
          repoFullName: "private-org/secret-repo",
          byStatus: { queued: 1, in_progress: 1, done: 0 },
          total: 2,
        },
      ],
      oldestQueuedAgeMs: 5_400_000,
    });
    // Repo names ARE exposed (matching the CLI's own dashboard, which already prints them locally), but
    // per-item identifiers and rank-derived priorities never cross the wire.
    expect(handled?.body).toContain("private-org/secret-repo");
    expect(handled?.body).not.toContain("issue:12");
    expect(handled?.body).not.toContain("priority");
  });

  it("serves an empty summary on a fresh install WITHOUT initializing the store", async () => {
    let listed = false;
    const handled = await handlePortfolioQueueRequest(
      "GET",
      "/api/portfolio-queue",
      deps({
        loadPortfolioQueueModule: async () => ({
          resolvePortfolioQueueDbPath: () => "/nowhere/portfolio-queue.sqlite3",
          listQueue: () => {
            listed = true;
            return rows;
          },
        }),
        fileExists: () => false,
      }),
    );
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ summary: emptyPortfolioQueueSummary() }) });
    expect(listed).toBe(false);
  });

  it("falls through (null) for other paths and non-GET methods", async () => {
    expect(await handlePortfolioQueueRequest("GET", "/api/run-state", deps())).toBeNull();
    expect(await handlePortfolioQueueRequest("POST", "/api/portfolio-queue", deps())).toBeNull();
  });

  it("surfaces a store read failure as a 500 with a safe message", async () => {
    const handled = await handlePortfolioQueueRequest(
      "GET",
      "/api/portfolio-queue",
      deps({
        loadPortfolioQueueModule: async () => {
          throw new Error("sqlite locked");
        },
      }),
    );
    expect(handled).toEqual({ status: 500, body: JSON.stringify({ error: "sqlite locked" }) });
  });

  it("returns null oldestQueuedAgeMs when nothing is queued (only in_progress/done items present)", async () => {
    const handled = await handlePortfolioQueueRequest(
      "GET",
      "/api/portfolio-queue",
      deps({
        loadPortfolioQueueModule: async () => ({
          resolvePortfolioQueueDbPath: () => "/home/miner/.config/gittensory-miner/portfolio-queue.sqlite3",
          listQueue: () => [rows[1]!, rows[2]!], // in_progress + done only, no queued row
        }),
      }),
    );
    const body = JSON.parse(handled?.body ?? "{}") as { summary: PortfolioQueueSummary };
    expect(body.summary.oldestQueuedAgeMs).toBeNull();
  });
});
