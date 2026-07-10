import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codingAgentModeExecutes,
  isGlobalMinerCodingAgentPause,
  resolveCodingAgentExecutionMode,
  resolveCodingAgentModeFromConfig,
} from "../dist/index.js";

test("resolveCodingAgentExecutionMode: global OR per-config pause halts everything (#4313)", () => {
  assert.equal(resolveCodingAgentExecutionMode({ globalPaused: true }), "paused");
  assert.equal(resolveCodingAgentExecutionMode({ globalPaused: true, agentDryRun: true }), "paused");
  assert.equal(resolveCodingAgentExecutionMode({ globalPaused: false, agentPaused: true }), "paused");
  assert.equal(
    resolveCodingAgentExecutionMode({ globalPaused: false, agentPaused: true, agentDryRun: true }),
    "paused",
  );
});

test("resolveCodingAgentExecutionMode: dry-run wins over live when not paused", () => {
  assert.equal(resolveCodingAgentExecutionMode({ globalPaused: false, agentDryRun: true }), "dry_run");
  assert.equal(
    resolveCodingAgentExecutionMode({ globalPaused: false, agentPaused: false, agentDryRun: true }),
    "dry_run",
  );
});

test("resolveCodingAgentExecutionMode: defaults to live only when nothing is set", () => {
  assert.equal(resolveCodingAgentExecutionMode({ globalPaused: false }), "live");
  assert.equal(
    resolveCodingAgentExecutionMode({ globalPaused: false, agentPaused: false, agentDryRun: false }),
    "live",
  );
  assert.equal(
    resolveCodingAgentExecutionMode({ globalPaused: false, agentPaused: null, agentDryRun: null }),
    "live",
  );
});

test("codingAgentModeExecutes: only live actually runs the driver", () => {
  assert.equal(codingAgentModeExecutes("live"), true);
  assert.equal(codingAgentModeExecutes("dry_run"), false);
  assert.equal(codingAgentModeExecutes("paused"), false);
});

test("isGlobalMinerCodingAgentPause recognizes truthy-string forms", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(isGlobalMinerCodingAgentPause({ MINER_CODING_AGENT_PAUSED: value }), true);
  }
  for (const value of ["0", "false", "no", "off", "", "maybe"]) {
    assert.equal(isGlobalMinerCodingAgentPause({ MINER_CODING_AGENT_PAUSED: value }), false);
  }
  assert.equal(isGlobalMinerCodingAgentPause({}), false);
});

test("resolveCodingAgentModeFromConfig: global pause beats per-config dry-run", () => {
  assert.equal(
    resolveCodingAgentModeFromConfig({
      env: { MINER_CODING_AGENT_PAUSED: "true" },
      agentDryRun: true,
    }),
    "paused",
  );
});
