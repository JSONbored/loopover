import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODING_AGENT_DRIVER_CONFIG_ENV,
  CODING_AGENT_DRIVER_NAMES,
  createAttemptLogBuffer,
  createFakeCodingAgentDriver,
  createCodingAgentDriver,
  createDefaultCliSubprocessSpawn,
  isConfiguredCodingAgentDriver,
  resolveConfiguredCodingAgentDriverNames,
  runCodingAgentAttempt,
  type AgentSdkQueryFn,
  type CliSubprocessSpawnFn,
  type CodingAgentDriverTask,
} from "../dist/index.js";

const task: CodingAgentDriverTask = {
  attemptId: "attempt-1",
  workingDirectory: "/tmp/work",
  acceptanceCriteriaPath: "/tmp/work/ACCEPTANCE.md",
  instructions: "fix the flaky test",
  maxTurns: 8,
};

test("CODING_AGENT_DRIVER_NAMES includes concrete backends", () => {
  assert.deepEqual([...CODING_AGENT_DRIVER_NAMES], ["noop", "cli-subprocess", "agent-sdk"]);
  assert.equal(CODING_AGENT_DRIVER_CONFIG_ENV["cli-subprocess"].command, "MINER_CODING_AGENT_CLI");
  assert.equal(CODING_AGENT_DRIVER_CONFIG_ENV["agent-sdk"].model, "MINER_CODING_AGENT_SDK_MODEL");
});

test("isConfiguredCodingAgentDriver is deny-by-default for unknown names", () => {
  assert.equal(isConfiguredCodingAgentDriver("noop", {}), true);
  assert.equal(isConfiguredCodingAgentDriver("cli-subprocess", {}), true);
  assert.equal(isConfiguredCodingAgentDriver("agent-sdk", {}), true);
  assert.equal(isConfiguredCodingAgentDriver("claude-code", {}), false);
  assert.equal(isConfiguredCodingAgentDriver("unknown", {}), false);
});

test("resolveConfiguredCodingAgentDriverNames filters to configured providers only", () => {
  assert.deepEqual(
    resolveConfiguredCodingAgentDriverNames({
      MINER_CODING_AGENT_PROVIDER: "noop,cli-subprocess,unknown,agent-sdk",
    }),
    ["noop", "cli-subprocess", "agent-sdk"],
  );
});

test("createCodingAgentDriver throws for unconfigured providers", () => {
  assert.throws(() => createCodingAgentDriver({ providerName: "unknown" }), /unconfigured_coding_agent_driver/);
});

test("createCodingAgentDriver resolves cli-subprocess via injected spawn", async () => {
  const calls: Array<{ cmd: string; timeoutMs: number }> = [];
  const spawn: CliSubprocessSpawnFn = async (cmd, _args, opts) => {
    calls.push({ cmd, timeoutMs: opts.timeoutMs });
    return { stdout: "ok", code: 0 };
  };
  const driver = createCodingAgentDriver({
    providerName: "cli-subprocess",
    env: { MINER_CODING_AGENT_CLI: "codex", MINER_CODING_AGENT_TIMEOUT_MS: "30000" },
    spawn,
  });
  const result = await driver.run(task);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ cmd: "codex", timeoutMs: 30_000 }]);
});

test("createCodingAgentDriver resolves agent-sdk via injected query", async () => {
  const query: AgentSdkQueryFn = async function* () {
    yield { type: "result", subtype: "success", result: "done", num_turns: 2 };
  };
  const driver = createCodingAgentDriver({ providerName: "agent-sdk", query });
  const result = await driver.run(task);
  assert.equal(result.ok, true);
  assert.equal(result.turnsUsed, 2);
});

test("createDefaultCliSubprocessSpawn is a function", () => {
  assert.equal(typeof createDefaultCliSubprocessSpawn(), "function");
});

test("runCodingAgentAttempt wires mode + driver + attempt log end-to-end", async () => {
  const log = createAttemptLogBuffer();
  const fake = createFakeCodingAgentDriver();
  const dry = await runCodingAgentAttempt({
    providerName: "noop",
    agentDryRun: true,
    task,
    log,
    driver: fake,
  });
  assert.equal(dry.mode, "dry_run");
  assert.equal(fake.lastTask, null);
  assert.equal(log.events().at(-1)?.eventType, "attempt_shadow");

  const live = await runCodingAgentAttempt({
    providerName: "noop",
    task,
    log,
    driver: fake,
  });
  assert.equal(live.mode, "live");
  assert.equal(fake.lastTask, task);
});
