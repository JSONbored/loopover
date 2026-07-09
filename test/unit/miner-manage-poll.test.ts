import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDefaultEventLedger,
  initEventLedger,
} from "../../packages/gittensory-miner/lib/event-ledger.js";
import {
  MANAGE_PR_UPDATE_EVENT,
  collectManageStatus,
} from "../../packages/gittensory-miner/lib/manage-status.js";
import {
  buildManagePollEventPayload,
  mapPollConclusionToGateVerdict,
  mapPollConclusionToOutcome,
  mapPollSnapshotToOutcome,
  parseManagePollArgs,
  recordManagePollSnapshot,
  runManagePoll,
} from "../../packages/gittensory-miner/lib/manage-poll.js";
import type { PollCheckRunsResult } from "../../packages/gittensory-miner/lib/ci-poller.d.ts";
import { MINER_PR_OUTCOME_EVENT } from "../../packages/gittensory-miner/lib/pr-outcome.js";
import {
  closeDefaultPortfolioQueueStore,
  initPortfolioQueueStore,
} from "../../packages/gittensory-miner/lib/portfolio-queue.js";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempStores() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-manage-poll-"));
  roots.push(root);
  const portfolioQueue = initPortfolioQueueStore(join(root, "portfolio-queue.sqlite3"));
  const eventLedger = initEventLedger(join(root, "event-ledger.sqlite3"));
  stores.push(portfolioQueue, eventLedger);
  return { portfolioQueue, eventLedger };
}

function pollResult(
  conclusion: PollCheckRunsResult["conclusion"],
  pullRequest: PollCheckRunsResult["pullRequest"] = {
    headSha: "abc123",
    state: "open",
    merged: false,
    mergedAt: null,
    closedAt: null,
  },
): PollCheckRunsResult {
  return {
    conclusion,
    checks: [],
    headSha: pullRequest?.headSha ?? "abc123",
    pullRequest,
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

describe("gittensory-miner manage poll (#2323/#2325)", () => {
  it("parseManagePollArgs validates argv", () => {
    expect(parseManagePollArgs([])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner manage poll"),
    });
    expect(parseManagePollArgs(["acme/widgets", "42", "--branch", "feat/x", "--json"])).toEqual({
      repoFullName: "acme/widgets",
      prNumber: 42,
      branch: "feat/x",
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
      mapPollSnapshotToOutcome(
        pollResult("success", {
          headSha: "abc123",
          state: "closed",
          merged: false,
          mergedAt: null,
          closedAt: "2026-07-08T12:00:00.000Z",
        }),
      ),
    ).toBe("disengaged");
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

  it("recordManagePollSnapshot transitions closed PRs to disengaged and records pr_outcome", async () => {
    const { portfolioQueue, eventLedger } = tempStores();
    const closedPullRequest = {
      headSha: "abc123",
      state: "closed",
      merged: false,
      mergedAt: null,
      closedAt: "2026-07-08T12:00:00.000Z",
    };
    const pollCheckRuns = vi.fn().mockResolvedValue(pollResult("failure", closedPullRequest));

    const result = await recordManagePollSnapshot(
      { repoFullName: "acme/widgets", prNumber: 15, branch: "fix/ci" },
      {
        eventLedger,
        portfolioQueue,
        pollCheckRuns,
        lastPolledAt: "2026-07-08T12:05:00.000Z",
      },
    );

    expect(result.payload).toEqual(
      expect.objectContaining({
        prNumber: 15,
        outcome: "disengaged",
        rejectionReason: "gate_close",
        courtesyNote: expect.stringContaining("#15"),
        closedAt: "2026-07-08T12:00:00.000Z",
      }),
    );
    expect(eventLedger.readEvents()).toEqual([
      expect.objectContaining({
        type: MANAGE_PR_UPDATE_EVENT,
        payload: expect.objectContaining({ outcome: "disengaged", rejectionReason: "gate_close" }),
      }),
      expect.objectContaining({
        type: MINER_PR_OUTCOME_EVENT,
        payload: expect.objectContaining({
          prNumber: 15,
          decision: "closed",
          outcome: "disengaged",
          rejectionReason: "gate_close",
        }),
      }),
    ]);
    expect(collectManageStatus({ portfolioQueue, eventLedger })).toEqual([
      expect.objectContaining({
        repoFullName: "acme/widgets",
        prNumber: 15,
        outcome: "disengaged",
      }),
    ]);
  });

  it("classifies maintainer_close_no_reason when a closed PR has no gate block signal", async () => {
    const { eventLedger } = tempStores();
    const pollCheckRuns = vi.fn().mockResolvedValue(
      pollResult("success", {
        headSha: "abc123",
        state: "closed",
        merged: false,
        mergedAt: null,
        closedAt: "2026-07-08T12:00:00.000Z",
      }),
    );

    const result = await recordManagePollSnapshot(
      { repoFullName: "acme/widgets", prNumber: 16 },
      {
        eventLedger,
        ensurePortfolioRow: false,
        pollCheckRuns,
      },
    );

    expect(result.payload).toEqual(
      expect.objectContaining({
        outcome: "disengaged",
        rejectionReason: "maintainer_close_no_reason",
      }),
    );
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
  });
});
