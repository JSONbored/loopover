// Tests for MinerGoalSpec file discovery (#2294). The tolerant parser itself is covered by
// miner-goal-spec-parser.test.ts; this covers only the discovery order. Pure —
// the existence check is injected, so no filesystem is touched. Runs against compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverMinerGoalSpecPath, MINER_GOAL_SPEC_FILENAMES } from "../dist/index.js";

test("MINER_GOAL_SPEC_FILENAMES lists the documented discovery order", () => {
  assert.deepEqual([...MINER_GOAL_SPEC_FILENAMES], [
    ".loopover-miner.yml",
    ".github/loopover-miner.yml",
    ".loopover-miner.json",
    ".github/loopover-miner.json",
  ]);
});

test("discoverMinerGoalSpecPath: returns the first existing candidate, first match wins", () => {
  assert.equal(discoverMinerGoalSpecPath(() => true), ".loopover-miner.yml");
  // repo-root yml missing but the .github yml present → that one is chosen
  assert.equal(
    discoverMinerGoalSpecPath((p) => p !== ".loopover-miner.yml"),
    ".github/loopover-miner.yml",
  );
  // only a JSON variant present
  assert.equal(discoverMinerGoalSpecPath((p) => p === ".loopover-miner.json"), ".loopover-miner.json");
});

test("discoverMinerGoalSpecPath: short-circuits — stops probing once a candidate matches", () => {
  const probed: string[] = [];
  const result = discoverMinerGoalSpecPath((p) => {
    probed.push(p);
    return p === ".github/loopover-miner.yml"; // the 2nd candidate matches
  });
  assert.equal(result, ".github/loopover-miner.yml");
  // only the first two candidates are probed; the later .json variants are never reached
  assert.deepEqual(probed, [".loopover-miner.yml", ".github/loopover-miner.yml"]);
});

test("discoverMinerGoalSpecPath: returns null when no candidate exists, and never probes unlisted paths", () => {
  const probed: string[] = [];
  const result = discoverMinerGoalSpecPath((p) => {
    probed.push(p);
    return false;
  });
  assert.equal(result, null);
  assert.deepEqual(probed, [...MINER_GOAL_SPEC_FILENAMES]); // exactly the listed candidates, in order
});
