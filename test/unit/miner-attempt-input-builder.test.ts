import { describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { buildAttemptGovernorContext, buildAttemptLoopInput } from "../../packages/gittensory-miner/lib/attempt-input-builder.js";
import { DEFAULT_AMS_POLICY_SPEC, parseFocusManifest } from "../../packages/gittensory-engine/src/index";

function codingTaskSpec(overrides: Record<string, unknown> = {}) {
  return {
    ready: true as const,
    verdict: "go" as const,
    feasibility: { verdict: "go" as const, avoidReasons: [], raiseReasons: [], summary: "ready" },
    acceptanceCriteriaPath: "/fake/repo/.gittensory-worktrees/fake/acceptance-criteria.json",
    instructions: "Resolve issue #7",
    title: "Uploads should retry on 5xx",
    body: "Uploads fail silently.",
    labels: ["bug"],
    linkedIssues: [7],
    ...overrides,
  };
}

function reviewContext() {
  return {
    manifest: parseFocusManifest(undefined),
    repo: { fullName: "acme/widgets", owner: "acme", name: "widgets", isInstalled: true, isRegistered: true, isPrivate: false, htmlUrl: "https://github.com/acme/widgets", defaultBranch: "main" },
    issues: [],
    pullRequests: [],
  };
}

describe("buildAttemptGovernorContext (#5132)", () => {
  it("reflects the global kill switch and live-mode env vars, uses AmsPolicySpec's real capLimits", () => {
    const ctx = buildAttemptGovernorContext(
      { GITTENSORY_MINER_KILL_SWITCH: "1", GITTENSORY_MINER_LIVE_MODE: "live" },
      { ...DEFAULT_AMS_POLICY_SPEC, capLimits: { budget: 9, turns: 8, elapsedMs: 7 } },
    );
    expect(ctx.killSwitchGlobal).toBe(true);
    expect(ctx.liveModeGlobalOptIn).toBe(true);
    expect(ctx.capLimits).toEqual({ budget: 9, turns: 8, elapsedMs: 7 });
  });

  it("defaults to false/off when neither env var is set", () => {
    const ctx = buildAttemptGovernorContext({}, DEFAULT_AMS_POLICY_SPEC);
    expect(ctx.killSwitchGlobal).toBe(false);
    expect(ctx.liveModeGlobalOptIn).toBe(false);
  });

  it("REGRESSION: killSwitchRepoPaused threads the caller's real per-repo pause value through (#5392)", () => {
    const ctx = buildAttemptGovernorContext({}, DEFAULT_AMS_POLICY_SPEC, true);
    expect(ctx.killSwitchRepoPaused).toBe(true);
  });

  it("killSwitchRepoPaused defaults to undefined when the caller omits it", () => {
    const ctx = buildAttemptGovernorContext({}, DEFAULT_AMS_POLICY_SPEC);
    expect(ctx.killSwitchRepoPaused).toBeUndefined();
  });

  it("REGRESSION: convergenceInput is an honest first-attempt-shaped literal, not fabricated real history", () => {
    const ctx = buildAttemptGovernorContext({}, DEFAULT_AMS_POLICY_SPEC);
    expect(ctx.convergenceInput).toEqual({ attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false });
  });

  it("omits rateLimitBuckets/rateLimitBackoffAttempts/capUsage so the persisted governor-state store auto-supplies them", () => {
    const ctx = buildAttemptGovernorContext({}, DEFAULT_AMS_POLICY_SPEC);
    expect(ctx).not.toHaveProperty("rateLimitBuckets");
    expect(ctx).not.toHaveProperty("rateLimitBackoffAttempts");
    expect(ctx).not.toHaveProperty("capUsage");
  });
});

describe("buildAttemptLoopInput (#5132)", () => {
  it("assembles a real IterateLoopInput from every already-computed dependency", () => {
    const loopInput = buildAttemptLoopInput({
      codingTaskSpec: codingTaskSpec(),
      reviewContext: reviewContext(),
      worktreePath: "/fake/repo/.gittensory-worktrees/fake",
      attemptId: "acme_widgets-7-12345",
      mode: "dry_run",
      repoFullName: "acme/widgets",
      minerLogin: "alice",
      rejectionSignaled: false,
      amsPolicySpec: DEFAULT_AMS_POLICY_SPEC,
    });

    expect(loopInput).toEqual({
      attemptId: "acme_widgets-7-12345",
      workingDirectory: "/fake/repo/.gittensory-worktrees/fake",
      acceptanceCriteriaPath: "/fake/repo/.gittensory-worktrees/fake/acceptance-criteria.json",
      instructions: "Resolve issue #7",
      mode: "dry_run",
      maxIterations: DEFAULT_AMS_POLICY_SPEC.maxIterations,
      maxTurnsPerIteration: DEFAULT_AMS_POLICY_SPEC.maxTurnsPerIteration,
      budget: {
        maxTurns: DEFAULT_AMS_POLICY_SPEC.capLimits.turns,
        maxWallClockMs: DEFAULT_AMS_POLICY_SPEC.capLimits.elapsedMs,
        maxCostUsd: DEFAULT_AMS_POLICY_SPEC.capLimits.budget,
      },
      repoFullName: "acme/widgets",
      contributorLogin: "alice",
      title: "Uploads should retry on 5xx",
      body: "Uploads fail silently.",
      labels: ["bug"],
      linkedIssues: [7],
      branchRef: undefined,
      reviewContext: reviewContext(),
      rejectionSignaled: false,
    });
  });

  it("REGRESSION (#5395): budget mirrors AmsPolicySpec's real capLimits, not hardcoded literals", () => {
    const loopInput = buildAttemptLoopInput({
      codingTaskSpec: codingTaskSpec(),
      reviewContext: reviewContext(),
      worktreePath: "/fake",
      attemptId: "a1",
      mode: "dry_run",
      repoFullName: "acme/widgets",
      minerLogin: "alice",
      rejectionSignaled: false,
      amsPolicySpec: { ...DEFAULT_AMS_POLICY_SPEC, capLimits: { budget: 9, turns: 8, elapsedMs: 7 } },
    });
    expect(loopInput.budget).toEqual({ maxTurns: 8, maxWallClockMs: 7, maxCostUsd: 9 });
  });

  it("threads a real rejectionSignaled:true through unchanged", () => {
    const loopInput = buildAttemptLoopInput({
      codingTaskSpec: codingTaskSpec(),
      reviewContext: reviewContext(),
      worktreePath: "/fake",
      attemptId: "a1",
      mode: "live",
      repoFullName: "acme/widgets",
      minerLogin: "alice",
      rejectionSignaled: true,
      amsPolicySpec: DEFAULT_AMS_POLICY_SPEC,
    });
    expect(loopInput.rejectionSignaled).toBe(true);
    expect(loopInput.mode).toBe("live");
  });

  it("uses AmsPolicySpec's real maxIterations/maxTurnsPerIteration, not hardcoded literals", () => {
    const loopInput = buildAttemptLoopInput({
      codingTaskSpec: codingTaskSpec(),
      reviewContext: reviewContext(),
      worktreePath: "/fake",
      attemptId: "a1",
      mode: "dry_run",
      repoFullName: "acme/widgets",
      minerLogin: "alice",
      rejectionSignaled: false,
      amsPolicySpec: { ...DEFAULT_AMS_POLICY_SPEC, maxIterations: 9, maxTurnsPerIteration: 4 },
    });
    expect(loopInput.maxIterations).toBe(9);
    expect(loopInput.maxTurnsPerIteration).toBe(4);
  });

  it("passes an explicit branchRef through when provided", () => {
    const loopInput = buildAttemptLoopInput({
      codingTaskSpec: codingTaskSpec(),
      reviewContext: reviewContext(),
      worktreePath: "/fake",
      attemptId: "a1",
      mode: "dry_run",
      repoFullName: "acme/widgets",
      minerLogin: "alice",
      rejectionSignaled: false,
      amsPolicySpec: DEFAULT_AMS_POLICY_SPEC,
      branchRef: "gittensory/attempt/a1",
    });
    expect(loopInput.branchRef).toBe("gittensory/attempt/a1");
  });

  it("omits body/labels/linkedIssues when the coding-task-spec itself omits them", () => {
    const loopInput = buildAttemptLoopInput({
      codingTaskSpec: codingTaskSpec({ body: undefined, labels: undefined, linkedIssues: [] }),
      reviewContext: reviewContext(),
      worktreePath: "/fake",
      attemptId: "a1",
      mode: "dry_run",
      repoFullName: "acme/widgets",
      minerLogin: "alice",
      rejectionSignaled: false,
      amsPolicySpec: DEFAULT_AMS_POLICY_SPEC,
    });
    expect(loopInput.body).toBeUndefined();
    expect(loopInput.labels).toBeUndefined();
    expect(loopInput.linkedIssues).toEqual([]);
  });
});
