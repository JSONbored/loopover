import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDefaultPortfolioQueueStore,
  initPortfolioQueueStore,
} from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import {
  parseQueueDoneArgs,
  parseQueueListArgs,
  parseQueueNextArgs,
  parseQueueReleaseArgs,
  parseQueueRequeueArgs,
  renderQueueTable,
  runQueueCli,
  runQueueDone,
  runQueueList,
  runQueueNext,
  runQueueRelease,
  runQueueRequeue,
} from "../../packages/gittensory-miner/lib/portfolio-queue-cli.js";
import type { PortfolioQueueStore, QueueEntry } from "../../packages/gittensory-miner/lib/portfolio-queue.d.ts";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempQueueStore() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-queue-cli-"));
  roots.push(root);
  const store = initPortfolioQueueStore(join(root, "portfolio-queue.sqlite3"));
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  closeDefaultPortfolioQueueStore();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner portfolio queue CLI (#2292)", () => {
  it("parseQueueListArgs, parseQueueNextArgs, and parseQueueDoneArgs validate argv", () => {
    expect(parseQueueListArgs([])).toEqual({ json: false, repoFullName: null });
    expect(parseQueueListArgs(["--repo", "acme/widgets", "--json"])).toEqual({
      json: true,
      repoFullName: "acme/widgets",
    });
    expect(parseQueueNextArgs(["--json"])).toEqual({ json: true, dryRun: false });
    expect(parseQueueDoneArgs(["acme/widgets", "issue:42", "--json"])).toEqual({
      repoFullName: "acme/widgets",
      identifier: "issue:42",
      dryRun: false,
      json: true,
    });
    expect(parseQueueDoneArgs(["acme/widgets"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner queue done"),
    });
  });

  it("renderQueueTable formats numeric priority and empty output", () => {
    const entries: QueueEntry[] = [
      {
        repoFullName: "acme/widgets",
        identifier: "issue:7",
        status: "queued",
        priority: 42,
        enqueuedAt: "2026-07-04T12:00:00.000Z",
      },
    ];
    expect(renderQueueTable([])).toBe("no portfolio queue entries");
    expect(renderQueueTable(entries)).toContain("    42");
    expect(renderQueueTable(entries)).toContain("issue:7");
  });

  it("runQueueList prints table and JSON output", () => {
    const portfolioQueue = tempQueueStore();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue:1", priority: 10 });
    portfolioQueue.enqueue({ repoFullName: "acme/other", identifier: "issue:2", priority: 5 });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runQueueList([], {
        initPortfolioQueue: () => portfolioQueue,
      }),
    ).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("acme/widgets");

    log.mockClear();
    expect(
      runQueueList(["--repo", "acme/other", "--json"], {
        initPortfolioQueue: () => portfolioQueue,
      }),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      entries: [expect.objectContaining({ identifier: "issue:2", repoFullName: "acme/other" })],
    });
  });

  // Inject the operator's configured WIP cap (`maxConcurrentClaims`) so `queue next`'s caps-aware claim (#4850) is
  // exercised deterministically without a real `.gittensory-miner.yml` on disk.
  const nextOptions = (store: PortfolioQueueStore, maxConcurrentClaims: number) => ({
    initPortfolioQueue: () => store,
    resolveMinerGoalSpec: () => ({ spec: { maxConcurrentClaims } }),
  });

  it("runQueueNext claims the highest-priority queued item (within the WIP cap)", () => {
    const portfolioQueue = tempQueueStore();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue:1", priority: 10 });
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue:2", priority: 90 });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // A cap of 3 leaves room for both claims plus the empty follow-up, so the sequential behavior is unchanged.
    expect(runQueueNext([], nextOptions(portfolioQueue, 3))).toBe(0);
    expect(log).toHaveBeenCalledWith("issue:2");

    log.mockClear();
    expect(runQueueNext(["--json"], nextOptions(portfolioQueue, 3))).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      entry: expect.objectContaining({ identifier: "issue:1", status: "in_progress" }),
    });

    log.mockClear();
    expect(runQueueNext([], nextOptions(portfolioQueue, 3))).toBe(0);
    expect(log).toHaveBeenCalledWith("none");
  });

  it("#4850: runQueueNext stops claiming once the configured WIP cap is reached", () => {
    const portfolioQueue = tempQueueStore();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue:1", priority: 10 });
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue:2", priority: 90 });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Cap of 1: the first call claims the highest-priority item, the second stops (one item already in flight).
    expect(runQueueNext([], nextOptions(portfolioQueue, 1))).toBe(0);
    expect(log).toHaveBeenCalledWith("issue:2");

    log.mockClear();
    expect(runQueueNext([], nextOptions(portfolioQueue, 1))).toBe(0);
    expect(log).toHaveBeenCalledWith("none");
  });

  it("#4847: --dry-run reports what next/done would do and returns 0 without opening the portfolio queue", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const initPortfolioQueueSpy = vi.fn();

    expect(runQueueNext(["--dry-run", "--json"], { initPortfolioQueue: initPortfolioQueueSpy })).toBe(0);
    expect(initPortfolioQueueSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ outcome: "dry_run" });

    log.mockClear();
    expect(runQueueNext(["--dry-run"], { initPortfolioQueue: initPortfolioQueueSpy })).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("DRY RUN: would claim the next eligible queued item");

    log.mockClear();
    expect(
      runQueueDone(["acme/widgets", "issue:9", "--dry-run", "--json"], { initPortfolioQueue: initPortfolioQueueSpy }),
    ).toBe(0);
    expect(initPortfolioQueueSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      outcome: "dry_run",
      repoFullName: "acme/widgets",
      identifier: "issue:9",
    });

    log.mockClear();
    expect(runQueueDone(["acme/widgets", "issue:9", "--dry-run"], { initPortfolioQueue: initPortfolioQueueSpy })).toBe(
      0,
    );
    expect(String(log.mock.calls[0]?.[0])).toContain("DRY RUN: would mark acme/widgets issue:9 done");
  });

  it("runQueueDone marks an item done and rejects missing entries", () => {
    const portfolioQueue = tempQueueStore();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue:9", priority: 1 });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runQueueDone(["acme/widgets", "issue:9"], {
        initPortfolioQueue: () => portfolioQueue,
      }),
    ).toBe(0);
    expect(log).toHaveBeenCalledWith("done");

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      runQueueDone(["acme/widgets", "issue:404"], {
        initPortfolioQueue: () => portfolioQueue,
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("queue_entry_not_found");
    error.mockClear();
    log.mockClear();
    expect(
      runQueueDone(["acme/widgets", "issue:404", "--json"], {
        initPortfolioQueue: () => portfolioQueue,
      }),
    ).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "queue_entry_not_found",
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("runQueueCli dispatches list, next, and done subcommands", () => {
    const portfolioQueue = tempQueueStore();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue:3", priority: 1 });
    const options = { initPortfolioQueue: () => portfolioQueue };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runQueueCli("list", ["--json"], options)).toBe(0);
    expect(runQueueCli("next", [], options)).toBe(0);
    expect(runQueueCli("done", ["acme/widgets", "issue:3"], options)).toBe(0);
    expect(log).toHaveBeenCalled();
  });

  it("rejects unknown queue subcommands and options", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runQueueCli("peek", [])).toBe(2);
    expect(runQueueList(["--verbose"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown queue subcommand");
    error.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runQueueCli("peek", ["--json"])).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: expect.stringContaining("Unknown queue subcommand"),
    });
    expect(error).not.toHaveBeenCalled();
  });

  describe("release / requeue escape hatch (#4828)", () => {
    it("parseQueueReleaseArgs and parseQueueRequeueArgs validate argv with their own usage", () => {
      expect(parseQueueReleaseArgs(["acme/widgets", "issue:1"])).toEqual({
        repoFullName: "acme/widgets",
        identifier: "issue:1",
        dryRun: false,
        json: false,
      });
      expect(parseQueueRequeueArgs(["acme/widgets", "issue:1", "--json"])).toEqual({
        repoFullName: "acme/widgets",
        identifier: "issue:1",
        dryRun: false,
        json: true,
      });
      // Wrong positional count surfaces the command-specific usage string.
      expect(parseQueueReleaseArgs(["only-one"])).toEqual({ error: expect.stringContaining("queue release") });
      expect(parseQueueRequeueArgs([])).toEqual({ error: expect.stringContaining("queue requeue") });
    });

    it("#4847: --dry-run reports what release/requeue would do and returns 0 without opening the portfolio queue", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const initPortfolioQueueSpy = vi.fn();

      expect(
        runQueueRelease(["acme/widgets", "issue:7", "--dry-run", "--json"], {
          initPortfolioQueue: initPortfolioQueueSpy,
        }),
      ).toBe(0);
      expect(initPortfolioQueueSpy).not.toHaveBeenCalled();
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        outcome: "dry_run",
        repoFullName: "acme/widgets",
        identifier: "issue:7",
      });

      log.mockClear();
      expect(
        runQueueRelease(["acme/widgets", "issue:7", "--dry-run"], { initPortfolioQueue: initPortfolioQueueSpy }),
      ).toBe(0);
      expect(initPortfolioQueueSpy).not.toHaveBeenCalled();
      expect(String(log.mock.calls[0]?.[0])).toContain(
        "DRY RUN: would release acme/widgets issue:7 back to the queue",
      );

      log.mockClear();
      expect(
        runQueueRequeue(["acme/widgets", "issue:9", "--dry-run"], { initPortfolioQueue: initPortfolioQueueSpy }),
      ).toBe(0);
      expect(initPortfolioQueueSpy).not.toHaveBeenCalled();
      expect(String(log.mock.calls[0]?.[0])).toContain("DRY RUN: would requeue acme/widgets issue:9");

      log.mockClear();
      expect(
        runQueueRequeue(["acme/widgets", "issue:9", "--dry-run", "--json"], {
          initPortfolioQueue: initPortfolioQueueSpy,
        }),
      ).toBe(0);
      expect(initPortfolioQueueSpy).not.toHaveBeenCalled();
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        outcome: "dry_run",
        repoFullName: "acme/widgets",
        identifier: "issue:9",
      });
    });

    it("release returns a CLAIMED (in-progress) item to the queue", () => {
      const portfolioQueue = tempQueueStore();
      portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue:7", priority: 1 });
      portfolioQueue.dequeueNext(); // claim it → in_progress
      const options = { initPortfolioQueue: () => portfolioQueue };
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      expect(runQueueRelease(["acme/widgets", "issue:7"], options)).toBe(0);
      expect(log).toHaveBeenCalledWith("queued");
      expect(portfolioQueue.listQueue("acme/widgets")[0]?.status).toBe("queued");
    });

    it("release emits the full entry as JSON under --json", () => {
      const portfolioQueue = tempQueueStore();
      portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue:7b", priority: 2 });
      portfolioQueue.dequeueNext(); // → in_progress
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      expect(
        runQueueRelease(["acme/widgets", "issue:7b", "--json"], { initPortfolioQueue: () => portfolioQueue }),
      ).toBe(0);
      const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(printed.entry).toMatchObject({ identifier: "issue:7b", status: "queued" });
    });

    it("release exits 2 when the item is not in-progress (nothing to release)", () => {
      const portfolioQueue = tempQueueStore();
      portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue:8", priority: 1 }); // still 'queued'
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      expect(runQueueRelease(["acme/widgets", "issue:8"], { initPortfolioQueue: () => portfolioQueue })).toBe(2);
      expect(error).toHaveBeenCalledWith("queue_entry_not_in_progress");
      error.mockClear();
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(
        runQueueRelease(["acme/widgets", "issue:8", "--json"], { initPortfolioQueue: () => portfolioQueue }),
      ).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        error: "queue_entry_not_in_progress",
      });
    });

    it("requeue puts a COMPLETED (done) item back on the queue, keeping its position", () => {
      const portfolioQueue = tempQueueStore();
      portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue:9", priority: 5 });
      portfolioQueue.markDone("acme/widgets", "issue:9"); // → done
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      expect(
        runQueueRequeue(["acme/widgets", "issue:9", "--json"], { initPortfolioQueue: () => portfolioQueue }),
      ).toBe(0);
      const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(printed.entry).toMatchObject({ repoFullName: "acme/widgets", identifier: "issue:9", status: "queued", priority: 5 });
      expect(portfolioQueue.listQueue("acme/widgets")[0]?.status).toBe("queued");
    });

    it("requeue exits 2 when the item is not a completed entry (already queued / in-flight / absent)", () => {
      const portfolioQueue = tempQueueStore();
      portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue:10", priority: 1 }); // 'queued'
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      expect(runQueueRequeue(["acme/widgets", "issue:10"], { initPortfolioQueue: () => portfolioQueue })).toBe(2);
      expect(error).toHaveBeenCalledWith("queue_entry_not_requeuable");
      // Absent item too.
      expect(runQueueRequeue(["acme/widgets", "issue:404"], { initPortfolioQueue: () => portfolioQueue })).toBe(2);
      error.mockClear();
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(
        runQueueRequeue(["acme/widgets", "issue:10", "--json"], { initPortfolioQueue: () => portfolioQueue }),
      ).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        error: "queue_entry_not_requeuable",
      });
    });

    it("the shared parser rejects a bad option, a malformed repo, and an empty identifier", () => {
      expect(parseQueueReleaseArgs(["--bad"])).toEqual({ error: expect.stringContaining("Unknown option") });
      expect(parseQueueRequeueArgs(["notarepo", "issue:1"])).toEqual({
        error: "Repository must be in owner/repo form.",
      });
      expect(parseQueueReleaseArgs(["acme/widgets", "   "])).toEqual({ error: expect.stringContaining("queue release") });
    });

    it("release and requeue each surface a parse error before touching the store", () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(runQueueRelease(["only-one"], {})).toBe(2);
      expect(String(error.mock.calls[0]?.[0])).toContain("queue release");
      expect(runQueueRequeue(["only-one"], {})).toBe(2);
      expect(String(error.mock.calls[1]?.[0])).toContain("queue requeue");
    });

    it("release and requeue fail-safe (exit 2) when the store throws", () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const throwingStore = {
        reclaimStuckItem() {
          throw new Error("db_locked");
        },
        requeueItem() {
          throw new Error("db_locked");
        },
      } as unknown as ReturnType<typeof initPortfolioQueueStore>;
      expect(runQueueRelease(["acme/widgets", "issue:1"], { initPortfolioQueue: () => throwingStore })).toBe(2);
      expect(runQueueRequeue(["acme/widgets", "issue:1"], { initPortfolioQueue: () => throwingStore })).toBe(2);
      expect(error).toHaveBeenCalledWith("db_locked");
      error.mockClear();
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(
        runQueueRelease(["acme/widgets", "issue:1", "--json"], { initPortfolioQueue: () => throwingStore }),
      ).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        error: "db_locked",
      });

      // A thrown non-Error is stringified rather than crashing (the String(error) fallback branch).
      const throwingNonError = {
        reclaimStuckItem() {
          throw "raw_string_fault";
        },
        requeueItem() {
          throw "raw_string_fault";
        },
      } as unknown as ReturnType<typeof initPortfolioQueueStore>;
      expect(runQueueRelease(["acme/widgets", "issue:1"], { initPortfolioQueue: () => throwingNonError })).toBe(2);
      expect(runQueueRequeue(["acme/widgets", "issue:1"], { initPortfolioQueue: () => throwingNonError })).toBe(2);
      expect(error).toHaveBeenCalledWith("raw_string_fault");
    });

    it("runQueueCli dispatches release and requeue", () => {
      const portfolioQueue = tempQueueStore();
      portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue:11", priority: 1 });
      portfolioQueue.dequeueNext(); // in_progress
      const options = { initPortfolioQueue: () => portfolioQueue };
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      expect(runQueueCli("release", ["acme/widgets", "issue:11"], options)).toBe(0);
      expect(portfolioQueue.listQueue("acme/widgets")[0]?.status).toBe("queued");

      portfolioQueue.markDone("acme/widgets", "issue:11");
      expect(runQueueCli("requeue", ["acme/widgets", "issue:11"], options)).toBe(0);
      expect(portfolioQueue.listQueue("acme/widgets")[0]?.status).toBe("queued");
    });
  });
});
