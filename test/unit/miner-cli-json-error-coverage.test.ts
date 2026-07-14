import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runClaimClaim,
  runClaimCli,
  runClaimList,
  runClaimRelease,
} from "../../packages/gittensory-miner/lib/claim-ledger-cli.js";
import { runLedgerList } from "../../packages/gittensory-miner/lib/event-ledger-cli.js";
import { runGovernorList } from "../../packages/gittensory-miner/lib/governor-ledger-cli.js";
import { runLoop } from "../../packages/gittensory-miner/lib/loop-cli.js";
import { runManagePoll } from "../../packages/gittensory-miner/lib/manage-poll.js";
import { runPlanList, runPlanShow } from "../../packages/gittensory-miner/lib/plan-store-cli.js";
import {
  runQueueClaimBatch,
  runQueueDone,
  runQueueList,
  runQueueNext,
  runQueueRelease,
  runQueueRequeue,
} from "../../packages/gittensory-miner/lib/portfolio-queue-cli.js";

const { getRunState, setRunState } = vi.hoisted(() => ({
  getRunState: vi.fn(),
  setRunState: vi.fn(),
}));

vi.mock("../../packages/gittensory-miner/lib/run-state.js", () => ({
  RUN_STATES: ["idle", "discovering", "planning", "preparing"],
  getRunState,
  setRunState,
}));

const { runStateCli, runStateGet, runStateSet } = await import(
  "../../packages/gittensory-miner/lib/run-state-cli.js"
);

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function expectJsonError(run: () => unknown, error: string | RegExp, exitCode = 2) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(run()).toBe(exitCode);
  const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
  expect(payload).toEqual({ ok: false, error: expect.any(String) });
  if (error instanceof RegExp) expect(payload.error).toMatch(error);
  else expect(payload.error).toBe(error);
  expect(stderr).not.toHaveBeenCalled();
  log.mockRestore();
  stderr.mockRestore();
}

async function expectJsonErrorAsync(
  run: () => Promise<unknown>,
  error: string | RegExp,
  exitCode = 2,
) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await run()).toBe(exitCode);
  const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
  expect(payload).toEqual({ ok: false, error: expect.any(String) });
  if (error instanceof RegExp) expect(payload.error).toMatch(error);
  else expect(payload.error).toBe(error);
  expect(stderr).not.toHaveBeenCalled();
  log.mockRestore();
  stderr.mockRestore();
}

describe("miner CLI --json error coverage (#4836)", () => {
  it("portfolio queue list/next/done/claim-batch failures", () => {
    expectJsonError(() => runQueueList(["--verbose", "--json"]), /Unknown option/);
    expectJsonError(
      () =>
        runQueueList(["--json"], {
          initPortfolioQueue: () =>
            ({ listQueue: () => { throw new Error("list_db"); }, close: () => {} }) as never,
        }),
      "list_db",
    );
    expectJsonError(
      () =>
        runQueueNext(["--json"], {
          initPortfolioQueue: () =>
            ({ dequeueNext: () => { throw new Error("next_db"); }, close: () => {} }) as never,
        }),
      "next_db",
    );
    expectJsonError(
      () =>
        runQueueDone(["acme/a", "issue:1", "--json"], {
          initPortfolioQueue: () =>
            ({ markDone: () => { throw new Error("done_db"); }, close: () => {} }) as never,
        }),
      "done_db",
    );
    expectJsonError(
      () =>
        runQueueClaimBatch(["--global-wip", "nope", "--json"], {
          initPortfolioQueueManager: () => ({ claimBatch: () => [], close: () => {} }) as never,
        }),
      /Usage: loopover-miner queue claim-batch/,
    );
    expectJsonError(
      () =>
        runQueueClaimBatch(["--json"], {
          initPortfolioQueueManager: () => {
            throw new Error("batch_db");
          },
        }),
      "batch_db",
    );
    expectJsonError(() => runQueueRelease(["only-one", "--json"]), /queue release/);
    expectJsonError(() => runQueueRequeue(["only-one", "--json"]), /queue requeue/);
    expectJsonError(() => runQueueDone(["only-one", "--json"]), /queue done/);
    expectJsonError(() => runQueueNext(["--bogus", "--json"]), /Unknown option/);
    expectJsonError(
      () =>
        runQueueRelease(["acme/widgets", "issue:1", "--json"], {
          initPortfolioQueue: () =>
            ({ reclaimStuckItem: () => { throw "raw_release_fault"; }, close: () => {} }) as never,
        }),
      "raw_release_fault",
    );
  });

  it("plan list/show failures", () => {
    expectJsonError(() => runPlanList(["--verbose", "--json"]), /Unknown option/);
    expectJsonError(
      () =>
        runPlanList(["--json"], {
          openPlanStore: () => {
            throw new Error("plan_list_db");
          },
        }),
      "plan_list_db",
    );
    expectJsonError(() => runPlanShow(["--json"]), /Usage: loopover-miner plan show/);
    expectJsonError(
      () =>
        runPlanShow(["plan-a", "--json"], {
          openPlanStore: () => {
            throw new Error("plan_show_db");
          },
        }),
      "plan_show_db",
    );
  });

  it("state get/set/cli failures", () => {
    expectJsonError(() => runStateGet(["--json"]), /Usage: loopover-miner state get/);
    setRunState.mockImplementation(() => {
      throw new Error("set_failed");
    });
    expectJsonError(() => runStateSet(["acme/widgets", "idle", "--json"]), "set_failed");
    expectJsonError(() => runStateCli("tail", ["--json"]), /Unknown state subcommand/);
  });

  it("claim ledger runtime failures", () => {
    const broken = () => {
      throw new Error("ledger_broken");
    };
    expectJsonError(() => runClaimClaim(["--json"]), /Usage: loopover-miner claim claim/);
    expectJsonError(() => runClaimRelease(["acme/widgets", "--json"]), /Usage: loopover-miner claim release/);
    expectJsonError(() => runClaimList(["--status", "bogus", "--json"]), /status must be one of/);
    expectJsonError(
      () => runClaimClaim(["acme/widgets", "1", "--json"], { openClaimLedger: broken }),
      "ledger_broken",
    );
    expectJsonError(
      () =>
        runClaimClaim(["acme/widgets", "2", "--json"], {
          openClaimLedger: () => {
            throw "raw_claim_fault";
          },
        }),
      "raw_claim_fault",
    );
    expectJsonError(
      () => runClaimRelease(["acme/widgets", "1", "--json"], { openClaimLedger: broken }),
      "ledger_broken",
    );
    expectJsonError(
      () => runClaimList(["--json"], { openClaimLedger: broken }),
      "ledger_broken",
    );
    expectJsonError(() => runClaimCli("peek", ["--json"]), /Unknown claim subcommand/);
  });

  it("event ledger list runtime failure", () => {
    expectJsonError(
      () =>
        runLedgerList(["--json"], {
          initEventLedger: () =>
            ({ readEvents: () => { throw new Error("ledger_read"); }, close: () => {} }) as never,
        }),
      "ledger_read",
    );
  });

  it("governor list parse failure", async () => {
    await expectJsonErrorAsync(() => runGovernorList(["--verbose", "--json"]), /Unknown option/);
    await expectJsonErrorAsync(
      () =>
        runGovernorList(["--json"], {
          initGovernorLedger: () => {
            throw new Error("gov_db");
          },
        }),
      "gov_db",
    );
  });

  it("loop parse failure", async () => {
    await expectJsonErrorAsync(() => runLoop(["--json"]), /Usage: loopover-miner loop/);
  });

  it("manage poll parse failure", async () => {
    await expectJsonErrorAsync(() => runManagePoll(["--json"]), /Usage: loopover-miner manage poll/);
  });
});
