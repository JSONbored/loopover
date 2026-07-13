import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDefaultEventLedger,
  initEventLedger,
} from "../../packages/gittensory-miner/lib/event-ledger.js";
import { enqueueRankedDiscovery } from "../../packages/gittensory-miner/lib/portfolio-discovery.js";
import type { EnqueueRankedDiscoveryInput } from "../../packages/gittensory-miner/lib/portfolio-discovery.d.ts";
import {
  closeDefaultPortfolioQueueStore,
  initPortfolioQueueStore,
} from "../../packages/gittensory-miner/lib/portfolio-queue.js";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempQueueStore() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-discovery-"));
  roots.push(root);
  const store = initPortfolioQueueStore(join(root, "portfolio-queue.sqlite3"));
  stores.push(store);
  return store;
}

function tempEventLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-discovery-ledger-"));
  roots.push(root);
  const ledger = initEventLedger(join(root, "event-ledger.sqlite3"));
  stores.push(ledger);
  return ledger;
}

function rankedIssue(overrides: Partial<EnqueueRankedDiscoveryInput> = {}): EnqueueRankedDiscoveryInput {
  return {
    repoFullName: "acme/widgets",
    issueNumber: 42,
    title: "Add queue retry helper",
    labels: ["help wanted"],
    rankScore: 50,
    ...overrides,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  closeDefaultPortfolioQueueStore();
  closeDefaultEventLedger();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner portfolio discovery (#2292)", () => {
  it("returns a zero summary for empty input without touching the queue", () => {
    const queueStore = tempQueueStore();
    expect(enqueueRankedDiscovery([], { queueStore })).toEqual({
      enqueued: 0,
      skippedBelowMinRank: 0,
      skippedInvalid: 0,
      eventsAppended: 0,
    });
    expect(queueStore.listQueue()).toEqual([]);
  });

  it("enqueues ranked rows using rankScore as portfolio priority", () => {
    const queueStore = tempQueueStore();
    const summary = enqueueRankedDiscovery(
      [
        rankedIssue({ issueNumber: 1, rankScore: 10 }),
        rankedIssue({ issueNumber: 2, rankScore: 90 }),
        rankedIssue({ issueNumber: 3, rankScore: 40 }),
      ],
      { queueStore },
    );
    expect(summary).toEqual({
      enqueued: 3,
      skippedBelowMinRank: 0,
      skippedInvalid: 0,
      eventsAppended: 0,
    });
    expect(queueStore.dequeueNext()?.identifier).toBe("issue:2");
    expect(queueStore.dequeueNext()?.identifier).toBe("issue:3");
    expect(queueStore.dequeueNext()?.identifier).toBe("issue:1");
  });

  it("skips rows below minRankScore without enqueueing them", () => {
    const queueStore = tempQueueStore();
    const summary = enqueueRankedDiscovery(
      [
        rankedIssue({ issueNumber: 1, rankScore: 5 }),
        rankedIssue({ issueNumber: 2, rankScore: 25 }),
      ],
      { queueStore, minRankScore: 20 },
    );
    expect(summary).toEqual({
      enqueued: 1,
      skippedBelowMinRank: 1,
      skippedInvalid: 0,
      eventsAppended: 0,
    });
    expect(queueStore.listQueue().map((entry) => entry.identifier)).toEqual(["issue:2"]);
  });

  it("skips malformed ranked rows instead of throwing", () => {
    const queueStore = tempQueueStore();
    const summary = enqueueRankedDiscovery(
      [
        rankedIssue({ issueNumber: 1, rankScore: 30 }),
        { repoFullName: "bad", issueNumber: 2, title: "x", rankScore: 40 },
        rankedIssue({ issueNumber: 3, title: "", rankScore: 50 }),
      ] as EnqueueRankedDiscoveryInput[],
      { queueStore },
    );
    expect(summary).toEqual({
      enqueued: 1,
      skippedBelowMinRank: 0,
      skippedInvalid: 2,
      eventsAppended: 0,
    });
    expect(queueStore.listQueue()[0]?.identifier).toBe("issue:1");
  });

  it("refreshes priority for done items but leaves in_progress rows unchanged", () => {
    const queueStore = tempQueueStore();
    enqueueRankedDiscovery([rankedIssue({ issueNumber: 7, rankScore: 10 })], { queueStore });
    expect(queueStore.dequeueNext()).toMatchObject({ identifier: "issue:7", status: "in_progress", priority: 10 });

    enqueueRankedDiscovery([rankedIssue({ issueNumber: 8, rankScore: 5 })], { queueStore });
    queueStore.markDone("acme/widgets", "issue:8");

    enqueueRankedDiscovery(
      [
        rankedIssue({ issueNumber: 7, rankScore: 99 }),
        rankedIssue({ issueNumber: 8, rankScore: 88 }),
      ],
      { queueStore },
    );

    expect(queueStore.listQueue("acme/widgets").find((entry) => entry.identifier === "issue:7")).toMatchObject({
      status: "in_progress",
      priority: 10,
    });
    expect(queueStore.listQueue("acme/widgets").find((entry) => entry.identifier === "issue:8")).toMatchObject({
      status: "queued",
      priority: 88,
    });
  });

  it("appends discovered_issue audit events when an event ledger is supplied", () => {
    const queueStore = tempQueueStore();
    const eventLedger = tempEventLedger();
    const summary = enqueueRankedDiscovery([rankedIssue({ issueNumber: 12, rankScore: 33 })], {
      queueStore,
      eventLedger,
    });
    expect(summary.eventsAppended).toBe(1);
    expect(eventLedger.readEvents()).toEqual([
      expect.objectContaining({
        seq: 1,
        type: "discovered_issue",
        repoFullName: "acme/widgets",
        payload: {
          issueNumber: 12,
          rankScore: 33,
          title: "Add queue retry helper",
          labels: ["help wanted"],
        },
      }),
    ]);
  });

  it("threads options.apiBaseUrl through to every enqueued row, so a non-default host doesn't collide with github.com (#5563)", () => {
    const queueStore = tempQueueStore();
    queueStore.enqueue({ repoFullName: "acme/widgets", identifier: "issue:7", apiBaseUrl: "https://api.github.com" });
    enqueueRankedDiscovery([rankedIssue({ issueNumber: 7, rankScore: 10 })], {
      queueStore,
      apiBaseUrl: "https://ghe.example.com/api/v3",
    });
    expect(queueStore.listQueue("acme/widgets")).toHaveLength(2);
    expect(
      queueStore.listQueue("acme/widgets").find((entry) => entry.apiBaseUrl === "https://ghe.example.com/api/v3"),
    ).toMatchObject({ identifier: "issue:7", status: "queued" });
  });

  it("rejects invalid rankedIssues, queue store, event ledger, or minRankScore", () => {
    const queueStore = tempQueueStore();
    expect(() => enqueueRankedDiscovery(null as never, { queueStore })).toThrow("invalid_ranked_issues");
    expect(() => enqueueRankedDiscovery([], { queueStore: null as never })).toThrow("invalid_queue_store");
    expect(() =>
      enqueueRankedDiscovery([], { queueStore, eventLedger: null as never }),
    ).toThrow("invalid_event_ledger");
    expect(() =>
      enqueueRankedDiscovery([], { queueStore, eventLedger: {} as never }),
    ).toThrow("invalid_event_ledger");
    expect(() =>
      enqueueRankedDiscovery([], { queueStore, minRankScore: Number.NaN }),
    ).toThrow("invalid_min_rank_score");
  });
});
