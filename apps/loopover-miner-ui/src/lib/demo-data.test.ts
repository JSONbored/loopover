import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_LEDGERS_SUMMARY,
  DEMO_PORTFOLIO_QUEUE_SUMMARY,
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

  it("its actionable-item counts match DEMO_PORTFOLIO_QUEUE_SUMMARY's byStatus, so the table can't disagree with the status cards (#7227)", () => {
    const items = getDemoPortfolioQueueItems();
    const count = (status: string) => items.filter((i) => i.status === status).length;
    expect(count("in_progress")).toBe(DEMO_PORTFOLIO_QUEUE_SUMMARY.byStatus.in_progress);
    expect(count("done")).toBe(DEMO_PORTFOLIO_QUEUE_SUMMARY.byStatus.done);
    expect(items).toHaveLength(
      DEMO_PORTFOLIO_QUEUE_SUMMARY.byStatus.in_progress + DEMO_PORTFOLIO_QUEUE_SUMMARY.byStatus.done,
    );
  });

  it("references only the four synthetic demo repos, never a real repo name (#7227)", () => {
    const allowed = new Set(["acme/widgets", "acme/api-gateway", "acme/docs-site", "northwind/inventory"]);
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
