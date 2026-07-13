import { describe, expect, it } from "vitest";
import {
  AMS_MINER_USAGE_PROVIDER_NAMES,
  buildAmsMinerUsageProviderSqlFilter,
  buildAmsMinerUsageProviderWhereClause,
  buildAttemptLogDriverUsagePayload,
  createFakeCodingAgentDriver,
  invokeCodingAgentDriver,
  isAmsMinerUsageProviderName,
  parseFocusManifest,
  resolveAmsMinerUsageProviderFilter,
  runIterateLoop,
  type AttemptLogEvent,
} from "../../packages/gittensory-engine/src/index";

describe("ams-miner-usage-grafana (#5185)", () => {
  it("lists the three AMS coding-agent providers", () => {
    expect(AMS_MINER_USAGE_PROVIDER_NAMES).toEqual(["claude-cli", "codex-cli", "agent-sdk"]);
  });

  it("classifies provider filters for all, one, and invalid selections", () => {
    expect(resolveAmsMinerUsageProviderFilter("$__all")).toEqual({ mode: "all" });
    expect(resolveAmsMinerUsageProviderFilter("")).toEqual({ mode: "all" });
    expect(resolveAmsMinerUsageProviderFilter(null)).toEqual({ mode: "all" });
    expect(resolveAmsMinerUsageProviderFilter(undefined)).toEqual({ mode: "all" });
    expect(resolveAmsMinerUsageProviderFilter("claude-cli")).toEqual({ mode: "one", provider: "claude-cli" });
    expect(resolveAmsMinerUsageProviderFilter("codex-cli")).toEqual({ mode: "one", provider: "codex-cli" });
    expect(resolveAmsMinerUsageProviderFilter("agent-sdk")).toEqual({ mode: "one", provider: "agent-sdk" });
    expect(resolveAmsMinerUsageProviderFilter("mystery")).toEqual({ mode: "invalid" });
  });

  it("isAmsMinerUsageProviderName is true only for bounded provider names", () => {
    expect(isAmsMinerUsageProviderName("claude-cli")).toBe(true);
    expect(isAmsMinerUsageProviderName("agent-sdk")).toBe(true);
    expect(isAmsMinerUsageProviderName("noop")).toBe(false);
    expect(isAmsMinerUsageProviderName("")).toBe(false);
  });

  it("buildAmsMinerUsageProviderWhereClause fails closed on invalid providers", () => {
    expect(buildAmsMinerUsageProviderWhereClause("$__all")).toBe("1=1");
    expect(buildAmsMinerUsageProviderWhereClause("codex-cli")).toBe("driver_provider = 'codex-cli'");
    expect(buildAmsMinerUsageProviderWhereClause("mystery")).toBe("1=0");
  });

  it("buildAmsMinerUsageProviderSqlFilter supports a custom template variable name", () => {
    expect(buildAmsMinerUsageProviderSqlFilter()).toBe(
      "(${provider:sqlstring} = '$__all' OR driver_provider = ${provider:sqlstring})",
    );
    expect(buildAmsMinerUsageProviderSqlFilter("driver")).toBe(
      "(${driver:sqlstring} = '$__all' OR driver_provider = ${driver:sqlstring})",
    );
  });
});

describe("attempt-log usage payload (#5185)", () => {
  it("stamps driverProvider and optional metering fields", () => {
    expect(buildAttemptLogDriverUsagePayload({})).toEqual({});
    expect(buildAttemptLogDriverUsagePayload({ driverProvider: "" })).toEqual({});
    expect(buildAttemptLogDriverUsagePayload({ driverProvider: "claude-cli" })).toEqual({
      driverProvider: "claude-cli",
    });
    expect(
      buildAttemptLogDriverUsagePayload({
        driverProvider: "agent-sdk",
        meterTotals: { tokens: 0, turns: 4, wallClockMs: 50, costUsd: 0.25 },
        includeMetering: true,
      }),
    ).toEqual({ driverProvider: "agent-sdk", turnsUsed: 4, tokensUsed: 0, costUsd: 0.25 });
    expect(
      buildAttemptLogDriverUsagePayload({
        meterTotals: { tokens: 1, turns: 2, wallClockMs: 10, costUsd: 0.5 },
        includeMetering: false,
      }),
    ).toEqual({});
  });
});

describe("iterate-loop driverProvider stamping (#5185)", () => {
  const task = {
    attemptId: "usage-1",
    workingDirectory: "/tmp/wt",
    acceptanceCriteriaPath: "/tmp/wt/acceptance.json",
    instructions: "fix it",
    maxTurns: 3,
  };

  it("threads driverProvider through dry_run invokeCodingAgentDriver and terminal iterate-loop events", async () => {
    const invokeEvents: AttemptLogEvent[] = [];
    await invokeCodingAgentDriver(createFakeCodingAgentDriver(), "dry_run", task, {
      append: (event) => invokeEvents.push(event),
    }, { driverProvider: "codex-cli" });
    expect(invokeEvents.at(-1)?.payload?.driverProvider).toBe("codex-cli");

    const driver = createFakeCodingAgentDriver({
      run: async () => ({
        ok: true,
        changedFiles: ["src/a.ts"],
        summary: "done",
        turnsUsed: 2,
        costUsd: 0.03,
      }),
    });
    const liveEvents: AttemptLogEvent[] = [];
    await invokeCodingAgentDriver(driver, "live", task, { append: (event) => liveEvents.push(event) }, {
      driverProvider: "claude-cli",
    });
    const liveTerminal = liveEvents.at(-1);
    expect(liveTerminal?.payload?.driverProvider).toBe("claude-cli");
    expect(liveTerminal?.payload?.turnsUsed).toBe(2);
    expect(liveTerminal?.payload?.costUsd).toBe(0.03);

    const loopEvents: AttemptLogEvent[] = [];
    await runIterateLoop(
      {
        attemptId: "usage-2",
        workingDirectory: "/tmp/wt",
        acceptanceCriteriaPath: "/tmp/wt/acceptance.json",
        instructions: "fix it",
        mode: "dry_run",
        maxIterations: 0,
        maxTurnsPerIteration: 3,
        repoFullName: "acme/widgets",
        contributorLogin: "miner",
        title: "title",
        reviewContext: {
          manifest: parseFocusManifest({ gate: { duplicates: "block", linkedIssue: "advisory" } }),
          repo: { fullName: "acme/widgets", owner: "acme", name: "widgets", isInstalled: true, isRegistered: true, isPrivate: false },
          issues: [],
          pullRequests: [],
        },
        rejectionSignaled: false,
      },
      {
        driver: createFakeCodingAgentDriver(),
        runSlopAssessment: () => ({ slopRisk: 0, band: "clean", findings: [] }),
        appendAttemptLogEvent: (event) => loopEvents.push(event),
        driverProvider: "agent-sdk",
      },
    );
    const terminal = loopEvents.find((event) => event.eventType === "attempt_aborted");
    expect(terminal?.payload?.driverProvider).toBe("agent-sdk");
    expect(terminal?.payload?.turnsUsed).toBe(0);
    expect(terminal?.payload?.costUsd).toBe(0);
  });

  it("stamps driverProvider and cumulative metering on a successful handoff", async () => {
    const loopEvents: AttemptLogEvent[] = [];
    const result = await runIterateLoop(
      {
        attemptId: "usage-handoff",
        workingDirectory: "/tmp/attempt-1",
        acceptanceCriteriaPath: "/tmp/attempt-1/acceptance-criteria.json",
        instructions: "Add retry to the upload client",
        mode: "live",
        maxIterations: 3,
        maxTurnsPerIteration: 20,
        repoFullName: "acme/widgets",
        contributorLogin: "miner1",
        title: "Add retry to the upload client",
        body: "Closes #7",
        linkedIssues: [7],
        reviewContext: {
          manifest: parseFocusManifest({ gate: { duplicates: "block", linkedIssue: "advisory" } }),
          repo: { fullName: "acme/widgets", owner: "acme", name: "widgets", isInstalled: true, isRegistered: true, isPrivate: false },
          issues: [{ repoFullName: "acme/widgets", number: 7, title: "Uploads should retry on 5xx", state: "open", labels: [], linkedPrs: [] }],
          pullRequests: [],
        },
        rejectionSignaled: false,
      },
      {
        driver: createFakeCodingAgentDriver({
          run: async () => ({
            ok: true,
            changedFiles: ["src/upload.ts"],
            summary: "added retry logic",
            turnsUsed: 5,
            tokensUsed: 1200,
            costUsd: 0.08,
          }),
        }),
        runSlopAssessment: () => ({ slopRisk: 0, band: "clean", findings: [] }),
        appendAttemptLogEvent: (event) => loopEvents.push(event),
        driverProvider: "claude-cli",
      },
    );

    expect(result.outcome).toBe("handoff");
    expect(loopEvents.find((event) => event.eventType === "attempt_started")?.payload?.driverProvider).toBe("claude-cli");
    const succeeded = loopEvents.find((event) => event.eventType === "attempt_succeeded");
    expect(succeeded?.payload?.driverProvider).toBe("claude-cli");
    expect(succeeded?.payload?.turnsUsed).toBe(5);
    expect(succeeded?.payload?.tokensUsed).toBe(1200);
    expect(succeeded?.payload?.costUsd).toBe(0.08);
  });

  it("records budgetBreaches on a hard budget-ceiling abandon and omits metering on continue iterations", async () => {
    const loopEvents: AttemptLogEvent[] = [];
    const duplicateBlockerContext = {
      manifest: parseFocusManifest({ gate: { duplicates: "block", linkedIssue: "advisory" } }),
      repo: { fullName: "acme/widgets", owner: "acme", name: "widgets", isInstalled: true, isRegistered: true, isPrivate: false },
      issues: [{ repoFullName: "acme/widgets", number: 7, title: "Uploads should retry on 5xx", state: "open", labels: [], linkedPrs: [] }],
      pullRequests: [
        {
          repoFullName: "acme/widgets",
          number: 99,
          title: "Duplicate PR",
          state: "open" as const,
          authorLogin: "miner1",
          linkedIssues: [7],
          labels: [],
        },
      ],
    };
    await runIterateLoop(
      {
        attemptId: "usage-continue",
        workingDirectory: "/tmp/attempt-1",
        acceptanceCriteriaPath: "/tmp/attempt-1/acceptance-criteria.json",
        instructions: "Add retry to the upload client",
        mode: "live",
        maxIterations: 2,
        maxTurnsPerIteration: 20,
        repoFullName: "acme/widgets",
        contributorLogin: "miner1",
        title: "Add retry to the upload client",
        body: "Closes #7",
        linkedIssues: [7],
        reviewContext: duplicateBlockerContext,
        rejectionSignaled: false,
      },
      {
        driver: createFakeCodingAgentDriver({
          run: async () => ({
            ok: true,
            changedFiles: ["src/upload.ts"],
            summary: "added retry logic",
            turnsUsed: 1,
            tokensUsed: 50,
            costUsd: 0.01,
          }),
        }),
        runSlopAssessment: () => ({ slopRisk: 0, band: "clean", findings: [] }),
        appendAttemptLogEvent: (event) => loopEvents.push(event),
        driverProvider: "codex-cli",
      },
    );
    const continueEvent = loopEvents.find((event) => event.eventType === "attempt_tool_edit");
    expect(continueEvent?.payload?.driverProvider).toBe("codex-cli");
    expect(continueEvent?.payload?.turnsUsed).toBeUndefined();

    const budgetEvents: AttemptLogEvent[] = [];
    await runIterateLoop(
      {
        attemptId: "usage-budget",
        workingDirectory: "/tmp/attempt-1",
        acceptanceCriteriaPath: "/tmp/attempt-1/acceptance-criteria.json",
        instructions: "Add retry to the upload client",
        mode: "live",
        maxIterations: 3,
        maxTurnsPerIteration: 1,
        budget: { maxTurns: 1 },
        repoFullName: "acme/widgets",
        contributorLogin: "miner1",
        title: "Add retry to the upload client",
        body: "Closes #7",
        linkedIssues: [7],
        reviewContext: {
          manifest: parseFocusManifest({ gate: { duplicates: "block", linkedIssue: "advisory" } }),
          repo: { fullName: "acme/widgets", owner: "acme", name: "widgets", isInstalled: true, isRegistered: true, isPrivate: false },
          issues: [{ repoFullName: "acme/widgets", number: 7, title: "Uploads should retry on 5xx", state: "open", labels: [], linkedPrs: [] }],
          pullRequests: [],
        },
        rejectionSignaled: false,
      },
      {
        driver: createFakeCodingAgentDriver({
          run: async () => ({
            ok: true,
            changedFiles: ["src/upload.ts"],
            summary: "added retry logic",
            turnsUsed: 2,
            tokensUsed: 80,
            costUsd: 0.02,
          }),
        }),
        runSlopAssessment: () => ({ slopRisk: 0, band: "clean", findings: [] }),
        appendAttemptLogEvent: (event) => budgetEvents.push(event),
        driverProvider: "agent-sdk",
      },
    );
    const budgetAbandon = budgetEvents.find((event) => event.eventType === "attempt_failed");
    expect(budgetAbandon?.payload?.budgetBreaches).toEqual(["turns"]);
    expect(budgetAbandon?.payload?.tokensUsed).toBe(80);
    expect(budgetAbandon?.payload?.driverProvider).toBe("agent-sdk");
  });

  it("normalizes a thrown live driver into an ambiguous abandon without crashing", async () => {
    const loopEvents: AttemptLogEvent[] = [];
    const result = await runIterateLoop(
      {
        attemptId: "usage-throw",
        workingDirectory: "/tmp/attempt-1",
        acceptanceCriteriaPath: "/tmp/attempt-1/acceptance-criteria.json",
        instructions: "Add retry to the upload client",
        mode: "live",
        maxIterations: 1,
        maxTurnsPerIteration: 20,
        repoFullName: "acme/widgets",
        contributorLogin: "miner1",
        title: "Add retry to the upload client",
        body: "Closes #7",
        linkedIssues: [7],
        reviewContext: {
          manifest: parseFocusManifest({ gate: { duplicates: "block", linkedIssue: "advisory" } }),
          repo: { fullName: "acme/widgets", owner: "acme", name: "widgets", isInstalled: true, isRegistered: true, isPrivate: false },
          issues: [{ repoFullName: "acme/widgets", number: 7, title: "Uploads should retry on 5xx", state: "open", labels: [], linkedPrs: [] }],
          pullRequests: [],
        },
        rejectionSignaled: false,
      },
      {
        driver: createFakeCodingAgentDriver({
          run: async () => {
            throw new Error("spawn failed");
          },
        }),
        runSlopAssessment: () => ({ slopRisk: 0, band: "clean", findings: [] }),
        appendAttemptLogEvent: (event) => loopEvents.push(event),
        driverProvider: "claude-cli",
      },
    );
    expect(result.outcome).toBe("abandon");
    expect(loopEvents.at(-1)?.eventType).toBe("attempt_aborted");
    expect(loopEvents.at(-1)?.payload?.driverProvider).toBe("claude-cli");
  });
});
