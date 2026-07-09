import { describe, expect, it } from "vitest";
import {
  ATTEMPT_LOG_EVENT_TYPES,
  CODING_AGENT_DRIVER_CONFIG_ENV,
  CODING_AGENT_DRIVER_NAMES,
  codingAgentModeExecutes,
  createAttemptLogBuffer,
  createCodingAgentDriver,
  createFakeCodingAgentDriver,
  createFakeCodingAgentDriverForFactory,
  createNoopCodingAgentDriver,
  formatAttemptLogJsonl,
  invokeCodingAgentDriver,
  isConfiguredCodingAgentDriver,
  isGlobalMinerCodingAgentPause,
  normalizeAttemptLogEvent,
  resolveCodingAgentExecutionMode,
  resolveCodingAgentModeFromConfig,
  resolveConfiguredCodingAgentDriverNames,
  runCodingAgentAttempt,
  type CodingAgentDriverTask,
} from "../../packages/gittensory-engine/src/index";

const task: CodingAgentDriverTask = {
  attemptId: "attempt-1",
  workingDirectory: "/tmp/work",
  acceptanceCriteriaPath: "/tmp/work/ACCEPTANCE.md",
  instructions: "fix the flaky test",
  maxTurns: 8,
};

describe("coding-agent execution mode (#4313)", () => {
  it("resolveCodingAgentExecutionMode: pause beats dry-run beats live", () => {
    expect(resolveCodingAgentExecutionMode({ globalPaused: true })).toBe("paused");
    expect(resolveCodingAgentExecutionMode({ globalPaused: true, agentDryRun: true })).toBe("paused");
    expect(resolveCodingAgentExecutionMode({ globalPaused: false, agentPaused: true })).toBe("paused");
    expect(resolveCodingAgentExecutionMode({ globalPaused: false, agentDryRun: true })).toBe("dry_run");
    expect(resolveCodingAgentExecutionMode({ globalPaused: false })).toBe("live");
    expect(
      resolveCodingAgentExecutionMode({ globalPaused: false, agentPaused: false, agentDryRun: false }),
    ).toBe("live");
    expect(
      resolveCodingAgentExecutionMode({ globalPaused: false, agentPaused: null, agentDryRun: null }),
    ).toBe("live");
  });

  it("codingAgentModeExecutes is true only for live", () => {
    expect(codingAgentModeExecutes("live")).toBe(true);
    expect(codingAgentModeExecutes("dry_run")).toBe(false);
    expect(codingAgentModeExecutes("paused")).toBe(false);
  });

  it("isGlobalMinerCodingAgentPause recognizes truthy-string forms", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      expect(isGlobalMinerCodingAgentPause({ MINER_CODING_AGENT_PAUSED: value })).toBe(true);
    }
    for (const value of ["0", "false", "no", "off", "", "maybe", undefined]) {
      expect(isGlobalMinerCodingAgentPause({ MINER_CODING_AGENT_PAUSED: value })).toBe(false);
    }
    expect(isGlobalMinerCodingAgentPause({})).toBe(false);
  });

  it("resolveCodingAgentModeFromConfig reads the global pause env", () => {
    expect(
      resolveCodingAgentModeFromConfig({
        env: { MINER_CODING_AGENT_PAUSED: "true" },
        agentDryRun: true,
      }),
    ).toBe("paused");
  });
});

describe("CodingAgentDriver contract (#4262)", () => {
  it("createFakeCodingAgentDriver records the last task and returns ok", async () => {
    const driver = createFakeCodingAgentDriver();
    const result = await driver.run(task);
    expect(driver.lastTask).toEqual(task);
    expect(result.ok).toBe(true);
    expect(result.changedFiles).toEqual([]);
  });

  it("createFakeCodingAgentDriver honors a custom run implementation", async () => {
    const driver = createFakeCodingAgentDriver({
      run: async () => ({
        ok: false,
        changedFiles: ["a.ts"],
        summary: "custom",
        error: "nope",
      }),
    });
    const result = await driver.run(task);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("nope");
  });

  it("createNoopCodingAgentDriver acknowledges the attempt without IO", async () => {
    const driver = createNoopCodingAgentDriver();
    const result = await driver.run(task);
    expect(result.summary).toMatch(/noop driver acknowledged attempt-1/);
    expect(result.turnsUsed).toBe(0);
  });
});

describe("attempt log normalization (#4294)", () => {
  it("exposes a frozen event vocabulary", () => {
    expect([...ATTEMPT_LOG_EVENT_TYPES]).toEqual([
      "attempt_started",
      "attempt_shadow",
      "attempt_succeeded",
      "attempt_failed",
      "attempt_aborted",
    ]);
    expect(Object.isFrozen(ATTEMPT_LOG_EVENT_TYPES)).toBe(true);
  });

  it("normalizes a valid event with payload round-trip", () => {
    const normalized = normalizeAttemptLogEvent({
      eventType: "attempt_shadow",
      attemptId: "a-1",
      actionClass: "codegen",
      mode: "dry_run",
      reason: "dry-run shadow",
      payload: { workingDirectory: "/tmp/work" },
    });
    expect(normalized.mode).toBe("dry_run");
    expect(JSON.parse(normalized.payloadJson).workingDirectory).toBe("/tmp/work");
  });

  it("accepts nested array fields in JSON-round-tripped payloads", () => {
    const normalized = normalizeAttemptLogEvent({
      eventType: "attempt_succeeded",
      attemptId: "a-1",
      actionClass: "codegen",
      mode: "live",
      reason: "done",
      payload: { changedFiles: ["a.ts", "b.ts"], turnsUsed: 2 },
    });
    expect(JSON.parse(normalized.payloadJson)).toEqual({ changedFiles: ["a.ts", "b.ts"], turnsUsed: 2 });
  });

  it("defaults missing payload to {}", () => {
    expect(
      normalizeAttemptLogEvent({
        eventType: "attempt_started",
        attemptId: "a-1",
        actionClass: "codegen",
        mode: "live",
        reason: "live run",
      }).payloadJson,
    ).toBe("{}");
  });

  it("rejects unknown event types, modes, and malformed required fields", () => {
    const base = {
      attemptId: "a-1",
      actionClass: "codegen",
      mode: "dry_run",
      reason: "x",
    };
    expect(() => normalizeAttemptLogEvent({ ...base, eventType: "bogus" })).toThrow(/invalid_event_type/);
    expect(() => normalizeAttemptLogEvent({ ...base, eventType: "attempt_shadow", mode: "bogus" })).toThrow(
      /invalid_mode/,
    );
    expect(() => normalizeAttemptLogEvent(null)).toThrow(/invalid_event/);
    expect(() => normalizeAttemptLogEvent("not-an-object")).toThrow(/invalid_event/);
    expect(() =>
      normalizeAttemptLogEvent({ ...base, eventType: "attempt_shadow", attemptId: "  " }),
    ).toThrow(/invalid_attempt_id/);
    expect(() =>
      normalizeAttemptLogEvent({ ...base, eventType: "attempt_shadow", actionClass: 0 } as unknown),
    ).toThrow(/invalid_action_class/);
    expect(() =>
      normalizeAttemptLogEvent({ ...base, eventType: "attempt_shadow", reason: "  " }),
    ).toThrow(/invalid_reason/);
    expect(() =>
      normalizeAttemptLogEvent({ ...base, eventType: "attempt_shadow", payload: null } as unknown),
    ).toThrow(/invalid_payload/);
    expect(() =>
      normalizeAttemptLogEvent({ ...base, eventType: "attempt_shadow", payload: ["bad"] } as unknown),
    ).toThrow(/invalid_payload/);
    expect(() =>
      normalizeAttemptLogEvent({ ...base, eventType: "attempt_shadow", payload: { value: undefined } }),
    ).toThrow(/invalid_payload/);
    expect(() =>
      normalizeAttemptLogEvent({
        ...base,
        eventType: "attempt_shadow",
        payload: { value: BigInt(1) },
      }),
    ).toThrow(/invalid_payload/);
  });

  it("createAttemptLogBuffer appends normalized rows and exports JSONL", () => {
    const buffer = createAttemptLogBuffer();
    buffer.append({
      eventType: "attempt_started",
      attemptId: "a-1",
      actionClass: "codegen",
      mode: "live",
      reason: "live run",
    });
    buffer.append({
      eventType: "attempt_succeeded",
      attemptId: "a-1",
      actionClass: "codegen",
      mode: "live",
      reason: "done",
    });
    expect(buffer.events()).toHaveLength(2);
    const jsonl = formatAttemptLogJsonl(buffer.events());
    expect(jsonl.split("\n")).toHaveLength(2);
    expect(buffer.jsonl()).toBe(jsonl);
    expect(formatAttemptLogJsonl([])).toBe("");
  });
});

describe("invokeCodingAgentDriver (#4313)", () => {
  it("paused never calls the underlying driver", async () => {
    const driver = createFakeCodingAgentDriver();
    const log = createAttemptLogBuffer();
    const result = await invokeCodingAgentDriver(driver, "paused", task, log);
    expect(driver.lastTask).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("coding_agent_paused");
    expect(log.events().at(-1)?.eventType).toBe("attempt_aborted");
  });

  it("paused without a log sink still returns denied", async () => {
    const driver = createFakeCodingAgentDriver();
    const result = await invokeCodingAgentDriver(driver, "paused", task);
    expect(driver.lastTask).toBeNull();
    expect(result.error).toBe("coding_agent_paused");
  });

  it("dry_run records attempt_shadow without calling the driver", async () => {
    const driver = createFakeCodingAgentDriver();
    const log = createAttemptLogBuffer();
    const result = await invokeCodingAgentDriver(driver, "dry_run", task, log);
    expect(driver.lastTask).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/dry-run: would invoke coding agent/);
    expect(log.events().at(-1)?.eventType).toBe("attempt_shadow");
  });

  it("live delegates to the driver and logs success", async () => {
    const driver = createFakeCodingAgentDriver();
    const log = createAttemptLogBuffer();
    const result = await invokeCodingAgentDriver(driver, "live", task, log);
    expect(driver.lastTask).toEqual(task);
    expect(result.ok).toBe(true);
    expect(log.events().map((event) => event.eventType)).toEqual(["attempt_started", "attempt_succeeded"]);
  });

  it("live records attempt_failed when the driver returns ok=false", async () => {
    const driver = createFakeCodingAgentDriver({
      run: async () => ({
        ok: false,
        changedFiles: [],
        summary: "driver declined",
        error: "declined",
      }),
    });
    const log = createAttemptLogBuffer();
    const result = await invokeCodingAgentDriver(driver, "live", task, log);
    expect(result.ok).toBe(false);
    expect(log.events().at(-1)?.eventType).toBe("attempt_failed");
  });

  it("live records attempt_failed when the driver throws", async () => {
    const driver = createFakeCodingAgentDriver({
      run: async () => {
        throw new Error("spawn failed");
      },
    });
    const log = createAttemptLogBuffer();
    const result = await invokeCodingAgentDriver(driver, "live", task, log);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("spawn failed");
    expect(log.events().at(-1)?.eventType).toBe("attempt_failed");
  });

  it("live degrades non-Error throws to unknown error", async () => {
    const driver = createFakeCodingAgentDriver({
      run: async () => {
        throw "boom";
      },
    });
    const result = await invokeCodingAgentDriver(driver, "live", task);
    expect(result.error).toBe("unknown error");
  });
});

describe("coding-agent driver factory (#4289)", () => {
  it("exposes the noop provider registry", () => {
    expect([...CODING_AGENT_DRIVER_NAMES]).toEqual(["noop"]);
    expect(CODING_AGENT_DRIVER_CONFIG_ENV.noop).toEqual({});
  });

  it("isConfiguredCodingAgentDriver is deny-by-default for unknown names", () => {
    expect(isConfiguredCodingAgentDriver("noop", {})).toBe(true);
    expect(isConfiguredCodingAgentDriver("claude-code", {})).toBe(false);
    expect(isConfiguredCodingAgentDriver("unknown", {})).toBe(false);
  });

  it("resolveConfiguredCodingAgentDriverNames filters to configured providers only", () => {
    expect(
      resolveConfiguredCodingAgentDriverNames({ MINER_CODING_AGENT_PROVIDER: " noop , unknown , " }),
    ).toEqual(["noop"]);
    expect(resolveConfiguredCodingAgentDriverNames({})).toEqual([]);
  });

  it("createCodingAgentDriver returns injected drivers or resolves noop", () => {
    const injected = createFakeCodingAgentDriver();
    expect(createCodingAgentDriver({ providerName: "noop", driver: injected })).toBe(injected);
    expect(createCodingAgentDriver({ providerName: " NOOP " }).constructor).toBe(
      createNoopCodingAgentDriver().constructor,
    );
    expect(() => createCodingAgentDriver({ providerName: "unknown" })).toThrow(/unconfigured_coding_agent_driver/);
  });

  it("createFakeCodingAgentDriverForFactory is an identity helper", () => {
    expect(createFakeCodingAgentDriverForFactory().run).toBeTypeOf("function");
  });

  it("runCodingAgentAttempt wires mode + driver + attempt log end-to-end", async () => {
    const log = createAttemptLogBuffer();
    const fake = createFakeCodingAgentDriver();

    const dry = await runCodingAgentAttempt({
      providerName: "noop",
      agentDryRun: true,
      task,
      log,
      driver: fake,
    });
    expect(dry.mode).toBe("dry_run");
    expect(fake.lastTask).toBeNull();
    expect(log.events().at(-1)?.eventType).toBe("attempt_shadow");

    const live = await runCodingAgentAttempt({
      providerName: "noop",
      task,
      log,
      driver: fake,
    });
    expect(live.mode).toBe("live");
    expect(fake.lastTask).toEqual(task);
  });

  it("runCodingAgentAttempt respects a global pause env override", async () => {
    const fake = createFakeCodingAgentDriver();
    const paused = await runCodingAgentAttempt({
      providerName: "noop",
      env: { MINER_CODING_AGENT_PAUSED: "true" },
      task,
      driver: fake,
    });
    expect(paused.mode).toBe("paused");
    expect(fake.lastTask).toBeNull();
  });
});
