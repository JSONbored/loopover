import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { runMinerAttempt } from "../../packages/gittensory-miner/lib/attempt-runner.js";
import { initEventLedger } from "../../packages/gittensory-miner/lib/event-ledger.js";
import { initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";
import { openGovernorState } from "../../packages/gittensory-miner/lib/governor-state.js";
import { parseFocusManifest, type CodingAgentDriver, type CodingAgentDriverResult } from "../../packages/gittensory-engine/src/index";

const roots: string[] = [];
const closers: Array<{ close(): void }> = [];

function tempEventLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-attempt-runner-events-"));
  roots.push(root);
  const ledger = initEventLedger(join(root, "db.sqlite3"));
  closers.push(ledger);
  return ledger;
}

function tempGovernorLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-attempt-runner-governor-"));
  roots.push(root);
  const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
  closers.push(ledger);
  return ledger;
}

// Isolated per test: without this, evaluateGovernorChokepointGatePersisted's own default-store fallback
// would open the REAL ~/.config/gittensory-miner/governor-state.sqlite3 on whatever machine runs these tests.
function tempGovernorState() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-attempt-runner-governor-state-"));
  roots.push(root);
  const state = openGovernorState(join(root, "governor-state.sqlite3"));
  closers.push(state);
  return state;
}

afterEach(() => {
  for (const closer of closers.splice(0)) closer.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ── IterateLoopInput fixtures, mirroring packages/gittensory-engine/test/iterate-loop.test.ts's own ──────────

const REPO = { fullName: "acme/widgets", owner: "acme", name: "widgets", isInstalled: true, isRegistered: true, isPrivate: false };

function openIssue(number: number, title: string) {
  return { repoFullName: "acme/widgets", number, title, state: "open" as const, labels: [], linkedPrs: [] };
}

const noopSlop = { slopRisk: 0, band: "clean" as const, findings: [] };

function baseReviewContext(overrides: Record<string, unknown> = {}) {
  return {
    manifest: parseFocusManifest({ gate: { duplicates: "block", linkedIssue: "advisory" } }),
    repo: REPO,
    issues: [openIssue(7, "Uploads should retry on 5xx")],
    pullRequests: [],
    ...overrides,
  };
}

function passingLoopInput(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: "attempt-1",
    workingDirectory: "/tmp/attempt-1",
    acceptanceCriteriaPath: "/tmp/attempt-1/acceptance-criteria.json",
    instructions: "Add retry to the upload client",
    mode: "live" as const,
    maxIterations: 3,
    maxTurnsPerIteration: 20,
    repoFullName: "acme/widgets",
    contributorLogin: "miner-bot",
    title: "Add retry to the upload client",
    body: "Closes #7",
    linkedIssues: [7],
    branchRef: "miner/attempt-1",
    reviewContext: baseReviewContext(),
    rejectionSignaled: false,
    ...overrides,
  };
}

function driverReturning(result: CodingAgentDriverResult): CodingAgentDriver {
  return { async run() { return result; } };
}

function okDriverResult(changedFiles: string[] = ["src/upload.ts"], turnsUsed = 5): CodingAgentDriverResult {
  return { ok: true, changedFiles, summary: "added retry logic", turnsUsed };
}

// ── Governor "everything allows" fixture, mirroring test/unit/miner-governor-chokepoint.test.ts's own ────────

function allowingGovernorContext(overrides: Record<string, unknown> = {}) {
  return {
    killSwitchGlobal: false,
    killSwitchRepoPaused: false,
    liveModeGlobalOptIn: true,
    liveModeRepoOptIn: "live",
    rateLimitBuckets: { global: {}, perRepo: {} },
    rateLimitBackoffAttempts: {},
    capUsage: { budgetSpent: 0, turnsTaken: 0, elapsedMs: 0 },
    capLimits: { budget: 100, turns: 100, elapsedMs: 1_000_000 },
    convergenceInput: { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false },
    ...overrides,
  };
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  const eventLedger = tempEventLedger();
  const governorLedger = tempGovernorLedger();
  const governorState = tempGovernorState();
  return {
    driver: driverReturning(okDriverResult()),
    runSlopAssessment: () => noopSlop,
    appendAttemptLogEvent: () => undefined,
    claimLedger: { listClaims: () => [{ repoFullName: "acme/widgets", issueNumber: 7, status: "active" }] },
    fetchLiveIssueSnapshot: async () => ({ state: "open" as const, referencingPrs: [] }),
    eventLedger,
    governorLedgerAppend: (event: unknown) => governorLedger.appendGovernorEvent(event as never),
    governorState,
    nowMs: 10_000,
    executeLocalWrite: async () => ({ ranAt: 10_000 }),
    ...overrides,
  };
}

function baseAttemptInput(overrides: Record<string, unknown> = {}) {
  return {
    loopInput: passingLoopInput(),
    issueNumber: 7,
    minerLogin: "miner-bot",
    base: "main",
    killSwitchScope: "none" as const,
    slopThreshold: "low" as const,
    submissionMode: "enforce" as const,
    draft: false,
    governor: allowingGovernorContext(),
    ...overrides,
  };
}

describe("runMinerAttempt (#2337) — the real create->review->gate->submit pipeline", () => {
  it("full happy path: handoff -> fresh -> ready -> allowed -> builds and executes the real open_pr command", async () => {
    const deps = baseDeps();
    const result = await runMinerAttempt(baseAttemptInput(), deps);

    expect(result.outcome).toBe("submitted");
    if (result.outcome !== "submitted") throw new Error("expected submitted");
    expect(result.spec.action).toBe("open_pr");
    expect(result.spec.command).toContain("gh pr create");
    expect(result.spec.command).toContain("'acme/widgets'");
    expect(result.spec.command).toContain("'miner/attempt-1'");
    expect(result.execResult).toEqual({ ranAt: 10_000 });
    expect(result.loopResult.outcome).toBe("handoff");
  });

  it("defaults the open_pr body to an empty string when the loop input never set one", async () => {
    const deps = baseDeps();
    const result = await runMinerAttempt(baseAttemptInput({ loopInput: passingLoopInput({ body: undefined }) }), deps);

    expect(result.outcome).toBe("submitted");
    if (result.outcome !== "submitted") throw new Error("expected submitted");
    expect(result.spec.inputs.body).toBe("");
  });

  it("abandon: the loop never reaches a candidate worth submitting -- no downstream gate is even consulted", async () => {
    const claimLedgerListClaims = vi.fn();
    const deps = baseDeps({ claimLedger: { listClaims: claimLedgerListClaims } });
    const result = await runMinerAttempt(baseAttemptInput({ loopInput: passingLoopInput({ maxIterations: 0 }) }), deps);

    expect(result.outcome).toBe("abandon");
    expect(claimLedgerListClaims).not.toHaveBeenCalled();
  });

  it("stale: a superseded claim aborts before the submission-gate or governor ever run", async () => {
    const deps = baseDeps({ claimLedger: { listClaims: () => [{ repoFullName: "acme/widgets", issueNumber: 7, status: "released" }] } });
    const result = await runMinerAttempt(baseAttemptInput(), deps);

    expect(result.outcome).toBe("stale");
    if (result.outcome !== "stale") throw new Error("expected stale");
    expect(result.reason).toBe("claim_superseded");
  });

  it("blocked: the submission-gate itself declines (e.g. global kill-switch) before the governor ever runs", async () => {
    const deps = baseDeps();
    const result = await runMinerAttempt(baseAttemptInput({ killSwitchScope: "global" }), deps);

    expect(result.outcome).toBe("blocked");
    if (result.outcome !== "blocked") throw new Error("expected blocked");
    expect(result.decision.allow).toBe(false);
    expect(result.decision.reasons).toContain("global_kill_switch_active");
  });

  it("governed: the submission-gate says ready, but the Governor chokepoint denies (e.g. dry-run mode)", async () => {
    const deps = baseDeps();
    const result = await runMinerAttempt(baseAttemptInput({ governor: allowingGovernorContext({ liveModeGlobalOptIn: false }) }), deps);

    expect(result.outcome).toBe("governed");
    if (result.outcome !== "governed") throw new Error("expected governed");
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.stage).toBe("dry_run");
  });

  it("governed: the Governor's own kill-switch stage denies even though the submission-gate itself said ready", async () => {
    const deps = baseDeps();
    const result = await runMinerAttempt(baseAttemptInput({ governor: allowingGovernorContext({ killSwitchGlobal: true }) }), deps);

    expect(result.outcome).toBe("governed");
    if (result.outcome !== "governed") throw new Error("expected governed");
    expect(result.decision.stage).toBe("kill_switch");
  });

  it("falls back to the real default governor-ledger append when governorLedgerAppend is omitted", async () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-attempt-runner-default-governor-"));
    roots.push(root);
    vi.stubEnv("GITTENSORY_MINER_GOVERNOR_LEDGER_DB", join(root, "default-governor.sqlite3"));
    const deps = baseDeps();
    delete (deps as { governorLedgerAppend?: unknown }).governorLedgerAppend;

    const result = await runMinerAttempt(baseAttemptInput(), deps);

    expect(result.outcome).toBe("submitted");
    vi.unstubAllEnvs();
  });

  it("falls back to the real default governor-state store when governorState is omitted", async () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-attempt-runner-default-governor-state-"));
    roots.push(root);
    vi.stubEnv("GITTENSORY_MINER_GOVERNOR_STATE_DB", join(root, "default-governor-state.sqlite3"));
    const deps = baseDeps();
    delete (deps as { governorState?: unknown }).governorState;

    const result = await runMinerAttempt(baseAttemptInput(), deps);

    expect(result.outcome).toBe("submitted");
    vi.unstubAllEnvs();
  });

  it("REGRESSION (#5134/#5203): a rate limit consumed by one runMinerAttempt call is honored by the next, via the shared governor-state store -- this is what the missing wiring bug looked like", async () => {
    const deps = baseDeps();
    const policies = {
      global: { open_pr: { limit: 1, windowMs: 60_000 } },
      perRepo: { open_pr: { limit: 5, windowMs: 60_000 } },
      backoffBaseMs: 100,
    };
    // rateLimitBuckets/rateLimitBackoffAttempts are DELIBERATELY omitted here (unlike allowingGovernorContext's
    // own explicit empty defaults) -- an explicit value on the input always wins over persisted state, so
    // omitting them is what actually exercises evaluateGovernorChokepointGatePersisted's auto-load/save path
    // through the real runMinerAttempt entrypoint, not just the lower-level wrapper tested elsewhere.
    const governorWithoutRateLimitState = allowingGovernorContext({ rateLimitPolicies: policies });
    delete (governorWithoutRateLimitState as { rateLimitBuckets?: unknown }).rateLimitBuckets;
    delete (governorWithoutRateLimitState as { rateLimitBackoffAttempts?: unknown }).rateLimitBackoffAttempts;

    const first = await runMinerAttempt(baseAttemptInput({ governor: governorWithoutRateLimitState }), deps);
    expect(first.outcome).toBe("submitted");

    const second = await runMinerAttempt(
      baseAttemptInput({ loopInput: passingLoopInput({ attemptId: "attempt-2" }), governor: governorWithoutRateLimitState }),
      { ...deps, nowMs: deps.nowMs + 100 },
    );
    expect(second.outcome).toBe("governed");
    if (second.outcome !== "governed") throw new Error("expected governed");
    expect(second.decision.stage).toBe("rate_limit");
  });

  it("fails closed on malformed input", async () => {
    const deps = baseDeps();
    await expect(runMinerAttempt(null as never, deps)).rejects.toThrow("invalid_attempt_input");
    await expect(runMinerAttempt({} as never, deps)).rejects.toThrow("invalid_loop_input");
    await expect(runMinerAttempt(baseAttemptInput({ issueNumber: 0 }), deps)).rejects.toThrow("invalid_issue_number");
    await expect(runMinerAttempt(baseAttemptInput({ minerLogin: "" }), deps)).rejects.toThrow("invalid_miner_login");
    await expect(runMinerAttempt(baseAttemptInput({ base: "" }), deps)).rejects.toThrow("invalid_base");
    await expect(runMinerAttempt(baseAttemptInput({ killSwitchScope: "bogus" }), deps)).rejects.toThrow("invalid_kill_switch_scope");
    await expect(runMinerAttempt(baseAttemptInput({ slopThreshold: "bogus" }), deps)).rejects.toThrow("invalid_slop_threshold");
    await expect(runMinerAttempt(baseAttemptInput({ submissionMode: "bogus" }), deps)).rejects.toThrow("invalid_submission_mode");
    await expect(runMinerAttempt(baseAttemptInput({ governor: null }), deps)).rejects.toThrow("invalid_governor_context");
  });

  it("fails closed on malformed or missing deps", async () => {
    const input = baseAttemptInput();
    const full = baseDeps();
    await expect(runMinerAttempt(input, null as never)).rejects.toThrow("invalid_attempt_deps");
    await expect(runMinerAttempt(input, { ...full, runSlopAssessment: undefined } as never)).rejects.toThrow("invalid_run_slop_assessment");
    await expect(runMinerAttempt(input, { ...full, appendAttemptLogEvent: undefined } as never)).rejects.toThrow("invalid_append_attempt_log_event");
    await expect(runMinerAttempt(input, { ...full, fetchLiveIssueSnapshot: undefined } as never)).rejects.toThrow("invalid_fetch_live_issue_snapshot");
    await expect(runMinerAttempt(input, { ...full, executeLocalWrite: undefined } as never)).rejects.toThrow("invalid_execute_local_write");
    await expect(runMinerAttempt(input, { ...full, driver: undefined } as never)).rejects.toThrow("invalid_driver");
    await expect(runMinerAttempt(input, { ...full, claimLedger: undefined } as never)).rejects.toThrow("invalid_claim_ledger");
    await expect(runMinerAttempt(input, { ...full, eventLedger: undefined } as never)).rejects.toThrow("invalid_event_ledger");
    await expect(runMinerAttempt(input, { ...full, nowMs: Number.NaN } as never)).rejects.toThrow("invalid_now_ms");
  });
});
