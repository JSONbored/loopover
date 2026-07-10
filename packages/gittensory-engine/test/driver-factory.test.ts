import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAttemptLogBuffer,
  createFakeCodingAgentDriver,
  createCodingAgentDriver,
  isConfiguredCodingAgentDriver,
  resolveConfiguredCodingAgentDriverNames,
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
