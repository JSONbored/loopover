import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAttemptLogBuffer,
  createFakeCodingAgentDriver,
  createCodingAgentDriver,
  isConfiguredCodingAgentDriver,
  resolveConfiguredCodingAgentDriverNames,
  resolveFirstConfiguredCodingAgentDriverName,
  runCodingAgentAttempt,
  type CodingAgentDriverTask,
} from "../dist/index.js";

const task: CodingAgentDriverTask = {
  attemptId: "attempt-1",
  workingDirectory: "/tmp/work",
  acceptanceCriteriaPath: "/tmp/work/ACCEPTANCE.md",
  instructions: "fix the flaky test",
  maxTurns: 8,
};

test("isConfiguredCodingAgentDriver is deny-by-default for unknown names", () => {
  assert.equal(isConfiguredCodingAgentDriver("noop", {}), true);
  assert.equal(isConfiguredCodingAgentDriver("claude-code", {}), false);
  assert.equal(isConfiguredCodingAgentDriver("unknown", {}), false);
});

test("resolveConfiguredCodingAgentDriverNames filters to configured providers only", () => {
  assert.deepEqual(
    resolveConfiguredCodingAgentDriverNames({ MINER_CODING_AGENT_PROVIDER: "noop,unknown" }),
    ["noop"],
  );
});

test("createCodingAgentDriver throws for unconfigured providers", () => {
  assert.throws(() => createCodingAgentDriver({ providerName: "unknown" }), /unconfigured_coding_agent_driver/);
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

test("all concrete provider names are configured; unknown stays denied (#4289)", () => {
  for (const name of ["claude-cli", "codex-cli", "agent-sdk"]) {
    assert.equal(isConfiguredCodingAgentDriver(name, {}), true);
  }
  assert.equal(isConfiguredCodingAgentDriver("mystery", {}), false);
});

test("claude-cli consumes its declared model env key into the argv (#4289)", async () => {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const driver = createCodingAgentDriver({
    providerName: "claude-cli",
    env: { MINER_CODING_AGENT_CLAUDE_MODEL: "claude-sonnet-5" },
    spawn: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: "done", code: 0 };
    },
  });
  const cliTask = {
    attemptId: "a1",
    workingDirectory: "/tmp/w",
    acceptanceCriteriaPath: "/tmp/w/AC.md",
    instructions: "fix",
    maxTurns: 2,
  };
  const result = await driver.run(cliTask);
  assert.equal(result.ok, true);
  assert.equal(calls[0]!.cmd, "claude");
  assert.deepEqual([...calls[0]!.args].slice(0, 2), ["--model", "claude-sonnet-5"]);
});

test("a CLI provider without a spawn dependency fails closed (#4289)", () => {
  assert.throws(
    () => createCodingAgentDriver({ providerName: "codex-cli" }),
    /unconfigured_coding_agent_driver_missing_spawn:codex-cli/,
  );
});

test("resolveFirstConfiguredCodingAgentDriverName is primary-then-fallback over the provider list (#4289)", () => {
  assert.equal(
    resolveFirstConfiguredCodingAgentDriverName({ MINER_CODING_AGENT_PROVIDER: "mystery, agent-sdk" }),
    "agent-sdk",
  );
  assert.equal(resolveFirstConfiguredCodingAgentDriverName({}), undefined);
});

test("runCodingAgentAttempt dry_run with claude-cli does not require spawn (#4289)", async () => {
  const log = createAttemptLogBuffer();
  const dry = await runCodingAgentAttempt({
    providerName: "claude-cli",
    agentDryRun: true,
    task,
    log,
  });
  assert.equal(dry.mode, "dry_run");
  assert.equal(log.events().at(-1)?.eventType, "attempt_shadow");
});
