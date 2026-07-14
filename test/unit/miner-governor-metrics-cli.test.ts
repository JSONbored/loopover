import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDefaultGovernorState, openGovernorState } from "../../packages/gittensory-miner/lib/governor-state.js";
import {
  GOVERNOR_CAP_USAGE_RATIO,
  GOVERNOR_RATE_LIMIT_REMAINING_RATIO,
  renderGovernorMetrics,
  runGovernorMetrics,
} from "../../packages/gittensory-miner/lib/governor-metrics-cli.js";
import { runGovernorCli } from "../../packages/gittensory-miner/lib/governor-ledger-cli.js";

const roots: string[] = [];
const states: Array<{ close(): void }> = [];

function tempGovernorState() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-metrics-cli-"));
  roots.push(root);
  const state = openGovernorState(join(root, "governor-state.sqlite3"));
  states.push(state);
  return state;
}

afterEach(() => {
  for (const state of states.splice(0)) state.close();
  closeDefaultGovernorState();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = Date.parse("2026-07-13T12:00:00.000Z");
const EMPTY_CAP_USAGE = { budgetSpent: 0, turnsTaken: 0, elapsedMs: 0 };

describe("renderGovernorMetrics() (#5187)", () => {
  it("emits well-formed HELP/TYPE headers even with no bucket activity and zero cap usage", () => {
    const output = renderGovernorMetrics({ buckets: { global: {}, perRepo: {} }, backoffAttempts: {} }, EMPTY_CAP_USAGE, NOW);
    expect(output).toContain(`# HELP ${GOVERNOR_RATE_LIMIT_REMAINING_RATIO}`);
    expect(output).toContain(`# TYPE ${GOVERNOR_RATE_LIMIT_REMAINING_RATIO} gauge`);
    expect(output).toContain(`# HELP ${GOVERNOR_CAP_USAGE_RATIO}`);
    expect(output).toContain(`# TYPE ${GOVERNOR_CAP_USAGE_RATIO} gauge`);
    expect(output).toContain(`${GOVERNOR_CAP_USAGE_RATIO}{dimension="budget"} 0`);
    expect(output).toContain(`${GOVERNOR_CAP_USAGE_RATIO}{dimension="turns"} 0`);
    expect(output).toContain(`${GOVERNOR_CAP_USAGE_RATIO}{dimension="elapsed_ms"} 0`);
    expect(output.endsWith("\n")).toBe(true);
  });

  it("renders a global bucket's TRUE current headroom, not evaluateLocalRateLimit's next-write-adjusted remaining", () => {
    // global.open_pr policy: limit 30, windowMs 60_000. count=27 within the window -> effectiveCount=27,
    // allowed=true (27<30). evaluateLocalRateLimit's own `remaining` field is limit-effectiveCount-1=2 (headroom
    // AFTER one more hypothetical write), so the renderer must add 1 back to recover current headroom (3) before
    // dividing by limit -- using `remaining` directly would under-report by exactly one slot.
    const output = renderGovernorMetrics(
      { buckets: { global: { open_pr: { count: 27, windowStartMs: NOW } }, perRepo: {} }, backoffAttempts: {} },
      EMPTY_CAP_USAGE,
      NOW,
    );
    expect(output).toContain(
      `${GOVERNOR_RATE_LIMIT_REMAINING_RATIO}{scope="global",action_class="open_pr"} ${3 / 30}`,
    );
  });

  it("renders a per-repo bucket's TRUE current headroom, splitting the composite actionClass:repo key", () => {
    // perRepo.open_pr policy: limit 3, windowMs 60_000. count=2 within the window -> effectiveCount=2,
    // allowed=true (2<3): ONE write is still allowed even though evaluateLocalRateLimit's own `remaining` field
    // is already 0 at this count (3-2-1). Current headroom is 1, not 0 -- this is the exact case a prior
    // version of this renderer got wrong (indistinguishable from a fully exhausted bucket).
    const output = renderGovernorMetrics(
      {
        buckets: { global: {}, perRepo: { "open_pr:acme/widgets": { count: 2, windowStartMs: NOW } } },
        backoffAttempts: {},
      },
      EMPTY_CAP_USAGE,
      NOW,
    );
    expect(output).toContain(
      `${GOVERNOR_RATE_LIMIT_REMAINING_RATIO}{scope="per_repo",action_class="open_pr",repo="acme/widgets"} ${1 / 3}`,
    );
  });

  it("renders 0 headroom for a bucket that has genuinely reached its limit (count === limit, not allowed)", () => {
    // perRepo.open_pr policy: limit 3. count=3 -> effectiveCount=3, allowed=false (3 is NOT < 3): this is the
    // ACTUAL exhausted case, distinct from the count=2 "one write left" case above -- both must not render the
    // same ratio, which is exactly the bug this test (and the one above) guards against together.
    const output = renderGovernorMetrics(
      {
        buckets: { global: {}, perRepo: { "open_pr:acme/widgets": { count: 3, windowStartMs: NOW } } },
        backoffAttempts: {},
      },
      EMPTY_CAP_USAGE,
      NOW,
    );
    expect(output).toContain(
      `${GOVERNOR_RATE_LIMIT_REMAINING_RATIO}{scope="per_repo",action_class="open_pr",repo="acme/widgets"} 0`,
    );
  });

  it("skips a global/per-repo bucket whose actionClass has no DEFAULT_WRITE_RATE_LIMIT_POLICIES entry", () => {
    const output = renderGovernorMetrics(
      {
        buckets: {
          global: { unknown_action: { count: 5, windowStartMs: NOW } },
          perRepo: { "unknown_action:acme/widgets": { count: 1, windowStartMs: NOW } },
        },
        backoffAttempts: {},
      },
      EMPTY_CAP_USAGE,
      NOW,
    );
    expect(output).not.toContain("unknown_action");
  });

  it("recovers actionClass/repo from a malformed per-repo key with no colon separator", () => {
    const output = renderGovernorMetrics(
      { buckets: { global: {}, perRepo: { malformed_no_colon: { count: 0, windowStartMs: NOW } } }, backoffAttempts: {} },
      EMPTY_CAP_USAGE,
      NOW,
    );
    // "malformed_no_colon" has no DEFAULT_WRITE_RATE_LIMIT_POLICIES.perRepo entry, so it is skipped -- this
    // test only exists to exercise splitPerRepoKey's separatorIndex === -1 branch without throwing.
    expect(output).not.toContain("malformed_no_colon");
  });

  it("sorts series deterministically by scope, then action_class, then repo", () => {
    const output = renderGovernorMetrics(
      {
        buckets: {
          global: { comment: { count: 0, windowStartMs: NOW }, open_pr: { count: 0, windowStartMs: NOW } },
          perRepo: {
            "open_pr:zeta/repo": { count: 0, windowStartMs: NOW },
            "open_pr:acme/repo": { count: 0, windowStartMs: NOW },
          },
        },
        backoffAttempts: {},
      },
      EMPTY_CAP_USAGE,
      NOW,
    );
    // count=0 for every bucket -> full current headroom (limit - 0 = limit), so the ratio is 1 for all of them.
    const seriesLines = output.split("\n").filter((line) => line.startsWith(GOVERNOR_RATE_LIMIT_REMAINING_RATIO + "{"));
    expect(seriesLines).toEqual([
      `${GOVERNOR_RATE_LIMIT_REMAINING_RATIO}{scope="global",action_class="comment"} 1`,
      `${GOVERNOR_RATE_LIMIT_REMAINING_RATIO}{scope="global",action_class="open_pr"} 1`,
      `${GOVERNOR_RATE_LIMIT_REMAINING_RATIO}{scope="per_repo",action_class="open_pr",repo="acme/repo"} 1`,
      `${GOVERNOR_RATE_LIMIT_REMAINING_RATIO}{scope="per_repo",action_class="open_pr",repo="zeta/repo"} 1`,
    ]);
  });

  it("renders cap-usage ratios against DEFAULT_AMS_POLICY_SPEC.capLimits (budget 5, turns 20, elapsedMs 1_800_000)", () => {
    const output = renderGovernorMetrics(
      { buckets: { global: {}, perRepo: {} }, backoffAttempts: {} },
      { budgetSpent: 4.5, turnsTaken: 20, elapsedMs: 900_000 },
      NOW,
    );
    expect(output).toContain(`${GOVERNOR_CAP_USAGE_RATIO}{dimension="budget"} 0.9`);
    expect(output).toContain(`${GOVERNOR_CAP_USAGE_RATIO}{dimension="turns"} 1`);
    expect(output).toContain(`${GOVERNOR_CAP_USAGE_RATIO}{dimension="elapsed_ms"} 0.5`);
  });
});

describe("runGovernorMetrics (#5187)", () => {
  it("prints the rendered document from the real governor-state store", async () => {
    const governorState = tempGovernorState();
    governorState.saveRateLimitState({
      buckets: { global: { open_pr: { count: 15, windowStartMs: NOW } }, perRepo: {} },
      backoffAttempts: {},
    });
    governorState.saveCapUsage({ budgetSpent: 1, turnsTaken: 2, elapsedMs: 3 });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runGovernorMetrics([], { openGovernorState: () => governorState, nowMs: NOW })).toBe(0);
    const output = String(log.mock.calls[0]?.[0]);
    // limit 30, count 15 -> current headroom = 30 - 15 = 15, ratio = 15/30 = 0.5.
    expect(output).toContain(`${GOVERNOR_RATE_LIMIT_REMAINING_RATIO}{scope="global",action_class="open_pr"} 0.5`);
    expect(output.endsWith("\n")).toBe(false); // console.log adds its own trailing newline
  });

  it("defaults nowMs to the real clock when not injected", async () => {
    const governorState = tempGovernorState();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runGovernorMetrics([], { openGovernorState: () => governorState })).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain(`${GOVERNOR_CAP_USAGE_RATIO}{dimension="budget"} 0`);
  });

  it("rejects unexpected positional args and surfaces a store failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runGovernorMetrics(["extra"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Usage: loopover-miner governor metrics");

    error.mockClear();
    expect(
      await runGovernorMetrics([], {
        openGovernorState: () => {
          throw new Error("store_broken");
        },
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("store_broken");
  });

  it("reports a JSON-formatted usage error on stdout when --json is present alongside an extra arg", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runGovernorMetrics(["extra", "--json"])).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ ok: false });
  });

  it("opens and closes the default on-disk governor state when no override is supplied", async () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-metrics-cli-default-"));
    roots.push(root);
    const dbPath = join(root, "governor-state.sqlite3");
    const previousDbPath = process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB;
    process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB = dbPath;
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(await runGovernorMetrics([])).toBe(0);
      expect(log).toHaveBeenCalled();
    } finally {
      if (previousDbPath === undefined) delete process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB;
      else process.env.LOOPOVER_MINER_GOVERNOR_STATE_DB = previousDbPath;
    }
  });

  it("runGovernorCli dispatches the metrics subcommand", async () => {
    const governorState = tempGovernorState();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runGovernorCli("metrics", [], { openGovernorState: () => governorState })).toBe(0);
    expect(log).toHaveBeenCalled();
  });
});
