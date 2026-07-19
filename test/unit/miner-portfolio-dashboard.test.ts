import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectPortfolioDashboard,
  parsePortfolioDashboardArgs,
  renderPortfolioDashboardTable,
  runPortfolioDashboard,
} from "../../packages/loopover-miner/lib/portfolio-dashboard.js";

const mockQueue = (entries: unknown[]): { listQueue: () => unknown[]; close: () => void } => ({ listQueue: () => entries, close: () => {} });
const NOW = Date.parse("2026-07-10T00:00:00.000Z");

afterEach(() => vi.restoreAllMocks());

describe("collectPortfolioDashboard (#4287)", () => {
  it("throws when the injected portfolio queue is unusable", () => {
    expect(() => collectPortfolioDashboard({} as never)).toThrow("invalid_portfolio_queue");
  });

  it("aggregates counts by status globally and per repo, skipping unknown statuses and coercing a non-string repo", () => {
    const summary = collectPortfolioDashboard(
      {
        portfolioQueue: mockQueue([
          { repoFullName: "acme/b", status: "queued", enqueuedAt: "2026-07-03T00:00:00.000Z" },
          { repoFullName: "acme/b", status: "in_progress", enqueuedAt: "2026-07-02T00:00:00.000Z" },
          { repoFullName: "acme/a", status: "queued", enqueuedAt: "2026-07-01T00:00:00.000Z" }, // earliest
          { repoFullName: "acme/a", status: "queued", enqueuedAt: "2026-07-05T00:00:00.000Z" }, // later
          { repoFullName: "acme/a", status: "done", enqueuedAt: "2026-07-04T00:00:00.000Z" },
          { status: "queued", enqueuedAt: "not-a-date" }, // missing repo → "", malformed date skipped for oldest
          { repoFullName: 42, status: "queued", enqueuedAt: "2026-07-06T00:00:00.000Z" }, // non-string repo → ""
          { repoFullName: "acme/a", status: "bogus" }, // unknown status → skipped entirely
        ]),
      },
      { nowMs: NOW },
    );
    expect(summary.total).toBe(7);
    expect(summary.byStatus).toEqual({ queued: 5, in_progress: 1, done: 1 });
    expect(summary.repos.map((r) => r.repoFullName)).toEqual(["", "acme/a", "acme/b"]); // sorted
    expect(summary.repos.find((r) => r.repoFullName === "acme/a")).toEqual({ apiBaseUrl: "", repoFullName: "acme/a", byStatus: { queued: 2, in_progress: 0, done: 1 }, total: 3 });
    // oldest queued is acme/a's 2026-07-01 → 9 days before NOW
    expect(summary.oldestQueuedAgeMs).toBe(9 * 24 * 60 * 60 * 1000);
  });

  it("keeps two forge hosts sharing a repo name as distinct, non-merged per-repo entries (#7225)", () => {
    const summary = collectPortfolioDashboard(
      {
        portfolioQueue: mockQueue([
          { apiBaseUrl: "https://api.github.com", repoFullName: "acme/widgets", status: "queued", enqueuedAt: "2026-07-01T00:00:00.000Z" },
          { apiBaseUrl: "https://api.github.com", repoFullName: "acme/widgets", status: "queued", enqueuedAt: "2026-07-02T00:00:00.000Z" },
          { apiBaseUrl: "https://ghe.example.com/api/v3", repoFullName: "acme/widgets", status: "done", enqueuedAt: "2026-07-03T00:00:00.000Z" },
        ]),
      },
      { nowMs: NOW },
    );
    // Same repoFullName across two hosts → two entries, tie-broken by apiBaseUrl (github.com before ghe.example.com).
    expect(summary.repos).toEqual([
      { apiBaseUrl: "https://api.github.com", repoFullName: "acme/widgets", byStatus: { queued: 2, in_progress: 0, done: 0 }, total: 2 },
      { apiBaseUrl: "https://ghe.example.com/api/v3", repoFullName: "acme/widgets", byStatus: { queued: 0, in_progress: 0, done: 1 }, total: 1 },
    ]);
    // The two hosts' backlogs stay independent instead of collapsing into one { queued: 2, done: 1, total: 3 } entry.
    expect(summary.total).toBe(3);
  });

  it("reports a null oldest-queued age when no clock is supplied, and when nothing is queued", () => {
    const entries = [{ repoFullName: "a/b", status: "queued", enqueuedAt: "2026-07-01T00:00:00.000Z" }];
    expect(collectPortfolioDashboard({ portfolioQueue: mockQueue(entries) }).oldestQueuedAgeMs).toBeNull(); // no nowMs
    expect(
      collectPortfolioDashboard({ portfolioQueue: mockQueue([{ repoFullName: "a/b", status: "done", enqueuedAt: "x" }]) }, { nowMs: NOW }).oldestQueuedAgeMs,
    ).toBeNull(); // nothing queued
  });
});

describe("renderPortfolioDashboardTable (#4287)", () => {
  it("renders the empty message for an empty (or missing) summary", () => {
    expect(renderPortfolioDashboardTable({ total: 0, byStatus: { queued: 0, in_progress: 0, done: 0 }, repos: [], oldestQueuedAgeMs: null })).toBe("portfolio queue is empty");
    expect(renderPortfolioDashboardTable(null)).toBe("portfolio queue is empty");
  });

  it("renders totals, per-repo rows, and the oldest-queued age when present", () => {
    const withAge = renderPortfolioDashboardTable({ total: 2, byStatus: { queued: 2, in_progress: 0, done: 0 }, repos: [{ apiBaseUrl: "https://api.github.com", repoFullName: "acme/a", byStatus: { queued: 2, in_progress: 0, done: 0 }, total: 2 }], oldestQueuedAgeMs: 3_600_000 });
    expect(withAge).toContain("total: 2");
    expect(withAge).toContain("oldest-queued: 60m");
    expect(withAge).toContain("acme/a");
    const noAge = renderPortfolioDashboardTable({ total: 1, byStatus: { queued: 0, in_progress: 1, done: 0 }, repos: [{ apiBaseUrl: "https://api.github.com", repoFullName: "acme/a", byStatus: { queued: 0, in_progress: 1, done: 0 }, total: 1 }], oldestQueuedAgeMs: null });
    expect(noAge).not.toContain("oldest-queued");
  });

  it("shows a host column so two same-named repos on different forge hosts are distinguishable (#7225)", () => {
    const table = renderPortfolioDashboardTable({
      total: 2,
      byStatus: { queued: 2, in_progress: 0, done: 0 },
      repos: [
        { apiBaseUrl: "https://api.github.com", repoFullName: "acme/widgets", byStatus: { queued: 1, in_progress: 0, done: 0 }, total: 1 },
        { apiBaseUrl: "https://ghe.example.com/api/v3", repoFullName: "acme/widgets", byStatus: { queued: 1, in_progress: 0, done: 0 }, total: 1 },
      ],
      oldestQueuedAgeMs: null,
    });
    expect(table).toContain("host");
    expect(table).toContain("https://api.github.com");
    expect(table).toContain("https://ghe.example.com/api/v3");
  });
});

describe("parsePortfolioDashboardArgs (#4287)", () => {
  it("accepts --json, rejects unknown options and stray positionals", () => {
    expect(parsePortfolioDashboardArgs([])).toEqual({ json: false });
    expect(parsePortfolioDashboardArgs(["--json"])).toEqual({ json: true });
    expect(parsePortfolioDashboardArgs(["--nope"])).toEqual({ error: expect.stringContaining("Unknown option") });
    expect(parsePortfolioDashboardArgs(["extra"])).toEqual({ error: expect.stringContaining("Usage: loopover-miner queue dashboard") });
  });
});

describe("runPortfolioDashboard (#4287)", () => {
  it("prints a table (and --json) from the injected store, and errors on a bad arg", () => {
    const store = mockQueue([{ repoFullName: "acme/a", status: "queued", enqueuedAt: "2026-07-09T00:00:00.000Z" }]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runPortfolioDashboard([], { initPortfolioQueue: () => store, nowMs: NOW })).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("acme/a");
    log.mockClear();
    expect(runPortfolioDashboard(["--json"], { initPortfolioQueue: () => store, nowMs: NOW })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).total).toBe(1);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runPortfolioDashboard(["--bad"], { initPortfolioQueue: () => store })).toBe(2);
    expect(String(err.mock.calls[0]?.[0])).toContain("Unknown option");
    log.mockClear();
    err.mockClear();
    expect(runPortfolioDashboard(["--bad", "--json"], { initPortfolioQueue: () => store })).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: expect.stringContaining("Unknown option"),
    });
    expect(err).not.toHaveBeenCalled();
  });
});
