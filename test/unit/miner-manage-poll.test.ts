import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDefaultEventLedger,
  initEventLedger,
} from "../../packages/loopover-miner/lib/event-ledger.js";
import {
  MANAGE_PR_UPDATE_EVENT,
  collectManageStatus,
} from "../../packages/loopover-miner/lib/manage-status.js";
import {
  buildManagePollEventPayload,
  mapPollConclusionToGateVerdict,
  mapPollConclusionToOutcome,
  parseManagePollArgs,
  recordManagePollSnapshot,
  runManagePoll,
} from "../../packages/loopover-miner/lib/manage-poll.js";
import type { PollCheckRunsResult } from "../../packages/loopover-miner/lib/ci-poller.d.ts";
import {
  closeDefaultPortfolioQueueStore,
  initPortfolioQueueStore,
} from "../../packages/loopover-miner/lib/portfolio-queue.js";
import { DEFAULT_FORGE_CONFIG } from "../../packages/loopover-miner/lib/forge-config.js";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempStores() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-manage-poll-"));
  roots.push(root);
  const portfolioQueue = initPortfolioQueueStore(join(root, "portfolio-queue.sqlite3"));
  const eventLedger = initEventLedger(join(root, "event-ledger.sqlite3"));
  stores.push(portfolioQueue, eventLedger);
  return { portfolioQueue, eventLedger };
}

function pollResult(conclusion: PollCheckRunsResult["conclusion"]): PollCheckRunsResult {
  return {
    conclusion,
    checks: [],
    headSha: "abc123",
    attempts: 1,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  closeDefaultPortfolioQueueStore();
  closeDefaultEventLedger();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loopover-miner manage poll (#2323/#2325)", () => {
  it("parseManagePollArgs validates argv", () => {
    expect(parseManagePollArgs([])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner manage poll"),
    });
    expect(parseManagePollArgs(["acme/widgets", "42", "--branch", "feat/x", "--json"])).toEqual({
      repoFullName: "acme/widgets",
      prNumber: 42,
      branch: "feat/x",
      dryRun: false,
      json: true,
    });
    expect(parseManagePollArgs(["acme/widgets", "0"])).toEqual({
      error: "Pull request number must be a positive integer.",
    });
  });

  it("maps poll conclusions to manage snapshot fields", () => {
    expect(mapPollConclusionToGateVerdict("success")).toBe("pass");
    expect(mapPollConclusionToGateVerdict("failure")).toBe("block");
    expect(mapPollConclusionToGateVerdict("pending")).toBe("advisory");
    expect(mapPollConclusionToOutcome("success")).toBe("ready");
    expect(mapPollConclusionToOutcome("failure")).toBe("needs-work");
    expect(mapPollConclusionToOutcome("neutral")).toBe("open");
    expect(
      buildManagePollEventPayload(7, pollResult("success"), {
        branch: "feat/x",
        lastPolledAt: "2026-07-04T12:00:00.000Z",
      }),
    ).toEqual({
      prNumber: 7,
      branch: "feat/x",
      ciState: "success",
      gateVerdict: "pass",
      outcome: "ready",
      lastPolledAt: "2026-07-04T12:00:00.000Z",
    });
  });

  it("recordManagePollSnapshot rejects malformed input and dependency seams", async () => {
    const { eventLedger, portfolioQueue } = tempStores();
    await expect(recordManagePollSnapshot(null as never, { eventLedger })).rejects.toThrow(
      "invalid_manage_poll_input",
    );
    await expect(
      recordManagePollSnapshot({ repoFullName: "acme", prNumber: 1 }, { eventLedger }),
    ).rejects.toThrow("invalid_repo_full_name");
    await expect(
      recordManagePollSnapshot({ repoFullName: "acme/widgets", prNumber: 0 }, { eventLedger }),
    ).rejects.toThrow("invalid_pr_number");
    await expect(
      recordManagePollSnapshot(
        { repoFullName: "acme/widgets", prNumber: 1 },
        { eventLedger: {} as never },
      ),
    ).rejects.toThrow("invalid_event_ledger");
    await expect(
      recordManagePollSnapshot(
        { repoFullName: "acme/widgets", prNumber: 1 },
        { eventLedger, portfolioQueue: {} as never },
      ),
    ).rejects.toThrow("invalid_portfolio_queue");
    // Keep a live queue reference so afterEach cleanup still closes a real store.
    expect(portfolioQueue.listQueue("acme/widgets")).toEqual([]);
  });

  it("recordManagePollSnapshot appends manage_pr_update and ensures a portfolio row", async () => {
    const { portfolioQueue, eventLedger } = tempStores();
    const pollCheckRuns = vi.fn().mockResolvedValue(pollResult("failure"));

    const result = await recordManagePollSnapshot(
      { repoFullName: "acme/widgets", prNumber: 12, branch: "fix/ci" },
      {
        eventLedger,
        portfolioQueue,
        pollCheckRuns,
        githubToken: "token",
        lastPolledAt: "2026-07-04T12:05:00.000Z",
      },
    );

    expect(pollCheckRuns).toHaveBeenCalledWith("acme/widgets", 12, expect.objectContaining({ githubToken: "token" }));
    expect(result.payload).toEqual({
      prNumber: 12,
      branch: "fix/ci",
      ciState: "failure",
      gateVerdict: "block",
      outcome: "needs-work",
      lastPolledAt: "2026-07-04T12:05:00.000Z",
    });
    expect(eventLedger.readEvents()).toEqual([
      expect.objectContaining({
        type: MANAGE_PR_UPDATE_EVENT,
        repoFullName: "acme/widgets",
        payload: result.payload,
      }),
    ]);
    expect(portfolioQueue.listQueue("acme/widgets")).toEqual([
      expect.objectContaining({ identifier: "pr:12", status: "queued", priority: 0 }),
    ]);
    expect(collectManageStatus({ portfolioQueue, eventLedger })).toEqual([
      expect.objectContaining({
        repoFullName: "acme/widgets",
        prNumber: 12,
        ciState: "failure",
        gateVerdict: "block",
        outcome: "needs-work",
        queueStatus: "queued",
      }),
    ]);
  });

  it("REGRESSION: scopes the managed-PR queue row to the polled forge host instead of silently defaulting to github.com (#6764)", async () => {
    const { portfolioQueue, eventLedger } = tempStores();
    const apiBaseUrl = "https://ghe.acme.example/api/v3";
    const pollCheckRuns = vi.fn().mockResolvedValue(pollResult("success"));

    await recordManagePollSnapshot(
      { repoFullName: "acme/widgets", prNumber: 12, branch: "fix/ci" },
      { eventLedger, portfolioQueue, pollCheckRuns, githubToken: "token", apiBaseUrl },
    );

    // The CI poll is already host-scoped two lines away; the queue row it ensures must match it.
    expect(pollCheckRuns).toHaveBeenCalledWith("acme/widgets", 12, expect.objectContaining({ apiBaseUrl }));
    expect(portfolioQueue.listQueue("acme/widgets")).toEqual([
      expect.objectContaining({ apiBaseUrl, identifier: "pr:12", status: "queued", priority: 0 }),
    ]);
  });

  it("REGRESSION: a same-named repo+PR already tracked on ANOTHER forge host does not suppress this host's row (#6764)", async () => {
    const { portfolioQueue, eventLedger } = tempStores();
    const otherHost = "https://ghe.acme.example/api/v3";
    // The SAME owner/repo + PR number, already queued against a DIFFERENT forge host. The queue's composite
    // (api_base_url, repo_full_name, identifier) key exists precisely so these two never collide (#5563).
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "pr:12", priority: 0, apiBaseUrl: otherHost });

    await recordManagePollSnapshot(
      { repoFullName: "acme/widgets", prNumber: 12, branch: "fix/ci" },
      {
        eventLedger,
        portfolioQueue,
        pollCheckRuns: vi.fn().mockResolvedValue(pollResult("success")),
        githubToken: "token",
      },
    );

    // Before the fix, the forge-blind existence check matched the other host's row on identifier alone and
    // skipped creating this host's row entirely.
    const rows = portfolioQueue.listQueue("acme/widgets");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.apiBaseUrl).sort()).toEqual([DEFAULT_FORGE_CONFIG.apiBaseUrl, otherHost].sort());
  });

  it("runManagePoll prints summary and JSON output with injected stores", async () => {
    const { portfolioQueue, eventLedger } = tempStores();
    const pollCheckRuns = vi.fn().mockResolvedValue(pollResult("success"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await runManagePoll(["acme/widgets", "4", "--branch", "feat/x"], {
        initPortfolioQueue: () => portfolioQueue,
        initEventLedger: () => eventLedger,
        pollCheckRuns,
        lastPolledAt: "2026-07-04T12:10:00.000Z",
      }),
    ).toBe(0);
    expect(log).toHaveBeenCalledWith("success (pass/ready)");

    log.mockClear();
    expect(
      await runManagePoll(["acme/widgets", "4", "--json"], {
        initPortfolioQueue: () => portfolioQueue,
        initEventLedger: () => eventLedger,
        pollCheckRuns,
        lastPolledAt: "2026-07-04T12:10:00.000Z",
      }),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ prNumber: 4, ciState: "success" }),
      }),
    );
  });

  it("#4847: --dry-run performs the real CI poll but never opens the event ledger or portfolio queue", async () => {
    const initPortfolioQueue = vi.fn();
    const initEventLedger = vi.fn();
    const pollCheckRuns = vi.fn().mockResolvedValue(pollResult("success"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await runManagePoll(["acme/widgets", "4", "--branch", "feat/x", "--dry-run", "--json"], {
        initPortfolioQueue,
        initEventLedger,
        pollCheckRuns,
        lastPolledAt: "2026-07-04T12:10:00.000Z",
      }),
    ).toBe(0);
    expect(pollCheckRuns).toHaveBeenCalledWith("acme/widgets", 4, expect.any(Object));
    expect(initPortfolioQueue).not.toHaveBeenCalled();
    expect(initEventLedger).not.toHaveBeenCalled();
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.outcome).toBe("dry_run");
    expect(payload.payload).toEqual(
      expect.objectContaining({ prNumber: 4, ciState: "success", gateVerdict: "pass", outcome: "ready" }),
    );

    log.mockClear();
    expect(
      await runManagePoll(["acme/widgets", "4", "--dry-run"], {
        initPortfolioQueue,
        initEventLedger,
        pollCheckRuns,
        lastPolledAt: "2026-07-04T12:10:00.000Z",
      }),
    ).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain(
      "DRY RUN: success (pass/ready). No event-ledger or portfolio-queue write was made.",
    );
  });

  it("#4847: --dry-run reports poll failures and exits non-zero without opening any local store", async () => {
    const initPortfolioQueue = vi.fn();
    const initEventLedger = vi.fn();
    const pollCheckRuns = vi.fn().mockRejectedValue(new Error("github_404: not found"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      await runManagePoll(["acme/widgets", "4", "--dry-run"], {
        initPortfolioQueue,
        initEventLedger,
        pollCheckRuns,
      }),
    ).toBe(2);
    expect(initPortfolioQueue).not.toHaveBeenCalled();
    expect(initEventLedger).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("github_404: not found");
  });

  it("#6054: --dry-run --json reports poll failures as a parseable {ok:false,error} object", async () => {
    const initPortfolioQueue = vi.fn();
    const initEventLedger = vi.fn();
    const pollCheckRuns = vi.fn().mockRejectedValue(new Error("github_404: not found"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await runManagePoll(["acme/widgets", "4", "--dry-run", "--json"], {
        initPortfolioQueue,
        initEventLedger,
        pollCheckRuns,
      }),
    ).toBe(2);
    expect(initPortfolioQueue).not.toHaveBeenCalled();
    expect(initEventLedger).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "github_404: not found",
    });
  });

  it("#4847: --dry-run stringifies a thrown non-Error value instead of crashing", async () => {
    const pollCheckRuns = vi.fn().mockRejectedValue("raw_string_fault");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runManagePoll(["acme/widgets", "4", "--dry-run"], { pollCheckRuns })).toBe(2);
    expect(error).toHaveBeenCalledWith("raw_string_fault");
  });

  it("rejects invalid stores and poll failures", async () => {
    const { eventLedger } = tempStores();
    await expect(
      recordManagePollSnapshot(
        { repoFullName: "acme/widgets", prNumber: 1 },
        { eventLedger: null as never, pollCheckRuns: vi.fn() },
      ),
    ).rejects.toThrow("invalid_event_ledger");

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { portfolioQueue } = tempStores();
    expect(
      await runManagePoll(["acme/widgets", "9"], {
        initPortfolioQueue: () => portfolioQueue,
        initEventLedger: () => eventLedger,
        pollCheckRuns: vi.fn().mockRejectedValue(new Error("github_404: not found")),
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("github_404: not found");
    error.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      await runManagePoll(["acme/widgets", "9", "--json"], {
        initPortfolioQueue: () => portfolioQueue,
        initEventLedger: () => eventLedger,
        pollCheckRuns: vi.fn().mockRejectedValue(new Error("github_404: not found")),
      }),
    ).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "github_404: not found",
    });
  });
});
