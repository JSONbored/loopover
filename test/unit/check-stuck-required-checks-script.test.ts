import { describe, expect, it } from "vitest";

import {
  MARKER,
  REQUIRED_CONTEXTS,
  findStuckChecksForPr,
  minutesSince,
  runStuckCheckWatchdog,
} from "../../scripts/check-stuck-required-checks.mjs";

// #7455: findStuckChecksForPr's stuck/threshold decision and the watchdog's dry-run + marker-idempotency
// only ran inside the un-guarded live-GitHub driver. With githubApi injected and the driver behind an
// entrypoint guard, both are now testable with mock responses and zero network.

type CheckRun = { name: string; status: string; started_at?: string; html_url?: string };
type ApiOptions = { method?: string; body?: string; headers?: Record<string, string> };

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const scope = { owner: "acme", repoName: "widget", thresholdMinutes: 20 };

function checkRunApi(checkRuns: CheckRun[]) {
  return async (path: string): Promise<unknown> => {
    if (path.includes("/check-runs")) return { check_runs: checkRuns };
    throw new Error(`unexpected path: ${path}`);
  };
}

describe("minutesSince (#7455)", () => {
  it("returns elapsed minutes since an ISO timestamp", () => {
    expect(minutesSince(minutesAgoIso(30))).toBeGreaterThanOrEqual(29.9);
    expect(minutesSince(minutesAgoIso(30))).toBeLessThanOrEqual(30.1);
  });
});

describe("findStuckChecksForPr (#7455)", () => {
  const pr = { number: 1, head: { sha: "deadbeef" } };

  it("flags a required check pending past the threshold", async () => {
    const stuck = await findStuckChecksForPr(pr, REQUIRED_CONTEXTS, {
      githubApi: checkRunApi([{ name: "validate", status: "in_progress", started_at: minutesAgoIso(30) }]),
      ...scope,
    });
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.name).toBe("validate");
    expect(stuck[0]!.elapsedMinutes).toBeGreaterThanOrEqual(20);
  });

  it("does not flag a required check still under the threshold", async () => {
    const stuck = await findStuckChecksForPr(pr, REQUIRED_CONTEXTS, {
      githubApi: checkRunApi([{ name: "validate", status: "in_progress", started_at: minutesAgoIso(5) }]),
      ...scope,
    });
    expect(stuck).toHaveLength(0);
  });

  it("excludes a not-completed check that has no started_at (elapsedMinutes === null), e.g. still queued", async () => {
    const stuck = await findStuckChecksForPr(pr, REQUIRED_CONTEXTS, {
      githubApi: checkRunApi([{ name: "validate", status: "queued" }]),
      ...scope,
    });
    expect(stuck).toHaveLength(0);
  });

  it("ignores non-required and already-completed checks even when old", async () => {
    const stuck = await findStuckChecksForPr(pr, REQUIRED_CONTEXTS, {
      githubApi: checkRunApi([
        { name: "some-other-check", status: "in_progress", started_at: minutesAgoIso(60) },
        { name: "validate", status: "completed", started_at: minutesAgoIso(60) },
      ]),
      ...scope,
    });
    expect(stuck).toHaveLength(0);
  });
});

describe("runStuckCheckWatchdog (#7455)", () => {
  function watchdogApi(opts: { prs: unknown[]; checkRuns: CheckRun[]; comments: Array<{ body?: string }> }) {
    const calls: Array<{ path: string; method: string }> = [];
    const githubApi = async (path: string, options: ApiOptions = {}): Promise<unknown> => {
      const method = options.method ?? "GET";
      calls.push({ path, method });
      if (path.includes("/pulls?")) return opts.prs;
      if (path.includes("/check-runs")) return { check_runs: opts.checkRuns };
      if (path.includes("/comments")) return method === "POST" ? {} : opts.comments;
      throw new Error(`unexpected path: ${path}`);
    };
    return { githubApi, calls };
  }

  const stuckRun: CheckRun = { name: "validate", status: "in_progress", started_at: minutesAgoIso(30) };

  it("posts a comment for a stuck PR that has not been flagged yet", async () => {
    const { githubApi, calls } = watchdogApi({
      prs: [{ number: 7, draft: false, head: { sha: "s" } }],
      checkRuns: [stuckRun],
      comments: [],
    });
    const flagged = await runStuckCheckWatchdog({ githubApi, ...scope, log: () => {} });
    expect(flagged).toBe(1);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("is idempotent: skips a PR that already has the watchdog marker comment (no POST)", async () => {
    const { githubApi, calls } = watchdogApi({
      prs: [{ number: 7, draft: false, head: { sha: "s" } }],
      checkRuns: [stuckRun],
      comments: [{ body: `${MARKER}\n## previously flagged` }],
    });
    const flagged = await runStuckCheckWatchdog({ githubApi, ...scope, log: () => {} });
    expect(flagged).toBe(0);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("--dry-run never calls the comment-post endpoint", async () => {
    const { githubApi, calls } = watchdogApi({
      prs: [{ number: 7, draft: false, head: { sha: "s" } }],
      checkRuns: [stuckRun],
      comments: [],
    });
    const flagged = await runStuckCheckWatchdog({ githubApi, ...scope, dryRun: true, log: () => {} });
    expect(flagged).toBe(0);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});
