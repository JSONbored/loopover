import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAttemptLogBuffer,
  createFakeCodingAgentDriver,
  invokeCodingAgentDriver,
  type CodingAgentDriverTask,
} from "../dist/index.js";

const task: CodingAgentDriverTask = {
  attemptId: "attempt-1",
  workingDirectory: "/tmp/work",
  acceptanceCriteriaPath: "/tmp/work/ACCEPTANCE.md",
  instructions: "fix the flaky test",
  maxTurns: 8,
};

test("invokeCodingAgentDriver: paused never calls the underlying driver", async () => {
  const driver = createFakeCodingAgentDriver();
  const log = createAttemptLogBuffer();
  const result = await invokeCodingAgentDriver(driver, "paused", task, log);
  assert.equal(driver.lastTask, null);
  assert.equal(result.ok, false);
  assert.equal(result.error, "coding_agent_paused");
  assert.equal(log.events().at(-1)?.eventType, "attempt_aborted");
  assert.equal(log.events().at(-1)?.mode, "paused");
});

test("invokeCodingAgentDriver: dry_run records attempt_shadow without calling the driver", async () => {
  const driver = createFakeCodingAgentDriver();
  const log = createAttemptLogBuffer();
  const result = await invokeCodingAgentDriver(driver, "dry_run", task, log);
  assert.equal(driver.lastTask, null);
  assert.equal(result.ok, true);
  assert.match(result.summary, /dry-run: would invoke coding agent/);
  assert.equal(log.events().at(-1)?.eventType, "attempt_shadow");
  assert.equal(log.events().at(-1)?.mode, "dry_run");
});

test("invokeCodingAgentDriver: live delegates to the driver and logs success", async () => {
  const driver = createFakeCodingAgentDriver();
  const log = createAttemptLogBuffer();
  const result = await invokeCodingAgentDriver(driver, "live", task, log);
  assert.equal(driver.lastTask, task);
  assert.equal(result.ok, true);
  assert.deepEqual(
    log.events().map((event) => event.eventType),
    ["attempt_started", "attempt_succeeded"],
  );
});

test("invokeCodingAgentDriver: live records attempt_failed when the driver throws", async () => {
  const driver = createFakeCodingAgentDriver({
    run: async () => {
      throw new Error("spawn failed");
    },
  });
  const log = createAttemptLogBuffer();
  const result = await invokeCodingAgentDriver(driver, "live", task, log);
  assert.equal(result.ok, false);
  assert.equal(result.error, "spawn failed");
  assert.equal(log.events().at(-1)?.eventType, "attempt_failed");
});
