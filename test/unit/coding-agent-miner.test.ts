import { describe, expect, it } from "vitest";
import {
  ATTEMPT_LOG_EVENT_TYPES,
  CODING_AGENT_DRIVER_CONFIG_ENV,
  CODING_AGENT_DRIVER_NAMES,
  classifyLintGuardPackage,
  codingAgentModeExecutes,
  createAttemptLogBuffer,
  createCodingAgentDriver,
  createFakeCodingAgentDriver,
  createFakeCodingAgentDriverForFactory,
  createNoopCodingAgentDriver,
  formatAttemptLogJsonl,
  guardChangedFiles,
  guardCodingAgentDriverResult,
  invokeCodingAgentDriver,
  isConfiguredCodingAgentDriver,
  isGlobalMinerCodingAgentPause,
  normalizeAttemptLogEvent,
  resolveCodingAgentExecutionMode,
  resolveCodingAgentModeFromConfig,
  resolveConfiguredCodingAgentDriverNames,
  resolveFirstConfiguredCodingAgentDriverName,
  runCodingAgentAttempt,
  type CodingAgentDriverResult,
  type CodingAgentDriverTask,
  type LintGuardSpawnFn,
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
      "attempt_tool_edit",
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
  it("exposes the provider registry", () => {
    expect([...CODING_AGENT_DRIVER_NAMES]).toEqual(["noop", "claude-cli", "codex-cli", "agent-sdk"]);
    expect(CODING_AGENT_DRIVER_CONFIG_ENV.noop).toEqual({});
    expect(CODING_AGENT_DRIVER_CONFIG_ENV["claude-cli"]).toEqual({
      model: "MINER_CODING_AGENT_CLAUDE_MODEL",
      timeoutMs: "MINER_CODING_AGENT_TIMEOUT_MS",
    });
    expect(CODING_AGENT_DRIVER_CONFIG_ENV["agent-sdk"]).toEqual({});
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

  it("runCodingAgentAttempt is unaffected when lintGuard is omitted (backward compatible)", async () => {
    const fake = createFakeCodingAgentDriver({
      run: async () => ({ ok: true, changedFiles: ["a.ts"], summary: "did it", turnsUsed: 1 }),
    });
    const live = await runCodingAgentAttempt({ providerName: "noop", task, driver: fake });
    expect(live.result.ok).toBe(true);
    expect(live.result.lintGuard).toBeUndefined();
  });

  it("runCodingAgentAttempt runs the supplied lint guard on the driver's changed files, downgrading ok on failure", async () => {
    const fake = createFakeCodingAgentDriver({
      run: async () => ({ ok: true, changedFiles: ["src/review/ops-wire.ts"], summary: "did it", turnsUsed: 1 }),
    });
    const spawn: LintGuardSpawnFn = async () => ({ code: 2, output: "type error" });
    const live = await runCodingAgentAttempt({
      providerName: "noop",
      task,
      driver: fake,
      lintGuard: { spawn, cwd: "/repo" },
    });
    expect(live.result.ok).toBe(false);
    expect(live.result.lintGuard?.ok).toBe(false);
  });

  it("runCodingAgentAttempt keeps ok: true when the supplied lint guard passes", async () => {
    const fake = createFakeCodingAgentDriver({
      run: async () => ({ ok: true, changedFiles: ["src/review/ops-wire.ts"], summary: "did it", turnsUsed: 1 }),
    });
    const spawn: LintGuardSpawnFn = async () => ({ code: 0, output: "" });
    const live = await runCodingAgentAttempt({
      providerName: "noop",
      task,
      driver: fake,
      lintGuard: { spawn, cwd: "/repo" },
    });
    expect(live.result.ok).toBe(true);
    expect(live.result.lintGuard?.ok).toBe(true);
  });
});

describe("createCodingAgentDriver provider resolution (#4289)", () => {
  const cliTask: CodingAgentDriverTask = {
    attemptId: "attempt-factory-1",
    workingDirectory: "/tmp/worktrees/attempt-factory-1",
    acceptanceCriteriaPath: "/tmp/worktrees/attempt-factory-1/ACCEPTANCE-CRITERIA.md",
    instructions: "Apply the fix.",
    maxTurns: 4,
  };

  function recordingSpawn() {
    const calls: Array<{ cmd: string; args: readonly string[]; opts: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number } }> = [];
    const spawn = async (cmd: string, args: readonly string[], opts: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }) => {
      calls.push({ cmd, args, opts });
      return { stdout: "done", code: 0 };
    };
    return { spawn, calls };
  }

  it("accepts every concrete provider name (locally-authenticated, always configured)", () => {
    for (const name of ["claude-cli", "codex-cli", "agent-sdk"]) {
      expect(isConfiguredCodingAgentDriver(name, {})).toBe(true);
    }
  });

  it("claude-cli spawns the claude command with the driver's default argv when no model is configured", async () => {
    const { spawn, calls } = recordingSpawn();
    const driver = createCodingAgentDriver({ providerName: "claude-cli", spawn, env: {} });
    const result = await driver.run(cliTask);
    expect(result.ok).toBe(true);
    expect(calls[0]!.cmd).toBe("claude");
    expect(calls[0]!.args).not.toContain("--model");
    expect(calls[0]!.args).toContain("--max-turns");
    expect(calls[0]!.opts.cwd).toBe(cliTask.workingDirectory);
  });

  it("CONSUMES the declared model env key: MINER_CODING_AGENT_CLAUDE_MODEL lands in the claude argv", async () => {
    const { spawn, calls } = recordingSpawn();
    const driver = createCodingAgentDriver({
      providerName: "claude-cli",
      spawn,
      env: { MINER_CODING_AGENT_CLAUDE_MODEL: "claude-sonnet-5" },
    });
    await driver.run(cliTask);
    const args = [...calls[0]!.args];
    expect(args.slice(0, 2)).toEqual(["--model", "claude-sonnet-5"]);
    expect(args).toContain("--max-turns");
  });

  it("codex-cli reads ITS OWN model key and ignores claude's", async () => {
    const { spawn, calls } = recordingSpawn();
    const driver = createCodingAgentDriver({
      providerName: "codex-cli",
      spawn,
      env: { MINER_CODING_AGENT_CODEX_MODEL: "gpt-5.1-codex", MINER_CODING_AGENT_CLAUDE_MODEL: "ignored" },
    });
    await driver.run(cliTask);
    expect(calls[0]!.cmd).toBe("codex");
    expect([...calls[0]!.args].slice(0, 2)).toEqual(["--model", "gpt-5.1-codex"]);
  });

  it("CONSUMES the declared timeout env key when it is a positive integer, else defers to the driver default", async () => {
    const { spawn, calls } = recordingSpawn();
    await createCodingAgentDriver({ providerName: "claude-cli", spawn, env: { MINER_CODING_AGENT_TIMEOUT_MS: "90000" } }).run(cliTask);
    expect(calls[0]!.opts.timeoutMs).toBe(90_000);
    for (const bad of ["not-a-number", "-5", "0", "1.5", "  "]) {
      const rec = recordingSpawn();
      await createCodingAgentDriver({ providerName: "claude-cli", spawn: rec.spawn, env: { MINER_CODING_AGENT_TIMEOUT_MS: bad } }).run(cliTask);
      expect(rec.calls[0]!.opts.timeoutMs).toBe(120_000);
    }
  });

  it("a whitespace-only model env value is treated as unset", async () => {
    const { spawn, calls } = recordingSpawn();
    await createCodingAgentDriver({ providerName: "claude-cli", spawn, env: { MINER_CODING_AGENT_CLAUDE_MODEL: "   " } }).run(cliTask);
    expect(calls[0]!.args).not.toContain("--model");
  });

  it("fails closed when a CLI provider has no spawn dependency", () => {
    expect(() => createCodingAgentDriver({ providerName: "claude-cli" })).toThrowError(
      "unconfigured_coding_agent_driver_missing_spawn:claude-cli",
    );
    expect(() => createCodingAgentDriver({ providerName: "codex-cli", env: {} })).toThrowError(
      "unconfigured_coding_agent_driver_missing_spawn:codex-cli",
    );
  });

  it("forwards knownSecrets to the CLI driver's redaction", async () => {
    const secretValue = ["long-injected", "auth-value"].join("-");
    const spawn = async () => ({ stdout: `echoed ${secretValue}`, code: 0 });
    const driver = createCodingAgentDriver({ providerName: "claude-cli", spawn, knownSecrets: [secretValue] });
    const result = await driver.run(cliTask);
    expect(result.transcript).not.toContain(secretValue);
    expect(result.transcript).toContain("[redacted]");
  });

  it("agent-sdk resolves with an injected query loop and forwards hooks to the session", async () => {
    let captured: { options: { hooks?: unknown } } | undefined;
    const hooks = { PreToolUse: [{ hooks: ["policy"] }] };
    const driver = createCodingAgentDriver({
      providerName: "agent-sdk",
      hooks,
      query: (input) => {
        captured = input;
        return (async function* (): AsyncGenerator<Record<string, unknown>> {
          yield { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok" };
        })();
      },
    });
    const result = await driver.run(cliTask);
    expect(result.ok).toBe(true);
    expect(captured!.options.hooks).toBe(hooks);
  });

  it("agent-sdk constructs without any injected deps (real-SDK default) without invoking it", () => {
    const driver = createCodingAgentDriver({ providerName: "agent-sdk" });
    expect(typeof driver.run).toBe("function");
  });

  it("normalizes provider-name case and whitespace", async () => {
    const { spawn, calls } = recordingSpawn();
    const driver = createCodingAgentDriver({ providerName: "  Claude-CLI ", spawn });
    await driver.run(cliTask);
    expect(calls[0]!.cmd).toBe("claude");
  });

  it("resolveFirstConfiguredCodingAgentDriverName skips unknown names (primary-then-fallback) and fails closed on none", () => {
    expect(resolveFirstConfiguredCodingAgentDriverName({ MINER_CODING_AGENT_PROVIDER: "mystery, agent-sdk, noop" })).toBe("agent-sdk");
    expect(resolveFirstConfiguredCodingAgentDriverName({ MINER_CODING_AGENT_PROVIDER: "mystery,unknown" })).toBeUndefined();
    expect(resolveFirstConfiguredCodingAgentDriverName({})).toBeUndefined();
  });

  it("runCodingAgentAttempt threads provider deps end-to-end (claude-cli under live mode)", async () => {
    const { spawn, calls } = recordingSpawn();
    const { mode, result } = await runCodingAgentAttempt({
      providerName: "claude-cli",
      env: { MINER_CODING_AGENT_CLAUDE_MODEL: "claude-sonnet-5" },
      spawn,
      task: cliTask,
    });
    expect(mode).toBe("live");
    expect(result.ok).toBe(true);
    expect([...calls[0]!.args].slice(0, 2)).toEqual(["--model", "claude-sonnet-5"]);
  });

  it("runCodingAgentAttempt dry_run with claude-cli does not require spawn (shadow event only)", async () => {
    const log = createAttemptLogBuffer();
    const dry = await runCodingAgentAttempt({
      providerName: "claude-cli",
      agentDryRun: true,
      task: cliTask,
      log,
    });
    expect(dry.mode).toBe("dry_run");
    expect(dry.result.ok).toBe(true);
    expect(log.events().at(-1)?.eventType).toBe("attempt_shadow");
  });
});

describe("lint-guarded edit wrapper (#4276)", () => {
  it("classifyLintGuardPackage routes each file to the check that actually governs it", () => {
    expect(classifyLintGuardPackage("apps/gittensory-ui/src/App.tsx")).toBe("ui");
    expect(classifyLintGuardPackage("packages/gittensory-engine/src/miner/lint-guard.ts")).toBe("engine");
    expect(classifyLintGuardPackage("packages/gittensory-miner/lib/cli.js")).toBe("miner-js");
    expect(classifyLintGuardPackage("packages/gittensory-mcp/bin/gittensory-mcp.js")).toBe("mcp-js");
    expect(classifyLintGuardPackage("src/review/ops-wire.ts")).toBe("root");
    // A hand-written .d.ts under miner/mcp is type-checked by the root tsc, not node --check.
    expect(classifyLintGuardPackage("packages/gittensory-miner/lib/cli.d.ts")).toBe("root");
    expect(classifyLintGuardPackage("packages/gittensory-mcp/lib/local-branch.d.ts")).toBe("root");
  });

  it("classifyLintGuardPackage normalizes Windows-style backslash paths and a leading ./", () => {
    expect(classifyLintGuardPackage("packages\\gittensory-miner\\lib\\cli.js")).toBe("miner-js");
    expect(classifyLintGuardPackage("./src/review/ops-wire.ts")).toBe("root");
  });

  function recordingSpawn(outcomes: Record<string, { code: number; output: string }>): {
    spawn: LintGuardSpawnFn;
    calls: Array<{ cmd: string; args: readonly string[] }>;
  } {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const spawn: LintGuardSpawnFn = async (cmd, args) => {
      calls.push({ cmd, args });
      const key = [cmd, ...args].join(" ");
      const outcome = outcomes[key] ?? { code: 0, output: "" };
      return outcome;
    };
    return { spawn, calls };
  }

  it("guardChangedFiles reports a root typecheck failure as a structured (not thrown) result", async () => {
    const { spawn } = recordingSpawn({
      "npm run typecheck": { code: 2, output: "src/review/ops-wire.ts(10,3): error TS2322" },
    });
    const result = await guardChangedFiles(["src/review/ops-wire.ts"], { spawn, cwd: "/repo" });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      { package: "root", file: "src/review/ops-wire.ts", command: "npm run typecheck", ok: false, output: "src/review/ops-wire.ts(10,3): error TS2322" },
    ]);
  });

  it("guardChangedFiles reports a node --check syntax error in a gittensory-miner JS file", async () => {
    const { spawn } = recordingSpawn({
      "node --check packages/gittensory-miner/lib/cli.js": {
        code: 1,
        output: "SyntaxError: Unexpected token '}'",
      },
    });
    const result = await guardChangedFiles(["packages/gittensory-miner/lib/cli.js"], { spawn, cwd: "/repo" });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      {
        package: "miner-js",
        file: "packages/gittensory-miner/lib/cli.js",
        command: "node --check packages/gittensory-miner/lib/cli.js",
        ok: false,
        output: "SyntaxError: Unexpected token '}'",
      },
    ]);
  });

  it("guardChangedFiles reports ok: true for a fully clean change", async () => {
    const { spawn } = recordingSpawn({});
    const result = await guardChangedFiles(["src/review/ops-wire.ts"], { spawn, cwd: "/repo" });
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual([
      { package: "root", file: "src/review/ops-wire.ts", command: "npm run typecheck", ok: true, output: "" },
    ]);
  });

  it("guardChangedFiles checks a changeset spanning multiple packages against each file's OWN rule, once per package", async () => {
    const { spawn, calls } = recordingSpawn({
      "npm run typecheck": { code: 0, output: "" },
      "npm run build --workspace @jsonbored/gittensory-engine": { code: 1, output: "engine build failed" },
      "node --check packages/gittensory-miner/lib/cli.js": { code: 0, output: "" },
      "npm run ui:typecheck": { code: 0, output: "" },
    });
    const result = await guardChangedFiles(
      [
        "src/review/ops-wire.ts",
        "packages/gittensory-engine/src/miner/lint-guard.ts",
        "packages/gittensory-miner/lib/cli.js",
        "apps/gittensory-ui/src/App.tsx",
      ],
      { spawn, cwd: "/repo" },
    );
    expect(result.ok).toBe(false);
    // Exactly one check per package group -- the root/ui/engine commands are NOT re-run per file.
    expect(result.checks).toHaveLength(4);
    expect(result.checks.find((check) => check.package === "root")?.ok).toBe(true);
    expect(result.checks.find((check) => check.package === "engine")?.ok).toBe(false);
    expect(result.checks.find((check) => check.package === "miner-js")?.ok).toBe(true);
    expect(result.checks.find((check) => check.package === "ui")?.ok).toBe(true);
    expect(calls.filter((call) => call.cmd === "npm" && call.args.join(" ") === "run typecheck")).toHaveLength(1);
  });

  it("guardChangedFiles groups multiple files in the same package into a single check", async () => {
    const { spawn } = recordingSpawn({
      "node --check packages/gittensory-miner/lib/a.js": { code: 0, output: "" },
      "node --check packages/gittensory-miner/lib/b.js": { code: 0, output: "" },
    });
    const result = await guardChangedFiles(
      ["packages/gittensory-miner/lib/a.js", "packages/gittensory-miner/lib/b.js"],
      { spawn, cwd: "/repo" },
    );
    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(2);
    expect(result.checks.map((check) => check.file)).toEqual([
      "packages/gittensory-miner/lib/a.js",
      "packages/gittensory-miner/lib/b.js",
    ]);
  });

  it("guardChangedFiles returns ok: true with no checks for an empty changeset", async () => {
    const { spawn, calls } = recordingSpawn({});
    const result = await guardChangedFiles([], { spawn, cwd: "/repo" });
    expect(result).toEqual({ ok: true, checks: [] });
    expect(calls).toHaveLength(0);
  });

  it("guardChangedFiles defaults cwd to process.cwd() when omitted", async () => {
    const seenCwds: Array<{ cwd: string }> = [];
    const spawn: LintGuardSpawnFn = async (_cmd, _args, opts) => {
      seenCwds.push(opts);
      return { code: 0, output: "" };
    };
    await guardChangedFiles(["src/review/ops-wire.ts"], { spawn });
    expect(seenCwds).toEqual([{ cwd: process.cwd() }]);
  });

  function driverResult(overrides: Partial<CodingAgentDriverResult> = {}): CodingAgentDriverResult {
    return { ok: true, changedFiles: [], summary: "ok", turnsUsed: 1, ...overrides };
  }

  it("guardCodingAgentDriverResult skips the guard when the driver itself failed", async () => {
    const { spawn, calls } = recordingSpawn({});
    const decorated = await guardCodingAgentDriverResult(driverResult({ ok: false, error: "boom" }), { spawn });
    expect(decorated.ok).toBe(false);
    expect(decorated.lintGuard).toEqual({ ok: true, checks: [] });
    expect(calls).toHaveLength(0);
  });

  it("guardCodingAgentDriverResult skips the guard when no files changed", async () => {
    const { spawn, calls } = recordingSpawn({});
    const decorated = await guardCodingAgentDriverResult(driverResult({ changedFiles: [] }), { spawn });
    expect(decorated.ok).toBe(true);
    expect(decorated.lintGuard).toEqual({ ok: true, checks: [] });
    expect(calls).toHaveLength(0);
  });

  it("guardCodingAgentDriverResult runs the guard and downgrades ok when a check fails", async () => {
    const { spawn } = recordingSpawn({
      "npm run typecheck": { code: 2, output: "type error" },
    });
    const decorated = await guardCodingAgentDriverResult(
      driverResult({ changedFiles: ["src/review/ops-wire.ts"] }),
      { spawn },
    );
    expect(decorated.ok).toBe(false);
    expect(decorated.lintGuard.ok).toBe(false);
    expect(decorated.lintGuard.checks).toHaveLength(1);
  });

  it("guardCodingAgentDriverResult keeps ok: true and preserves driver fields when every check passes", async () => {
    const { spawn } = recordingSpawn({});
    const decorated = await guardCodingAgentDriverResult(
      driverResult({ changedFiles: ["src/review/ops-wire.ts"], summary: "did the thing", turnsUsed: 3 }),
      { spawn },
    );
    expect(decorated.ok).toBe(true);
    expect(decorated.summary).toBe("did the thing");
    expect(decorated.turnsUsed).toBe(3);
    expect(decorated.lintGuard.ok).toBe(true);
  });
});
