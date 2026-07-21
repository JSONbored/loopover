import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_LEDGERS_SUMMARY,
  DEMO_PORTFOLIO_QUEUE_SUMMARY,
  DEMO_RANKED_CANDIDATES,
  DEMO_RUN_STATES,
  getDemoGovernorState,
  getDemoPortfolioQueueItems,
  isDemoMode,
  removeDemoPortfolioQueueItem,
  resetDemoDataForTest,
  setDemoGovernorPaused,
  setDemoGovernorResumed,
} from "./demo-data";

afterEach(() => {
  vi.unstubAllEnvs();
  resetDemoDataForTest();
});

describe("isDemoMode() (#5963)", () => {
  it("is false when VITE_DEMO_MODE is unset", () => {
    vi.stubEnv("VITE_DEMO_MODE", "");
    expect(isDemoMode()).toBe(false);
  });

  it("is true only for the exact string '1'", () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    expect(isDemoMode()).toBe(true);
    vi.stubEnv("VITE_DEMO_MODE", "true");
    expect(isDemoMode()).toBe(false);
  });
});

describe("demo fixtures shape (#5963)", () => {
  it("DEMO_RUN_STATES is non-empty and every row has a valid state", () => {
    expect(DEMO_RUN_STATES.length).toBeGreaterThan(0);
    for (const row of DEMO_RUN_STATES) {
      expect(["idle", "discovering", "planning", "preparing"]).toContain(row.state);
    }
  });

  it("DEMO_RANKED_CANDIDATES is non-empty and every row's scores fall in the valid 0..1 fraction range", () => {
    expect(DEMO_RANKED_CANDIDATES.length).toBeGreaterThan(0);
    for (const row of DEMO_RANKED_CANDIDATES) {
      for (const score of [row.rankScore, row.laneFit, row.freshness, row.potential, row.feasibility, row.dupRisk]) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it("DEMO_LEDGERS_SUMMARY's claim byStatus counts sum to its total", () => {
    const { total, byStatus } = DEMO_LEDGERS_SUMMARY.claims;
    expect(byStatus.active + byStatus.released + byStatus.expired).toBe(total);
  });

  it("DEMO_PORTFOLIO_QUEUE_SUMMARY's per-repo totals sum to the fleet total", () => {
    const repoSum = DEMO_PORTFOLIO_QUEUE_SUMMARY.repos.reduce((sum, r) => sum + r.total, 0);
    expect(repoSum).toBe(DEMO_PORTFOLIO_QUEUE_SUMMARY.total);
  });
});

describe("demo governor pause state (#5963)", () => {
  it("starts resumed (not paused)", () => {
    expect(getDemoGovernorState()).toEqual({ paused: false, reason: null, pausedAt: null });
  });

  it("setDemoGovernorPaused sets paused=true with the given reason and a fresh timestamp", () => {
    const state = setDemoGovernorPaused("investigating");
    expect(state.paused).toBe(true);
    expect(state.reason).toBe("investigating");
    expect(state.pausedAt).toEqual(expect.any(String));
    expect(getDemoGovernorState()).toEqual(state);
  });

  it("setDemoGovernorPaused accepts a null reason", () => {
    expect(setDemoGovernorPaused(null).reason).toBeNull();
  });

  it("setDemoGovernorResumed clears paused/reason/pausedAt", () => {
    setDemoGovernorPaused("x");
    expect(setDemoGovernorResumed()).toEqual({ paused: false, reason: null, pausedAt: null });
  });
});

describe("demo portfolio-queue items (#5963)", () => {
  it("starts with the default fixture items", () => {
    expect(getDemoPortfolioQueueItems().length).toBeGreaterThan(0);
  });

  it("its in_progress/done counts match DEMO_PORTFOLIO_QUEUE_SUMMARY both fleet-wide AND per repo (#7227)", () => {
    const items = getDemoPortfolioQueueItems();
    const count = (rows: typeof items, status: string) => rows.filter((i) => i.status === status).length;

    // Fleet-wide: the table can't disagree with the status cards above it.
    expect(count(items, "in_progress")).toBe(DEMO_PORTFOLIO_QUEUE_SUMMARY.byStatus.in_progress);
    expect(count(items, "done")).toBe(DEMO_PORTFOLIO_QUEUE_SUMMARY.byStatus.done);

    // Per repo: each repo's actionable split matches its summary byStatus (only `queued`, which an actionable
    // item can't represent, is absent) -- so the fixture is internally consistent at every level.
    for (const repo of DEMO_PORTFOLIO_QUEUE_SUMMARY.repos) {
      const rows = items.filter((i) => i.repoFullName === repo.repoFullName);
      expect(count(rows, "in_progress")).toBe(repo.byStatus.in_progress);
      expect(count(rows, "done")).toBe(repo.byStatus.done);
    }
  });

  it("references only the four synthetic demo repos, never a real repo name (#7227)", () => {
    const allowed = new Set(DEMO_PORTFOLIO_QUEUE_SUMMARY.repos.map((r) => r.repoFullName));
    for (const item of getDemoPortfolioQueueItems()) {
      expect(allowed.has(item.repoFullName)).toBe(true);
    }
  });

  it("removeDemoPortfolioQueueItem removes and returns the matching item", () => {
    const beforeCount = getDemoPortfolioQueueItems().length;
    const target = { ...getDemoPortfolioQueueItems()[0]! };
    const removed = removeDemoPortfolioQueueItem(target.repoFullName, target.identifier);
    expect(removed).toEqual(target);
    expect(getDemoPortfolioQueueItems()).toHaveLength(beforeCount - 1);
    expect(getDemoPortfolioQueueItems().find((i) => i.identifier === target.identifier)).toBeUndefined();
  });

  it("removeDemoPortfolioQueueItem returns null for an unknown item, without mutating the list", () => {
    const before = getDemoPortfolioQueueItems().length;
    expect(removeDemoPortfolioQueueItem("nope/nope", "does-not-exist")).toBeNull();
    expect(getDemoPortfolioQueueItems()).toHaveLength(before);
  });
});
