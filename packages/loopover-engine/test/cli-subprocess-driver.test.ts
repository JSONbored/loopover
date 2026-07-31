import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCliSubprocessCodingAgentDriver,
  type CliSubprocessSpawnFn,
  type CodingAgentDriverTask,
} from "../dist/index.js";

// #10246: this driver had NO test in the engine's own suite -- its behavior coverage lived entirely in
// the root vitest copy (test/unit/cli-subprocess-driver.test.ts). That suite is invisible to the
// `engine` Codecov flag (c8 over dist-test), so the three-counter input-tier sum landed as uncovered
// changed lines and failed codecov/patch. These are the tier-sum scenarios from the vitest copy, ported
// here so the suite that carries this file's coverage actually executes the new path. The vitest copy
// stays -- the two suites are deliberately parallel (see agent-sdk-driver's pairing).

const task: CodingAgentDriverTask = {
  attemptId: "attempt-7",
  workingDirectory: "/tmp/worktrees/attempt-7",
  acceptanceCriteriaPath: "/tmp/worktrees/attempt-7/ACCEPTANCE-CRITERIA.md",
  instructions: "Apply the fix described in ACCEPTANCE-CRITERIA.md.",
  maxTurns: 6,
};

function spawnPrinting(stdout: string): CliSubprocessSpawnFn {
  return async () => ({ stdout, code: 0 });
}

test("counts the prompt-cache tiers as input tokens (#10246)", async () => {
  const driver = createCliSubprocessCodingAgentDriver({
    command: "claude",
    spawn: spawnPrinting(
      JSON.stringify({
        type: "result",
        usage: { input_tokens: 2, output_tokens: 787, cache_read_input_tokens: 48210, cache_creation_input_tokens: 1536 },
      }),
    ),
  });
  const result = await driver.run(task);
  // 2 + 48210 + 1536 -- the tiers are additive components of ONE prompt, not aliases of one value.
  assert.equal(result.inputTokens, 49748);
  assert.equal(result.outputTokens, 787);
  assert.equal(result.tokensUsed, 50535);
});

test("leaves input absent when NO input counter is reported, but keeps a genuinely-zero tier (#10246)", async () => {
  const noInput = createCliSubprocessCodingAgentDriver({
    command: "claude",
    spawn: spawnPrinting(JSON.stringify({ output_tokens: 50 })),
  });
  assert.equal((await noInput.run(task)).inputTokens, undefined);

  const zeroTier = createCliSubprocessCodingAgentDriver({
    command: "claude",
    spawn: spawnPrinting(JSON.stringify({ usage: { input_tokens: 0, cache_read_input_tokens: 900 } })),
  });
  assert.equal((await zeroTier.run(task)).inputTokens, 900);
});

test("is byte-identical for a provider that emits no cache keys at all (#10246)", async () => {
  const driver = createCliSubprocessCodingAgentDriver({
    command: "codex",
    spawn: spawnPrinting(JSON.stringify({ prompt_tokens: 2706, completion_tokens: 544 })),
  });
  const result = await driver.run(task);
  assert.equal(result.inputTokens, 2706);
  assert.equal(result.outputTokens, 544);
});

test("tolerates camelCase cache-tier spellings across a JSONL stream (#10246)", async () => {
  const driver = createCliSubprocessCodingAgentDriver({
    command: "codex",
    spawn: spawnPrinting(
      '{"type":"start"}\n{"tokenUsage":{"inputTokens":50,"cacheReadInputTokens":200,"cacheCreationInputTokens":30,"outputTokens":25}}\n{"type":"end"}',
    ),
  });
  const result = await driver.run(task);
  assert.equal(result.inputTokens, 280);
  assert.equal(result.tokensUsed, 305);
});
