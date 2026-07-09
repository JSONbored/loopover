import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFakeCodingAgentDriver,
  createNoopCodingAgentDriver,
  type CodingAgentDriverTask,
} from "../dist/index.js";

const task: CodingAgentDriverTask = {
  attemptId: "attempt-1",
  workingDirectory: "/tmp/work",
  acceptanceCriteriaPath: "/tmp/work/ACCEPTANCE.md",
  instructions: "fix the flaky test",
  maxTurns: 8,
};

test("createFakeCodingAgentDriver records the last task and returns ok", async () => {
  const driver = createFakeCodingAgentDriver();
  const result = await driver.run(task);
  assert.equal(driver.lastTask, task);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedFiles, []);
});

test("createNoopCodingAgentDriver acknowledges the attempt without IO", async () => {
  const driver = createNoopCodingAgentDriver();
  const result = await driver.run(task);
  assert.match(result.summary, /noop driver acknowledged attempt-1/);
  assert.equal(result.turnsUsed, 0);
});
