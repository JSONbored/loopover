import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildAttemptGovernorContext } from "../../packages/gittensory-miner/lib/attempt-input-builder.js";
import { initPortfolioQueueStore } from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import {
  DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS,
  classifyPortfolioConvergence,
} from "../../packages/gittensory-engine/src/portfolio/non-convergence";

// #5654: real per-issue attempt history on the portfolio queue, feeding the Governor's non-convergence detector.
const REPO = "owner/repo";
const ID = "issue:42";
const memStore = () => initPortfolioQueueStore(":memory:");

/** A pre-#5654 on-disk store: the v3 table shape (post api_base_url rebuild) stamped at schema version 3, so
 *  re-opening runs exactly the 3->4 attempt-history migration. `withColumns` seeds an already-migrated file to
 *  exercise the migration's defensive "column already present" branch. */
function seedV3File(withColumns: boolean, seed?: { attempts: number; consecutive: number; reenqueues: number; status: string }) {
  const file = join(mkdtempSync(join(tmpdir(), "pq-attempt-")), "portfolio-queue.sqlite3");
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE miner_portfolio_queue (
    api_base_url TEXT NOT NULL, repo_full_name TEXT NOT NULL, identifier TEXT NOT NULL,
    priority REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_progress', 'done')),
    enqueued_at TEXT NOT NULL, leased_at TEXT${
      withColumns
        ? ",\n    attempts INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0, reenqueues INTEGER NOT NULL DEFAULT 0"
        : ""
    },
    PRIMARY KEY (api_base_url, repo_full_name, identifier))`);
  raw.exec("PRAGMA user_version = 3");
  const cols = withColumns
    ? "(api_base_url,repo_full_name,identifier,priority,status,enqueued_at,attempts,consecutive_failures,reenqueues)"
    : "(api_base_url,repo_full_name,identifier,priority,status,enqueued_at)";
  const vals = withColumns ? "?,?,?,0,?,?,?,?,?" : "?,?,?,0,?,?";
  const args = withColumns
    ? ["https://api.github.com", REPO, ID, seed!.status, "2026-01-01T00:00:00Z", seed!.attempts, seed!.consecutive, seed!.reenqueues]
    : ["https://api.github.com", REPO, ID, seed?.status ?? "queued", "2026-01-01T00:00:00Z"];
  raw.prepare(`INSERT INTO miner_portfolio_queue ${cols} VALUES (${vals})`).run(...args);
  raw.close();
  return file;
}

describe("portfolio-queue attempt-history migration (#5654)", () => {
  it("adds the attempt-history columns to a pre-existing store that lacks them; old rows read fresh-zero", () => {
    const store = initPortfolioQueueStore(seedV3File(false, { attempts: 0, consecutive: 0, reenqueues: 0, status: "done" }));
    expect(store.getAttemptHistory(REPO, ID, "https://api.github.com")).toEqual({
      attempts: 0,
      consecutiveFailures: 0,
      reenqueues: 0,
      reachedDone: true,
    });
    store.close();
  });

  it("is defensive: a store already carrying the columns is not re-altered, and its values survive", () => {
    const store = initPortfolioQueueStore(seedV3File(true, { attempts: 5, consecutive: 1, reenqueues: 2, status: "queued" }));
    expect(store.getAttemptHistory(REPO, ID, "https://api.github.com")).toEqual({
      attempts: 5,
      consecutiveFailures: 1,
      reenqueues: 2,
      reachedDone: false,
    });
    store.close();
  });
});

describe("portfolio-queue attempt-history counters (#5654)", () => {
  it("counts attempts on claim, re-enqueues + consecutive failures on failure, and resets consecutive on done", () => {
    const store = memStore();
    store.enqueue({ repoFullName: REPO, identifier: ID });
    expect(store.getAttemptHistory(REPO, ID)).toEqual({ attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false });

    store.dequeueNext();
    store.markFailed(REPO, ID);
    expect(store.getAttemptHistory(REPO, ID)).toEqual({ attempts: 1, consecutiveFailures: 1, reenqueues: 1, reachedDone: false });

    store.dequeueNext();
    store.markFailed(REPO, ID);
    expect(store.getAttemptHistory(REPO, ID)).toEqual({ attempts: 2, consecutiveFailures: 2, reenqueues: 2, reachedDone: false });

    store.dequeueNext();
    store.markDone(REPO, ID);
    // consecutive failures reset, but the lifetime attempts/reenqueues totals survive the done.
    expect(store.getAttemptHistory(REPO, ID)).toEqual({ attempts: 3, consecutiveFailures: 0, reenqueues: 2, reachedDone: true });
    store.close();
  });

  it("counts a batch claim as an attempt", () => {
    const store = memStore();
    store.enqueue({ repoFullName: REPO, identifier: ID });
    store.batchClaim((entries) => entries);
    expect(store.getAttemptHistory(REPO, ID).attempts).toBe(1);
    store.close();
  });

  it("treats the stuck-lease reclaim sweep as a re-enqueue + consecutive failure", () => {
    const store = memStore();
    store.enqueue({ repoFullName: REPO, identifier: ID });
    store.dequeueNext();
    store.reclaimStuckItem(REPO, ID);
    expect(store.getAttemptHistory(REPO, ID)).toEqual({ attempts: 1, consecutiveFailures: 1, reenqueues: 1, reachedDone: false });
    store.close();
  });

  it("does NOT count requeueItem (a completed done row re-run) as a re-enqueue or failure", () => {
    const store = memStore();
    store.enqueue({ repoFullName: REPO, identifier: ID });
    store.dequeueNext();
    store.markDone(REPO, ID);
    store.requeueItem(REPO, ID);
    expect(store.getAttemptHistory(REPO, ID)).toEqual({ attempts: 1, consecutiveFailures: 0, reenqueues: 0, reachedDone: false });
    store.close();
  });

  it("reads an unknown (never-enqueued) item as a fresh, never-attempted item", () => {
    const store = memStore();
    expect(store.getAttemptHistory("no/thing", "issue:1")).toEqual({ attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false });
    store.close();
  });

  it("only ever reports reachedDone from a real 'done' status, never fabricated", () => {
    const store = memStore();
    store.enqueue({ repoFullName: REPO, identifier: ID });
    expect(store.getAttemptHistory(REPO, ID).reachedDone).toBe(false); // queued
    store.dequeueNext();
    expect(store.getAttemptHistory(REPO, ID).reachedDone).toBe(false); // in_progress
    store.markDone(REPO, ID);
    expect(store.getAttemptHistory(REPO, ID).reachedDone).toBe(true); // done
    store.close();
  });
});

describe("portfolio-queue attempt-history feeds the non-convergence detector (#5654)", () => {
  it("REGRESSION: a repeatedly re-enqueued item that never reaches done now classifies as non_convergent", () => {
    const store = memStore();
    store.enqueue({ repoFullName: REPO, identifier: ID });
    for (let i = 0; i < DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS.maxReenqueues; i++) {
      store.dequeueNext();
      store.markFailed(REPO, ID);
    }
    const history = store.getAttemptHistory(REPO, ID);
    const verdict = classifyPortfolioConvergence(history, DEFAULT_PORTFOLIO_CONVERGENCE_THRESHOLDS);
    expect(verdict.status).toBe("non_convergent");
    store.close();
  });

  it("a fresh single attempt still classifies as converging (fail-open, not a stuck loop)", () => {
    const store = memStore();
    store.enqueue({ repoFullName: REPO, identifier: ID });
    store.dequeueNext();
    expect(classifyPortfolioConvergence(store.getAttemptHistory(REPO, ID)).status).toBe("converging");
    store.close();
  });
});

describe("buildAttemptGovernorContext convergenceInput (#5654)", () => {
  const env = {} as Record<string, string | undefined>;
  const amsPolicySpec = { capLimits: { budget: 1 } } as never;

  it("forwards a real convergenceInput the caller resolved from the portfolio queue", () => {
    const real = { attempts: 5, consecutiveFailures: 2, reenqueues: 4, reachedDone: false };
    expect(buildAttemptGovernorContext(env, amsPolicySpec, false, real).convergenceInput).toEqual(real);
  });

  it("defaults to a fresh, never-attempted item when the caller passes none (fail-open)", () => {
    expect(buildAttemptGovernorContext(env, amsPolicySpec, false).convergenceInput).toEqual({
      attempts: 0,
      consecutiveFailures: 0,
      reenqueues: 0,
      reachedDone: false,
    });
  });
});
