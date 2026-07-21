import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  EXTERNAL_REQUIRED_CHECKS,
  MARKER,
  REQUIRED_CONTEXTS,
  findStuckChecksForPr,
  minutesSince,
  runStuckCheckWatchdog,
} from "../../scripts/check-stuck-required-checks.js";

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

// #7774: REQUIRED_CONTEXTS is hardcoded because branch protection's required-checks list can't be read live
// from the ephemeral workflow token (Administration read is not grantable). That makes it silent-drift-prone:
// if the workflow's required aggregate check is renamed without a matching edit here, the watchdog goes blind
// to it with no signal anywhere. These tests fail loudly on that divergence. Deriving "which checks are
// required" from YAML alone isn't possible (the same permissions limitation), so the achievable, genuine
// guarantee is forward consistency: every workflow-sourced required context must still name a real ci.yml job.
describe("REQUIRED_CONTEXTS stays in sync with .github/workflows/ci.yml (#7774)", () => {
  // EXTERNAL_REQUIRED_CHECKS (from the script) is the documented set of required checks no workflow declares —
  // currently the third-party "Superagent Security Scan" GitHub App check — so they intentionally have no
  // ci.yml job counterpart and are excluded from the workflow-consistency assertion below.
  const EXTERNAL_CHECKS = EXTERNAL_REQUIRED_CHECKS;

  function ciJobCheckNames(): Set<string> {
    const doc = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
      jobs: Record<string, { name?: string }>;
    };
    const names = new Set<string>();
    // A job's status-check context is its `name:` when set, else its job id.
    for (const [jobId, job] of Object.entries(doc.jobs)) names.add(job.name ?? jobId);
    return names;
  }

  it("every workflow-sourced required context is a real ci.yml job name", () => {
    const jobNames = ciJobCheckNames();
    const workflowSourced = [...REQUIRED_CONTEXTS].filter((context) => !EXTERNAL_CHECKS.has(context));
    // Premise guard: at least one required context must come from a workflow (else EXTERNAL_CHECKS is stale).
    expect(workflowSourced.length).toBeGreaterThan(0);
    const missing = workflowSourced.filter((context) => !jobNames.has(context));
    expect(
      missing,
      `REQUIRED_CONTEXTS has ${missing.join(", ")} which is not a job name in .github/workflows/ci.yml — ` +
        `update scripts/check-stuck-required-checks.mjs's REQUIRED_CONTEXTS (or EXTERNAL_CHECKS in this test) to match.`,
    ).toEqual([]);
  });

  it("still lists the single required aggregate the workflow documents ('validate')", () => {
    // ci.yml declares one required status check that branch protection points at: the `validate` aggregate.
    // Renaming it without updating REQUIRED_CONTEXTS is exactly the drift the watchdog would silently miss.
    const jobNames = ciJobCheckNames();
    expect(jobNames.has("validate")).toBe(true);
    expect(REQUIRED_CONTEXTS.has("validate")).toBe(true);
  });

  it("EXTERNAL_CHECKS lists only genuinely external checks (none is a ci.yml job)", () => {
    const jobNames = ciJobCheckNames();
    for (const external of EXTERNAL_CHECKS) expect(jobNames.has(external)).toBe(false);
  });

  it("every EXTERNAL_REQUIRED_CHECKS entry is actually a required context", () => {
    // Excluding a check from the workflow-consistency assertion only makes sense if it's genuinely required.
    for (const external of EXTERNAL_REQUIRED_CHECKS) expect(REQUIRED_CONTEXTS.has(external)).toBe(true);
  });
});
